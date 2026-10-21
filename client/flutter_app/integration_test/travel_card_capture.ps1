# Chat travel-card visual capture: find the Flutter main window of the
# NEXTBOT.exe process and copy it from screen to a PNG.
#   powershell -File integration_test/travel_card_capture.ps1 -OutPng <path>
param([string] $OutPng = 'C:\Users\Administrator\AppData\Local\Temp\pai_travel_card.png')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PaiTravelCap {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiTravelCap]::SetProcessDPIAware() | Out-Null

$procIds = (Get-Process -Name 'NEXTBOT' -ErrorAction Stop | Select-Object -ExpandProperty Id)
$found = [IntPtr]::Zero
$cb = {
  param($h, $lp)
  $pid2 = 0
  [PaiTravelCap]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($procIds -contains [int]$pid2 -and [PaiTravelCap]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PaiTravelCap]::GetClassNameW($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like 'FLUTTER_*') {
      # prefer the MAIN chat window: skip the travel plan panel (title=行程规划)
      $tb = New-Object System.Text.StringBuilder 256
      [PaiTravelCap]::GetWindowTextW($h, $tb, 256) | Out-Null
      if ($tb.ToString() -ne '行程规划') {
        $script:found = $h
        return $false
      }
      if ($script:found -eq [IntPtr]::Zero) { $script:fallback = $h }
    }
  }
  return $true
}
[PaiTravelCap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { $found = $script:fallback }
if ($found -eq [IntPtr]::Zero) { throw 'flutter main window not found' }

$r = New-Object PaiTravelCap+RECT
[PaiTravelCap]::GetWindowRect($found, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { throw 'bad window rect' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2): capture DirectX/Flutter window content even when occluded
$ok = [PaiTravelCap]::PrintWindow($found, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { $bmp.Dispose(); throw 'PrintWindow failed' }
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "captured ${w}x${h} -> $OutPng"
