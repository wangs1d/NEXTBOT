#Requires -Version 5.1
<#
.SYNOPSIS
  Build Flutter Windows (Release and/or Debug) and copy the runner folder to E:.

.DESCRIPTION
  Flutter still writes under project build\windows\...; every install (including
  plain "flutter build windows") also mirrors the bundle to windows_dist via
  windows/cmake (see PRIVATE_AI_AGENT_SKIP_WINDOWS_DIST to opt out). This script
  additionally mirrors the full Release or Debug folder (entire folder, not only .exe),
  including stopping processes that lock the deploy folder.

  Default dist root: E:\W-Project\Private AI Agent\windows_dist\Release | Debug
  Override: set env PRIVATE_AI_AGENT_WINDOWS_DIST to a folder on E: (or any drive).

  Requires: Flutter on PATH or FLUTTER_ROOT, Visual Studio desktop C++, Windows Developer Mode for symlinks.
#>
param(
  [ValidateSet('Release', 'Debug', 'Both')]
  [string] $Configuration = 'Release',
  # 发布版服务器地址：不传时客户端默认连 http://127.0.0.1:3000（仅本机联调）。
  # 发给用户的安装包必须烤进真实服务器，例：
  #   .\build_windows_release.ps1 -HttpBase https://your-server-domain
  [string] $HttpBase = '',
  # 版本清单（更新检查）地址：byok 捆绑形态下 chat 走本地 runtime，而版本控制面
  # 在云端，必须单独烤入。默认烤入云端域名（nginx login 子域反代 Node，勿烤裸 IP：
  # 登录页等页面会直接进用户浏览器地址栏）——控制面常量是编译期烤死的，漏传时客户端
  # 静默回落 127.0.0.1:3000，更新检查/反馈失联（0.2.1 与本地 Debug 均翻过车）。
  # 确要回落本地联调请显式传空：-UpdateManifestUrl ''
  [string] $UpdateManifestUrl = 'http://login.nextbot.top',
  # 控制面（管理后台所在服务器）：反馈/站内信/网页登录页（/accounts/web）走这里。
  # 网页登录 URL 用户可见，必须烤域名（login.nextbot.top）而非裸 IP。
  # 默认烤入云端域名，本地构建也能在后台看到反馈；确要回落本地请显式传空：-ControlPlaneUrl ''
  [string] $ControlPlaneUrl = 'http://login.nextbot.top',
  # 发行版本：internal=内测版（默认，能力全量）；oss=开源版（GitHub 发行，
  # 内测独占能力整族隐藏）。与服务端 NEXTBOT_EDITION 同名值，开源安装包传 -Edition oss。
  [ValidateSet('internal', 'oss')]
  [string] $Edition = 'internal'
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Resolve-FlutterExecutable {
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($env:FLUTTER_ROOT) {
    $bat = Join-Path $env:FLUTTER_ROOT 'bin\flutter.bat'
    if (Test-Path $bat) { return $bat }
  }
  $candidates = @(
    (Join-Path $env:USERPROFILE 'flutter\bin\flutter.bat'),
    (Join-Path $env:USERPROFILE 'development\flutter\bin\flutter.bat'),
    'C:\flutter\bin\flutter.bat',
    'C:\src\flutter\bin\flutter.bat',
    (Join-Path $env:LOCALAPPDATA 'flutter\bin\flutter.bat')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Assert-FlutterOk {
  param([string]$StepName)
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'If you see symlink / Developer Mode: enable Windows Developer Mode, then retry.' -ForegroundColor Yellow
    Write-Host '  start ms-settings:developers' -ForegroundColor Yellow
    Write-Host ''
    Write-Error "Flutter step failed: $StepName (exit $LASTEXITCODE)"
  }
}

$flutterExe = Resolve-FlutterExecutable
if (-not $flutterExe) {
  Write-Error 'Flutter not found. Add flutter to PATH or set FLUTTER_ROOT. See https://docs.flutter.dev/get-started/install/windows'
}

$DistRoot = 'E:\W-Project\Private AI Agent\windows_dist'
if ($env:PRIVATE_AI_AGENT_WINDOWS_DIST) {
  $DistRoot = $env:PRIVATE_AI_AGENT_WINDOWS_DIST.Trim()
}
if (-not $DistRoot) {
  Write-Error 'PRIVATE_AI_AGENT_WINDOWS_DIST is set but empty.'
}

$cmakeLists = Join-Path $Root 'windows\CMakeLists.txt'
if (-not (Test-Path $cmakeLists)) {
  if (Test-Path (Join-Path $Root 'windows')) {
    Write-Host 'Incomplete windows folder detected; removing to regenerate...'
    Remove-Item -Recurse -Force (Join-Path $Root 'windows')
  }
  Write-Host 'Generating Windows platform: flutter create --platforms=windows .'
  & $flutterExe create --platforms=windows .
  Assert-FlutterOk 'flutter create --platforms=windows'
}

$null = New-Item -ItemType Directory -Force -Path $DistRoot

Write-Host 'flutter pub get'
& $flutterExe pub get
Assert-FlutterOk 'flutter pub get'

function Stop-ProcessesUsingDeployFolder {
  param([string] $FolderPath)
  if (-not (Test-Path -LiteralPath $FolderPath)) { return }
  $full = (Get-Item -LiteralPath $FolderPath).FullName.TrimEnd('\', '/')
  foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
    $exePath = $null
    try { $exePath = $proc.Path } catch { continue }
    if (-not $exePath) { continue }
    try {
      $exeFull = [System.IO.Path]::GetFullPath($exePath)
    } catch { continue }
    if ($exeFull.StartsWith($full, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "Stopping process locking deploy folder: $($proc.ProcessName) (PID $($proc.Id))" -ForegroundColor Yellow
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 600
}

function Remove-DeployFolder {
  param([string] $LiteralPath)
  Stop-ProcessesUsingDeployFolder -FolderPath $LiteralPath
  $max = 8
  for ($i = 0; $i -lt $max; $i++) {
    try {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq $max - 1) { throw }
      Stop-ProcessesUsingDeployFolder -FolderPath $LiteralPath
      Start-Sleep -Milliseconds (500 * ($i + 1))
    }
  }
}

function Invoke-BuildAndDeploy {
  param(
    [ValidateSet('Release', 'Debug')]
    [string] $Mode
  )

  $dartDefines = @('--dart-define', "PAI_EDITION=$Edition")
  if ($HttpBase) { $dartDefines += @('--dart-define', "HTTP_BASE=$HttpBase") }
  if ($UpdateManifestUrl) { $dartDefines += @('--dart-define', "UPDATE_MANIFEST_URL=$UpdateManifestUrl") }
  if ($ControlPlaneUrl) { $dartDefines += @('--dart-define', "CONTROL_PLANE_URL=$ControlPlaneUrl") }

  if ($Mode -eq 'Release') {
    if (-not $UpdateManifestUrl -or -not $ControlPlaneUrl) {
      # 静默回落是隐形坑：0.2.1 安装包因此把用户反馈全落在了本机库
      Write-Host 'WARNING: 本次 Release 构建未烤入 UpdateManifestUrl / ControlPlaneUrl，' -ForegroundColor Yellow
      Write-Host '  更新检查与用户反馈将回落 httpBase（本地 127.0.0.1:3000），云端后台收不到。' -ForegroundColor Yellow
      Write-Host '  需联调后台或发用户请加：-UpdateManifestUrl http://login.nextbot.top -ControlPlaneUrl http://login.nextbot.top' -ForegroundColor Yellow
    }
    if (-not $HttpBase) {
      # 2026-10-16 复发：无 HttpBase 的 Release 包静默回落 127.0.0.1:3000，
      # 用户机器上没人监听 → 「行程列表加载失败/拒绝连接」。byok 捆绑构建
      # （exe 旁会有 runtime\）合法回落，不受影响；非捆绑包运行期直接 fail-fast。
      Write-Host 'WARNING: 本次 Release 构建未烤入 HttpBase，客户端将回落 http://127.0.0.1:3000。' -ForegroundColor Yellow
      Write-Host '  发给用户（连云端后端）请加：-HttpBase http://<后端地址>:3000' -ForegroundColor Yellow
      Write-Host '  仅 byok 捆绑形态（安装器会放置 runtime\）允许不带 HttpBase。' -ForegroundColor Yellow
    }
    Write-Host "flutter build windows --release $($dartDefines -join ' ')"
    & $flutterExe build windows --release @dartDefines
  }
  else {
    Write-Host "flutter build windows --debug $($dartDefines -join ' ')"
    & $flutterExe build windows --debug @dartDefines
  }
  Assert-FlutterOk "flutter build windows ($Mode)"

  $src = Join-Path $Root "build\windows\x64\runner\$Mode"
  $builtExe = Get-ChildItem -Path $src -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $builtExe) {
    Write-Error "No .exe found under: $src"
  }

  $dest = Join-Path $DistRoot $Mode
  if (Test-Path -LiteralPath $dest) {
    Remove-DeployFolder -LiteralPath $dest
  }
  $null = New-Item -ItemType Directory -Force -Path $dest
  Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force

  Write-Host ''
  Write-Host "$Mode build OK. Deployed folder:" -ForegroundColor Green
  Write-Host ('  ' + $dest)
  Write-Host ('  exe: ' + (Join-Path $dest $builtExe.Name))
}

if ($Configuration -eq 'Release' -or $Configuration -eq 'Both') {
  Invoke-BuildAndDeploy -Mode Release
}

if ($Configuration -eq 'Debug' -or $Configuration -eq 'Both') {
  Invoke-BuildAndDeploy -Mode Debug
}

Write-Host ''
Write-Host ('Dist root: ' + $DistRoot)
