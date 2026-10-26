# Drive the NEXTBOT app window using the SAME window pick as shot-app.ps1
# (largest visible top-level window of the process), because MainWindowHandle
# can resolve to a different, much smaller HWND for this app.
# Coordinates are window-relative, in the same space GetWindowRect reports.
# ASCII only. Usage:
#   ... -Action click -X 1317 -Y 615
#   ... -Action drag  -X 400 -Y 20 -DX 200 -DY 120
param(
  [ValidateSet('click', 'drag', 'rect', 'wheel')]
  [string] $Action = 'rect',
  [int] $X = 0,
  [int] $Y = 0,
  [int] $DX = 200,
  [int] $DY = 120,
  [int] $Delta = 0,
  [string] $ProcName = "NEXTBOT",
  [int] $ProcId = 0
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Drive {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
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

if ($ProcId -gt 0) {
  $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
} else {
  $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $proc) { Write-Error "process $ProcName not found"; exit 1 }
[Drive]::TargetPid = [uint32]$proc.Id
[Drive]::EnumWindows([Drive+EnumWindowsProc]{ param($h, $l) [Drive]::Cb($h, $l) }, [IntPtr]::Zero) | Out-Null
if ([Drive]::Found.Count -eq 0) { Write-Error "no visible window for pid $($proc.Id)"; exit 1 }

$h = [IntPtr]::Zero; $bestArea = 0; $bestW = 0; $bestH = 0; $bestL = 0; $bestT = 0
foreach ($w in [Drive]::Found) {
  $r = New-Object Drive+RECT
  [Drive]::GetWindowRect($w, [ref]$r) | Out-Null
  $area = ($r.R - $r.L) * ($r.B - $r.T)
  if ($area -gt $bestArea) {
    $bestArea = $area; $h = $w
    $bestW = $r.R - $r.L; $bestH = $r.B - $r.T; $bestL = $r.L; $bestT = $r.T
  }
}
Write-Host ("target hwnd={0} pid={1} win=({2},{3}) {4}x{5} candidates={6}" -f `
  $h, $proc.Id, $bestL, $bestT, $bestW, $bestH, [Drive]::Found.Count)
if ($Action -eq 'rect') { exit 0 }

[Drive]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$sx = $bestL + $X; $sy = $bestT + $Y
[Drive]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 200

if ($Action -eq 'click') {
  [Drive]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [Drive]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host ("clicked win-relative({0},{1}) screen({2},{3})" -f $X, $Y, $sx, $sy)
  exit 0
}

if ($Action -eq 'wheel') {
  $d = [uint32]((($Delta % 4294967296) + 4294967296) % 4294967296)
  1..3 | ForEach-Object {
    [Drive]::mouse_event(0x0800, 0, 0, $d, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
  }
  Write-Host ("wheeled win-relative({0},{1}) delta={2} x3" -f $X, $Y, $d)
  exit 0
}

$rectBefore = New-Object Drive+RECT
[Drive]::GetWindowRect($h, [ref]$rectBefore) | Out-Null
[Drive]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Milliseconds 25
  [Drive]::SetCursorPos($sx + [int]($DX * $i / 20), $sy + [int]($DY * $i / 20)) | Out-Null
}
Start-Sleep -Milliseconds 200
[Drive]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400

$rectAfter = New-Object Drive+RECT
[Drive]::GetWindowRect($h, [ref]$rectAfter) | Out-Null
$mx = $rectAfter.L - $rectBefore.L
$my = $rectAfter.T - $rectBefore.T
Write-Host ("grab=({0},{1}) before=({2},{3}) after=({4},{5}) moved=({6},{7})" -f `
  $sx, $sy, $rectBefore.L, $rectBefore.T, $rectAfter.L, $rectAfter.T, $mx, $my)
if ($mx -ne 0 -or $my -ne 0) { Write-Host 'DRAG_OK'; exit 0 }
Write-Host 'DRAG_NOOP'; exit 2
