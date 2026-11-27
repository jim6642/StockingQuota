Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCheck {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_LAYERED = 0x00080000;
}
"@

$found = $null
$callback = [WinCheck+EnumWindowsProc]{
    param($hWnd, $lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [void][WinCheck]::GetWindowText($hWnd, $sb, 256)
    $title = $sb.ToString()
    if ($title -eq "StockingQuota Desktop Widget") {
        $script:found = $hWnd
        return $false
    }
    return $true
}
[void][WinCheck]::EnumWindows($callback, [IntPtr]::Zero)

if ($null -eq $found) {
    Write-Output "NOT_FOUND: StockingQuota Desktop Widget window not open yet."
    exit 1
}

$rect = New-Object WinCheck+RECT
[void][WinCheck]::GetWindowRect($found, [ref]$rect)
$ex = [WinCheck]::GetWindowLong($found, [WinCheck]::GWL_EXSTYLE)
$visible = [WinCheck]::IsWindowVisible($found)
$topmost = ($ex -band [WinCheck]::WS_EX_TOPMOST) -ne 0
$transparent = ($ex -band [WinCheck]::WS_EX_TRANSPARENT) -ne 0
$layered = ($ex -band [WinCheck]::WS_EX_LAYERED) -ne 0
$toolwin = ($ex -band [WinCheck]::WS_EX_TOOLWINDOW) -ne 0

Write-Output "FOUND_HWND=$found Visible=$visible"
Write-Output "RECT=($($rect.Left),$($rect.Top)) -> ($($rect.Right),$($rect.Bottom)) Size=$($rect.Right-$rect.Left)x$($rect.Bottom-$rect.Top)"
Write-Output "WS_EX_TOPMOST=$topmost WS_EX_TRANSPARENT(clickThrough)=$transparent WS_EX_LAYERED=$layered WS_EX_TOOLWINDOW=$toolwin ExStyle=0x$($ex.ToString('X8'))"

# Test local external quota bridge (127.0.0.1:17821)
try {
    $q = Invoke-RestMethod -Uri "http://127.0.0.1:17821/quota" -Method Get -TimeoutSec 2
    Write-Output "QUOTA_GET_OK: left=$($q.leftQuota) right=$($q.rightQuota) source=$($q.source)"
} catch {
    Write-Output "QUOTA_GET_ERR: $_"
}

# Capture real Windows desktop crop around the floating transparent widget!
$pad = 36
$sx = [Math]::Max(0, $rect.Left - $pad)
$sy = [Math]::Max(0, $rect.Top - $pad)
$sw = [Math]::Min(1200, ($rect.Right - $rect.Left) + $pad * 2)
$sh = [Math]::Min(1200, ($rect.Bottom - $rect.Top) + $pad * 2)

$bmp = New-Object System.Drawing.Bitmap($sw, $sh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
$outPath = "C:\Users\Fan Haorong\.gemini\antigravity\scratch\StockingQuota\raw_assets\windows_desktop_live_verify.png"
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "SAVED_DESKTOP_SHOT=$outPath"
