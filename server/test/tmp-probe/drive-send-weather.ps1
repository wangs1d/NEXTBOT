param([string]$TextB64 = "")
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Drive2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindMain(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target && IsWindowVisible(h)) {
        StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256);
        if (sb.ToString() == "FLUTTER_RUNNER_WIN32_WINDOW") { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$proc = Get-Process private_ai_agent -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "no app"; exit 1 }
$hwnd = [Drive2]::FindMain([uint32]$proc.Id)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "no main window"; exit 1 }
$r = New-Object Drive2+RECT
[void][Drive2]::GetWindowRect($hwnd, [ref]$r)
Write-Output ("window rect: L=" + $r.Left + " T=" + $r.Top + " W=" + ($r.Right-$r.Left) + " H=" + ($r.Bottom-$r.Top))

[void][Drive2]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800

$cx = $r.Left + 573
$cy = $r.Top + 816
[void][Drive2]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 200
[Drive2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[Drive2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600

$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
[System.Windows.Forms.SendKeys]::SendWait($text)
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output "sent ok"
