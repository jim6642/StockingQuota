using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// <summary>
/// StockingQuota Headless ConPTY CLI Runner (WinExe, zero dependencies, ~8KB).
///
/// WHY THIS EXISTS ON WINDOWS 10/11:
/// Even when Node.js passes `windowsHide: true` (CREATE_NO_WINDOW) to `agy.exe` or `codexbar-cli.exe`,
/// any console GRANDCHILD process spawned by those CLIs (e.g. language_server, cmd, git) inherits NO console,
/// causing Windows 11 / Windows Terminal to allocate a visible black console window on the desktop!
///
/// HOW THIS FIXES IT 100%:
/// 1. Creates a headless in-memory ConPTY (`CreatePseudoConsole`, Win10 1809+ / Win11) — literally NO window exists.
/// 2. Launches the target CLI with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` + explicit `hStdOutput`/`hStdError` pipes,
///    so ALL child & grandchild processes inherit the invisible headless ConPTY (ZERO black box flashes EVER!),
///    while `stdout` / `stderr` stream pure raw uncorrupted bytes directly back to Electron.
/// 3. Assigns the child to a Win32 Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) so timeouts never leak orphans.
///
/// Usage: sq-silent-exec.exe <exePath> [args...]
/// </summary>
internal static class Program
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEXW
    {
        public STARTUPINFOW StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

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
        ref STARTUPINFOEXW lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    private static string QuoteArg(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        bool needsQuotes = false;
        for (int i = 0; i < arg.Length; i++)
        {
            if (arg[i] == ' ' || arg[i] == '\t' || arg[i] == '"') { needsQuotes = true; break; }
        }
        if (!needsQuotes) return arg;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '\\')
            {
                backslashes++;
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
                sb.Append(c);
            }
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        if (args == null || args.Length == 0) return 2;
        string targetExe = args[0];
        StringBuilder cmd = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) cmd.Append(' ');
            cmd.Append(QuoteArg(args[i]));
        }

        // Create Job Object so any grandchild processes terminate immediately if this runner exits
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jinfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            jinfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref jinfo, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        }

        // Create dummy pipes for headless ConPTY (drained in background so PTY output never deadlocks)
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = false };
        IntPtr ptyInRead = IntPtr.Zero, ptyInWrite = IntPtr.Zero;
        IntPtr ptyOutRead = IntPtr.Zero, ptyOutWrite = IntPtr.Zero;
        IntPtr hPC = IntPtr.Zero;
        IntPtr attrList = IntPtr.Zero;

        bool useConPty = false;
        try
        {
            if (CreatePipe(out ptyInRead, out ptyInWrite, ref sa, 0) &&
                CreatePipe(out ptyOutRead, out ptyOutWrite, ref sa, 0))
            {
                COORD size = new COORD { X = 120, Y = 30 };
                if (CreatePseudoConsole(size, ptyInRead, ptyOutWrite, 0, out hPC) == 0 && hPC != IntPtr.Zero)
                {
                    IntPtr lpSize = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);
                    attrList = Marshal.AllocHGlobal(lpSize);
                    if (InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize) &&
                        UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    {
                        useConPty = true;
                        // Drain ConPTY output stream in background so child/grandchild writes never block
                        IntPtr drainHandle = ptyOutRead;
                        Thread drainer = new Thread(() =>
                        {
                            byte[] buf = new byte[4096];
                            uint read;
                            while (ReadFile(drainHandle, buf, (uint)buf.Length, out read, IntPtr.Zero) && read > 0) { }
                        });
                        drainer.IsBackground = true;
                        drainer.Start();
                    }
                }
            }
        }
        catch
        {
            useConPty = false;
        }

        // Ensure inherited standard handles (Node's stdout/stderr pipes) are explicitly inheritable
        IntPtr hIn = GetStdHandle(STD_INPUT_HANDLE);
        IntPtr hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        IntPtr hErr = GetStdHandle(STD_ERROR_HANDLE);
        if (hIn != IntPtr.Zero && hIn != new IntPtr(-1)) SetHandleInformation(hIn, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        if (hOut != IntPtr.Zero && hOut != new IntPtr(-1)) SetHandleInformation(hOut, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        if (hErr != IntPtr.Zero && hErr != new IntPtr(-1)) SetHandleInformation(hErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        STARTUPINFOEXW siEx = new STARTUPINFOEXW();
        siEx.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEXW));
        siEx.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        siEx.StartupInfo.wShowWindow = SW_HIDE;
        siEx.StartupInfo.hStdInput = hIn;
        siEx.StartupInfo.hStdOutput = hOut;
        siEx.StartupInfo.hStdError = hErr;
        if (useConPty)
        {
            siEx.lpAttributeList = attrList;
        }

        uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | (useConPty ? 0u : CREATE_NO_WINDOW);
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(
            targetExe,
            cmd.ToString(),
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            creationFlags,
            IntPtr.Zero,
            Environment.CurrentDirectory,
            ref siEx,
            out pi);

        uint exitCode = 1;
        if (ok)
        {
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
            WaitForSingleObject(pi.hProcess, INFINITE);
            GetExitCodeProcess(pi.hProcess, out exitCode);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }

        if (attrList != IntPtr.Zero)
        {
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
        }
        if (hPC != IntPtr.Zero) ClosePseudoConsole(hPC);
        if (ptyInRead != IntPtr.Zero) CloseHandle(ptyInRead);
        if (ptyInWrite != IntPtr.Zero) CloseHandle(ptyInWrite);
        if (ptyOutRead != IntPtr.Zero) CloseHandle(ptyOutRead);
        if (ptyOutWrite != IntPtr.Zero) CloseHandle(ptyOutWrite);
        if (job != IntPtr.Zero) CloseHandle(job);

        return (int)exitCode;
    }
}
