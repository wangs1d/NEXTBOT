# 守护启动：uvicorn 退出后自动重启（这台机器的 GPU 驱动偶发会无堆栈直接退出进程）
param(
  [switch] $Lan,
  [int] $Port = 8765
)

$ErrorActionPreference = "Continue"
$py = "D:\Ditto\venv\Scripts\python.exe"
Set-Location -Path $PSScriptRoot
$bindHost = "127.0.0.1"
$displayHost = "127.0.0.1"
if ($Lan) {
  $ip = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } | Sort-Object {
      if ($_.IPAddress -like "192.168.*") { 0 }
      elseif ($_.IPAddress -like "10.*") { 1 }
      else { 2 }
    })[0].IPAddress
  if (-not $ip) { throw "未能探测到局域网 IPv4" }
  $bindHost = "0.0.0.0"
  $displayHost = $ip
}

while ($true) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[watchdog $ts] starting uvicorn on ${displayHost}:$Port ..."
    & $py -m uvicorn main:app --host $bindHost --port $Port
    $code = $LASTEXITCODE
    Write-Host "[watchdog] uvicorn exited (code=$code), restarting in 3s"
    Start-Sleep -Seconds 3
}
