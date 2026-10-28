# 干净 Windows 机器一键验收：基线缺席确认 -> 装 Nextbot-Setup -> 逐项核验 -> 拉起 App 截屏。
# 用法（在真实桌面会话里跑，不要走 SSH，否则截不到窗口）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-clean-machine.ps1 -PackageUrl https://.../Nextbot-Setup-0.1.6.exe
# 报告落在 .\nb-verify\report.txt，末尾打印 PASS/FAIL 汇总，退出码非 0 表示有 FAIL。
param(
  [string]$PackageUrl,
  [string]$PackagePath,
  [string]$OutDir = (Join-Path (Get-Location) 'nb-verify'),
  [int]$ReadyTimeoutSec = 90
)
$ErrorActionPreference = 'Continue'
$fails = New-Object System.Collections.ArrayList
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$report = Join-Path $OutDir 'report.txt'

function Say($text, $color) {
  Write-Host $text -ForegroundColor $color
  Add-Content -Path $report -Value $text -Encoding utf8
}
function Check($name, $ok, $detail) {
  if ($ok) { Say ("[PASS] {0}  {1}" -f $name, $detail) 'Green' }
  else { [void]$fails.Add($name); Say ("[FAIL] {0}  {1}" -f $name, $detail) 'Red' }
}
function Info($text) { Say ("       $text") 'DarkGray' }

Set-Content -Path $report -Value ('=== NextBot 干净机器验收 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===') -Encoding utf8
$os = Get-CimInstance Win32_OperatingSystem
Say ("OS = " + $os.Caption.Trim() + ' ' + $os.Version + '.' + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR) 'White'

# ---------- [1] 装机前基线：这台机器本来没有这些，装完还能跑，才证明包是自足的 ----------
Say '' None
Say '--- [1/5] 装机前依赖基线 ---' 'White'
foreach ($t in 'node', 'python', 'ffmpeg', 'ffprobe', 'npx', 'git') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  Check "PATH 上没有 $t" ($null -eq $c) $(if ($c) { $c.Source } else { 'absent' })
}
$pwCache = @($env:PLAYWRIGHT_BROWSERS_PATH, (Join-Path $env:LOCALAPPDATA 'ms-playwright'), 'C:\Program Files\ms-playwright', 'D:\ms-playwright') |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
Check 'Playwright 浏览器缓存缺席' ($pwCache.Count -eq 0) ($(if ($pwCache) { $pwCache -join '; ' } else { 'absent' }))
$wv2Key = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
$wv2 = $null
foreach ($k in $wv2Key) {
  $v = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).pv
  if ($v -and $v -ne '0.0.0.0') { $wv2 = $v; break }
}
if ($wv2) { Info "WebView2 运行时已存在 pv=$wv2（本机验不到安装器的引导路径）" } else { Info 'WebView2 运行时缺席（正好能验安装器的引导安装）' }
$sysMsvcp = Test-Path (Join-Path $env:windir 'System32\msvcp140.dll')
if ($sysMsvcp) { Info 'System32 已有 msvcp140.dll：下面用「模块加载来源」断言包内副本才是真被用的' } else { Info 'System32 无 msvcp140.dll：这台机器没装过 VC++ 运行库，包内副本是唯一来源' }

# ---------- [2] 取包 + 静默安装 ----------
Say '' None
Say '--- [2/5] 安装 ---' 'White'
$pkg = $null
if ($PackageUrl) {
  $pkg = Join-Path $OutDir 'Nextbot-Setup.exe'
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $PackageUrl -OutFile $pkg -UseBasicParsing -TimeoutSec 3600
  } catch { Check '安装包下载' $false $_.Exception.Message; Say ('=== 结论：FAIL ===') 'Red'; exit 1 }
} elseif ($PackagePath -and (Test-Path $PackagePath)) {
  $pkg = (Resolve-Path $PackagePath).Path
} else {
  Say '用法：-PackageUrl https://… 或 -PackagePath C:\path\to\Nextbot-Setup.exe' 'Red'; exit 2
}
$hash = (Get-FileHash $pkg -Algorithm SHA256).Hash
Say ("  安装包 = " + (Split-Path $pkg -Leaf) + '  ' + [math]::Round((Get-Item $pkg).Length / 1MB, 1) + ' MB  sha256=' + $hash) 'White'
$t0 = Get-Date
$p = Start-Process -FilePath $pkg -ArgumentList '/VERYSILENT', '/NORESTART', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru
Check '安装器退出码为 0' ($p.ExitCode -eq 0) ("exit=" + $p.ExitCode + ' 用时 ' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + ' 秒')

# ---------- [3] 包内容核验 ----------
Say '' None
Say '--- [3/5] 包内依赖核验 ---' 'White'
$root = @((Join-Path $env:LOCALAPPDATA 'Programs\Nextbot'), (Join-Path $env:ProgramFiles 'Nextbot'), (Join-Path ${env:ProgramFiles(x86)} 'Nextbot')) |
  Where-Object { $_ -and (Test-Path (Join-Path $_ 'NEXTBOT.exe')) } | Select-Object -First 1
Check '找到安装目录' ($null -ne $root) $(if ($root) { $root } else { 'NEXTBOT.exe 不在任何常规路径' })
if (-not $root) { Say '=== 结论：FAIL ===' 'Red'; exit 1 }
$runtime = Join-Path $root 'runtime'
$node = Join-Path $runtime 'node.exe'

Check 'NEXTBOT.exe 非零字节' ((Get-Item (Join-Path $root 'NEXTBOT.exe')).Length -gt 1MB) ((Get-Item (Join-Path $root 'NEXTBOT.exe')).Length.ToString() + ' bytes')
Check '捆绑 node.exe 存在' (Test-Path $node) $node
if (Test-Path $node) { Check '捆绑 node 可执行' ((& $node --version 2>&1 | Out-String).Trim().StartsWith('v')) ((& $node --version 2>&1) -join '') }
Check 'runtime\dist\index.js 存在' (Test-Path (Join-Path $runtime 'dist\index.js')) (Join-Path $runtime 'dist\index.js')
foreach ($dep in 'better-sqlite3', 'sharp', '@img', 'onnxruntime-node', 'playwright-core') {
  Check "依赖已入包：$dep" (Test-Path (Join-Path $runtime "node_modules\$dep")) ''
}
$ff = Join-Path $runtime 'bin\ffmpeg.exe'
$ffOk = (Test-Path $ff) -and ((Get-Item $ff).Length -gt 1MB)
Check 'ffmpeg 已入包且是真实二进制' $ffOk $(if ($ffOk) { [math]::Round((Get-Item $ff).Length / 1MB, 1).ToString() + ' MB' } else { $ff })
if ($ffOk) { Check 'ffmpeg 真跑起来了' ((& $ff -version 2>&1 | Select-Object -First 1) -match 'ffmpeg version') '' }
$shell = Get-ChildItem (Join-Path $runtime 'ms-playwright') -Directory -Filter 'chromium_headless_shell-*' -ErrorAction SilentlyContinue | Select-Object -First 1
$shellExe = if ($shell) { Get-ChildItem $shell.FullName -Recurse -Filter 'chrome-headless-shell.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
Check '包内 chromium headless shell 存在' ($null -ne $shellExe) $(if ($shellExe) { $shellExe.FullName } else { 'runtime\ms-playwright\chromium_headless_shell-*' })
$vc = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll')
foreach ($scope in @($root, $runtime)) {
  $present = @($vc | Where-Object { Test-Path (Join-Path $scope $_) })
  Check "VC 运行库随包（$scope）" ($present.Count -eq $vc.Count) ($present -join ', ')
}
$envFile = Join-Path $runtime '.env'
Check 'runtime\.env 已随包生成' (Test-Path $envFile) $envFile
if (Test-Path $envFile) {
  $keys = (Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z0-9_]+\s*=' } | ForEach-Object { ($_ -split '=')[0].Trim() })
  Info ".env 键名（不打印值）：$($keys -join ', ')"
  $personal = @($keys | Where-Object { $_ -match 'MINIMAX|SILICONFLOW|AMAP|SMTP|_KEY$' -and $_ -ne 'SEARCH_API_KEY' })
  Check '包内未夹带个人密钥' ($personal.Count -eq 0) ($personal -join ', ')
}
Check '未夹带 config.env' (-not (Test-Path (Join-Path $env:APPDATA 'Nextbot\config.env'))) ''

# 原生模块真加载一次：缺 DLL 只有 dlopen 时才暴露
$probe = "const D=require('better-sqlite3');const db=new D(':memory:');db.close();require('sharp');" +
  "const ort=require('onnxruntime-node');console.log('NATIVE_OK '+ort.version);"
Push-Location $runtime
$nativeOut = & $node -e $probe 2>&1
$nativeExit = $LASTEXITCODE
Pop-Location
Check '原生模块加载成功（sqlite/sharp/onnxruntime）' ($nativeExit -eq 0) (($nativeOut | ForEach-Object { $_.ToString() }) -join ' | ')

# 包内浏览器真起一次，并证明起的是包内那个二进制
$pwProbe = @'
import('playwright').then(async (m) => {
  const b = await m.chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.setContent('<h1 id="t">nextbot</h1>');
  console.log('BROWSER_OK ' + (await b.version()) + ' text=' + (await p.textContent('#t')));
  await b.close();
}).catch((e) => { console.error('BROWSER_FAIL ' + (e && e.message ? e.message : e)); process.exit(1); });
'@
if (Test-Path (Join-Path $runtime 'node_modules\playwright')) {
  $prevPw = $env:PLAYWRIGHT_BROWSERS_PATH
  $prevDbg = $env:DEBUG
  $env:PLAYWRIGHT_BROWSERS_PATH = (Join-Path $runtime 'ms-playwright')
  $env:DEBUG = 'pw:browser*'
  Push-Location $runtime
  $pwOut = & $node --input-type=module -e $pwProbe 2>&1
  $pwExit = $LASTEXITCODE
  Pop-Location
  if ($prevPw) { $env:PLAYWRIGHT_BROWSERS_PATH = $prevPw } else { Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue }
  if ($prevDbg) { $env:DEBUG = $prevDbg } else { Remove-Item Env:DEBUG -ErrorAction SilentlyContinue }
  # 不能用 Out-String：按控制台宽度折行会把 <launching> 的路径拦腰截断
  $pwText = (($pwOut | ForEach-Object { $_.ToString() }) -join "`n")
  $m = [regex]::Match($pwText, '<launching> (.+?)(?: --|$)')
  $spawn = if ($m.Success) { $m.Groups[1].Value.Trim() } else { '' }
  Check '起的是包内浏览器' ($spawn.StartsWith((Join-Path $runtime 'ms-playwright'), [StringComparison]::OrdinalIgnoreCase)) "spawn=$spawn"
  Check '包内 headless 浏览器渲染成功' (($pwExit -eq 0) -and $pwText.Contains('BROWSER_OK') -and $pwText.Contains('text=nextbot')) (($pwText -split "`n" | Where-Object { $_ -match 'BROWSER_' } | Select-Object -First 1) -join '')
} else {
  Check '包内 playwright 存在' $false (Join-Path $runtime 'node_modules\playwright')
}

# ---------- [4] 零配置拉起本地后端 ----------
Say '' None
Say '--- [4/5] 零配置拉起本地 runtime ---' 'White'
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
  Check '3000 端口空闲' $false '已被占用，无法判定是包内后端'
} else {
  $env:NEXTBOT_DATA_DIR = Join-Path $OutDir 'data'
  $rp = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $runtime 'dist\index.js')`"" -WorkingDirectory $runtime `
    -RedirectStandardOutput (Join-Path $OutDir 'runtime-out.log') -RedirectStandardError (Join-Path $OutDir 'runtime-err.log') -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  $code = 0
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/client/manifest' -UseBasicParsing -TimeoutSec 2
      $code = $r.StatusCode; if ($code -eq 200) { break }
    } catch { $code = 0 }
  }
  Check "本地后端零配置就绪（$ReadyTimeoutSec 秒内 200）" ($code -eq 200) "HTTP $code"
  if ($code -eq 200) {
    Info ('manifest: ' + ((Invoke-WebRequest 'http://127.0.0.1:3000/api/client/manifest' -UseBasicParsing).Content))
    try {
      $tele = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/telemetry/client-boot' -Method POST -ContentType 'application/json' `
        -Body '{"installId":"inst_verify","bootStatus":"bundledStarted","bootMs":1000}' -UseBasicParsing -TimeoutSec 5
      Check '埋点上报接口可达' ($tele.StatusCode -eq 200) "HTTP $($tele.StatusCode)"
    } catch { Check '埋点上报接口可达' $false $_.Exception.Message }
  }
  Stop-Process -Id $rp.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# ---------- [5] 真拉起 App：界面 + 模块来源 ----------
Say '' None
Say '--- [5/5] 拉起 App 并核对加载来源 ---' 'White'
$app = Start-Process -FilePath (Join-Path $root 'NEXTBOT.exe') -PassThru
Start-Sleep -Seconds 45
$alive = $null -ne (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)
Check 'App 进程存活 45 秒' $alive $(if ($alive) { "pid=$($app.Id) 窗口标题=" + $app.MainWindowTitle } else { '已退出' })
if ($alive) {
  $mods = (Get-Process -Id $app.Id -Module -ErrorAction SilentlyContinue).Modules |
    Where-Object { $_.ModuleName -match '^(msvcp140|vcruntime140)' }
  $fromPackage = @($mods | Where-Object { $_.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
  $fromSystem = @($mods | Where-Object { -not $_.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
  Check 'VC 运行库确实从包内加载' ($fromPackage.Count -gt 0) ("包内=$($fromPackage.Count) 系统=$($fromSystem.Count) " + (($fromPackage | ForEach-Object { $_.ModuleName }) -join ','))
  if ($fromSystem.Count) { Info ("系统目录来源: " + (($fromSystem | ForEach-Object { $_.FileName }) -join ' | ')) }
  Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -like "$root*") { Info "随包 runtime 进程 pid=$($_.Id) path=$($_.Path)" }
  }
  try {
    $h = (Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5).Content
    Info "App 自带后端 /health = $h"
  } catch { Info "App 自带后端 /health 读取失败：$($_.Exception.Message)" }
}
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $shot = Join-Path $OutDir 'screenshot.png'
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Info "截屏 = $shot"
} catch { Info "截屏失败：$($_.Exception.Message)" }
$crash = Join-Path $env:APPDATA 'Nextbot\pai_app_crash.log'
if (Test-Path $crash) { Copy-Item $crash (Join-Path $OutDir 'pai_app_crash.log') -Force; Info '崩溃日志已回收到 nb-verify\' }
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Say '' None
if ($fails.Count) {
  Say ("=== 结论：FAIL（$($fails.Count) 项）===") 'Red'
  foreach ($f in $fails) { Say ('  - ' + $f) 'Red' }
  exit 1
}
Say '=== 结论：PASS ===' 'Green'
Say ("报告全文：$report") 'Green'
