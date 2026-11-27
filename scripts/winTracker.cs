using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

/// <summary>
/// Ultra-lightweight Per-Monitor V2 DPI-aware Win32 foreground window, Agent process,
/// and cached UI Automation (UIA) button tracker for StockingQuota V0.4+.
/// - Antigravity: tracks model selector button + menu open state + left-click instant dismiss.
/// - Codex: tracks bottom-left quota circle via cached UIA element (handles sidebar open/close/resize)
///   with semantic keyword match + left-rail geometric fallback + left-click instant dismiss.
/// Exits automatically if parent closes stdin (never leaves orphan processes).
/// </summary>
internal static class Program
{
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int GA_ROOT = 2;
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    private static readonly object OutputLock = new object();
    private static readonly BlockingCollection<MousePressEvent> MousePresses = new BlockingCollection<MousePressEvent>(32);
    private static readonly MouseHook MouseCallback = OnMouse;

    private static IntPtr antigravityWindow;
    private static IntPtr codexWindow;
    private static volatile TrackedControl antigravityControl;
    private static volatile TrackedControl codexControl;

    private struct MousePressEvent
    {
        public string Agent;
        public POINT Point;
    }

    private sealed class TrackedControl
    {
        public readonly IntPtr Window;
        public readonly Rect Bounds;
        public readonly bool MenuOpen;
        public readonly bool UiaReady;

        public TrackedControl(IntPtr window, Rect bounds, bool menuOpen, bool uiaReady)
        {
            Window = window;
            Bounds = bounds;
            MenuOpen = menuOpen;
            UiaReady = uiaReady;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr Hwnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public POINT Point;
        public uint Private;
    }

    private delegate IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, MouseHook callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG msg, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string name);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    private static void WritePayload(string payload)
    {
        lock (OutputLock)
        {
            Console.WriteLine(payload);
            Console.Out.Flush();
        }
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code == 0 && wParam.ToInt64() == WM_LBUTTONDOWN)
        {
            IntPtr agyHost = Interlocked.CompareExchange(ref antigravityWindow, IntPtr.Zero, IntPtr.Zero);
            IntPtr codexHost = Interlocked.CompareExchange(ref codexWindow, IntPtr.Zero, IntPtr.Zero);
            if (agyHost != IntPtr.Zero || codexHost != IntPtr.Zero)
            {
                POINT point = (POINT)Marshal.PtrToStructure(lParam, typeof(POINT));
                IntPtr rootHwnd = GetAncestor(WindowFromPoint(point), GA_ROOT);
                if (agyHost != IntPtr.Zero && rootHwnd == agyHost)
                {
                    MousePresses.TryAdd(new MousePressEvent { Agent = "antigravity", Point = point });
                }
                else if (codexHost != IntPtr.Zero && rootHwnd == codexHost)
                {
                    MousePresses.TryAdd(new MousePressEvent { Agent = "codex", Point = point });
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    private static void TrackMouse()
    {
        IntPtr hook = SetWindowsHookEx(WH_MOUSE_LL, MouseCallback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) return;
        try
        {
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        }
        finally
        {
            UnhookWindowsHookEx(hook);
        }
    }

    private static readonly string[] CodexQuotaKeywords = new[]
    {
        "usage", "rate limit", "rate-limit", "limits", "quota", "credit",
        "用量", "额度", "限额", "使用量", "配额", "剩余"
    };

    private static bool MatchesCodexQuotaKeyword(string text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        string lower = text.ToLowerInvariant();
        for (int i = 0; i < CodexQuotaKeywords.Length; i++)
        {
            if (lower.Contains(CodexQuotaKeywords[i])) return true;
        }
        return false;
    }

    private static bool IsExpanded(AutomationElement element, bool useCached)
    {
        try
        {
            object pattern;
            if (useCached)
            {
                if (element.TryGetCachedPattern(ExpandCollapsePattern.Pattern, out pattern))
                    return ((ExpandCollapsePattern)pattern).Cached.ExpandCollapseState == ExpandCollapseState.Expanded;
            }
            else
            {
                if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                    return ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState == ExpandCollapseState.Expanded;
            }
        }
        catch { }
        return false;
    }

    private sealed class CodexCandidate
    {
        public AutomationElement Element;
        public Rect Bounds;
        public bool KeywordHit;
        public bool Expanded;
    }

    private static void TrackHostButtons()
    {
        // Antigravity UIA condition & cache
        var agyCondition = new AndCondition(
            new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                    new OrCondition(
                        new PropertyCondition(AutomationElement.NameProperty, "查看用量"),
                        new PropertyCondition(AutomationElement.NameProperty, "View usage", PropertyConditionFlags.IgnoreCase)))),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        var agyCache = new CacheRequest { AutomationElementMode = AutomationElementMode.None };
        agyCache.Add(AutomationElement.NameProperty);
        agyCache.Add(AutomationElement.BoundingRectangleProperty);
        agyCache.Add(AutomationElement.ControlTypeProperty);
        agyCache.Add(ExpandCollapsePattern.Pattern);
        agyCache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);

        // Codex UIA condition & cache (keeps live element handle so we can query single node in <1ms!)
        var codexButtonCondition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        var codexScanCache = new CacheRequest { AutomationElementMode = AutomationElementMode.Full };
        codexScanCache.Add(AutomationElement.NameProperty);
        codexScanCache.Add(AutomationElement.HelpTextProperty);
        codexScanCache.Add(AutomationElement.AutomationIdProperty);
        codexScanCache.Add(AutomationElement.BoundingRectangleProperty);
        codexScanCache.Add(ExpandCollapsePattern.Pattern);
        codexScanCache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);

        // Single-element cache state for Codex (avoids scanning large chat DOM trees every 400ms!)
        AutomationElement cachedCodexEl = null;
        IntPtr cachedCodexHwnd = IntPtr.Zero;
        RECT cachedCodexWinRect = new RECT();
        long lastCodexFullScanTick = 0;

        while (true)
        {
            IntPtr fg = GetForegroundWindow();

            // 1. Antigravity model selector button & menu tracking
            IntPtr agyHost = Interlocked.CompareExchange(ref antigravityWindow, IntPtr.Zero, IntPtr.Zero);
            if (agyHost != IntPtr.Zero && fg == agyHost)
            {
                TrackedControl result = null;
                try
                {
                    var root = AutomationElement.FromHandle(agyHost);
                    AutomationElementCollection controls;
                    using (agyCache.Activate())
                        controls = root.FindAll(TreeScope.Descendants, agyCondition);
                    Rect bounds = Rect.Empty;
                    bool menuOpen = false;
                    foreach (AutomationElement control in controls)
                    {
                        if (control.Cached.ControlType == ControlType.MenuItem)
                        {
                            menuOpen = true;
                        }
                        else if (control.Cached.Name.StartsWith("Select model, current:", StringComparison.OrdinalIgnoreCase))
                        {
                            bounds = control.Cached.BoundingRectangle;
                            menuOpen |= IsExpanded(control, true);
                        }
                    }
                    result = new TrackedControl(agyHost, bounds, menuOpen, controls.Count > 0);
                }
                catch { }
                antigravityControl = result;
            }
            else if (agyHost == IntPtr.Zero)
            {
                antigravityControl = null;
            }

            // 2. Codex bottom-left quota circle tracking (with fast single-element cache!)
            IntPtr cxHost = Interlocked.CompareExchange(ref codexWindow, IntPtr.Zero, IntPtr.Zero);
            if (cxHost != IntPtr.Zero && fg == cxHost)
            {
                RECT winRect;
                bool gotWinRect = TryGetCleanRect(cxHost, out winRect);
                long nowTick = Environment.TickCount;
                bool winSizeChanged =
                    !gotWinRect ||
                    cachedCodexHwnd != cxHost ||
                    Math.Abs((winRect.Right - winRect.Left) - (cachedCodexWinRect.Right - cachedCodexWinRect.Left)) > 4 ||
                    Math.Abs((winRect.Bottom - winRect.Top) - (cachedCodexWinRect.Bottom - cachedCodexWinRect.Top)) > 4;

                bool usedFastCache = false;
                if (cachedCodexEl != null && !winSizeChanged && unchecked(nowTick - lastCodexFullScanTick) < 2500)
                {
                    try
                    {
                        bool offscreen = cachedCodexEl.Current.IsOffscreen;
                        Rect b = cachedCodexEl.Current.BoundingRectangle;
                        if (!offscreen && !b.IsEmpty && b.Width >= 14 && b.Height >= 14 && b.Width <= 260 &&
                            (!gotWinRect || (b.Left >= winRect.Left - 8 && b.Bottom <= winRect.Bottom + 8)))
                        {
                            bool expanded = IsExpanded(cachedCodexEl, false);
                            codexControl = new TrackedControl(cxHost, b, expanded, true);
                            usedFastCache = true;
                        }
                        else
                        {
                            cachedCodexEl = null;
                        }
                    }
                    catch
                    {
                        cachedCodexEl = null;
                    }
                }

                if (!usedFastCache && gotWinRect)
                {
                    lastCodexFullScanTick = nowTick;
                    cachedCodexHwnd = cxHost;
                    cachedCodexWinRect = winRect;
                    try
                    {
                        var root = AutomationElement.FromHandle(cxHost);
                        AutomationElementCollection buttons;
                        using (codexScanCache.Activate())
                            buttons = root.FindAll(TreeScope.Descendants, codexButtonCondition);

                        bool uiaReady = buttons.Count >= 3;
                        int winW = Math.Max(1, winRect.Right - winRect.Left);
                        int leftLimit = winRect.Left + Math.Min(320, Math.Max(140, winW / 3));
                        int bottomZoneTop = winRect.Bottom - 220;

                        CodexCandidate bestKeyword = null;
                        List<CodexCandidate> leftRailIcons = new List<CodexCandidate>();

                        foreach (AutomationElement btn in buttons)
                        {
                            Rect b;
                            try { b = btn.Cached.BoundingRectangle; }
                            catch { continue; }
                            if (b.IsEmpty || b.Width < 14 || b.Height < 14) continue;
                            if (b.Bottom < bottomZoneTop || b.Top > winRect.Bottom + 4) continue;
                            if (b.Left < winRect.Left - 8 || b.Left > leftLimit) continue;

                            string name = btn.Cached.Name ?? "";
                            string help = btn.Cached.HelpText ?? "";
                            string autoId = btn.Cached.AutomationId ?? "";
                            bool kw = MatchesCodexQuotaKeyword(name) || MatchesCodexQuotaKeyword(help) || MatchesCodexQuotaKeyword(autoId);

                            if (kw && b.Width <= 240 && b.Height <= 72)
                            {
                                // Prefer compact bottom-left match
                                if (bestKeyword == null || b.Left < bestKeyword.Bounds.Left ||
                                    (Math.Abs(b.Left - bestKeyword.Bounds.Left) <= 20 && b.Bottom > bestKeyword.Bounds.Bottom))
                                {
                                    bestKeyword = new CodexCandidate
                                    {
                                        Element = btn,
                                        Bounds = b,
                                        KeywordHit = true,
                                        Expanded = IsExpanded(btn, true)
                                    };
                                }
                            }
                            else if (b.Left <= winRect.Left + 110 && b.Width >= 18 && b.Width <= 58 && b.Height >= 18 && b.Height <= 58 &&
                                     Math.Abs(b.Width - b.Height) <= 18 && b.Top >= winRect.Bottom - 165)
                            {
                                leftRailIcons.Add(new CodexCandidate
                                {
                                    Element = btn,
                                    Bounds = b,
                                    KeywordHit = false,
                                    Expanded = IsExpanded(btn, true)
                                });
                            }
                        }

                        CodexCandidate chosen = bestKeyword;
                        if (chosen == null && leftRailIcons.Count >= 2)
                        {
                            // In Codex's far-left rail, the circular quota icon sits directly above the bottom-most avatar circle
                            leftRailIcons.Sort((a, b) => a.Bounds.Top.CompareTo(b.Bounds.Top));
                            CodexCandidate bottomMost = leftRailIcons[leftRailIcons.Count - 1];
                            double bottomCx = bottomMost.Bounds.Left + bottomMost.Bounds.Width * 0.5;
                            for (int i = leftRailIcons.Count - 2; i >= 0; i--)
                            {
                                CodexCandidate cand = leftRailIcons[i];
                                double candCx = cand.Bounds.Left + cand.Bounds.Width * 0.5;
                                double gapY = bottomMost.Bounds.Top - cand.Bounds.Bottom;
                                if (Math.Abs(candCx - bottomCx) <= 18 && gapY >= -4 && gapY <= 48)
                                {
                                    chosen = cand;
                                    break;
                                }
                            }
                        }

                        if (chosen != null)
                        {
                            cachedCodexEl = chosen.Element;
                            codexControl = new TrackedControl(cxHost, chosen.Bounds, chosen.Expanded, uiaReady);
                        }
                        else
                        {
                            cachedCodexEl = null;
                            codexControl = new TrackedControl(cxHost, Rect.Empty, false, uiaReady);
                        }
                    }
                    catch
                    {
                        cachedCodexEl = null;
                        codexControl = null;
                    }
                }
            }
            else if (cxHost == IntPtr.Zero)
            {
                cachedCodexEl = null;
                codexControl = null;
            }

            Thread.Sleep(320);
        }
    }

    private static string ClassifyAgent(string procName, string title)
    {
        string p = (procName ?? "").ToLowerInvariant();
        string t = (title ?? "").ToLowerInvariant();

        if (p == "stockingquota" || (p == "electron" && t.Contains("stockingquota")))
            return "self";

        if (p == "codex" || p.StartsWith("codex-") || p == "chatgpt" ||
            (p == "applicationframehost" && (t.Contains("codex") || t.Contains("chatgpt"))))
            return "codex";

        if (p == "antigravity" || p.Contains("antigravity"))
            return "antigravity";

        if (p.Contains("deepseek") || p == "dsh" || t.Contains("deepseek harness"))
            return "dsh";

        return "";
    }

    private static bool TryGetCleanRect(IntPtr hWnd, out RECT r)
    {
        try
        {
            if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                if (r.Right > r.Left && r.Bottom > r.Top) return true;
            }
        }
        catch { }
        return GetWindowRect(hWnd, out r) && r.Right > r.Left && r.Bottom > r.Top;
    }

    private static string DetectRunningAgents()
    {
        bool codex = false, agy = false, dsh = false;
        try
        {
            Process[] procs = Process.GetProcesses();
            foreach (Process pr in procs)
            {
                try
                {
                    string n = pr.ProcessName.ToLowerInvariant();
                    if (!codex && (n == "codex" || n == "chatgpt")) codex = true;
                    else if (!agy && n == "antigravity") agy = true;
                    else if (!dsh && (n.Contains("deepseek") || n == "dsh")) dsh = true;
                }
                catch { }
                finally
                {
                    pr.Dispose();
                }
            }
        }
        catch { }

        List<string> list = new List<string>(3);
        if (codex) list.Add("\"codex\"");
        if (agy) list.Add("\"antigravity\"");
        if (dsh) list.Add("\"dsh\"");
        return "[" + string.Join(",", list.ToArray()) + "]";
    }

    private static string FormatRect(Rect b)
    {
        if (b.IsEmpty || b.Width <= 0 || b.Height <= 0) return "null";
        return string.Format("{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}",
            (int)Math.Round(b.X), (int)Math.Round(b.Y), (int)Math.Round(b.Width), (int)Math.Round(b.Height));
    }

    private static void Main()
    {
        try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }

        Thread stdinWatch = new Thread(() =>
        {
            try
            {
                while (Console.In.ReadLine() != null) { }
            }
            catch { }
            Environment.Exit(0);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        new Thread(TrackMouse) { IsBackground = true }.Start();
        new Thread(TrackHostButtons) { IsBackground = true }.Start();
        new Thread(() =>
        {
            foreach (MousePressEvent ev in MousePresses.GetConsumingEnumerable())
            {
                if (ev.Agent == "antigravity")
                {
                    WritePayload(string.Format("{{\"modelMouseDown\":{{\"x\":{0},\"y\":{1}}}}}", ev.Point.X, ev.Point.Y));
                }
                else if (ev.Agent == "codex")
                {
                    WritePayload(string.Format("{{\"codexMouseDown\":{{\"x\":{0},\"y\":{1}}}}}", ev.Point.X, ev.Point.Y));
                }
            }
        }) { IsBackground = true }.Start();

        string lastPayload = "";
        string cachedRunning = "[]";
        long lastProcScanTick = 0;
        StringBuilder titleBuf = new StringBuilder(256);

        while (true)
        {
            long now = Environment.TickCount;
            if (lastProcScanTick == 0 || unchecked(now - lastProcScanTick) >= 1500)
            {
                cachedRunning = DetectRunningAgents();
                lastProcScanTick = now;
            }

            string fgAgent = "";
            string fgProc = "";
            bool hasRect = false;
            RECT r = new RECT();
            IntPtr hwnd = IntPtr.Zero;

            try
            {
                hwnd = GetForegroundWindow();
                if (hwnd != IntPtr.Zero && !IsIconic(hwnd))
                {
                    uint pid = 0;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (pid > 0)
                    {
                        using (Process p = Process.GetProcessById((int)pid))
                        {
                            fgProc = p.ProcessName ?? "";
                        }
                    }
                    titleBuf.Length = 0;
                    GetWindowText(hwnd, titleBuf, titleBuf.Capacity);
                    string title = titleBuf.ToString();
                    fgAgent = ClassifyAgent(fgProc, title);
                    if (fgAgent == "codex" || fgAgent == "antigravity" || fgAgent == "dsh")
                    {
                        hasRect = TryGetCleanRect(hwnd, out r);
                    }
                }
            }
            catch { }

            if (fgAgent != "self")
            {
                Interlocked.Exchange(ref antigravityWindow, fgAgent == "antigravity" && hasRect ? hwnd : IntPtr.Zero);
                Interlocked.Exchange(ref codexWindow, fgAgent == "codex" && hasRect ? hwnd : IntPtr.Zero);
            }

            string rectJson = hasRect
                ? string.Format("{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top)
                : "null";

            TrackedControl agyBtn = antigravityControl;
            bool curAgy = fgAgent == "antigravity" && agyBtn != null && agyBtn.Window == hwnd;
            string agyButtonJson = curAgy ? FormatRect(agyBtn.Bounds) : "null";

            TrackedControl cxBtn = codexControl;
            bool curCx = fgAgent == "codex" && cxBtn != null && cxBtn.Window == hwnd;
            string cxButtonJson = curCx ? FormatRect(cxBtn.Bounds) : "null";

            string payload = string.Format(
                "{{\"fgAgent\":\"{0}\",\"rect\":{1},\"running\":{2},\"modelButton\":{3},\"modelMenuOpen\":{4},\"codexButton\":{5},\"codexUiaReady\":{6},\"codexMenuOpen\":{7}}}",
                fgAgent,
                rectJson,
                cachedRunning,
                agyButtonJson,
                curAgy && agyBtn.MenuOpen ? "true" : "false",
                cxButtonJson,
                curCx && cxBtn.UiaReady ? "true" : "false",
                curCx && cxBtn.MenuOpen ? "true" : "false"
            );

            if (payload != lastPayload)
            {
                lastPayload = payload;
                WritePayload(payload);
            }

            Thread.Sleep(100);
        }
    }
}
