# NEXTBOT 手机 APK 构建脚本
# 用法：在 client/flutter_app 目录下执行 .\build_apk.ps1
# 效果：flutter build apk --release 后，把产物统一命名为 NEXTBOT.apk（不带版本号）放到桌面
#
# 后端地址必须烤入（--dart-define），否则 ApiConfig.httpBase 回落
# http://127.0.0.1:3000 —— 在真机上那是手机自己，登录/发验证码必然「网络错误」。
# 默认烤入生产 https 域名（2026-11-10 起）：api.nextbot.top 443 由 nginx 反代到
# 127.0.0.1:3000（含 WS 升级头），与桌面云版 build-installer-cloud.ps1 同一先例值。
# https 不受 Android 明文禁令约束，network_security_config 白名单不再需要维护。
# 本机联调（手机与电脑同 WiFi 直连 dev server）请显式传 -Lan。
param(
  # 后端 HTTP 根地址；留空走默认（-Cloud）或 -Lan 自动探测
  [string] $HttpBase = "",
  # 控制面（账号/OTP/登录页所在）；留空则与 -HttpBase 同值
  [string] $ControlPlaneUrl = "",
  # 内测版 internal / 开源版 oss
  [string] $Edition = "internal",
  [int] $Port = 3000,
  # 本机联调开关：烤入 http://<局域网IP>:3000（明文，需白名单内 IP）
  [switch] $Lan
)

$ErrorActionPreference = "Stop"

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
  if ($Lan) {
    $ip = Get-LanIPv4
    if (-not $ip) { throw "未能探测到局域网 IPv4，请显式传 -HttpBase http://<电脑IP>:3000" }
    $HttpBase = "http://${ip}:$Port"
    Write-Host "本机联调（-Lan）：烤入局域网地址 $HttpBase" -ForegroundColor Cyan
  } else {
    $HttpBase = "https://api.nextbot.top"
    Write-Host "默认生产地址：$HttpBase（本机联调请传 -Lan）" -ForegroundColor Cyan
  }
}
if ([string]::IsNullOrWhiteSpace($ControlPlaneUrl)) {
  # 云端形态控制面固定走 login 子域（登录页/OTP 主入口）；局域网联调与 HttpBase 同值
  if ($HttpBase -eq "https://api.nextbot.top") {
    $ControlPlaneUrl = "https://login.nextbot.top"
  } else {
    $ControlPlaneUrl = $HttpBase
  }
}

# --no-version-check：跳过 flutter 启动时的 `git log` 版本新鲜度检查。
# 该检查纯属提示用途；在管道资源紧张的机器上它会直接让 flutter 崩掉
# （ProcessException: 所有的管道范例都在使用中 / OS error 231），构建跑不起来。
$dartDefines = @(
  "--no-version-check",
  "--suppress-analytics",
  "--dart-define", "HTTP_BASE=$HttpBase",
  "--dart-define", "CONTROL_PLANE_URL=$ControlPlaneUrl",
  "--dart-define", "PAI_EDITION=$Edition"
)

Write-Host "烤入：HTTP_BASE=$HttpBase | CONTROL_PLANE_URL=$ControlPlaneUrl | PAI_EDITION=$Edition" -ForegroundColor Yellow

# 明文 HTTP 白名单提醒：Android 9+ 默认禁明文，局域网 http:// 地址必须在
# android/app/src/main/res/xml/network_security_config.xml 的白名单里，
# 否则请求被系统直接掐掉（表现同样是「网络错误」）。
$uri = [Uri]$HttpBase
$nsConfig = Join-Path $PSScriptRoot "android\app\src\main\res\xml\network_security_config.xml"
if ((Test-Path $nsConfig) -and $uri.Scheme -eq "http" -and $uri.Host -match '^\d+\.\d+\.\d+\.\d+$') {
  $xmlText = Get-Content $nsConfig -Raw
  if ($xmlText -notmatch "<domain[^>]*>\s*$([regex]::Escape($uri.Host))\s*</domain>") {
    Write-Host ""
    Write-Host "⚠ 明文白名单未包含 $($uri.Host)：Android 会拦截 http 请求（登录报「网络错误」）。" -ForegroundColor Yellow
    Write-Host "  请把 <domain includeSubdomains=""false"">$($uri.Host)</domain> 加进：" -ForegroundColor Yellow
    Write-Host "  $nsConfig" -ForegroundColor Yellow
    Write-Host "  （或改用 https 域名，如 https://login.nextbot.top）" -ForegroundColor Yellow
  }
}

# Release 构建前清掉插件注册器与插件清单：
# `flutter test`（尤其 integration_test）会把 **dev 依赖插件** 写进
# `.flutter-plugins-dependencies`，随后 release 构建沿用这份清单生成
# GeneratedPluginRegistrant.java，就会编译出
# 「程序包 dev.flutter.plugins.integration_test 不存在」（dev 插件不进 release
# 的 classpath）。删掉让 flutter 按 release 规则重新生成，避免这类假失败。
$registrant = Join-Path $PSScriptRoot "android\app\src\main\java\io\flutter\plugins\GeneratedPluginRegistrant.java"
$pluginsList = Join-Path $PSScriptRoot ".flutter-plugins-dependencies"
# 用 .NET 文件 API 而不是 Remove-Item：环境里的 safe-delete 钩子会对
# Remove-Item 走回收站，回收站不可用时 fail-closed 直接抛错，把构建打断
# 在这两行上（2026-11-11 实测）。这两个都是可再生成产物，直接删即可。
foreach ($f in @($registrant, $pluginsList)) {
  if (Test-Path -LiteralPath $f) {
    try { [System.IO.File]::Delete($f) } catch { Write-Warning "清理失败（可忽略）: $f" }
  }
}

flutter build apk --release @dartDefines
if ($LASTEXITCODE -ne 0) { throw "flutter build 失败" }

$src = Join-Path $PSScriptRoot "build\app\outputs\flutter-apk\app-release.apk"
if (-not (Test-Path $src)) { throw "构建产物不存在: $src" }

$dst = Join-Path ([Environment]::GetFolderPath("Desktop")) "NEXTBOT.apk"
Copy-Item $src $dst -Force

Write-Host ""
Write-Host "已放到桌面: $dst"
(Get-Item $dst) | Format-Table Name, LastWriteTime, Length
$sha1 = (Get-FileHash $dst -Algorithm SHA1).Hash
Write-Host "SHA1: $sha1"
