#Requires -Version 5.1
<#
.SYNOPSIS
  Nextbot 本地后端拉起自检（绿色版 / zip 解压版专用）。

.DESCRIPTION
  放置位置：private_ai_agent.exe 的同级目录。
  运行方式：双击同目录的「诊断后端.bat」，或对本文件右键「使用 PowerShell 运行」。

  回答一个问题：客户端为什么没能把本地后端拉起来。
  按 LocalRuntimeManager 的真实判据逐项复现：
    1) isBundled 两件套（exe 同级 runtime\node.exe + runtime\dist\index.js）
    2) 运行期依赖是否完整（zip 解压丢文件 / 深路径截断的高发区）
    3) 3000 端口是否被别的程序占着
    4) 真按客户端的方式冷启动一次，量耗时、抓失败原因
#>
param(
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Definition)
)

$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.Generic.List[string]

function Say {
  param([string]$Msg, [string]$Color = 'Gray')
  Write-Host $Msg -ForegroundColor $Color
  $report.Add($Msg)
}
function Verdict {
  param([bool]$Ok, [string]$Title, [string]$Detail = '')
  if ($Ok) { Say "  [OK]   $Title" 'Green' }
  else { Say "  [FAIL] $Title" 'Red' }
  if ($Detail) { Say "         $Detail" 'DarkGray'; }
}

Say ''
Say '================ Nextbot 本地后端拉起自检 ================' 'Cyan'
Say "检查目录: $Root"
Say "时间:     $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "系统:     $([System.Environment]::OSVersion.VersionString)"
Say ''

$exe = Join-Path $Root 'private_ai_agent.exe'
$runtime = Join-Path $Root 'runtime'
$node = Join-Path $runtime 'node.exe'
$entry = Join-Path $runtime 'dist\index.js'
$fatal = $false

# ---------- 1. isBundled 判据（客户端拉后端的唯一开关） ----------
Say '[1] 客户端拉起判据（LocalRuntimeManager.isBundled）' 'Yellow'
$hasExe = Test-Path $exe
$hasNode = Test-Path $node
$hasEntry = Test-Path $entry
Verdict $hasExe 'private_ai_agent.exe 存在'
Verdict $hasNode 'runtime\node.exe 存在'
Verdict $hasEntry 'runtime\dist\index.js 存在'

if (-not $hasExe) {
  Say '  >> 当前目录不是应用根目录，请把本脚本放到 private_ai_agent.exe 旁边再运行。' 'Red'
  Say ''
  $out = Join-Path $Root 'runtime-diagnose-report.txt'
  [System.IO.File]::WriteAllLines($out, $report, [System.Text.UTF8Encoding]::new($true))
  try { Read-Host '按回车退出' } catch { }
  exit 1
}
if (-not ($hasNode -and $hasEntry)) {
  $fatal = $true
  Say '  >> isBundled = false：客户端会静默跳过拉起本地后端（ensureRunning 直接 return true）。' 'Red'
  Say '     典型成因：zip 里只有 app 目录，或从压缩包内部直接双击运行（exe 被解到临时目录）。' 'Red'
}
Say ''

# ---------- 2. 运行期依赖完整性 ----------
Say '[2] 运行期依赖完整性（zip 解压丢文件高发区）' 'Yellow'
$required = @(
  @{ P = 'runtime\package.json'; D = '模块类型声明（缺了会 ERR_MODULE_NOT_FOUND）' },
  @{ P = 'runtime\.env'; D = '随包配置（edition / 更新通道）' },
  @{ P = 'runtime\config'; D = '默认配置清单' },
  @{ P = 'runtime\web'; D = '服务端静态页（行程地图 / 照片墙）' },
  @{ P = 'runtime\node_modules'; D = '根依赖' },
  @{ P = 'runtime\dist\node_modules'; D = 'server 私有依赖（mem0ai / groq-sdk 等）' },
  @{ P = 'runtime\models\bge-small-zh-v1.5'; D = '本地向量模型' }
)
foreach ($r in $required) {
  Verdict (Test-Path (Join-Path $Root $r.P)) $r.P $r.D
}

$fileCount = (Get-ChildItem -LiteralPath $runtime -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $runtime -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Say "  runtime 实际规模: $fileCount 个文件 / $sizeMb MB（完整包约 32000+ 文件 / 600+ MB）" 'DarkGray'
if ($fileCount -lt 20000) {
  $fatal = $true
  Say '  >> 文件数明显偏少，zip 解压不完整（长路径 / 编码 / 压缩包损坏）。请换 7-Zip 重新解压到短路径。' 'Red'
}
Say ''

# ---------- 3. 路径深度 ----------
Say '[3] 路径深度（Windows MAX_PATH 260 限制）' 'Yellow'
$longest = Get-ChildItem -LiteralPath $runtime -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 1
if ($longest) {
  $len = $longest.FullName.Length
  Verdict ($len -lt 240) "最长路径 $len 字符" $longest.FullName
  if ($len -ge 240) {
    $fatal = $true
    Say '  >> 已逼近 260 上限，深层 node_modules 极可能在解压时被丢弃。请解压到更短的路径（如 D:\Nextbot）。' 'Red'
  }
}
Say ''

# ---------- 4. Mark-of-the-Web ----------
Say '[4] 网络下载标记（Mark-of-the-Web）' 'Yellow'
$motw = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('private_ai_agent.exe', 'node.exe', 'flutter_windows.dll') } |
  ForEach-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }
if ($motw) {
  Say '  [WARN] 部分主文件带 Zone.Identifier（下载自网络）' 'Yellow'
  Say '         exe 可能弹 SmartScreen，原生 .node 模块可能被安全软件拦截。' 'DarkGray'
  Say '         处理：对 zip 右键「属性」勾选「解除锁定」后再解压。' 'DarkGray'
} else {
  Say '  [OK]   未发现下载标记' 'Green'
}
Say ''

# ---------- 5. 端口占用 ----------
Say '[5] 3000 端口占用' 'Yellow'
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  foreach ($c in $busy) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Say "  [WARN] 3000 已被占用: pid $($c.OwningProcess) $($p.ProcessName) $($p.Path)" 'Yellow'
  }
  Say '         后端会 EADDRINUSE 启动失败，或客户端连到了别的服务。' 'DarkGray'
} else {
  Say '  [OK]   3000 空闲' 'Green'
}
Say ''

# ---------- 6. 冷启动实测 ----------
Say '[6] 按客户端的方式冷启动一次（最多等 60 秒）' 'Yellow'

# 复现 LocalRuntimeManager 的注入行为：把 %APPDATA%\PrivateAgent\config.env
# 灌进本进程环境，子进程继承 —— 与客户端 spawn runtime 时完全一致。
# 新机器首启没有这个文件，注入的即是空配置（这正是根因高发区）。
$cfgPath = Join-Path $env:APPDATA 'PrivateAgent\config.env'
$cfg = @{}
if (Test-Path $cfgPath) {
  foreach ($line in (Get-Content -LiteralPath $cfgPath -ErrorAction SilentlyContinue)) {
    $t = ([string]$line).Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -le 0) { continue }
    $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
  }
  Say "  [OK]   读到用户配置 $cfgPath" 'Green'
} else {
  Say "  [FAIL] 用户配置不存在: $cfgPath" 'Red'
  Say '         新机器首启就是这种状态 —— 客户端注入的是空配置。' 'DarkGray'
}
# 严格模拟：先把本进程从父环境继承来的模型 key 清掉，只保留 config.env 注入的。
# 不做这一步，诊断者自己环境里的 key 会泄漏给被测进程，把「没 key 就起不来」
# 这个根因彻底掩盖（正是本机长期测不出来的原因之一）。
foreach ($v in 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MOONSHOT_API_KEY', 'MINIMAX_API_KEY', 'AGENT_EMBEDDING_API_KEY', 'AGENT_EMBEDDING_BASE_URL', 'EXTERNAL_MODEL_PROVIDER') {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
$hasKey = $cfg.ContainsKey('OPENAI_API_KEY') -and $cfg['OPENAI_API_KEY']
Verdict ([bool]$hasKey) 'config.env 含 OPENAI_API_KEY' '缺 key 时服务端会在装配期 abort，3000 永不监听'
foreach ($k in $cfg.Keys) { Set-Item -Path "Env:$k" -Value $cfg[$k] }

$ok = $false
if ($hasNode -and $hasEntry -and -not $fatal) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = 'dist\index.js'
  $psi.WorkingDirectory = $runtime
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # 与客户端一致：关掉 FunASR 自启动（不要碰 $psi.EnvironmentVariables，
  # PS 5.1 下它是 null，索引赋值会炸且导致环境块异常，制造假失败）
  $env:FUNASR_AUTO_START = '0'
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    Say "  [FAIL] 启动 node.exe 失败: $($_.Exception.Message)" 'Red'
    Say '         node.exe 被安全软件拦截 / 无执行权限 的可能性最大。' 'Red'
  }
  if ($proc) {
    Say "  spawn pid $($proc.Id)，开始轮询 http://127.0.0.1:3000/api/client/manifest" 'DarkGray'
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Milliseconds 500
      if ($proc.HasExited) { break }
      try {
        $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:3000/api/client/manifest'
        if ($res.StatusCode -eq 200) { $ok = $true; break }
      } catch {}
    }
    $sw.Stop()
    $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    & cmd /c "taskkill /T /F /PID $($proc.Id) >nul 2>&1"
    $null = $proc.WaitForExit(5000)
    $logText = ''
    try { $logText = [string]$outTask.Result + "`n" + [string]$errTask.Result } catch { }

    if ($ok) {
      Say "  [OK]   后端就绪，耗时 $secs 秒" 'Green'
      if ($secs -gt 25) {
        Say "  [WARN] 超过客户端 25 秒的等待上限 —— 客户端会判定超时放弃，但后端其实在启动。" 'Yellow'
        Say "         这种机器上一会儿自己就通了，根治要调大 readyTimeout。" 'DarkGray'
      }
    } else {
      $fatal = $true
      Say "  [FAIL] $secs 秒内后端未就绪" 'Red'
      if ($proc.HasExited) { Say "         node.exe 已退出，退出码 $($proc.ExitCode)" 'Red' }
      foreach ($pat in @(
        @{ K = 'OpenAI API key is required'; M = '根因命中：未配置模型 Key，服务端在装配期 abort（3000 永不监听）。到「设置-模型服务」填 Key，或在本目录建 %APPDATA%\PrivateAgent\config.env 写入 OPENAI_API_KEY 后重启。' },
        @{ K = 'Cannot find module'; M = 'zip 解压不完整：换 7-Zip 重新解压到短路径（如 D:\Nextbot）。' },
        @{ K = 'ERR_MODULE_NOT_FOUND'; M = '依赖缺失：dist\node_modules 没随包带上。' },
        @{ K = 'EADDRINUSE'; M = '3000 端口被别的程序占用。' },
        @{ K = 'NODE_MODULE_VERSION'; M = 'node ABI 与原生模块不匹配：bundled node.exe 被换过。' }
      )) {
        if ($logText -and $logText.Contains($pat.K)) { Say "         >> $($pat.M)" 'Yellow' }
      }
    }
  }
} else {
  Say '  [SKIP] 前置检查已失败，跳过冷启动' 'DarkGray'
}
Say ''

# ---------- 7. 客户端日志 ----------
Say '[7] 客户端 runtime 日志（%APPDATA%\PrivateAgent\runtime.log）' 'Yellow'
$log = Join-Path $env:APPDATA 'PrivateAgent\runtime.log'
if (Test-Path $log) {
  $tail = Get-Content -LiteralPath $log -Tail 12 -ErrorAction SilentlyContinue
  foreach ($l in $tail) { Say "  | $l" 'DarkGray' }
  $all = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
  if ($all -and -not $all.Contains('spawn:')) {
    Say '  >> 日志里没有 spawn: 行 —— 客户端根本没尝试拉起后端（isBundled=false 或 health 已命中别的 3000 服务）。' 'Red'
  }
} else {
  Say '  >> 日志文件不存在 —— 客户端从未进入 spawn 分支，属静默跳过。' 'Red'
}
Say ''

# ---------- 结论 ----------
Say '================ 结论 ================' 'Cyan'
if ($ok) {
  Say '本地后端可以正常拉起。若用户仍连不上，问题在客户端侧（端口/地址烤入/防火墙），不在 runtime。' 'Green'
} elseif (-not ($hasNode -and $hasEntry)) {
  Say '目录布局不对：exe 同级缺少 runtime\node.exe 或 runtime\dist\index.js。' 'Red'
  Say '客户端会静默跳过拉起，且 Release 版会在 ApiConfig.httpBase 直接抛 StateError。' 'Red'
} elseif ($fileCount -lt 20000) {
  Say 'zip 解压不完整，深层 node_modules 丢失。换 7-Zip 解压到短路径（如 D:\Nextbot）即可。' 'Red'
} else {
  Say '布局与文件完整，但冷启动失败。看上面 [6] 的失败原因与 [7] 的日志尾部。' 'Red'
}
Say ''

$outFile = Join-Path $Root 'runtime-diagnose-report.txt'
[System.IO.File]::WriteAllLines($outFile, $report, [System.Text.UTF8Encoding]::new($true))
Say "报告已写入: $outFile" 'Cyan'
Say ''
try { Read-Host '按回车退出' } catch { }
