@echo off
cd /d E:\ws-project\NextBot\server
if not exist E:\ws-project\NextBot\logs mkdir E:\ws-project\NextBot\logs
echo [restart-server-launcher] %date% %time% starting server with .env.local (huawei push env) >> E:\ws-project\NextBot\logs\server-restart.log
"D:\nodejs\node.exe" --require E:\ws-project\NextBot\node_modules\tsx\dist\preflight.cjs --import file:///E:/ws-project/NextBot/node_modules/tsx/dist/loader.mjs src\index.ts >> E:\ws-project\NextBot\logs\server-restart.log 2>&1
