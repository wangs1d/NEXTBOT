# avatar-talk-service 一键启动脚本（Ditto 实时数字人）
# 用法：powershell -ExecutionPolicy Bypass -File start_all.ps1
# 服务地址：默认 http://127.0.0.1:8765/；-Lan 供手机同 Wi-Fi 联调。

param(
  [switch] $Lan,
  [int] $Port = 8765
)

$env:PYTHONUNBUFFERED = "1"

$py = "D:\Ditto\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "找不到 Ditto 环境: $py" -ForegroundColor Red
  Write-Host "请先按 README 搭建 D:\Ditto\venv（torch cu130 + librosa + onnxruntime-gpu + mediapipe 等）"
  exit 1
}

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
  # 服务无鉴权，只监听探测到的可信局域网网卡，不暴露到其它接口。
  $bindHost = $ip
  $displayHost = $ip
}

Write-Host "启动 Ditto 实时数字人服务（首次加载模型并捕获 CUDA Graph，约 10-20 秒）..."
$svc = Start-Process -PassThru -FilePath $py `
  -ArgumentList "-m uvicorn main:app --host $bindHost --port $Port" `
  -WorkingDirectory "E:\ws-project\NextBot\avatar-talk-service" -WindowStyle Minimized

Start-Sleep -Seconds 6
Write-Host ""
Write-Host "打开页面: http://${displayHost}:$Port/  (PID $($svc.Id))"
Write-Host "健康检查: http://${displayHost}:$Port/api/health"
Write-Host "停止服务: Stop-Process -Id $($svc.Id)"
