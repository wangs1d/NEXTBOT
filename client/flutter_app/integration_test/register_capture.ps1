# Register preview visual capture: pick the LARGEST visible FLUTTER_* window
# of NEXTBOT (the preview window), skipping small overlays such as
# the dynamic-island capsule that the runner also creates at startup.
#   powershell -File integration_test/register_capture.ps1 -OutPng <path>
param([string] $OutPng = 'C:\Users\Administrator\AppData\Local\Temp\pai_register.png')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PaiRegisterCap {
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
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiRegisterCap]::SetProcessDPIAware() | Out-Null

$procIds = (Get-Process -Name 'NEXTBOT' -ErrorAction Stop | Select-Object -ExpandProperty Id)
$best = [IntPtr]::Zero
$bestArea = 0
$cb = {
  param($h, $lp)
  $pid2 = 0
  [PaiRegisterCap]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($procIds -contains [int]$pid2 -and [PaiRegisterCap]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [PaiRegisterCap]::GetClassNameW($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like 'FLUTTER_*') {
      $r = New-Object PaiRegisterCap+RECT
      [PaiRegisterCap]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt $bestArea) { $script:bestArea = $area; $script:best = $h }
    }
  }
  return $true
}
[PaiRegisterCap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($best -eq [IntPtr]::Zero) { throw 'flutter register preview window not found' }

$r = New-Object PaiRegisterCap+RECT
[PaiRegisterCap]::GetWindowRect($best, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { throw 'bad window rect' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2): capture DirectX/Flutter window content even when occluded
$ok = [PaiRegisterCap]::PrintWindow($best, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { $bmp.Dispose(); throw 'PrintWindow failed' }
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "captured ${w}x${h} -> $OutPng"
