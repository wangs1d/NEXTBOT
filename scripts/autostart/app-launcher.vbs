' Desktop app autostart shell: HKCU Run key "Nextbot" -> this file -> app-launcher.mjs.
' wscript window style 0 keeps the waiter fully hidden until NEXTBOT.exe is launched.
' Keep this file pure ASCII: wscript decodes .vbs as ANSI/GBK and UTF-8 Chinese comments
' can swallow the newline and break parsing (same iron rule as launch-desktop-app.vbs).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\ws-project\NextBot"
sh.Run """D:\nodejs\node.exe"" ""E:\ws-project\NextBot\scripts\autostart\app-launcher.mjs""", 0, False
