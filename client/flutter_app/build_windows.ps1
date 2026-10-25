#Requires -Version 5.1
<#
.SYNOPSIS
  Build Flutter Windows (Release and/or Debug) and copy the runner folder to E:.

.DESCRIPTION
  Flutter still writes under project build\windows\...; every install (including
  plain "flutter build windows") also mirrors the bundle to windows_dist via
  windows/cmake (see NEXTBOT_SKIP_WINDOWS_DIST to opt out). This script
  additionally mirrors the full Release or Debug folder (entire folder, not only .exe),
  including stopping processes that lock the deploy folder.

  Default dist root: <repo>\windows_dist\Release | Debug —— 与 cmake_install 的
  镜像目标（windows/cmake/nextbot_deploy_windows_dist.cmake）保持同一处，
  不再指向机器相关的绝对路径（旧默认 E:\W-Project\... 早已不是本仓）。
  Override: set env NEXTBOT_WINDOWS_DIST to any folder.

  Requires: Flutter on PATH or FLUTTER_ROOT, Visual Studio desktop C++, Windows Developer Mode for symlinks.
#>
param(
  [ValidateSet('Release', 'Debug', 'Both')]
  [string] $Configuration = 'Release',
  # 发布版服务器地址：默认 http://127.0.0.1:3000（本机日常构建入口，连本地 dev server）。
  # 不能留空默认：api_config.dart 的 P0 防线在 Windows Release 非捆绑形态下
  # 对空 HTTP_BASE 直接 fail-fast（2026-10-20 / 10-23 两次白屏复发），空默认
  # 产出的包启动即白屏。发给用户的分发构建走 build_windows_release.ps1，
  # 那里强制显式传真实服务器，例：
  #   .\build_windows_release.ps1 -HttpBase https://api.nextbot.top
  [string] $HttpBase = 'http://127.0.0.1:3000',
  # 版本清单（更新检查）地址：byok 捆绑形态下 chat 走本地 runtime，而版本控制面
  # 在云端，必须单独烤入。默认烤入云端域名（nginx login 子域反代 Node，勿烤裸 IP：
  # 登录页等页面会直接进用户浏览器地址栏）——控制面常量是编译期烤死的，漏传时客户端
  # 静默回落 127.0.0.1:3000，更新检查/反馈失联（0.2.1 与本地 Debug 均翻过车）。
  # 必须烤 https://（2026-10-19 定调）：80 已 301 到 https，烤 http 会让每次
  # 「检查更新」都多付一次 301 重定向 + 二次 TLS 握手，弱网下弹卡延迟数秒。
  # 确要回落本地联调请显式传空：-UpdateManifestUrl ''
  [string] $UpdateManifestUrl = 'https://login.nextbot.top',
  # 控制面（管理后台所在服务器）：反馈/站内信/网页登录页（/accounts/web）走这里。
  # 网页登录 URL 用户可见，必须烤域名（login.nextbot.top）而非裸 IP；
  # 同样必须烤 https://（同上，80 已 301，跨协议重定向不可靠）。
  # 默认烤入云端域名，本地构建也能在后台看到反馈；确要回落本地请显式传空：-ControlPlaneUrl ''
  [string] $ControlPlaneUrl = 'https://login.nextbot.top',
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

# 部署目录默认落在本仓 <repo>\windows_dist，与 cmake_install 的镜像目标一致。
# 旧默认写死 'E:\W-Project\Nextbot\windows_dist'（早已不是本仓路径），
# 在别的机器/别的盘符上会凭空造目录、与真正在跑的包不是同一份——「改了代码但
# 界面上没变」的经典来源之一。
# 仓根 = 本脚本所在目录（client\flutter_app）往上两级；与 CMakeLists.txt 里
# ${CMAKE_SOURCE_DIR}/../../.. 的口径一致（CMAKE_SOURCE_DIR 是 windows\）。
$RepoRoot = Split-Path (Split-Path $Root -Parent) -Parent
$DistRoot = Join-Path $RepoRoot 'windows_dist'
if ($env:NEXTBOT_WINDOWS_DIST) {
  $override = $env:NEXTBOT_WINDOWS_DIST.Trim()
  if (-not $override) {
    Write-Error 'NEXTBOT_WINDOWS_DIST is set but empty.'
  }
  $DistRoot = if ([System.IO.Path]::IsPathRooted($override)) {
    $override
  } else {
    Join-Path $RepoRoot $override
  }
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

function Invoke-BuildAndDeploy {
  param(
    [ValidateSet('Release', 'Debug')]
    [string] $Mode
  )

  # 构建前先放行：windows/cmake 的 install 步骤会把产物镜像到 windows_dist\<Mode>，
  # App 正在跑就锁着该目录（以及 build\...\runner\<Mode> 本体），构建必挂在最后
  # 一步（2026-10-24 实测：Release exit 1，MSB3073 on INSTALL.vcxproj）。
  Stop-ProcessesUsingDeployFolder -FolderPath (Join-Path $DistRoot $Mode)
  Stop-ProcessesUsingDeployFolder -FolderPath (Join-Path $Root "build\windows\x64\runner\$Mode")

  $dartDefines = @('--dart-define', "PAI_EDITION=$Edition")
  if ($HttpBase) { $dartDefines += @('--dart-define', "HTTP_BASE=$HttpBase") }
  if ($UpdateManifestUrl) { $dartDefines += @('--dart-define', "UPDATE_MANIFEST_URL=$UpdateManifestUrl") }
  if ($ControlPlaneUrl) { $dartDefines += @('--dart-define', "CONTROL_PLANE_URL=$ControlPlaneUrl") }

  if ($Mode -eq 'Release') {
    if (-not $UpdateManifestUrl -or -not $ControlPlaneUrl) {
      # 静默回落是隐形坑：0.2.1 安装包因此把用户反馈全落在了本机库
      Write-Host 'WARNING: 本次 Release 构建未烤入 UpdateManifestUrl / ControlPlaneUrl，' -ForegroundColor Yellow
      Write-Host '  更新检查与用户反馈将回落 httpBase（本地 127.0.0.1:3000），云端后台收不到。' -ForegroundColor Yellow
      Write-Host '  需联调后台或发用户请加：-UpdateManifestUrl https://login.nextbot.top -ControlPlaneUrl https://login.nextbot.top' -ForegroundColor Yellow
    }
    if (-not $HttpBase) {
      # 2026-10-16 复发：无 HttpBase 的 Release 包静默回落 127.0.0.1:3000，
      # 用户机器上没人监听 → 「行程列表加载失败/拒绝连接」。byok 捆绑构建
      # （exe 旁会有 runtime\）合法回落，不受影响；非捆绑包运行期直接 fail-fast。
      Write-Host 'WARNING: 本次 Release 构建未烤入 HttpBase（显式传了空值），非捆绑包启动即 fail-fast 白屏。' -ForegroundColor Yellow
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
  $null = New-Item -ItemType Directory -Force -Path $dest
  # 不再「整目录删掉再拷」：其它程序（编辑器/索引器）会以独占只读句柄持有产物
  # 文件，删除必抛异常，构建明明已成功却被判失败（2026-10-25：ZCode 持有两个
  # 字体文件 → Remove-Item 报「正在被另一进程使用」）。robocopy /MIR 对
  # 「时间戳+大小相同」的文件直接跳过，不会去写那类锁住的未变文件；内容真变了
  # 的文件照样会失败——那才是需要人介入的失败。
  $copyArgs = @($src, $dest, '/MIR', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS')
  $copy = Start-Process -FilePath 'robocopy.exe' -ArgumentList $copyArgs -NoNewWindow -Wait -PassThru
  if ($copy.ExitCode -ge 8) {
    Write-Error "robocopy to $dest failed (code $($copy.ExitCode))"
  }

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
