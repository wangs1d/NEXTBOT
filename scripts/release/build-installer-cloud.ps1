#Requires -Version 5.1
<#
.SYNOPSIS
  一键产出「云端连接版」Windows 安装包：客户端构建（烤入云端 wss + cloud 更新通道）
  → app-only staging → Inno 编译。
.EXAMPLE
  .\build-installer-cloud.ps1 -Version 0.1.3
.DESCRIPTION
  与 build-installer.ps1（byok 捆绑版）的差异：
  - 无 runtime：不组 node/server/模型资产（模型跑云端 https://api.nextbot.top），
    安装包 ~90MB（byok 版 ~700MB 量级）。
  - PAI_EDITION=cloud：客户端更新检查请求 /api/client/manifest?edition=cloud，
    独立更新通道（ECS config/client-manifest.cloud.json），不会被 byok 清单拖去装捆绑版。
  - HTTP_BASE 烤入云端 wss 域名；用户模型 Key 在「设置-模型服务」配置，
    仅 wss 连接时上送（明文 ws 服务端拒收）。
#>
param(
  [string]$Version = "0.1.3",
  # 版本控制面（ECS manifest）：cloud 通道更新检查与 byok 同域不同清单
  [string]$UpdateManifestUrl = "https://login.nextbot.top",
  # 控制面：反馈/站内信等运营数据走这里
  [string]$ControlPlaneUrl = "https://login.nextbot.top",
  # 云端 wss 网关（模型对话与 Agent 运行时全走这里）
  [string]$HttpBase = "https://api.nextbot.top",
  # staging 根目录：与 byok 版（E:\PAStage）隔离，避免互相覆盖 staging
  [string]$StageRootPath = "E:\PACloudStage",
  [switch]$SkipClientBuild
)
$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$FlutterApp = Join-Path $Repo 'client\flutter_app'
$StageApp = Join-Path $StageRootPath 'app'

Write-Host '== [1/3] 客户端 release 构建（烤入 HTTP_BASE + PAI_EDITION=cloud + 控制面）=='
if (-not $SkipClientBuild) {
  Push-Location $FlutterApp
  & flutter build windows --release `
    --dart-define "HTTP_BASE=$HttpBase" `
    --dart-define "PAI_EDITION=cloud" `
    --dart-define "UPDATE_MANIFEST_URL=$UpdateManifestUrl" `
    --dart-define "CONTROL_PLANE_URL=$ControlPlaneUrl"
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'flutter build failed' }
  Pop-Location
}

Write-Host '== [2/3] 组装 app-only staging =='
if (Test-Path $StageRootPath) {
  & cmd /c "rmdir /s /q `"$StageRootPath`""
  if (Test-Path $StageRootPath) {
    Remove-Item -Recurse -Force -LiteralPath ('\\?\' + $StageRootPath)
  }
}
New-Item -ItemType Directory -Force -Path $StageApp | Out-Null

# Flutter 产物 + VC 运行库（本机 System32 同架构拷贝，免去 vc_redist 静默安装）
Copy-Item (Join-Path $FlutterApp 'build\windows\x64\runner\Release\*') $StageApp -Recurse -Force
foreach ($dll in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') {
  Copy-Item (Join-Path $env:windir "System32\$dll") $StageApp -Force
}

Write-Host '== [2.5/3] 校验关键文件 =='
foreach ($f in (Join-Path $StageApp 'NEXTBOT.exe'),
               (Join-Path $StageApp 'data\app.so')) {
  if (-not (Test-Path $f)) { throw "staging 缺少关键文件: $f" }
}

# 烤入门禁：flutter build 漏传 --dart-define 时客户端静默回落本地/官方端点，
# 云端版直接失联（wss 连不上）或更新通道错乱。app.so 是 Dart AOT 快照，
# dart-define 字符串常量以明文 ASCII 存于其中，可直接搜。
$soText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes((Join-Path $StageApp 'data\app.so')))
foreach ($url in @($HttpBase, $UpdateManifestUrl, $ControlPlaneUrl)) {
  $host_ = ([uri]$url).Host
  if ($host_ -and -not $soText.Contains($host_)) {
    throw "发版门禁失败：app.so 未烤入 $url —— 请确认 [1/3] 的 flutter build 带全 --dart-define（勿用 SkipClientBuild 跳过带参构建）。"
  }
}
# cloud 更新通道断言：URL 模板与 PAI_EDITION 值经运行时插值拼接，AOT 快照常量池里
# 只有两段独立字面量——分别断言「edition 机制在」+「cloud 值在」，都缺一不可。
if (-not $soText.Contains('manifest?edition=') -or -not $soText.Contains('cloud')) {
  throw '发版门禁失败：app.so 未同时含 manifest?edition= 模板与 cloud 值 —— PAI_EDITION=cloud 未生效，更新会走 byok 清单。'
}
Write-Host '烤入校验通过（wss + 控制面 + cloud 更新通道）' -ForegroundColor Green

Write-Host '== [3/3] Inno 编译（private-agent-cloud.iss）=='
$iscc = @('C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Users\Administrator\AppData\Local\Programs\Inno Setup 6\ISCC.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw '未找到 ISCC.exe，请安装 Inno Setup 6' }
& $iscc (Join-Path $Repo 'installer\private-agent-cloud.iss') "/DAppVersion=$Version" "/DStage=$StageRootPath" "/DEdition=cloud"
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

$out = Join-Path $Repo "windows_dist\installer\Nextbot-Cloud-Setup.exe"
Write-Host ''
Write-Host "安装包产出: $out" -ForegroundColor Green
Write-Host ("大小: {0:N1} MB" -f ((Get-Item $out).Length / 1MB))
