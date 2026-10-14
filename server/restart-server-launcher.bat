@echo off
cd /d E:\ws-project\Private-Agent\server
if not exist E:\ws-project\Private-Agent\logs mkdir E:\ws-project\Private-Agent\logs
echo [restart-server-launcher] %date% %time% starting server with .env.local (huawei push env) >> E:\ws-project\Private-Agent\logs\server-restart.log
"D:\nodejs\node.exe" --require E:\ws-project\Private-Agent\node_modules\tsx\dist\preflight.cjs --import file:///E:/ws-project/Private-Agent/node_modules/tsx/dist/loader.mjs src\index.ts >> E:\ws-project\Private-Agent\logs\server-restart.log 2>&1
