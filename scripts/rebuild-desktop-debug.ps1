# Fast rebuild for the Flutter Windows *debug* client, for Dart-only changes (lib/**).
#
# Prefer scripts/desktop-hot-reload.mjs (npm run dev:desktop) when only Dart changed:
# it pushes the new kernel straight into the running app through the VM Service
# (true hot reload: no rebuild of the bundle, no process restart). This script
# remains the restart-based fallback (e.g. after a rejected hot reload, or when
# you want a clean process).
#
# Why this exists:
#   On this machine the `flutter` tool cannot run at all: the Dart VM inside it fails to
#   create child processes ("CreateFile failed 231", ERROR_PIPE_BUSY, system named-pipe
#   resource exhaustion), and `flutter build` needs to spawn cmake / ninja / gen_snapshot.
#   The Dart front-end compiler (dartaotruntime + frontend_server snapshot) is a native
#   binary that compiles *in process*, so the Dart kernel can be regenerated without the
#   flutter tool. Reboot the machine to restore the normal path.
#
# What it does:
#   1) recompiles <app.dill> with the same options flutter_tools uses for
#      KernelSnapshot(debug, windows-x64)   [incremental, platform linked in]
#   2) copies it over kernel_blob.bin in the build output AND in windows_dist\Debug
#   3) restarts the desktop app from windows_dist\Debug
#
# Limitation: this only refreshes Dart code. If native code changed (windows\**, plugin
# native sources, pubspec native deps) you must run a full `flutter build windows --debug`
# on a machine where the flutter tool works.
#
# Keep this file pure ASCII: PowerShell 5.1 decodes BOM-less .ps1 as ANSI/GBK.

$ErrorActionPreference = 'Stop'

$Root     = 'E:\ws-project\Private-Agent'
$App      = Join-Path $Root 'client\flutter_app'
$Cache    = 'D:\Flutter\bin\cache'
$Package  = 'private_ai_agent'
$BuildOut = Join-Path $App 'build\windows\x64\runner\Debug\data\flutter_assets\kernel_blob.bin'
$DistOut  = Join-Path $Root 'windows_dist\Debug\data\flutter_assets\kernel_blob.bin'
$Exe      = Join-Path $Root 'windows_dist\Debug\NEXTBOT.exe'

function To-Fwd([string] $p) { return ($p -replace '\\', '/') }

# --- 0. stop the running app ---------------------------------------------------------
# Must happen BEFORE syncing: while NEXTBOT.exe is up it keeps
# kernel_blob.bin memory-mapped, and Copy-Item onto it fails with
# "The requested operation cannot be performed on a file with a user-mapped section open."
Write-Host '[0/4] stopping running app (if any)...'
Get-Process -Name 'NEXTBOT' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

# --- 1. locate the build dir the currently shipped kernel_blob.bin came from ---------
$shipped = if (Test-Path $DistOut) { (Get-Item $DistOut).Length } else { -1 }
$dills = Get-ChildItem -Path (Join-Path $App '.dart_tool\flutter_build') -Directory |
    ForEach-Object { Join-Path $_.FullName 'app.dill' } |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-Item $_ } |
    Where-Object { $_.Length -gt 10MB }

if (-not $dills) { throw 'No app.dill found under .dart_tool\flutter_build. Run a full flutter build first.' }

$exact = $dills | Where-Object { $_.Length -eq $shipped } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$target = if ($exact) { $exact } else { $dills | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
$BuildDir = $target.Directory.FullName

Write-Host "[1/4] build dir : $BuildDir"
if (-not $exact) { Write-Host '      NOTE: no app.dill matches the shipped kernel_blob.bin size; using the newest one.' }

$dill     = Join-Path $BuildDir 'app.dill'
$depfile  = Join-Path $BuildDir 'kernel_snapshot_program.d'
$regFile  = Join-Path $App '.dart_tool\flutter_build\dart_plugin_registrant.dart'
$regUri   = 'file:///' + (To-Fwd $regFile)

# --- 2. recompile the kernel ----------------------------------------------------------
$dartExe  = Join-Path $Cache 'dart-sdk\bin\dartaotruntime.exe'
$feServer = Join-Path $Cache 'dart-sdk\bin\snapshots\frontend_server_aot.dart.snapshot'
$sdkRoot  = (To-Fwd (Join-Path $Cache 'artifacts\engine\common\flutter_patched_sdk')) + '/'

foreach ($p in @($dartExe, $feServer)) { if (-not (Test-Path $p)) { throw "missing toolchain: $p" } }

$PrevSize = if (Test-Path $dill) { (Get-Item $dill).Length } else { 0 }
# single rolling backup (~80MB), not one per run
$backup = Join-Path $BuildDir 'app.dill.prev'
if ($PrevSize -gt 0) { Copy-Item $dill $backup -Force }

$feArgs = @(
    $feServer,
    '--sdk-root', $sdkRoot,
    '--target=flutter',
    '--no-print-incremental-dependencies',
    '-Ddart.vm.profile=false',
    '-Ddart.vm.product=false',
    '--enable-asserts',
    '--track-widget-creation',
    '--packages', (To-Fwd (Join-Path $App '.dart_tool\package_config.json')),
    '--output-dill', (To-Fwd $dill),
    '--depfile', (To-Fwd $depfile),
    '--incremental',
    '--initialize-from-dill', (To-Fwd $dill),
    '--source', $regUri,
    '--source', 'package:flutter/src/dart_plugin_registrant.dart',
    "-Dflutter.dart_plugin_registrant=$regUri",
    '--verbosity=error',
    "package:$Package/main.dart"
)

Write-Host '[2/4] compiling kernel (frontend_server)...'
& $dartExe @feArgs
if ($LASTEXITCODE -ne 0) {
    if ($PrevSize -gt 0 -and (Test-Path $backup)) { Copy-Item $backup $dill -Force }
    throw "frontend_server failed with exit code $LASTEXITCODE (previous app.dill restored)"
}

$newSize = (Get-Item $dill).Length
if ($newSize -lt 10MB) { throw "compiled app.dill looks wrong ($newSize bytes)" }
Write-Host ("      app.dill {0} -> {1} bytes" -f $PrevSize, $newSize)

# --- 3. sync bundles ------------------------------------------------------------------
Write-Host '[3/4] syncing kernel_blob.bin...'
foreach ($out in @($BuildOut, $DistOut)) {
    $dir = Split-Path $out
    if (-not (Test-Path $dir)) { throw "bundle dir missing: $dir" }
    Copy-Item $dill $out -Force
    Write-Host ("      -> {0} ({1} bytes)" -f $out, (Get-Item $out).Length)
}

# --- 4. restart the app ---------------------------------------------------------------
Write-Host '[4/4] starting desktop app...'
Get-Process -Name 'NEXTBOT' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe)
Write-Host 'Done. Hover a message bubble to reveal the delete entry.'
