param([int]$Seconds = 20, [string]$OutPrefix = "app")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Cap2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.ArrayList FindByPid(uint target) {
    System.Collections.ArrayList list = new System.Collections.ArrayList();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target && IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256);
        RECT r; GetWindowRect(h, out r);
        list.Add(new object[] { h, sb.ToString(), r.Right - r.Left, r.Bottom - r.Top });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Start-Sleep -Seconds $Seconds
$procs = Get-Process private_ai_agent -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "no process"; exit 1 }
$i = 0
foreach ($p in $procs) {
  $wins = [Cap2]::FindByPid([uint32]$p.Id)
  foreach ($w in $wins) {
    $h = [IntPtr]$w[0]; $cls = [string]$w[1]; $w1 = [int]$w[2]; $h1 = [int]$w[3]
    if ($w1 -lt 300 -or $h1 -lt 300) { continue }
    $bmp = New-Object System.Drawing.Bitmap $w1, $h1
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [void][Cap2]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $out = "e:\ws-project\Private-Agent\server\test\tmp-probe\${OutPrefix}_$i.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "saved $out class=$cls ${w1}x${h1} pid=$($p.Id)"
    $i++
  }
}
