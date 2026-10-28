#Requires -Version 5.1
<#
.SYNOPSIS
  一键产出 Windows 安装包：客户端构建 → server dist → staging 组装 → Inno 编译。
.EXAMPLE
  .\build-installer.ps1 -Version 0.1.0 -UpdateManifestUrl https://login.nextbot.top
#>
param(
  [string]$Version = "0.1.0",
  # 版本控制面（ECS manifest），byok 形态 chat 仍走本地 runtime。
  # 必须 https://（80 已 301，烤 http 每次更新检查多付一次重定向 + 二次 TLS，弱网弹卡慢数秒）
  [string]$UpdateManifestUrl = "https://login.nextbot.top",
  # 控制面（管理后台所在服务器）：反馈/站内信等运营数据走这里。
  # 不烤入的话捆绑用户的反馈只会落在本机数据库，管理后台收不到。（同上必须 https）
  [string]$ControlPlaneUrl = "https://login.nextbot.top",
  # 客户端后端地址（编译期烤入）。构建会同时镜像出无 runtime\ 的 windows_dist\Release，
  # 该形态运行期禁止回落本地，漏烤即启动白屏，故不允许为空；仅产捆绑包走 build_windows.ps1。
  [string]$HttpBase = "http://127.0.0.1:3000",
  # 安装包默认搜索端点：运营方云端搜索代理（nginx :443 -> 主服务 /v1/search 路由，
  # key 只存云端，客户端零 key）。内测/公测发行搜索统一由运营方提供。
  # 必须 https://（80 已 301，明文要多付一次重定向 + 二次 TLS，弱网下更易被中间设备改写）
  [string]$SearchApiUrl = "https://nextbot.top/v1/search",
  # 搜索代理访问令牌：烤入 runtime\.env 的 SEARCH_API_KEY（authorization: Bearer），
  # 云端 ANYSEARCH_PROXY_ACCESS_TOKEN 校验——扫描器拿到端点无令牌 403。
  # 不写死在脚本里（历史版本把令牌提交进了仓库=人人可用）。取值优先级：
  #   -SearchApiToken 参数 > 环境变量 NEXTBOT_SEARCH_API_TOKEN > 本机 server\.env 的
  #   ANYSEARCH_PROXY_ACCESS_TOKEN。三者都没有且发行版是 internal 时直接失败。
  [string]$SearchApiToken = "",
  # staging 根目录：刻意用短路径，避开 node_modules 深路径 260 字符上限
  [string]$StageRootPath = "E:\NBStage",
  # Playwright 浏览器缓存源（打包机上的真实目录，装机后随包分发到 runtime\ms-playwright）
  # 默认自动探测：$env:PLAYWRIGHT_BROWSERS_PATH > %LOCALAPPDATA%\ms-playwright > D:\ms-playwright
  [string]$PlaywrightBrowsersPath = "",
  # ffmpeg.exe 来源目录（装机后落在 runtime\bin，供 code.shell 白名单命令调用）
  # 默认自动探测本机 PATH 上的 ffmpeg（解析 WinGet 符号链接到真实目录）
  [string]$FfmpegSourceDir = "",
  # 发行版本：internal=内测版（默认，能力全量，AppId/文件名同历史）；oss=开源版
  # （GitHub 发行）：烤 PAI_EDITION=oss、runtime\.env 写 NEXTBOT_EDITION=oss、
  # 独立 AppId 与 Nextbot-Setup-OSS.exe 文件名、跳过 travel-knowledge 种子。
  [ValidateSet('internal', 'oss')]
  [string]$Edition = "internal",
  [switch]$SkipClientBuild,
  [switch]$SkipServerBuild,
  # 代码签名证书指纹（SHA1）。留空 = 跳过签名（当前无证书的默认路径）；
  # 传值 = ISCC 之后用 signtool 给 Setup.exe 签名并校验。
  [string]$CertThumbprint = ""
)
$ErrorActionPreference = 'Stop'
# 开源版默认不烤云端控制面（GitHub 发行不依赖 ECS）；确要烤请显式传参
if ($Edition -eq 'oss') {
  if (-not $PSBoundParameters.ContainsKey('UpdateManifestUrl')) { $UpdateManifestUrl = '' }
  if (-not $PSBoundParameters.ContainsKey('ControlPlaneUrl')) { $ControlPlaneUrl = '' }
}
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$StageRoot = $StageRootPath
$FlutterApp = Join-Path $Repo 'client\flutter_app'
$StageApp = Join-Path $StageRoot 'app'
$StageRuntime = Join-Path $StageRoot 'runtime'

# ---- 构建期取值与依赖源探测（在 flutter build 之前失败，别等十分钟才报错）----

# .iss 的 VersionInfoVersion 只收数字段（Inno 会补 .0），带 -beta/+8 之类后缀直接编译失败
if ($Version -notmatch '^\d+(\.\d+){1,3}$') {
  throw "-Version 必须是纯数字版本号（如 0.1.6 或 0.1.6.8），当前是 `"$Version`""
}

# 漏烤 HTTP_BASE 会让无 runtime\ 的镜像目录启动白屏（api_config.dart 非捆绑 fail-fast）
if (-not $SkipClientBuild -and -not $HttpBase) {
  throw '-HttpBase 不能为空：安装包构建必须烤后端地址（默认 http://127.0.0.1:3000）。仅产出捆绑形态包请改用 build_windows.ps1 -HttpBase ''''。'
}

# 搜索令牌：参数 > 环境变量 NEXTBOT_SEARCH_API_TOKEN > 构建机 server\.env 的
# ANYSEARCH_PROXY_ACCESS_TOKEN（该文件 gitignore，令牌不进仓库）
if (-not $SearchApiToken) { $SearchApiToken = $env:NEXTBOT_SEARCH_API_TOKEN }
if (-not $SearchApiToken) {
  $localEnv = Join-Path $Repo 'server\.env'
  if (Test-Path $localEnv) {
    $line = Select-String -Path $localEnv -Pattern '^\s*ANYSEARCH_PROXY_ACCESS_TOKEN\s*=\s*(.+)$' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($line) { $SearchApiToken = $line.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'") }
  }
}
if (-not $SearchApiToken -and $Edition -eq 'internal') {
  throw '缺少搜索令牌：用 -SearchApiToken 传入，或设环境变量 NEXTBOT_SEARCH_API_TOKEN，或在构建机 server\.env 配 ANYSEARCH_PROXY_ACCESS_TOKEN。' +
    '（历史版本把令牌写死在本脚本里并提交进仓库，那个值已泄露，必须在云端轮换后重新注入）'
}

# Playwright 浏览器缓存：headless 抓取用的 chromium-headless-shell 从这里搬进包
$pwRev = (Get-Content (Join-Path $Repo 'node_modules\playwright-core\browsers.json') -Raw |
  ConvertFrom-Json).browsers | Where-Object { $_.name -eq 'chromium-headless-shell' } |
  Select-Object -First 1
if (-not $pwRev) { throw 'playwright-core/browsers.json 里找不到 chromium-headless-shell 版本' }
if (-not $PlaywrightBrowsersPath) {
  $PlaywrightBrowsersPath = @($env:PLAYWRIGHT_BROWSERS_PATH,
    (Join-Path $env:LOCALAPPDATA 'ms-playwright'),
    'D:\ms-playwright') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $PlaywrightBrowsersPath) { throw '未找到 Playwright 浏览器缓存目录（设 -PlaywrightBrowsersPath 或在构建机执行 npx playwright install chromium）' }
$pwShellDir = Join-Path $PlaywrightBrowsersPath "chromium_headless_shell-$($pwRev.revision)"
if (-not (Test-Path $pwShellDir)) {
  throw "浏览器缓存里缺 chromium_headless_shell-$($pwRev.revision)（与 playwright-core $($pwRev.revision) 不匹配）：在构建机执行 npx playwright install chromium"
}

# ffmpeg：装机的 code.shell 白名单命令靠它转码，构建机 PATH 上的真实二进制搬进包
if (-not $FfmpegSourceDir) {
  $ff = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
  if ($ff) {
    # WinGet 的 Links\ffmpeg.exe 是重解析点（Length=0），Resolve-Path 也不会跟随；
    # 必须取 Target 拿到包内真实二进制，否则拷进包的是 0 字节桩。
    $item = Get-Item $ff -Force
    $real = if ($item.Target) { [string]($item.Target | Select-Object -First 1) } else { $item.FullName }
    if (-not (Test-Path $real)) { $real = $item.FullName }
    $FfmpegSourceDir = Split-Path $real -Parent
  }
}
$ffmpegExe = if ($FfmpegSourceDir) { Join-Path $FfmpegSourceDir 'ffmpeg.exe' } else { $null }
if (-not $ffmpegExe -or -not (Test-Path $ffmpegExe)) {
  throw '未找到 ffmpeg.exe（设 -FfmpegSourceDir 或在构建机安装 ffmpeg）：内置浏览器的网页抓取不依赖它，但 code.shell 的转码能力依赖它。'
}
if ((Get-Item $ffmpegExe).Length -lt 1MB) {
  throw "ffmpeg.exe 只有 $((Get-Item $ffmpegExe).Length) 字节（$ffmpegExe 不是真实二进制）：用 -FfmpegSourceDir 指向含完整 ffmpeg.exe 的目录。"
}

Write-Host '== [1/5] 客户端 release 构建（委托 build_windows.ps1，单一构建入口）=='
if (-not $SkipClientBuild) {
  # 单一构建入口：build_windows.ps1 负责 HTTP_BASE 默认值、未烤入告警与构建前目录解锁
  Push-Location
  try {
    & (Join-Path $FlutterApp 'build_windows.ps1') -Configuration Release `
      -HttpBase $HttpBase -UpdateManifestUrl $UpdateManifestUrl `
      -ControlPlaneUrl $ControlPlaneUrl -Edition $Edition
    if ($LASTEXITCODE -ne 0) { throw "flutter build failed (exit=$LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

Write-Host '== [2/5] server 编译（含 workspace 包）=='
if (-not $SkipServerBuild) {
  & npm run build --prefix (Join-Path $Repo 'server')
  if ($LASTEXITCODE -ne 0) { throw 'server build failed' }
}

Write-Host '== [3/5] 组装 staging =='
# 深路径清理：node_modules 里超 MAX_PATH 的文件需 \\?\ 前缀才能删除
if (Test-Path $StageRoot) {
  & cmd /c "rmdir /s /q `"$StageRoot`""
  if (Test-Path $StageRoot) {
    Remove-Item -Recurse -Force -LiteralPath ('\\?\' + $StageRoot)
  }
}
New-Item -ItemType Directory -Force -Path $StageApp, $StageRuntime | Out-Null

# 3.1 Flutter 产物 + VC 运行库（本机 System32 同架构拷贝，免去 vc_redist 静默安装）
# 集合按包内全部原生二进制的 import 表取全：onnxruntime.dll 除 msvcp140/vcruntime140(_1)
# 外还要 msvcp140_1 与 msvcp140_atomic_wait，少一个是装机后本地向量引擎/声纹加载崩，
# 而构建机 System32 常带完整 redist，本地冒烟看不出来。
Copy-Item (Join-Path $FlutterApp 'build\windows\x64\runner\Release\*') $StageApp -Recurse -Force
foreach ($dll in 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll',
                 'vcruntime140.dll', 'vcruntime140_1.dll') {
  $src = Join-Path $env:windir "System32\$dll"
  if (-not (Test-Path $src)) { throw "构建机 System32 缺 $dll（VC++ 运行库不完整），无法保证干净机器加载原生模块" }
  Copy-Item $src $StageApp -Force
  # runtime 同拷：better_sqlite3/onnxruntime 的 .node 加载时按 DLL 搜索顺序只看
  # node.exe 所在目录（runtime\）→ System32，够不着 app\。
  Copy-Item $src $StageRuntime -Force
}

# 3.2 捆绑 node.exe：必须与仓库里已编译的原生模块 ABI 对齐。
# 不能盲取 PATH 第一个 node——开发机常并存多个大版本（22=ABI127 / 24=ABI137），
# 取错就是装机后启动即崩：better_sqlite3.node was compiled against a different
# Node.js version（NODE_MODULE_VERSION 137 vs 127）。这里改为「谁能真的 require
# 起来就用谁」，对将来换版本也自洽。
$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue).Source,
  'D:\nodejs\node.exe',
  "$env:ProgramFiles\nodejs\node.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$nodeExe = $null
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # 原生命令 stderr 在 EAP=Stop 下会变成终止错误
try {
  Push-Location $Repo
  foreach ($cand in $nodeCandidates) {
    # 必须真的 open 一个内存库：better-sqlite3 的 .node 在 new Database() 时才加载，
    # 只 require 包永远成功（踩过这个坑，自检会假通过）。
    & $cand -e "const D=require('better-sqlite3');const db=new D(':memory:');db.close()" *> $null
    if ($LASTEXITCODE -eq 0) { $nodeExe = $cand; break }
  }
  Pop-Location
} finally {
  $ErrorActionPreference = $prevEap
}
if (-not $nodeExe) { throw "未找到能加载 better-sqlite3 的 node.exe（候选：$($nodeCandidates -join ', ')）；请确认 node_modules 已按该版本编译或改用对应大版本" }
$nodeAbi = & $nodeExe -p "process.version + '/abi' + process.versions.modules"
Write-Host "bundled node: $nodeExe ($nodeAbi)" -ForegroundColor Green
Copy-Item $nodeExe (Join-Path $StageRuntime 'node.exe') -Force

# 3.3 node_modules：解引用复制（排除 @nextbot 软链，workspace 包单独按需拷）
# 必须经 cmd 原生管道：PowerShell 5.1 管道会按行解码，毁掉 tar 的二进制流
$repoPosix = ($Repo.Path -replace '\\', '/')
$stagePosix = ($StageRuntime -replace '\\', '/')
& cmd /c "tar -chf - -C $repoPosix --exclude=./node_modules/@nextbot --exclude=./node_modules/nextbot-server ./node_modules | tar -xf - -C $stagePosix"
if ($LASTEXITCODE -ne 0) { throw 'node_modules tar copy failed' }

# 3.4 workspace 包：只带运行时必需的 dist+package.json。dist 自包含（包内相对
# import 全部落在 dist 内，数据文件走 cwd\data），包根的 .ts 源码/config/deps/data
# 均为开发态产物——整目录拷贝等于把源码随安装包公开。.d.ts/.d.ts.map 运行时
# 不加载且描述 API 面，一并剥掉。
$nbDir = Join-Path $StageRuntime 'node_modules\@nextbot'
New-Item -ItemType Directory -Force -Path $nbDir | Out-Null
foreach ($pkg in 'agent-world', 'packages\agent-protocol', 'packages\picture') {
  $pkgDst = Join-Path $nbDir (Split-Path $pkg -Leaf)
  Copy-Item (Join-Path $Repo "$pkg\dist") (Join-Path $pkgDst 'dist') -Recurse -Force
  Copy-Item (Join-Path $Repo "$pkg\package.json") (Join-Path $pkgDst 'package.json') -Force
  Get-ChildItem $pkgDst -Recurse -Include '*.d.ts', '*.d.ts.map' -File | Remove-Item -Force
}

# 3.5 server 产物（dist + package.json[type:module] + config 默认清单）
Copy-Item (Join-Path $Repo 'server\dist') (Join-Path $StageRuntime 'dist') -Recurse -Force
Copy-Item (Join-Path $Repo 'server\package.json') (Join-Path $StageRuntime 'package.json') -Force
Copy-Item (Join-Path $Repo 'server\config') (Join-Path $StageRuntime 'config') -Recurse -Force

# 3.5.1 服务端静态页资产：dist 只装编译后的 js，页面本体在 server\web——聊天网页、
# 照片墙、行程地图 desktop/mobile.html。路由按 `dist/routes/http` 上三级解析
# （即 **runtime 根** 的 web\），所以必须整树落到 runtime\web；漏拷在装机环境里
# 表现为页面 404（打开行程页/照片墙直接空白）。顺带摇树：*.js.map 只服务调试
# （~4MB），装机包不带 sourcemap。
Copy-Item (Join-Path $Repo 'server\web') (Join-Path $StageRuntime 'web') -Recurse -Force
Get-ChildItem (Join-Path $StageRuntime 'web') -Recurse -File -Include '*.map' -ErrorAction SilentlyContinue | Remove-Item -Force

# 3.6 server 私有依赖：npm 工作区不会把全部依赖提升到根 node_modules
# （如 mem0ai、groq-sdk、@anthropic-ai/sdk 等只落在 server\node_modules），
# 漏拷会让 dist/index.js 启动即 ERR_MODULE_NOT_FOUND。拷到 dist\node_modules
# 使解析顺序（dist\node_modules → node_modules）与开发态（server\node_modules →
# 根）一致；不能与根拍平合并——zod/pg/redis 等在两处是不同版本，会互相覆盖。
if (Test-Path (Join-Path $Repo 'server\node_modules')) {
  $serverPosix = (Join-Path $Repo 'server') -replace '\\', '/'
  & cmd /c "tar -chf - -C $serverPosix node_modules | tar -xf - -C $stagePosix/dist"
  if ($LASTEXITCODE -ne 0) { throw 'server node_modules tar copy failed' }
}

# 3.6.5 本地向量引擎原生库裁剪：onnxruntime-node 随包带全平台二进制
# （darwin/linux/win32 × arm64/x64），捆绑版只跑 Windows x64，其余全删
# （省 ~150MB staging，安装包体积同步受益）。bin 下按 napi-vN 版本目录逐个裁。
foreach ($ortBin in (Join-Path $StageRuntime 'node_modules\onnxruntime-node\bin'),
                    (Join-Path $StageRuntime 'dist\node_modules\onnxruntime-node\bin')) {
  if (Test-Path $ortBin) {
    foreach ($napi in Get-ChildItem $ortBin -Directory) {
      Get-ChildItem $napi.FullName -Directory | Where-Object { $_.Name -ne 'win32' } | Remove-Item -Recurse -Force
      $winDir = Join-Path $napi.FullName 'win32'
      if (Test-Path $winDir) {
        Get-ChildItem $winDir -Directory | Where-Object { $_.Name -ne 'x64' } | Remove-Item -Recurse -Force
      }
    }
  }
}

# 3.6.6 摇树：剔掉只服务开发/构建期的工具链包。dist 是编译好的 JS，运行时永不
# import 它们（已全仓 grep 确认无 typescript/esbuild/vite/vitest 的运行时引用），
# 留着只是把 dev 工具链随安装包分发（tsc+esbuild+vite-node ≈ 47MB 原始体积）。
# tsx 一并剔：它是 esbuild 的前端封装，esbuild 走后包内那份 tsx 已是死包；而
# 代码修复皮层跑的是用户 PATH 里的 npx/tsc/tsx（shell:true），不读包内 tsx。
# 同批清掉 node_modules 里的 *.map：只服务调试，装机包不带 sourcemap。
foreach ($nmRoot in @($StageRuntime, (Join-Path $StageRuntime 'dist'))) {
  $nm = Join-Path $nmRoot 'node_modules'
  if (-not (Test-Path $nm)) { continue }
  foreach ($pkg in 'typescript', 'vitest', 'vite', 'vite-node', 'esbuild', 'tinypool', 'tsx', '@esbuild', '@vitest') {
    $target = Join-Path $nm $pkg
    if (Test-Path $target) {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath ('\\?\' + (Resolve-Path $target).Path)
    }
  }
  # .bin 里指向被删包的 shim 一并清掉，避免留下指向空目录的入口
  foreach ($shim in 'typescript', 'tsc', 'vitest', 'vite', 'vite-node', 'esbuild', 'tsx') {
    Get-ChildItem (Join-Path $nm '.bin') -Filter "$shim.*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem $nm -Recurse -File -Include '*.map' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

# 3.7 本地内置向量引擎模型资产（零配置记忆底座）：bge-small-zh-v1.5 int8 ONNX
# （~24MB，512 维）。dev 在 server\models\bge-small-zh-v1.5，捆绑为 runtime\models\
# bge-small-zh-v1.5——引擎按模块相对路径解析（dist/agentic-memory/local-embedding
# 上三级即 runtime 根），与 load-server-env 的 serverRoot 口径一致。
Copy-Item (Join-Path $Repo 'server\models\bge-small-zh-v1.5') (Join-Path $StageRuntime 'models\bge-small-zh-v1.5') -Recurse -Force

# 3.7.1 说话人向量模型（声纹底座）：3D-Speaker CAM++ 中文版 ONNX（~28MB，192 维，
# CN-Celeb+CN-Common ~20 万说话人）。与 bge 同目录约定（runtime\models\speaker-campplus-zh）。
# 2026-10-03 由 wespeaker cnceleb_resnet34 升级；换模型=换向量空间，旧声纹全部作废。
Copy-Item (Join-Path $Repo 'server\models\speaker-campplus-zh') (Join-Path $StageRuntime 'models\speaker-campplus-zh') -Recurse -Force

# 3.8 旅行知识种子数据（68KB）：travel 技能的离线底座（poi/坐标/目的地/国内关键词）。
# 知识库读 cwd\data\travel-knowledge，捆绑 runtime 的 cwd 就是 runtime 目录，路径正好对上；
# 拷在冒烟之前，让门禁实跑时顺带验证真实加载。开源版剔除 travel 家族，种子一并跳过。
#
# **只拷 travel-knowledge，绝不整目录拷 data/**：travel-media/assets 是运行期回填出来的
# 图片资产（2026-10-12 存量一度 766MB / 1964 张），它属于用户数据不是随包资产——整目录
# 拷进 staging 就是几百 MB 的安装包。回填能力在代码里，用户首次规划时按需生成。
if ($Edition -ne 'oss') {
  Copy-Item (Join-Path $Repo 'server\data\travel-knowledge') (Join-Path $StageRuntime 'data\travel-knowledge') -Recurse -Force
}

# 3.8.1 staging 体积防线：media 资产绝不能进包。这里不是"清理"而是"断言"——
# 上面若有朝一日改成整目录拷 data/，这里会当场炸掉，而不是等到用户下载完才发现。
$leakedMedia = @('travel-media', 'tile-cache') | Where-Object {
  Test-Path (Join-Path $StageRuntime "data\$_")
}
if ($leakedMedia) {
  throw "staging 混入了运行期媒体资产（$($leakedMedia -join ', ')）——它们不该随安装包分发，请只拷 travel-knowledge"
}

# 3.8.2 Playwright headless 浏览器：内置浏览器的 WebView2 不可用/无界面抓取走
# playwright chromium.launch({headless:true})，它解析到 chromium-headless-shell，
# 可执行文件不在包里的话，干净机器上直接
# "Executable doesn't exist…请执行 npx playwright install chromium"（构建机有全局
# PLAYWRIGHT_BROWSERS_PATH 所以从没暴露过）。只带 chromium-headless-shell（227MB，
# 抓取全部 headless，不需要 413MB 的完整 chromium，也不需要 recordVideo 用的 ffmpeg-1011）。
# 落 runtime\ms-playwright\，runtime\.env 里 PLAYWRIGHT_BROWSERS_PATH=ms-playwright。
$pwDst = Join-Path $StageRuntime "ms-playwright\chromium_headless_shell-$($pwRev.revision)"
Copy-Item $pwShellDir $pwDst -Recurse -Force
# 语言包裁剪：headless 抓取只用得上中英文（220 个 .pak，43MB → ~1MB）
$locDir = Join-Path $pwDst 'chrome-headless-shell-win64\locales'
if (Test-Path $locDir) {
  Get-ChildItem $locDir -File | Where-Object { $_.Name -notmatch '^(en-GB|en-US|zh-CN)\.pak(\.info)?$' } |
    Remove-Item -Force
}

# 3.8.3 ffmpeg：code.shell 白名单里 advertise 了转码能力，干净机器上没有 ffmpeg
# 就是"模型说它会、实际一调就 ENOENT"。带单文件静态版（无 ffprobe：全仓无代码调用，
# 探针用 `ffmpeg -i` 足够），由 load-server-env 把 runtime\bin 前置进子进程 PATH。
$binDst = Join-Path $StageRuntime 'bin'
New-Item -ItemType Directory -Force -Path $binDst | Out-Null
Copy-Item $ffmpegExe (Join-Path $binDst 'ffmpeg.exe') -Force
# 拷完必须验体积：WinGet 的 Links\ffmpeg.exe 是重解析点，源头没解析好时这里只会
# 落一个 0 字节桩——装机后 code.shell 一调就崩，比不打包更坏。
$stagedFfmpegBytes = (Get-Item (Join-Path $binDst 'ffmpeg.exe')).Length
if ($stagedFfmpegBytes -lt 1MB) {
  throw "staging 里的 ffmpeg.exe 只有 $stagedFfmpegBytes 字节（源头 $ffmpegExe 是符号链接桩？）：用 -FfmpegSourceDir 指向真实 bin 目录"
}
Write-Host ("  ffmpeg.exe 入包 " + [math]::Round($stagedFfmpegBytes / 1MB, 1) + " MB")

# 3.9 runtime\.env：搜索 API 默认走运营方云端搜索代理（key 只存云端，客户端零 key
# 零配置），内测/开源两版一致——搜索由运营方统一提供。开源版追加 NEXTBOT_EDITION=oss
# （服务端版本闸的唯一开关，loadServerEnv 从 runtime 根读 .env）。
# UPDATE_MANIFEST_SOURCE_URL：本地 runtime 从更新控制面拉客户端版本清单，
# 变化沿本地 wss 推 update.available（客户端 0.1.4+ 处理；edition 不设 = byok 主清单）。
$searchEnvLines = @(
  "SEARCH_API_PROVIDER=anysearch",
  "ANYSEARCH_ENDPOINT=$SearchApiUrl",
  "PLAYWRIGHT_BROWSERS_PATH=ms-playwright"
)
if ($SearchApiToken) { $searchEnvLines += "SEARCH_API_KEY=$SearchApiToken" }
if ($UpdateManifestUrl) {
  $searchEnvLines += "UPDATE_MANIFEST_SOURCE_URL=$UpdateManifestUrl"
}
if ($Edition -eq 'oss') {
  $searchEnvLines = @("NEXTBOT_EDITION=oss") + $searchEnvLines
}
# 注意 PowerShell 5.1 的 utf8 带 BOM，Node JSON.parse 会炸，故用 ascii（内容全 ASCII）
Set-Content -Path (Join-Path $StageRuntime '.env') -Value $searchEnvLines -Encoding ascii
if ($Edition -eq 'oss') {
  $ossManifest = [ordered]@{
    latest     = $Version
    minVersion = $Version
    url        = ''
    notes      = "Open Source Edition $Version"
    channel    = 'byok'
  }
  # 注意 PowerShell 5.1 的 utf8 带 BOM，Node JSON.parse 会炸，故用 ascii（内容全 ASCII）
  $ossManifest | ConvertTo-Json | Set-Content -Path (Join-Path $StageRuntime 'config\client-manifest.oss.json') -Encoding ascii
}

Write-Host '== [4/5] 校验关键文件 =='
foreach ($f in (Join-Path $StageApp 'NEXTBOT.exe'),
               (Join-Path $StageRuntime 'node.exe'),
               (Join-Path $StageRuntime 'dist\index.js'),
               (Join-Path $StageRuntime 'node_modules\@nextbot\agent-world\dist'),
               (Join-Path $StageRuntime 'node_modules\onnxruntime-node\bin\napi-v6\win32\x64'),
               (Join-Path $StageRuntime 'models\bge-small-zh-v1.5\model_quantized.onnx'),
               (Join-Path $StageRuntime 'models\bge-small-zh-v1.5\vocab.txt'),
               (Join-Path $StageRuntime 'models\speaker-campplus-zh\campplus_zh_cn_common_200k.onnx'),
               (Join-Path $StageRuntime "ms-playwright\chromium_headless_shell-$($pwRev.revision)\chrome-headless-shell-win64\chrome-headless-shell.exe"),
               (Join-Path $StageRuntime 'bin\ffmpeg.exe'),
               (Join-Path $StageRuntime 'package.json')) {
  if (-not (Test-Path $f)) { throw "staging 缺少关键文件: $f" }
}

# 控制面/版本清单地址烤入门禁：flutter build 漏传 --dart-define 时客户端静默回落
# httpBase(本地)，用户反馈落本机库、后台永远收不到（0.2.1 实际翻车过）。
# app.so 是 Dart AOT 快照，dart-define 字符串常量以明文 ASCII 存于其中，可直接搜。
$stagedSo = Join-Path $StageApp 'data\app.so'
if (-not (Test-Path $stagedSo)) { throw "staging 缺少 app.so: $stagedSo" }
$soText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($stagedSo))
foreach ($ctrlUrl in @($UpdateManifestUrl, $ControlPlaneUrl)) {
  if (-not $ctrlUrl) {
    # 空值是有意的本地联调，但必须在日志留痕，避免门禁静默放行
    Write-Host 'WARNING: 本次未烤入控制面地址，更新检查/用户反馈将回落 httpBase（只落本机库）' -ForegroundColor Yellow
    continue
  }
  $ctrlHost = ([uri]$ctrlUrl).Host
  if ($ctrlHost -and -not $soText.Contains($ctrlHost)) {
    throw "发版门禁失败：app.so 未烤入 $ctrlUrl —— 客户端将回落本地，反馈/更新检查失联。" +
      "请确认 [1/5] 的 build_windows.ps1 收到对应参数（勿用 SkipClientBuild 跳过带参构建）。"
  }
}
# 非本机 HTTP_BASE 可明文校验；127.0.0.1 与回落字面量同形无法区分，靠构建期非空 throw 兜底
if ($HttpBase) {
  $hbHost = ([uri]$HttpBase).Host
  if ($hbHost -and $hbHost -notmatch '^(127\.0\.0\.1|localhost)$' -and -not $soText.Contains($hbHost)) {
    throw "发版门禁失败：app.so 未烤入 HTTP_BASE=$HttpBase —— 非捆绑镜像目录启动即白屏。"
  }
}
Write-Host '控制面地址烤入校验通过' -ForegroundColor Green

Write-Host '== [4.5/5] runtime 启动冒烟（按装机布局实跑，健康检查通过才算数）=='
# 文件存在性校验发现不了缺包/缺目录——0.2.0 曾因 server\node_modules 漏拷而在
# 用户机器上启动即崩。这里以与客户端 LocalRuntimeManager 相同的方式实跑一次：
# 起服务 → 轮询 /api/client/manifest → 通过后杀进程并清掉冒烟产生的运行期目录。
$smokePort = 3199  # 避开开发常驻的 3000；被占用会超时失败，属可接受的误报
$smokeLog = Join-Path $StageRoot 'runtime-smoke.log'
$env:PORT = "$smokePort"
# 冒烟必须走零配置路径：清掉开发 shell 可能残留的远端 Embedding 变量，
# 否则本地向量引擎不点亮，上面的 [local-embedding] 断言会假失败。
# 再放一个占位对话 key（过 OpenAI SDK 构造，冒烟不发真实对话请求），
# 让 agentic-memory 运行时能在冒烟环境完整装配。
Remove-Item Env:OPENAI_API_KEY, Env:OPENAI_BASE_URL, Env:AGENT_EMBEDDING_API_KEY, Env:AGENT_EMBEDDING_BASE_URL, Env:OPENAI_EMBEDDINGS_URL -ErrorAction SilentlyContinue
$env:OPENAI_API_KEY = 'sk-smoke-0000000000000000000'
# 起冒烟进程不用 Start-Process：PS 5.1 会先把环境变量塞进一个**大小写敏感**的
# 字典再传给子进程，而 Windows 环境块允许同时存在 HTTPS_PROXY 与 https_proxy
# （Clash / v2ray 一类代理软件常见写法），此时直接抛
# 「已添加项。字典中的关键字:"HTTPS_PROXY"所添加的关键字:"https_proxy"」——
# 冒烟还没开始就假失败（0.3.x 发版翻过车）。改用 .NET ProcessStartInfo：
# 它的 EnvironmentVariables 是大小写不敏感的 StringDictionary，等价变量只留一个。
# 输出用异步读干，避免子进程写满 4K 管道后阻塞在 write 上。
$smokePsi = New-Object System.Diagnostics.ProcessStartInfo
$smokePsi.FileName = Join-Path $StageRuntime 'node.exe'
$smokePsi.Arguments = 'dist\index.js'
$smokePsi.WorkingDirectory = $StageRuntime
$smokePsi.UseShellExecute = $false
$smokePsi.CreateNoWindow = $true
$smokePsi.RedirectStandardOutput = $true
$smokePsi.RedirectStandardError = $true
$smokeProc = [System.Diagnostics.Process]::Start($smokePsi)
$smokeOutTask = $smokeProc.StandardOutput.ReadToEndAsync()
$smokeErrTask = $smokeProc.StandardError.ReadToEndAsync()
Remove-Item Env:PORT -ErrorAction SilentlyContinue
$ready = $false
$smokeManifestUri = "http://127.0.0.1:$smokePort/api/client/manifest"
if ($Edition -eq 'oss') { $smokeManifestUri = "$smokeManifestUri?edition=oss" }
foreach ($i in 1..50) {
  Start-Sleep -Milliseconds 800
  if ($smokeProc.HasExited) { break }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $smokeManifestUri
    if ($res.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
& cmd /c "taskkill /T /F /PID $($smokeProc.Id) >nul 2>&1"
$null = $smokeProc.WaitForExit(8000)
# 落盘供失败时排查（.NET 路径没有 -RedirectStandardOutput，这里手工写回）。
# 必须在任何 throw 之前完成——否则「服务启动即退出」这种最该看日志的失败
# 恰恰拿不到日志（taskkill 找不到 PID 会被 EAP=Stop 当成终止错误）。
try {
  [System.IO.File]::WriteAllText($smokeLog, [string]$smokeOutTask.Result)
  [System.IO.File]::WriteAllText("$smokeLog.err", [string]$smokeErrTask.Result)
} catch {}
if (-not $ready) {
  Write-Host '--- 冒烟 stdout（尾部）---'
  Get-Content $smokeLog -Tail 40 -ErrorAction SilentlyContinue
  Write-Host '--- 冒烟 stderr（尾部）---'
  Get-Content "$smokeLog.err" -Tail 40 -ErrorAction SilentlyContinue
  throw 'runtime 启动冒烟失败：捆绑布局下服务未通过健康检查'
}
# 零配置记忆底座断言：捆绑冒烟环境无任何远端 Embedding 配置，内置向量引擎
# 必须自动点亮——模型资产/原生库/解析路径任何一环断了都会在这里暴露。
$smokeTextAll = (Get-Content $smokeLog -Raw -ErrorAction SilentlyContinue) + (Get-Content "$smokeLog.err" -Raw -ErrorAction SilentlyContinue)
if (-not $smokeTextAll.Contains('[local-embedding]')) {
  Write-Host '--- 冒烟 stdout（尾部）---'
  Get-Content $smokeLog -Tail 40 -ErrorAction SilentlyContinue
  throw '捆绑门禁失败：冒烟日志未出现 [local-embedding] 横幅，本地向量引擎未随包点亮（检查 models 资产与 onnxruntime-node 裁剪）'
}
if ($smokeTextAll.Contains('内置向量引擎不可用')) {
  throw '捆绑门禁失败：本地向量引擎装载失败（模型缺失或 ONNX 会话创建异常），详见冒烟日志'
}
if (-not $smokeTextAll.Contains('Mem0 OSS runtime ready')) {
  Write-Host '--- 冒烟 stdout（尾部）---'
  Get-Content $smokeLog -Tail 40 -ErrorAction SilentlyContinue
  throw '捆绑门禁失败：agentic-memory 运行时未就绪（零配置记忆底座未装配成功），详见冒烟日志'
}
# 开源版加一道版本闸生效断言：启动横幅必须打出 NEXTBOT_EDITION=oss
# （证明 runtime\.env 被 loadServerEnv 真实加载，capability-modules/路由/技能闸全链生效）
if ($Edition -eq 'oss') {
  $smokeText = (Get-Content $smokeLog -Raw -ErrorAction SilentlyContinue) + (Get-Content "$smokeLog.err" -Raw -ErrorAction SilentlyContinue)
  if (-not $smokeText.Contains('NEXTBOT_EDITION=oss')) {
    Write-Host '--- 冒烟 stdout（尾部）---'
    Get-Content $smokeLog -Tail 40 -ErrorAction SilentlyContinue
    throw '开源版门禁失败：冒烟日志未出现 [edition] NEXTBOT_EDITION=oss 横幅，版本闸未生效'
  }
}
Remove-Item $smokeLog, "$smokeLog.err" -Force -ErrorAction SilentlyContinue
# 清掉冒烟实跑产生的运行期垃圾（poi-cache、持久化文件、日志），但保留 3.7 拷入的
# travel-knowledge 种子数据——那是随包分发的资产，不是运行期产物（开源版无此项）
$dataDir = Join-Path $StageRuntime 'data'
foreach ($child in Get-ChildItem $dataDir -ErrorAction SilentlyContinue) {
  if ($child.Name -ne 'travel-knowledge') {
    Remove-Item $child.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
foreach ($dir in 'logs') {
  Remove-Item (Join-Path $StageRuntime $dir) -Recurse -Force -ErrorAction SilentlyContinue
}
if ($Edition -ne 'oss' -and -not (Test-Path (Join-Path $dataDir 'travel-knowledge\poi-db.json'))) {
  throw 'staging 缺少 travel-knowledge 种子数据'
}
Write-Host 'runtime 启动冒烟通过' -ForegroundColor Green

# 4.6 零配置启动门禁（2026-10-21 加）：4.5 那轮注入了占位 key（sk-smoke-…），
# 恰好把「用户没配 key 时服务在装配期 abort」这个 P0 永久掩盖了 —— 绿色版在
# 新机器上 3000 永不监听、客户端永远连不上，而打包门禁一路绿灯。
# 真实首启（config.env 尚不存在、客户端注入空配置）就是零 key，这里必须复现。
Write-Host '== [4.6/5] 零配置启动门禁（不注入任何模型 key）=='
Remove-Item Env:OPENAI_API_KEY, Env:OPENAI_BASE_URL, Env:MOONSHOT_API_KEY, `
  Env:MINIMAX_API_KEY, Env:AGENT_EMBEDDING_API_KEY, Env:AGENT_EMBEDDING_BASE_URL -ErrorAction SilentlyContinue
$zeroLog = Join-Path $StageRoot 'runtime-smoke-zerokey.log'
$env:PORT = "$smokePort"
$zeroPsi = New-Object System.Diagnostics.ProcessStartInfo
$zeroPsi.FileName = Join-Path $StageRuntime 'node.exe'
$zeroPsi.Arguments = 'dist\index.js'
$zeroPsi.WorkingDirectory = $StageRuntime
$zeroPsi.UseShellExecute = $false
$zeroPsi.CreateNoWindow = $true
$zeroPsi.RedirectStandardOutput = $true
$zeroPsi.RedirectStandardError = $true
$zeroProc = [System.Diagnostics.Process]::Start($zeroPsi)
$zeroOutTask = $zeroProc.StandardOutput.ReadToEndAsync()
$zeroErrTask = $zeroProc.StandardError.ReadToEndAsync()
Remove-Item Env:PORT -ErrorAction SilentlyContinue
$zeroReady = $false
foreach ($i in 1..75) {
  Start-Sleep -Milliseconds 800
  if ($zeroProc.HasExited) { break }
  try {
    $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $smokeManifestUri
    if ($res.StatusCode -eq 200) { $zeroReady = $true; break }
  } catch {}
}
& cmd /c "taskkill /T /F /PID $($zeroProc.Id) >nul 2>&1"
$null = $zeroProc.WaitForExit(8000)
try {
  [System.IO.File]::WriteAllText($zeroLog, [string]$zeroOutTask.Result)
  [System.IO.File]::WriteAllText("$zeroLog.err", [string]$zeroErrTask.Result)
} catch {}
if (-not $zeroReady) {
  Write-Host '--- 零配置冒烟 stdout（尾部）---'
  Get-Content $zeroLog -Tail 40 -ErrorAction SilentlyContinue
  Write-Host '--- 零配置冒烟 stderr（尾部）---'
  Get-Content "$zeroLog.err" -Tail 40 -ErrorAction SilentlyContinue
  throw '零配置启动门禁失败：未注入任何模型 key 时服务未通过健康检查 —— 新用户首启（config.env 尚不存在）必然复现「界面能开但本地后端永不就绪」。检查是否有启动期依赖在缺配置时 throw（装配期 throw 会变成 uncaughtException，进程 abort，3000 从不监听）。'
}
Write-Host '零配置启动门禁通过（无 key 也能 health 200）' -ForegroundColor Green
# 清掉本轮产生的运行期垃圾（与 4.5 同口径，保留 travel-knowledge 种子）
foreach ($child in Get-ChildItem $dataDir -ErrorAction SilentlyContinue) {
  if ($child.Name -ne 'travel-knowledge') {
    Remove-Item $child.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
foreach ($dir in 'logs') {
  Remove-Item (Join-Path $StageRuntime $dir) -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item $zeroLog, "$zeroLog.err" -Force -ErrorAction SilentlyContinue

Write-Host '== [4.7/5] 捆绑浏览器门禁（用包内 node 真的起一次 headless Chromium）=='
# 文件存在性校验发现不了"二进制带上了但起不来"（缺 DLL / 版本与 playwright-core 不匹配
# / 目录名不对导致解析不到）。这里按装机布局真起一次并渲染一段 HTML。
$pwStagedBrowserDir = Join-Path $StageRuntime 'ms-playwright'
$prevPwPath = $env:PLAYWRIGHT_BROWSERS_PATH
$prevPwDebug = $env:DEBUG
$env:PLAYWRIGHT_BROWSERS_PATH = $pwStagedBrowserDir
# headless:true 起的是 chromium_headless_shell，不是 executablePath() 报的完整
# chromium——DEBUG 的 <launching> 行是唯一可靠的「真起了哪个二进制」证据。
$env:DEBUG = 'pw:browser*'
$pwProbe = @'
import('playwright').then(async (m) => {
  const b = await m.chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.setContent('<h1 id="t">nextbot</h1>');
  const t = await p.textContent('#t');
  console.log('BROWSER_OK ' + (await b.version()) + ' text=' + t);
  await b.close();
}).catch((e) => { console.error('BROWSER_FAIL ' + (e && e.message ? e.message : e)); process.exit(1); });
'@
# 同 3.2：native 命令的 stderr 在 EAP=Stop 下会被当成终止错误（chromium 常往
# stderr 写警告），临时降级再还原。
$prevEap2 = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $StageRuntime
$pwProbeOut = & (Join-Path $StageRuntime 'node.exe') --input-type=module -e $pwProbe 2>&1
$pwProbeExit = $LASTEXITCODE
Pop-Location
$ErrorActionPreference = $prevEap2
if ($prevPwPath) { $env:PLAYWRIGHT_BROWSERS_PATH = $prevPwPath } else { Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue }
if ($prevPwDebug) { $env:DEBUG = $prevPwDebug } else { Remove-Item Env:DEBUG -ErrorAction SilentlyContinue }
# 不能用 Out-String：它按控制台宽度折行，会把 <launching> 的路径拦腰截断。
$pwProbeText = (($pwProbeOut | ForEach-Object { $_.ToString() }) -join "`n")
if ($pwProbeExit -ne 0 -or -not $pwProbeText.Contains('BROWSER_OK') -or -not $pwProbeText.Contains('text=nextbot')) {
  Write-Host '--- 浏览器门禁输出 ---'
  Write-Host (($pwProbeText -split "`n" | Where-Object { $_ -match 'BROWSER_|launching|Error|error' } | Select-Object -First 8) -join "`n")
  throw '捆绑门禁失败：包内 headless Chromium 未能启动/渲染（内置浏览器的无界面抓取与网页读页在装机环境不可用）'
}
# 探针起的外部浏览器（构建机全局缓存）等于没验：必须落在 staging 的 ms-playwright 下。
$pwLaunchMatch = [regex]::Match($pwProbeText, '<launching> (.+?)(?: --|$)')
$pwSpawnExe = if ($pwLaunchMatch.Success) { $pwLaunchMatch.Groups[1].Value.Trim() } else { '' }
if (-not $pwSpawnExe.StartsWith($pwStagedBrowserDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Host '--- 浏览器门禁输出 ---'
  Write-Host (($pwProbeText -split "`n" | Where-Object { $_ -match 'launching|BROWSER_' } | Select-Object -First 4) -join "`n")
  throw "捆绑门禁失败：探针起的是包外浏览器「$pwSpawnExe」，包内 ms-playwright 没被用上"
}
Write-Host "  包内浏览器实测可用：$pwSpawnExe" -ForegroundColor Green
Write-Host ($pwProbeText.Trim()) -ForegroundColor Green

Write-Host '== [5/5] Inno 编译 =='
$iscc = @('C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Users\Administrator\AppData\Local\Programs\Inno Setup 6\ISCC.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw '未找到 ISCC.exe，请安装 Inno Setup 6' }
$issArgs = @((Join-Path $Repo 'installer\nextbot.iss'), "/DAppVersion=$Version", "/DStage=$StageRoot", "/DEdition=$Edition")
if ($CertThumbprint) { $issArgs += '/DSignedSetup=1' }
& $iscc @issArgs
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

$setupName = if ($Edition -eq 'oss') { 'Nextbot-Setup-OSS.exe' } else { 'Nextbot-Setup.exe' }
$out = Join-Path $Repo "windows_dist\installer\$setupName"

# ---- 代码签名（预留位，无证书时跳过并如实警告）----
# 之前所有包都是「无人签名」的：下载被浏览器拦（SmartScreen/信誉）、被杀软报，
# 用户侧根本装不上。真正解法只有 OV/EV 证书（EV 直接免信誉期）。拿到证书后用
# -CertThumbprint 走这条路径；届时也建议顺手签 app\NEXTBOT.exe 与 runtime\bin。
if ($CertThumbprint) {
  $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
  if (-not $signtool) {
    $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $signtool) { throw "指定了 -CertThumbprint 但找不到 signtool.exe（需安装 Windows SDK）" }
  & $signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 $CertThumbprint $out
  if ($LASTEXITCODE -ne 0) { throw "signtool 签名失败（exit=$LASTEXITCODE）" }
  & $signtool verify /pa /v $out
  if ($LASTEXITCODE -ne 0) { throw '签名校验失败' }
  Write-Host "已签名并校验：$CertThumbprint" -ForegroundColor Green
} else {
  Write-Host '警告：本次未签名（无证书）。下载侧仍可能触发 SmartScreen「未知发布者」拦截；' -ForegroundColor Yellow
  Write-Host '      拿到代码签名证书后加 -CertThumbprint <SHA1> 重新出包即可。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "安装包产出: $out" -ForegroundColor Green
Write-Host ("大小: {0:N1} MB" -f ((Get-Item $out).Length / 1MB))
$sigState = (Get-AuthenticodeSignature $out).Status
if ($sigState -eq 'Valid') {
  Write-Host "签名: 有效（$((Get-AuthenticodeSignature $out).SignerCertificate.Subject)）" -ForegroundColor Green
} else {
  Write-Host "签名: $sigState —— 未签名的包在浏览器下载与 SmartScreen 处会被拦，出正式包必须带 -CertThumbprint" -ForegroundColor Yellow
}
