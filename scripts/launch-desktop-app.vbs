' Nextbot desktop shortcut entry: runs launch-desktop-app.ps1 hidden (no console flash).
' Keep this file pure ASCII: wscript decodes .vbs as ANSI/GBK and UTF-8 Chinese comments
' can swallow the newline and break parsing (same iron rule as build .ps1 scripts).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\ws-project\NextBot"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\ws-project\NextBot\scripts\launch-desktop-app.ps1""", 0, False
