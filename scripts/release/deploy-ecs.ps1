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
  [string]$DeployDir = "/opt/private-agent",
  [string]$ManifestUrl = "https://nextbot.top",
  [switch]$SkipPackage
)
$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$DistDir = Join-Path $Repo 'windows_dist\ecs-deploy'
$Tarball = Join-Path $DistDir 'private-agent-ecs.tar.gz'

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
  if (Test-Path $Tarball) { Remove-Item -Force $Tarball }
  Push-Location $Repo
  # 相对路径：GNU tar 会把 "E:\x" 里的冒号解析成 远程主机:path
  & tar -czf windows_dist/ecs-deploy/private-agent-ecs.tar.gz package.json package-lock.json `
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
& scp $Tarball "${Remote}:/tmp/private-agent-ecs.tar.gz"
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
tar -xzf /tmp/private-agent-ecs.tar.gz -C $DeployDir
rm -f /tmp/private-agent-ecs.tar.gz /tmp/node.tar.xz
cd $DeployDir
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
# onnxruntime-node 的 postinstall 要直连 GitHub 下 build list（302 被墙即 npm ci 全挂）；
# CPU 二进制本就捆绑在包里，ECS 也只做惰性 import（声纹/本地嵌入是桌面特性）——直接跳过下载。
export ONNXRUNTIME_NODE_INSTALL=skip
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
cat > /etc/systemd/system/private-agent.service <<UNIT
[Unit]
Description=PrivateAgent runtime (manifest + platform API)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DeployDir/server
ExecStart=`${NODE_BIN} dist/index.js
Environment=FUNASR_AUTO_START=0
Environment=NODE_ENV=production
Environment=DOWNLOADS_DIR=$DeployDir/downloads
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# 注意：enable --now 对已运行的服务不会重启（代码更新后必须显式 restart）
systemctl enable private-agent
systemctl restart private-agent
echo '[ecs] 等待就绪（冷启动约 15s）...'
for i in `$(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl is-active private-agent
# 终验带重试：冷启动偶发超过首轮 30s 时，单独一次 curl 会误报部署失败（实际服务 active 且健康）
for i in `$(seq 1 15); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest; then echo; echo '[ecs] deploy verify OK'; exit 0; fi
  sleep 2
done
echo '[ecs] deploy verify FAILED: manifest 不可达' >&2
exit 1
"@
$remoteScript | & ssh $Remote "bash -s"
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
