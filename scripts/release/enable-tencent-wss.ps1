#Requires -Version 5.1
<#
.SYNOPSIS
  Enable wss on Tencent cloud (api.nextbot.top): certbot sign -> enable nginx 443
  block -> reload -> probe. Run AFTER the DNS A record (api -> 159.75.52.2) is live.
.EXAMPLE
  .\enable-tencent-wss.ps1
#>
param(
  [string]$PemPath = "$env:USERPROFILE\Desktop\TencentServer\King.pem",
  [string]$Remote = "root@159.75.52.2",
  [string]$Domain = "api.nextbot.top",
  [string]$Email = "2378709729@qq.com"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $PemPath)) {
  $PemPath = "c:\Users\Administrator\Desktop\" + [char]0x817E + [char]0x8BAF + [char]0x670D + [char]0x52A1 + [char]0x5668 + "\King.pem"
}

# Remote: verify DNS -> certbot (skip if cert exists) -> uncomment 443 block -> nginx test/reload -> self probe
$remoteScript = @'
set -e
set -o pipefail
DOMAIN=__DOMAIN__
EMAIL=__EMAIL__
echo "[dns] resolving $DOMAIN on server side..."
IP=$(dig +short $DOMAIN A | head -n1)
if [ -z "$IP" ]; then echo "[dns] $DOMAIN does not resolve yet - ABORT" >&2; exit 3; fi
echo "[dns] $DOMAIN -> $IP"
if [ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  echo "[certbot] issuing certificate..."
  mkdir -p /var/www/certbot
  certbot certonly --webroot -w /var/www/certbot -d $DOMAIN \
    --agree-tos -m $EMAIL --no-eff-email -n \
    --deploy-hook "systemctl reload nginx"
else
  echo "[certbot] certificate already exists, skip issuing"
fi
CONF=/etc/nginx/conf.d/pai-api.conf
if grep -q "^# server {" "$CONF"; then
  echo "[nginx] enabling 443 server block..."
  sed -i '/^# server {/,/^# }/s/^# //' "$CONF"
else
  echo "[nginx] 443 block already enabled"
fi
nginx -t
systemctl reload nginx
echo "[probe] local https probe..."
sleep 1
curl -sSf "https://$DOMAIN/api/client/manifest" >/dev/null && echo "[probe] local OK"
'@
$remoteScript = $remoteScript.Replace('__DOMAIN__', $Domain).Replace('__EMAIL__', $Email)
$lf = ($remoteScript -replace "`r`n", "`n").TrimStart([char]0xFEFF)
$lf | & ssh -i $PemPath -o StrictHostKeyChecking=accept-new $Remote "bash -s"
if ($LASTEXITCODE -ne 0) { throw 'remote wss enable failed' }

# External probe (tests security group 443 from outside)
Write-Host '== external probe (security group 443) =='
$resp = & curl.exe -s -m 10 "https://$Domain/api/client/manifest"
if ($resp -match '"ok":true') {
  Write-Host "external OK: $resp" -ForegroundColor Green
} else {
  Write-Host "external probe failed (security group 443 open? DNS propagated?): $resp" -ForegroundColor Yellow
}
