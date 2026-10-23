#Requires -Version 5.1
<#
.SYNOPSIS
  Shortcut: Windows Release build and copy to E:\...\windows_dist\Release
#>
param(
  # 发布版服务器地址，透传给 build_windows.ps1（见其注释）
  [string]$HttpBase = '',
  # 版本清单（更新检查）地址，透传给 build_windows.ps1；默认与主脚本一致烤入 ECS。
  # 必须 https://（80 已 301，烤 http 每次检查多付一次重定向 + 二次 TLS，弱网弹卡慢数秒）
  [string]$UpdateManifestUrl = 'https://login.nextbot.top',
  # 控制面（管理后台）地址：反馈/站内信等运营数据走这里，透传给 build_windows.ps1；
  # 默认与主脚本一致烤入 ECS——本地 Debug/Release 测试的反馈才能落到后台（同上必须 https）
  [string]$ControlPlaneUrl = 'https://login.nextbot.top'
)
$ErrorActionPreference = 'Stop'
# 分发构建（绿色 zip）门禁：必须显式烤真实服务器地址。非捆绑形态下空 HTTP_BASE
# 会在客户端启动时 fail-fast（api_config.dart P0 防线）→ 用户拿到手即白屏
# （2026-10-23 根修）。本地日常构建走 build_windows.ps1（默认 127.0.0.1:3000）。
if (-not $HttpBase) {
  throw '分发构建必须显式传 -HttpBase（例：-HttpBase https://api.nextbot.top）。' +
    '本地日常构建请直接用 build_windows.ps1（默认连本机 dev server）。'
}
& (Join-Path $PSScriptRoot 'build_windows.ps1') -Configuration Release -HttpBase $HttpBase -UpdateManifestUrl $UpdateManifestUrl -ControlPlaneUrl $ControlPlaneUrl
