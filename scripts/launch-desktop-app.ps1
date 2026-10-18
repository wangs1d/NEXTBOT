# Desktop shortcut logic: ensure backend is online, then start the app (single instance).
# Called hidden by launch-desktop-app.vbs; debug directly with: powershell -File <this file>
# Backend start reuses the existing autostart chain (scheduled task PrivateAgentServer
# -> scripts/autostart/autostart-server.mjs) so the resident instance is never duplicated.
# Keep this file pure ASCII: PowerShell 5.1 decodes BOM-less .ps1 as ANSI/GBK.
$Root     = "D:\ws-project\Private-Agent"
$AppExe   = Join-Path $Root "windows_dist\Release\private_ai_agent.exe"
$TaskName = "PrivateAgentServer"
$Port     = 3000
$WaitMs   = 30000

function Test-BackendPort {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $task = $c.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(500)) { return $false }
        return $c.Connected
    } catch { return $false }
    finally { $c.Close() }
}

function Start-App {
    # Zombie guard: a crashed-but-unreaped process object (0 threads, 0 handles)
    # still matches by name and must not block a fresh launch.
    $live = Get-Process -Name "private_ai_agent" -ErrorAction SilentlyContinue |
        Where-Object { $_.Threads.Count -gt 0 }
    if ($live) { return }
    Start-Process -FilePath $AppExe -WorkingDirectory (Split-Path $AppExe)
}

# Backend already online (autostart chain usually has it) -> just open the app
if (Test-BackendPort) { Start-App; exit 0 }

# Offline -> trigger the autostart chain (port-in-use skip + crash backoff built in), wait for it
schtasks /run /tn $TaskName | Out-Null
$deadline = (Get-Date).AddMilliseconds($WaitMs)
while ((Get-Date) -lt $deadline -and -not (Test-BackendPort)) { Start-Sleep -Milliseconds 500 }

# Fallback: scheduled task missing (autostart uninstalled) -> hide-launch the same starter
if (-not (Test-BackendPort)) {
    Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $Root "scripts\autostart\autostart-launcher.vbs") + '"') -WindowStyle Hidden
    $deadline = (Get-Date).AddMilliseconds($WaitMs)
    while ((Get-Date) -lt $deadline -and -not (Test-BackendPort)) { Start-Sleep -Milliseconds 500 }
}

Start-App
