# Screenshot the largest visible top-level window of NEXTBOT via PrintWindow.
# Pure ASCII only (GBK swallows newlines in wscript/powershell). Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File shot-app.ps1 -Out C:\path\shot.png
param(
  [string] $Out = "E:\ws-project\NextBot\bubble-e2e-shot.png",
  [string] $ProcName = "NEXTBOT"
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
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

$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if (-not $procs) { Write-Error "process $ProcName not found"; exit 1 }
$pid2 = [uint32]($procs[0].Id)
[WinEnum]::TargetPid = $pid2
[WinEnum]::EnumWindows([WinEnum+EnumWindowsProc]{ param($h, $l) [WinEnum]::Cb($h, $l) }, [IntPtr]::Zero) | Out-Null

if ([WinEnum]::Found.Count -eq 0) { Write-Error "no visible window for pid $pid2"; exit 1 }

# pick largest by area; restore minimized windows first (minimized rect is -32000)
$best = [IntPtr]::Zero; $bestArea = 0
foreach ($h in [WinEnum]::Found) {
  if ([WinEnum]::IsIconic($h)) { [WinEnum]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }
  $r = New-Object WinEnum+RECT
  [WinEnum]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = ($r.R - $r.L) * ($r.B - $r.T)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
}
$r2 = New-Object WinEnum+RECT
[WinEnum]::GetWindowRect($best, [ref]$r2) | Out-Null
$w = $r2.R - $r2.L; $h2 = $r2.B - $r2.T
Write-Host "window ${w}x${h2} (pid $pid2, candidates: $([WinEnum]::Found.Count))"

[WinEnum]::SetForegroundWindow($best) | Out-Null
Start-Sleep -Milliseconds 600

$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2 : capture DirectComposition content (Flutter)
[WinEnum]::PrintWindow($best, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $Out"
