param([uint32]$TargetPid = 0)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WRest2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static string Restore(uint pid) {
    string result = "not-found";
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetClassName(h, sb, 256);
        if (sb.ToString() == "FLUTTER_RUNNER_WIN32_WINDOW") {
          ShowWindow(h, 9);
          System.Threading.Thread.Sleep(400);
          SetForegroundWindow(h);
          result = "restored";
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
Write-Output ([WRest2]::Restore($TargetPid))
