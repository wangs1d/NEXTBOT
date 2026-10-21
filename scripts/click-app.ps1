# Click inside the NEXTBOT window by relative coordinates (client area).
# ASCII only. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File click-app.ps1 -X 640 -Y 670
param(
  [int] $X = 0,
  [int] $Y = 0,
  [string] $ProcName = "NEXTBOT"
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClickWin {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { $proc = Get-Process -Name $ProcName | Select-Object -First 1 }
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Error "no main window"; exit 1 }
[ClickWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$rect = New-Object ClickWin+RECT
[ClickWin]::GetClientRect($h, [ref]$rect) | Out-Null
$pt = New-Object ClickWin+POINT
$pt.X = $X; $pt.Y = $Y
[ClickWin]::ClientToScreen($h, [ref]$pt) | Out-Null
[ClickWin]::SetCursorPos($pt.X, $pt.Y) | Out-Null
Start-Sleep -Milliseconds 150
[ClickWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
[ClickWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Write-Host "clicked client($X,$Y) screen($($pt.X),$($pt.Y)) rect $($rect.R)x$($rect.B)"
