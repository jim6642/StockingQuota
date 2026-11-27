using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// StockingQuota Ultra-Lightweight Companion Sentinel (~3MB RAM, 0% GPU, <0.05% CPU, WinExe no console).
/// Watches for OpenAI Codex, Google Antigravity, or DeepSeek Harness via lightweight Win32 Toolhelp32 snapshot.
/// - When any supported Agent starts and StockingQuota.exe is not running, launches StockingQuota silently
///   (`--silent --from-agent=<agent> --sentinel-managed`).
/// - Does NOT run Electron until an Agent is actually open; when all Agents close, StockingQuota exits cleanly
///   and only this tiny ~3MB sentinel remains waiting.
/// - Exits immediately when StockingQuota signals the `Local\StockingQuotaSentinelStop` event (user clicked Quit).
/// </summary>
internal static class Program
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const int MAX_PATH = 260;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MAX_PATH)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private struct ScanResult
    {
        public bool StockingRunning;
        public string ActiveAgent;
    }

    private static ScanResult ScanProcesses()
    {
        ScanResult res = new ScanResult { StockingRunning = false, ActiveAgent = null };
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return res;

        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref entry))
            {
                do
                {
                    string exe = (entry.szExeFile ?? "").ToLowerInvariant();
                    if (exe == "stockingquota.exe")
                    {
                        res.StockingRunning = true;
                    }
                    else if (res.ActiveAgent == null)
                    {
                        if (exe == "codex.exe" || exe == "chatgpt.exe")
                        {
                            res.ActiveAgent = "codex";
                        }
                        else if (exe == "antigravity.exe")
                        {
                            res.ActiveAgent = "antigravity";
                        }
                        else if (exe.Contains("deepseek") || exe == "dsh.exe")
                        {
                            res.ActiveAgent = "dsh";
                        }
                    }
                }
                while (Process32NextW(snap, ref entry));
            }
        }
        finally
        {
            CloseHandle(snap);
        }
        return res;
    }

    private static string ResolveTargetExe(string[] args)
    {
        if (args != null && args.Length > 0 && !string.IsNullOrEmpty(args[0]) && File.Exists(args[0]))
        {
            return Path.GetFullPath(args[0]);
        }

        string selfDir = AppDomain.CurrentDomain.BaseDirectory;
        string[] candidates = new[]
        {
            Path.Combine(selfDir, "..", "..", "..", "..", "StockingQuota.exe"),
            Path.Combine(selfDir, "..", "..", "release", "win-unpacked", "StockingQuota.exe"),
            Path.Combine(selfDir, "StockingQuota.exe"),
        };
        foreach (string c in candidates)
        {
            try
            {
                string full = Path.GetFullPath(c);
                if (File.Exists(full)) return full;
            }
            catch { }
        }
        return null;
    }

    [STAThread]
    private static void Main(string[] args)
    {
        bool createdNew;
        using (Mutex singleInstance = new Mutex(true, @"Local\StockingQuotaSentinelV1", out createdNew))
        {
            if (!createdNew) return;

            string targetExe = ResolveTargetExe(args);
            if (string.IsNullOrEmpty(targetExe)) return;

            using (EventWaitHandle stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\StockingQuotaSentinelStop"))
            {
                // Reset any stale stop signal from a previous session
                stopEvent.Reset();

                long lastLaunchTick = 0;

                while (true)
                {
                    if (stopEvent.WaitOne(0)) break;

                    ScanResult scan = ScanProcesses();
                    if (!scan.StockingRunning && scan.ActiveAgent != null)
                    {
                        long now = Environment.TickCount;
                        // Avoid rapid relaunch loops (at least 10 seconds cooldown between launches)
                        if (lastLaunchTick == 0 || unchecked(now - lastLaunchTick) >= 10000)
                        {
                            lastLaunchTick = now;
                            try
                            {
                                ProcessStartInfo psi = new ProcessStartInfo
                                {
                                    FileName = targetExe,
                                    Arguments = "--silent --sentinel-managed --from-agent=" + scan.ActiveAgent,
                                    UseShellExecute = false,
                                    CreateNoWindow = true,
                                    WindowStyle = ProcessWindowStyle.Hidden,
                                    WorkingDirectory = Path.GetDirectoryName(targetExe) ?? ""
                                };
                                Process.Start(psi);
                            }
                            catch { }
                        }
                    }

                    // Sleep 2.5s while remaining instantly interruptible by stopEvent
                    if (stopEvent.WaitOne(2500)) break;
                }
            }
        }
    }
}
