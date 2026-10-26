Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Rows = new List<string>();
  public static bool Cb(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    uint pid; GetWindowThreadProcessId(h, out pid);
    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    RECT r; GetWindowRect(h, out r);
    if (sb.Length > 0 || (r.R - r.L) > 200)
      Rows.Add(string.Format("hwnd=0x{0:X} pid={1} rect=({2},{3},{4},{5}) title={6}", h.ToInt64(), pid, r.L, r.T, r.R, r.B, sb));
    return true;
  }
}
"@
[WinEnum]::EnumWindows([WinEnum+EnumWindowsProc]{ param($h,$l) [WinEnum]::Cb($h,$l) }, [IntPtr]::Zero) | Out-Null
[WinEnum]::Rows | Where-Object { $_ -match 'pid=(7016|22032)\b' } | ForEach-Object { Write-Host $_ }
