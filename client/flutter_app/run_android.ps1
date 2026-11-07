# NEXTBOT 手机调试运行脚本（flutter run 封装）
# 用法：在 client/flutter_app 目录下执行 .\run_android.ps1 [-Device emulator-5554]
# 效果：带 --dart-define 烤入后端地址后 flutter run（支持热重载）
#
# ⚠ 为什么必须用本脚本：直接 `flutter run` 不带 --dart-define=HTTP_BASE 时，
# ApiConfig.httpBase 回落 127.0.0.1（已禁用），启动即报「客户端打包配置错误」。
# 与 build_apk.ps1 同款逻辑：未显式传 -HttpBase 时自动取本机局域网 IPv4。
param(
  # 后端 HTTP 根地址；留空则自动探测本机局域网 IP（http://<ip>:3000）
  [string] $HttpBase = "",
  # 控制面（账号/OTP/登录页所在）；留空则与 -HttpBase 同值
  [string] $ControlPlaneUrl = "",
  # 内测版 internal / 开源版 oss
  [string] $Edition = "internal",
  [int] $Port = 3000,
  # 目标设备（flutter -d 参数）；留空则让 flutter 自动选择
  [string] $Device = "",
  # 启动前自动拉起模拟器（无在线设备时也会自动拉起）；Pixel_API_37 已删除（图形 HAL 崩溃），统一用 Medium_Phone_API_37.0
  [switch] $Emulator,
  # 模拟器 AVD 名称
  [string] $EmulatorName = "Medium_Phone_API_37.0",
  # 额外透传给 flutter run 的参数（如 --release）
  [string[]] $ExtraArgs = @()
)

$ErrorActionPreference = "Stop"

# 无论从哪个目录调用（如 powershell -File <绝对路径>），都切回脚本所在目录，
# 保证 flutter run 在 Flutter 工程根目录执行。
Set-Location -LiteralPath $PSScriptRoot

# ── 把模拟器窗口强制归位到主屏右侧（模拟器会记住上次关闭位置，换分辨率/显示器后常跑屏幕外）──
function Move-EmulatorWindow {
  param([string] $EmulatorName)
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class EmuWin {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ -ErrorAction SilentlyContinue

  # 轮询找模拟器窗口（标题形如 "Android Emulator - Medium_Phone_API_37.0:5554"），最多等 90s
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 90; $i++) {
    $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$EmulatorName*" } | Select-Object -First 1
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $p.MainWindowHandle; break }
    Start-Sleep -Seconds 1
  }
  if ($hwnd -eq [IntPtr]::Zero) { Write-Host "未找到模拟器窗口，跳过归位" -ForegroundColor DarkYellow; return }

  $screenW = [EmuWin]::GetSystemMetrics(0)   # SM_CXSCREEN
  $screenH = [EmuWin]::GetSystemMetrics(1)   # SM_CYSCREEN
  $rect = New-Object EmuWin+RECT
  [EmuWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = [Math]::Min($rect.Right - $rect.Left, $screenW)   # 保持窗口自身大小，但不超过屏幕
  $h = [Math]::Min($rect.Bottom - $rect.Top, $screenH)
  $x = [Math]::Max(0, $screenW - $w)                     # 右侧贴边，顶部留任务栏空间
  $y = 0
  [EmuWin]::MoveWindow($hwnd, $x, $y, $w, $h, $true) | Out-Null
  Write-Host "模拟器窗口已归位到屏幕右侧 (${x},${y} ${w}x${h})" -ForegroundColor Green
}

# ── 模拟器：需要时自动拉起并等待开机 ──
$adbCandidates = @(
  "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
  "$env:ANDROID_HOME\platform-tools\adb.exe"
)
$Adb = $adbCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Adb) { throw "未找到 adb.exe，请确认 Android SDK 已安装" }

# adb 首次启动会把 "daemon not running; starting now..." 写到 stderr；
# PowerShell 5 在 $ErrorActionPreference = "Stop" 下会把原生命令的 stderr 当成
# NativeCommandError 直接终止脚本。这里临时切回 Continue 并合并 stderr，静默执行。
function Invoke-AdbQuiet {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $AdbArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Adb @AdbArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}
function Invoke-AdbText {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $AdbArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Adb @AdbArgs 2>$null } finally { $ErrorActionPreference = $prev }
}

# ── adb 连接自愈 ──
# Quick Boot 快照恢复后 adbd 常处于半连接状态：设备先显示 device，安装 180MB+ 的
# debug APK 时连接中途断开，表现为 "failed to run abb_exec. Error: closed" /
# "device offline"，flutter 随即 exit=1。重启 adb server 可重建干净连接。
function Reset-AdbConnection {
  Invoke-AdbQuiet kill-server
  Start-Sleep -Milliseconds 500
  Invoke-AdbQuiet start-server
  Start-Sleep -Seconds 2
}

# 确认目标设备真的处于 device 状态；offline/掉线时自动重启一次 adb server 再等。
function Wait-DeviceOnline {
  param([int] $TimeoutSec = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $recovered = $false
  while ((Get-Date) -lt $deadline) {
    $lines = (Invoke-AdbText devices) -match "\sdevice$" | Where-Object { $_ -notmatch "^List" }
    if (-not [string]::IsNullOrWhiteSpace($Device)) {
      $lines = $lines | Where-Object { $_ -match ("^" + [regex]::Escape($Device) + "\s") }
    }
    if ($lines) { return $true }
    if (-not $recovered) {
      Write-Host "adb 设备未在线，重启 adb server ..." -ForegroundColor Yellow
      Reset-AdbConnection
      $recovered = $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

Invoke-AdbQuiet start-server
$devices = (Invoke-AdbText devices) -match "\bdevice\b$" | Where-Object { $_ -notmatch "^List" }
if ($Emulator -or $devices.Count -eq 0) {
  $alreadyBooted = $devices -match "^emulator-"
  if (-not $alreadyBooted) {
    $emuExe = Join-Path (Split-Path $Adb -Parent) "..\emulator\emulator.exe"
    if (-not (Test-Path $emuExe)) { $emuExe = "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" }
    Write-Host "拉起模拟器 $EmulatorName ..." -ForegroundColor Cyan
    Start-Process -FilePath $emuExe -ArgumentList @("-avd", $EmulatorName) | Out-Null
  }
  Write-Host "等待模拟器开机 ..." -ForegroundColor Cyan
  Invoke-AdbQuiet wait-for-device
  Invoke-AdbQuiet shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
  # Quick Boot 快照恢复时 sys.boot_completed 几乎立刻为 1，但 system_server / package
  # manager 仍在重建；此时直接推 180MB+ 的 debug APK 容易把 adbd 拖挂（abb_exec closed /
  # device offline）。再等 package manager 真正可用，并给系统几秒静置。
  Invoke-AdbQuiet shell 'until pm path android >/dev/null 2>&1; do sleep 1; done'
  Start-Sleep -Seconds 3
  Move-EmulatorWindow -EmulatorName $EmulatorName
  Write-Host "模拟器已就绪" -ForegroundColor Green
}

# ── 自动探测本机局域网 IPv4（排除回环/链路本地，优先 192.168.* / 10.*）──
function Get-LanIPv4 {
  $cands = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } | Sort-Object {
      if ($_.IPAddress -like "192.168.*") { 0 }
      elseif ($_.IPAddress -like "10.*") { 1 }
      else { 2 }
    })
  if ($cands.Count -eq 0) { return $null }
  return $cands[0].IPAddress
}

if ([string]::IsNullOrWhiteSpace($HttpBase)) {
  $ip = Get-LanIPv4
  if (-not $ip) { throw "未能探测到局域网 IPv4，请显式传 -HttpBase http://<电脑IP>:3000" }
  $HttpBase = "http://${ip}:$Port"
  Write-Host "自动探测到局域网地址：$HttpBase" -ForegroundColor Cyan
}
if ([string]::IsNullOrWhiteSpace($ControlPlaneUrl)) { $ControlPlaneUrl = $HttpBase }

$dartDefines = @(
  "--suppress-analytics",
  "--dart-define", "HTTP_BASE=$HttpBase",
  "--dart-define", "CONTROL_PLANE_URL=$ControlPlaneUrl",
  "--dart-define", "PAI_EDITION=$Edition"
)

Write-Host "烤入：HTTP_BASE=$HttpBase | CONTROL_PLANE_URL=$ControlPlaneUrl | PAI_EDITION=$Edition" -ForegroundColor Yellow

$runArgs = @("run")
if (-not [string]::IsNullOrWhiteSpace($Device)) { $runArgs += @("-d", $Device) }
$runArgs += $dartDefines + $ExtraArgs

# 启动前确认 adb 连接干净：离线时先重启 adb server 自愈，避免安装阶段掉线。
if (-not (Wait-DeviceOnline)) { throw "adb 设备不在线（get-state 非 device），请重跑本脚本" }

$attempt = 1
while ($true) {
  flutter @runArgs
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -ge 2) { throw "flutter run 失败（exit=$LASTEXITCODE）" }
  $attempt++
  Write-Host "flutter run 失败（exit=$LASTEXITCODE），等待设备恢复后重试（若是代码编译错误请忽略重试）..." -ForegroundColor Yellow
  if (-not (Wait-DeviceOnline)) { throw "flutter run 失败（exit=$LASTEXITCODE），且 adb 设备不在线" }
}
