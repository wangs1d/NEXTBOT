Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiChk {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
[DpiChk]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[DpiChk]::SetCursorPos(955, 516) | Out-Null
Start-Sleep -Milliseconds 200
$p = New-Object DpiChk+POINT
[DpiChk]::GetCursorPos([ref]$p) | Out-Null
Write-Host ("cursor now at {0},{1}" -f $p.X, $p.Y)
Add-Type -AssemblyName System.Windows.Forms
Write-Host ("bounds: {0}x{1}" -f [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)
