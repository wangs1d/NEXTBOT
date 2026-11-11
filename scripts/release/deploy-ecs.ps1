#Requires -Version 5.1
<#
.SYNOPSIS
  首次/更新部署 server 到阿里云 ECS（manifest 控制面 + 未来 platform 模式的 runtime）。
  流程：打包精简产物（dist+workspace dist+config+.env，不含源码与 node_modules）
  → scp → 服务器端 npm ci --omit=dev（Linux 原生二进制）→ systemd 常驻 → 内外网验证。
.EXAMPLE
  .\deploy-ecs.ps1                      # 全流程
  .\deploy-ecs.ps1 -SkipPackage         # 复用已打好的 tarball 仅做上传+部署
#>
param(
  [string]$Remote = "root@47.98.122.29",
  [string]$DeployDir = "/opt/nextbot",
  [string]$ManifestUrl = "https://nextbot.top",
  [switch]$SkipPackage
)
$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$DistDir = Join-Path $Repo 'windows_dist\ecs-deploy'
$Tarball = Join-Path $DistDir 'nextbot-ecs.tar.gz'

# ── 0. SSH 连通性（公钥未授权时直接给出可执行指引） ──
Write-Host '== [0/5] SSH 连通性 =='
$sshTest = & ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new $Remote "echo ok" 2>&1 | ForEach-Object { ($_ -as [string]).Trim() }
if ($sshTest -notcontains "ok") {
  Write-Host (@"
SSH 公钥未授权，无法自动部署。请在服务器上执行一次（阿里云控制台 Workbench/任意现有通道）：

  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICaZ59uVHDzcCft9HcBYtCzPEVWW5DfNO6qL3TWpaYu8 2378709729@qq.com" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys

授权后重跑: .\deploy-ecs.ps1
"@) -ForegroundColor Yellow
  exit 2
}
Write-Host "SSH OK"

# ── 1. 打包（源码无关：dist/配置/锁文件；node_modules 在服务器端按 Linux 重装） ──
if (-not $SkipPackage) {
  Write-Host '== [1/5] 打包精简产物 =='
  New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
  # 用 .NET 文件 API：环境里的 safe-delete 钩子会让 Remove-Item 走回收站，
  # 回收站不可用时 fail-closed 直接抛错，把打包卡在清理旧 tarball 这一步。
  if (Test-Path -LiteralPath $Tarball) { [System.IO.File]::Delete($Tarball) }
  Push-Location $Repo
  # 相对路径：GNU tar 会把 "E:\x" 里的冒号解析成 远程主机:path
  & tar -czf windows_dist/ecs-deploy/nextbot-ecs.tar.gz package.json package-lock.json `
    server/dist server/package.json server/config server/.env server/public `
    server/scripts/admin-set-password.mjs `
    agent-world/package.json agent-world/dist agent-world/config agent-world/deps agent-world/data `
    packages/agent-protocol/package.json packages/agent-protocol/dist `
    packages/picture/package.json packages/picture/dist
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw 'tar 打包失败' }
  Write-Host ("tarball: {0} ({1:N1} MB)" -f $Tarball, ((Get-Item $Tarball).Length / 1MB))
}

# ── 2. 上传 ──
Write-Host '== [2/5] 上传 =='
& scp $Tarball "${Remote}:/tmp/nextbot-ecs.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'scp 失败' }

# ── 3. 服务器端：node（缺则装）→ 解包 → npm ci → systemd ──
Write-Host '== [3/5] 服务器端安装 =='
$remoteScript = @"
set -e
set -o pipefail
if ! command -v node >/dev/null 2>&1; then
  echo '[ecs] 安装 Node 22 LTS (npmmirror 镜像)'
  command -v xz >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq xz-utils)
  curl -fsSL https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  mkdir -p /usr/local/lib/nodejs
  tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
  ln -sf /usr/local/lib/nodejs/node-v22.14.0-linux-x64/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/node-v22.14.0-linux-x64/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/node-v22.14.0-linux-x64/bin/npx /usr/local/bin/npx
fi
node -v
NODE_BIN=`$(command -v node)
mkdir -p $DeployDir
# Pre-deploy data snapshot (2026-11-10, memory-loss incident): the data root
# lives OUTSIDE $DeployDir so a normal deploy never touches it, but this takes
# a tar before every deploy anyway - if anything downstream (manual wipe, bad
# migration, disk issue) destroys user memory, the last 5 deploys are always
# recoverable. Keep the 5 newest, prune older ones.
mkdir -p /opt/nextbot/backup/pre-deploy
tar -czf /opt/nextbot/backup/pre-deploy/data-pre-deploy-`$(date +%Y%m%d-%H%M%S).tar.gz -C /root/.local/share/Nextbot data 2>/dev/null || true
ls -1t /opt/nextbot/backup/pre-deploy/data-pre-deploy-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
echo '[ecs] pre-deploy data snapshot done'
# .env 合并保护（2026-11-10 事故修复）：tar 解包会整文件覆盖服务器 .env，
# 本地精简 .env（只有 4 个键）曾把线上 40 键配置（SMTP/MINIMAX/AMAP/充值计价）
# 全部抹掉，OTP 验证码通道静默失效。现在：备份现网 .env → 解包到临时目录 →
# 把 tar 内 .env 移出 → 逐键合并（服务器已有键保留服务器值，只补缺失键）。
mkdir -p /tmp/nb-extract
tar -xzf /tmp/nextbot-ecs.tar.gz -C /tmp/nb-extract
rm -f /tmp/nextbot-ecs.tar.gz /tmp/node.tar.xz
if [ -f /tmp/nb-extract/server/.env ]; then
  cp /opt/nextbot/server/.env /opt/nextbot/server/.env.bak-deploy-`$(date +%Y%m%d-%H%M%S) 2>/dev/null
  # 逐键合并：以现网 .env 为底，tar 内 .env 只补现网没有的键（键名精确匹配行首）
  while IFS= read -r line; do
    key=`$(printf '%s' "$line" | sed -n 's/^\([A-Za-z0-9_]\+\)=.*$/\1/p')
    if [ -n "$key" ] && ! grep -qE "^`$key=" /opt/nextbot/server/.env; then
      echo "$line" >> /opt/nextbot/server/.env
    fi
  done < /tmp/nb-extract/server/.env
  rm -f /tmp/nb-extract/server/.env
fi
rsync -a /tmp/nb-extract/ $DeployDir/ 2>/dev/null || cp -a /tmp/nb-extract/. $DeployDir/
rm -rf /tmp/nb-extract
cd $DeployDir
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
# onnxruntime-node 的 postinstall 要直连 GitHub 下 build list（302 被墙即 npm ci 全挂）；
# CPU 二进制本就捆绑在包里，ECS 也只做惰性 import（声纹/本地嵌入是桌面特性）——直接跳过下载。
export ONNXRUNTIME_NODE_INSTALL=skip
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
# Chromium for the cloud headless browser lane (2026-11-10): mobile
# price-compare / order / booking all execute through the SERVER-side headless
# browser (mobile has no embedded browser). npm ci installs the playwright
# module but never the browser binary - without this every agent_browser.* /
# shopping.* call fails with "Executable doesn't exist". Idempotent: probe the
# binary first, install only when missing. npmmirror mirror first (mainland
# ECS cannot reach playwright CDN reliably), official CDN as fallback.
# 注意探针必须验文件存在：chromium.executablePath() 只返回预期路径、不校验
# 二进制是否真的下载过（2026-11-10 真机教训：路径在、文件不在 → 误跳安装 →
# 终验闸拦下）。存在性检查交给 fs.existsSync。
if node -e "const fs=require('fs');const p=require('playwright').chromium.executablePath();process.exit(fs.existsSync(p)?0:1)" >/dev/null 2>&1; then
  echo '[ecs] chromium binary already present, skip install'
else
  echo '[ecs] installing playwright chromium (npmmirror first, official CDN fallback)'
  export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
  npx playwright install chromium 2>&1 | tail -2 \
    || { unset PLAYWRIGHT_DOWNLOAD_HOST; npx playwright install chromium 2>&1 | tail -2; }
  # System libraries for headless chromium (Ubuntu). install-deps needs apt;
  # tolerate failure here - /api/browser/health is the real gate below.
  npx playwright install-deps chromium >/dev/null 2>&1 || true
fi
# Travel pricing (flyai CLI) is a runtime system dependency, not an npm dep:
# npm ci never installs it, so a rebuilt box silently loses realtime quotes
# and every price degrades to "pending check" with no visible cause.
# Same class of gap as Chromium (also absent here by design of npm-only deploy).
if ! command -v flyai >/dev/null 2>&1; then
  npm i -g @fly-ai/flyai-cli 2>&1 | tail -2
fi
# 反引号转义 `$(` 与 `${}`：这里必须由 bash 求值，不能让 PowerShell 在
# 可展开 here-string 里插值——PS 5.1 还会因 `$(...)` 内的 || 直接解析失败
# （2026-11-10 修复：此前该行导致整个脚本在 5.1 下无法解析；PS7 下即使能跑，
# 也会被 PS 端插值成空值，FLYAI_BIN 静默失效）。
FLYAI_BIN_PATH=`$(command -v flyai || echo /usr/local/bin/flyai)
cat > /etc/systemd/system/nextbot.service <<UNIT
[Unit]
Description=Nextbot runtime (manifest + platform API)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DeployDir/server
ExecStart=`${NODE_BIN} dist/index.js
Environment=FUNASR_AUTO_START=0
Environment=NODE_ENV=production
Environment=DOWNLOADS_DIR=$DeployDir/downloads
# /v1 metered API retail price in cents per 1M tokens (input 1.00 CNY, output 3.50 CNY).
Environment=RECHARGE_API_PRICE_INPUT_CENTS_PER_MTOK=100
Environment=RECHARGE_API_PRICE_OUTPUT_CENTS_PER_MTOK=350
# Pin the data root: this unit is rewritten wholesale on every deploy, and without an
# explicit value the service silently falls back to platform-default root resolution.
# Keep this ASCII -- non-ASCII here-string content arrives mojibake on the server.
Environment=NEXTBOT_DATA_DIR=/root/.local/share/Nextbot/data
# Concurrency gates. Box is 2 vCPU / 1740 MB; measured service peak RSS was 1072 MB
# with MemoryCurrent 334 MB. The resource pool reads MemoryMax below as its capacity,
# so these env values are ceilings the pool may shrink further under RSS pressure
# (elevated at 70%, critical at 88%) instead of waiting for an OOM kill.
Environment=MAX_CONCURRENT_TURNS=6
Environment=ADAPTIVE_CONCURRENCY_ENABLED=1
Environment=ADAPTIVE_CONCURRENCY_MIN=2
Environment=ADAPTIVE_CONCURRENCY_MAX=6
Environment=AGENT_BG_TASK_MAX_PARALLEL=2
# Design the crash boundary instead of V8's default (~894 MB heap on this box):
# old-space cap 768 MB keeps headroom under MemoryHigh=1200M for native + children.
Environment=NODE_OPTIONS=--max-old-space-size=768
# systemd PATH excludes the npm global dir: without an explicit FLYAI_BIN the
# quote layer cannot resolve the CLI even when it is installed (resolveFlyAiBin
# only searches PATH + npm prefix), and every price silently degrades.
Environment=FLYAI_BIN=`${FLYAI_BIN_PATH}
# Memory guardrails: MemoryHigh puts the cgroup into reclaim first; MemoryMax only
# kills this service (Restart=always brings it back) so a leak cannot take nginx or
# sshd down with it. 1200M throttle sits above the observed 1072M peak, 1450M kill
# stays under the 1740M box total.
MemoryHigh=1200M
MemoryMax=1450M
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# 注意：enable --now 对已运行的服务不会重启（代码更新后必须显式 restart）
systemctl enable nextbot
systemctl restart nextbot
echo '[ecs] 等待就绪（冷启动约 15s）...'
for i in `$(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl is-active nextbot
# 终验带重试：冷启动偶发超过首轮 30s 时，单独一次 curl 会误报部署失败（实际服务 active 且健康）
for i in `$(seq 1 15); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest; then echo; echo '[ecs] manifest verify OK'; break; fi
  sleep 2
done
# Browser lane final gate (2026-11-10): a deploy without a working headless
# chromium silently breaks every mobile shopping/booking turn - fail the deploy
# instead of shipping a regression the user only discovers mid-chat.
if curl -sf -m 15 http://127.0.0.1:3000/api/browser/health | grep -q '"ok":true'; then
  echo '[ecs] browser health OK (chromium launches)'
  echo '[ecs] deploy verify OK'; exit 0
fi
echo '[ecs] deploy verify FAILED: browser health not ok (chromium missing or launch failed; see journalctl -u nextbot)' >&2
exit 1
"@
# ssh 管道要求 LF：PS here-string 是 CRLF，直接管道会把行尾 \r 塞进 bash
# （真实报错："set: -: invalid option"）。与 deploy-tencent.ps1 同一修法。
$remoteScriptLf = ($remoteScript -replace "`r`n", "`n").TrimStart([char]0xFEFF)
$remoteScriptLf | & ssh $Remote "bash -s"
if ($LASTEXITCODE -ne 0) { throw '服务器端部署失败' }

# ── 4. 外网验证（安全组 3000 是否放行） ──
Write-Host '== [4/5] 外网验证 =='
Start-Sleep -Seconds 2
$public = & curl.exe -s -m 8 "$ManifestUrl/api/client/manifest"
if ($public -match '"ok":true') {
  Write-Host "外网可达: $public" -ForegroundColor Green
} else {
  Write-Host "外网不可达——请到阿里云控制台安全组放行 TCP 443 入方向后重试 curl $ManifestUrl/api/client/manifest" -ForegroundColor Yellow
}

Write-Host '== [5/5] 完成 =='
Write-Host "发版：改 $DeployDir/server/config/client-manifest.json 即生效（latest/url/notes/minVersion/channel）"
