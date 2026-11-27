using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// StockingQuota Ultra-Lightweight Companion Sentinel (WinExe, zero console, trimmed working set).
/// Uses pure Win32 Toolhelp32 snapshot + CreateProcessW (avoids loading System.Diagnostics.Process metadata)
/// and trims one-time startup pages via SetProcessWorkingSetSize(-1, -1).
/// </summary>
internal static class Program
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint DETACHED_PROCESS = 0x00000008;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr dwMinimumWorkingSetSize, IntPtr dwMaximumWorkingSetSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOW lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

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
                    string exe = entry.szExeFile;
                    if (string.IsNullOrEmpty(exe)) continue;
                    if (string.Equals(exe, "StockingQuota.exe", StringComparison.OrdinalIgnoreCase))
                    {
                        res.StockingRunning = true;
                    }
                    else if (res.ActiveAgent == null)
                    {
                        if (string.Equals(exe, "codex.exe", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(exe, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            res.ActiveAgent = "codex";
                        }
                        else if (string.Equals(exe, "Antigravity.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            res.ActiveAgent = "antigravity";
                        }
                        else if (exe.IndexOf("deepseek", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 string.Equals(exe, "dsh.exe", StringComparison.OrdinalIgnoreCase))
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

    private static void LaunchSilent(string exePath, string workDir, string agentName)
    {
        STARTUPINFOW si = new STARTUPINFOW();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi;
        string cmd = "\"" + exePath + "\" --silent --sentinel-managed --from-agent=" + agentName;
        if (CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW | DETACHED_PROCESS, IntPtr.Zero, workDir, ref si, out pi))
        {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
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

    private static void TrimMemory()
    {
        try
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, true);
            GC.WaitForPendingFinalizers();
            SetProcessWorkingSetSize(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1));
        }
        catch { }
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
            string workDir = Path.GetDirectoryName(targetExe) ?? "";

            using (EventWaitHandle stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\StockingQuotaSentinelStop"))
            {
                stopEvent.Reset();
                long lastLaunchTick = 0;
                int loopsSinceTrim = 0;

                // Prime once then aggressively trim startup pages from WorkingSet!
                ScanProcesses();
                TrimMemory();

                while (true)
                {
                    if (stopEvent.WaitOne(0)) break;

                    ScanResult scan = ScanProcesses();
                    if (!scan.StockingRunning && scan.ActiveAgent != null)
                    {
                        long now = Environment.TickCount;
                        if (lastLaunchTick == 0 || unchecked(now - lastLaunchTick) >= 10000)
                        {
                            lastLaunchTick = now;
                            LaunchSilent(targetExe, workDir, scan.ActiveAgent);
                        }
                    }

                    if (++loopsSinceTrim >= 24)
                    {
                        loopsSinceTrim = 0;
                        TrimMemory();
                    }

                    if (stopEvent.WaitOne(2500)) break;
                }
            }
        }
    }
}
