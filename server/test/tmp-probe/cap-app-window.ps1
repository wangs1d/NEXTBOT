Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$exeNames = @("private_ai_agent", "PrivateAgent", "nextbot")
$procs = Get-Process | Where-Object { $n = $_.ProcessName.ToLower(); ($exeNames | ForEach-Object { $n -match $_ }) -contains $true }
if (-not $procs) {
  Write-Output "no app process found; listing flutter-ish processes:"
  Get-Process | Where-Object { $_.ProcessName -match "agent|nextbot|flutter|pai" } | Select-Object Id,ProcessName,MainWindowTitle | Format-Table
  exit 1
}
foreach ($p in $procs) { Write-Output ("proc: " + $p.Id + " " + $p.ProcessName + " ws=" + [math]::Round($p.WorkingSet64/1MB) + "MB threads=" + $p.Threads.Count) }

$found = @()
$cb = {
  param($h, $l)
  foreach ($p in $procs) {
    if ($p.Id -eq 0) { continue }
    $pid2 = 0
    [Cap]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pid2 -eq $p.Id -and [Cap]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [Cap]::GetClassName($h, $sb, 256) | Out-Null
      $r = New-Object Cap+RECT
      [Cap]::GetWindowRect($h, [ref]$r) | Out-Null
      $script:found += @{ Hwnd = $h; Class = $sb.ToString(); W = $r.Right - $r.Left; H = $r.Bottom - $r.Top; Pid = $pid2 }
    }
  }
  return $true
}
$gch = [System.Runtime.InteropServices.GCHandle]::Alloc($cb)
$ptr = [System.Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate($cb)
$fp = [System.Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($ptr, [Cap+EnumProc])
# simpler: use delegate directly via cast
$enumDelegate = [Cap+EnumProc]$cb
[Cap]::EnumWindows($enumDelegate, [IntPtr]::Zero) | Out-Null

$i = 0
foreach ($w in $script:found) {
  if ($w.W -lt 200 -or $w.H -lt 200) { continue }
  $bmp = New-Object System.Drawing.Bitmap $w.W, $w.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Cap]::PrintWindow($w.Hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $out = "e:\ws-project\Private-Agent\server\test\tmp-probe\app_win_$i.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("saved $out class=" + $w.Class + " " + $w.W + "x" + $w.H + " pid=" + $w.Pid)
  $i++
}
