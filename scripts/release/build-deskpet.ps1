#Requires -Version 5.1
<#
.SYNOPSIS
  把 PySide6 桌宠打成免安装 Python 的单目录产物（PyInstaller），供安装包随包分发。
.DESCRIPTION
  产物落在 sphere-overlay-py\dist\sphere-overlay\：sphere-overlay.exe + _internal\，
  装机后由客户端按「sphere-overlay-py 目录里有 exe」优先直接启动，不再依赖本机 Python。
  增量判断：exe 比全部源码/依赖清单新时跳过；-Force 强制重建。
#>
param(
  [string]$Repo = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$PetSrc = Join-Path $Repo 'sphere-overlay-py'
$Py = Join-Path $PetSrc '.venv\Scripts\python.exe'
$OutDir = Join-Path $PetSrc 'dist\sphere-overlay'
$OutExe = Join-Path $OutDir 'sphere-overlay.exe'

if (-not (Test-Path $Py)) {
  throw "缺少桌宠 venv：$Py（先执行 cd sphere-overlay-py && python -m venv --system-site-packages .venv）"
}

$sourceFiles = Get-ChildItem $PetSrc -Recurse -File -Include '*.py', '*.txt', '*.js' |
  Where-Object { $_.FullName -notmatch '\\dist\\|\\build\\|__pycache__' }
$newest = ($sourceFiles | Measure-Object LastWriteTime -Maximum).Maximum
if (-not $Force -and (Test-Path $OutExe) -and
    ((Get-Item $OutExe).LastWriteTime -ge $newest)) {
  Write-Host "桌宠打包产物已是最新：$OutDir" -ForegroundColor Green
  return
}

Write-Host '== 桌宠打包：PyInstaller 单目录 + 前端 dist =='
& $Py -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '  未安装 PyInstaller，安装到 venv…'
  & $Py -m pip install --disable-pip-version-check -q pyinstaller
  if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 安装失败' }
}

Push-Location $PetSrc
try {
  # qwebchannel.js 是运行期按文件读取的（Qt 不自带构造器），必须显式随包；
  # --specpath 在 build\pyi，相对路径会按 spec 目录解析，所以这里给绝对路径。
  $qwc = Join-Path $PetSrc 'sphere_overlay\qwebchannel.js'
  # 桌宠由 GUI 客户端 Process.start 拉起，控制台子系统子进程会分到一个可见控制台；
  # hide-early 让 bootloader 在 Python 起来前就把它藏掉，召唤时不会闪黑框。
  & $Py -m PyInstaller main.py --name sphere-overlay --noconfirm --clean --console `
    --hide-console hide-early `
    --add-data "$qwc;sphere_overlay" `
    --distpath dist --workpath build/pyi --specpath build/pyi
  if ($LASTEXITCODE -ne 0) { throw 'PyInstaller 打包失败' }
} finally {
  Pop-Location
}

$required = @(
  $OutExe,
  (Join-Path $OutDir '_internal\PySide6\Qt6WebEngineCore.dll'),
  (Join-Path $OutDir '_internal\PySide6\QtWebEngineProcess.exe'),
  (Join-Path $OutDir '_internal\sphere_overlay\qwebchannel.js')
)
foreach ($f in $required) {
  if (-not (Test-Path $f)) { throw "桌宠打包产物缺文件: $f" }
}

# 裁剪：调试 pak / Qt 自带翻译与其余语言包都不参与桌宠运行，留着白占几十 MB
$pysideInternal = Join-Path $OutDir '_internal\PySide6'
Get-ChildItem (Join-Path $pysideInternal 'resources') -File -Filter '*.debug.pak' -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $pysideInternal 'resources') -File -Filter '*.debug.bin' -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $pysideInternal 'translations') -File -Filter '*.qm' -ErrorAction SilentlyContinue | Remove-Item -Force
$locales = Join-Path $pysideInternal 'translations\qtwebengine_locales'
if (Test-Path $locales) {
  Get-ChildItem $locales -File |
    Where-Object { $_.Name -notin @('en-US.pak', 'en-GB.pak', 'zh-CN.pak') } |
    Remove-Item -Force
}

# 冒烟门禁：在打包产物上真起一次 WebEngine，等到页面首帧就绪才算打成功
Write-Host '== 桌宠打包冒烟 =='
$smokeLog = Join-Path $env:TEMP 'deskpet-smoke.log'
Remove-Item $smokeLog -ErrorAction SilentlyContinue
$oldAvatar = $env:PAI_AVATAR_DIST
$oldIdle = $env:PAI_PET_IDLE_EXIT_MS
$env:PAI_AVATAR_DIST = Join-Path $Repo 'agent-sphere-avatar\dist'
$env:PAI_PET_IDLE_EXIT_MS = '60000'
$petProc = $null
try {
  # 单实例会抢走"本进程"身份：先清掉可能残留的桌宠，冒烟才有意义
  & $OutExe --quit *> $null
  Start-Sleep -Milliseconds 300
  $petProc = Start-Process -FilePath $OutExe -ArgumentList '--warm' -WorkingDirectory $OutDir `
    -PassThru -NoNewWindow -RedirectStandardOutput $smokeLog
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $smokeLog) -and (Select-String -Path $smokeLog -SimpleMatch 'SPHERE_OVERLAY_READY' -Quiet)) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) {
    $tail = if (Test-Path $smokeLog) { (Get-Content $smokeLog -Tail 10) -join "`n" } else { '（无输出）' }
    throw "桌宠打包冒烟失败：产物未上报首帧就绪。`n$tail"
  }
} finally {
  if ($petProc -and -not $petProc.HasExited) {
    & $OutExe --quit *> $null
    $petProc.WaitForExit(8000) | Out-Null
    if (-not $petProc.HasExited) { Stop-Process -Id $petProc.Id -Force }
  }
  $env:PAI_AVATAR_DIST = $oldAvatar
  $env:PAI_PET_IDLE_EXIT_MS = $oldIdle
}

$size = (Get-ChildItem $OutDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("桌宠打包完成：{0}（{1:N1} MB）" -f $OutDir, $size) -ForegroundColor Green
