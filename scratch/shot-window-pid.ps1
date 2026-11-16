# Capture the largest visible top-level window of a given PID via PrintWindow.
# Pure ASCII only. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File shot-window-pid.ps1 -Out C:\path\shot.png -Pid 1234
param(
  [string] $Out,
  [int] $TargetPid
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Found = new List<IntPtr>();
  public static uint TargetPid;
  public static bool Cb(IntPtr h, IntPtr lp) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == TargetPid && IsWindowVisible(h)) Found.Add(h);
    return true;
  }
}
"@

[WinCap]::TargetPid = [uint32]$TargetPid
[WinCap]::EnumWindows([WinCap+EnumWindowsProc]{ param($h, $l) [WinCap]::Cb($h, $l) }, [IntPtr]::Zero) | Out-Null
if ([WinCap]::Found.Count -eq 0) { Write-Error "no visible window for pid $TargetPid"; exit 1 }

$best = [IntPtr]::Zero; $bestArea = 0
foreach ($h in [WinCap]::Found) {
  if ([WinCap]::IsIconic($h)) { [WinCap]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }
  $r = New-Object WinCap+RECT
  [WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = ($r.R - $r.L) * ($r.B - $r.T)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
}
$r2 = New-Object WinCap+RECT
[WinCap]::GetWindowRect($best, [ref]$r2) | Out-Null
$w = $r2.R - $r2.L; $h2 = $r2.B - $r2.T

[WinCap]::SetForegroundWindow($best) | Out-Null
Start-Sleep -Milliseconds 700

$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[WinCap]::PrintWindow($best, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $Out (${w}x${h2})"
