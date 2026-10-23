# Capture the dynamic island (layered window) by rect + PrintWindow fallback.
# FindWindowW must be CharSet=Unicode (memory: bare FindWindow returns 0).
# ASCII only.
$ErrorActionPreference = 'Stop'
$out = 'E:\ws-project\NextBot\build\island-shot.png'

Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;

public class IslandShot {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
Add-Type -TypeDefinition $src

$h = [IslandShot]::FindWindowW('PAI_DynamicIsland_Window', $null)
if ($h -eq [IntPtr]::Zero) { Write-Error 'island window not found' }
$r = New-Object IslandShot+RECT
[void][IslandShot]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hgt = $r.B - $r.T
Write-Host ("island hwnd={0} rect=({1},{2})-({3},{4}) size={5}x{6}" -f $h, $r.L, $r.T, $r.R, $r.B, $w, $hgt)

$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $hgt)))
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved $out"
