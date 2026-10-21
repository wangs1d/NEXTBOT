@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Nextbot local runtime diagnose...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-runtime.ps1"
pause
