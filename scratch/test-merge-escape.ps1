# 演练 deploy-ecs.ps1 合并块的转义：同样的可展开 here-string 片段 → bash 实跑验证。
$line1 = "MERGE_TEST marker"
$remoteMerge = @"
if [ -f /tmp/nb-merge-test/.env ]; then
  while IFS= read -r line; do
    key=`$(printf '%s' "`$line" | sed -n 's/^\([A-Za-z0-9_]\+\)=.*`$/\1/p')
    if [ -n "`$key" ] && ! grep -qE "^`$key=" /tmp/nb-merge-test/.env; then
      echo "`$line" >> /tmp/nb-merge-test/.env
    fi
  done < /tmp/nb-merge-test/.env
  echo 'merge .env ok'
fi
if [ -f /tmp/nb-merge-test/.env.local ]; then
  while IFS= read -r line; do
    key=`$(printf '%s' "`$line" | sed -n 's/^\([A-Za-z0-9_]\+\)=.*`$/\1/p')
    if [ -n "`$key" ] && ! grep -qE "^`$key=" /tmp/nb-merge-test/.env; then
      echo "`$line" >> /tmp/nb-merge-test/.env
    fi
  done < /tmp/nb-merge-test/.env.local
  echo 'merge .env.local ok'
fi
"@
$expanded = $remoteMerge -replace "`r`n", "`n"
$expanded | Out-File -Encoding ascii "$env:TEMP\merge-test.sh"
Write-Host '--- expanded bash ---'
Write-Host $expanded
