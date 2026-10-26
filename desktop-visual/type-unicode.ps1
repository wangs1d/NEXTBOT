param([string] $Text = "", [int] $ProcId = 22032)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TypeU {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KEYBDINPUT ki; public ulong pad; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static void TypeChar(char c) {
    var down = new INPUT(); down.type = 1;
    down.ki.wScan = c; down.ki.dwFlags = KEYEVENTF_UNICODE;
    var up = new INPUT(); up.type = 1;
    up.ki.wScan = c; up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    var arr = new INPUT[] { down, up };
    SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[TypeU]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
foreach ($ch in $Text.ToCharArray()) {
  [TypeU]::TypeChar($ch)
  Start-Sleep -Milliseconds 12
}
Write-Host "typed: $Text"
