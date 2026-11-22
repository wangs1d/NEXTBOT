#!/bin/bash
# Daily structured-data snapshot (local-first beta policy, 2026-11-22).
# User chat history / media live on the user's own device. The server keeps
# only the latest 2 small structured archives as a migration safety net;
# images, thumbnails and caches are excluded so backups no longer grow with
# the number of beta users.
set -e
BK=/opt/nextbot/backup/daily
mkdir -p "$BK"
TS=$(date +%Y%m%d-%H%M%S)
tar -czf "$BK/data-daily-$TS.tar.gz" \
  --exclude='data/images' \
  --exclude='data/images-thumbs' \
  --exclude='data/tile-cache' \
  --exclude='data/travel-media' \
  -C /root/.local/share/Nextbot data
ls -1t "$BK"/data-daily-*.tar.gz | tail -n +3 | xargs -r rm -f
echo "$(date +%F\ %T) backup ok (structured only, keep 2): data-daily-$TS.tar.gz"
