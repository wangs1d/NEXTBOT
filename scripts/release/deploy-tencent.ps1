#Requires -Version 5.1
<#
.SYNOPSIS
  Incremental deploy of server/dist to Tencent cloud (159.75.52.2, api.nextbot.top).
  Prereq: server/dist built (npx tsc -p tsconfig.json). Flow:
  pack server/dist -> scp -> remote backup old dist -> extract -> restart pai-server -> health check.
.EXAMPLE
  .\deploy-tencent.ps1                  # pack + deploy (assumes dist already built)
  .\deploy-tencent.ps1 -Build           # run tsc emit before packing
#>
param(
  [string]$PemPath = "$env:USERPROFILE\Desktop\TencentServer\King.pem",
  [string]$Remote = "root@159.75.52.2",
  [switch]$Build
)
$ErrorActionPreference = 'Stop'
# Fallback pem path (Chinese folder name in original setup)
if (-not (Test-Path $PemPath)) {
  $PemPath = "c:\Users\Administrator\Desktop\" + [char]0x817E + [char]0x8BAF + [char]0x670D + [char]0x52A1 + [char]0x5668 + "\King.pem"
}
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$ServerDir = Join-Path $Repo 'server'
$Tarball = Join-Path $Repo 'windows_dist\pai-tencent-dist.tar.gz'

if ($Build) {
  Write-Host '== [0/4] build server (tsc emit) =='
  Push-Location $ServerDir
  & npx tsc -p tsconfig.json
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw 'tsc build failed' }
}

Write-Host '== [1/4] pack server/dist =='
New-Item -ItemType Directory -Force -Path (Split-Path $Tarball) | Out-Null
if (Test-Path $Tarball) { Remove-Item -Force $Tarball }
& tar -czf $Tarball -C $ServerDir dist
if ($LASTEXITCODE -ne 0) { throw 'tar pack failed' }
Write-Host ("tarball: {0} ({1:N1} MB)" -f $Tarball, ((Get-Item $Tarball).Length / 1MB))

Write-Host '== [2/4] upload =='
& scp -i $PemPath $Tarball "${Remote}:/tmp/pai-dist.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

# Remote: backup old dist -> extract -> restart -> health check
# (remote script kept ASCII-only; executed via bash -s)
$remoteScript = @'
set -e
set -o pipefail
cd /opt/pai/server
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -d dist ]; then mv dist "dist.bak-$STAMP"; fi
tar -xzf /tmp/pai-dist.tar.gz -C /opt/pai/server
rm -f /tmp/pai-dist.tar.gz
# keep only the 3 most recent dist backups
ls -1dt dist.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
systemctl restart pai-server
echo '[tencent] waiting for readiness...'
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl is-active pai-server
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:3000/api/client/manifest >/dev/null 2>&1; then
    echo '[tencent] deploy verify OK'; exit 0
  fi
  sleep 2
done
echo '[tencent] deploy verify FAILED' >&2
exit 1
'@
Write-Host '== [3/4] remote deploy =='
$lf = ($remoteScript -replace "`r`n", "`n").TrimStart([char]0xFEFF)
$lf | & ssh -i $PemPath -o StrictHostKeyChecking=accept-new $Remote "bash -s"
if ($LASTEXITCODE -ne 0) { throw 'remote deploy failed' }

Write-Host '== [4/4] done =='
