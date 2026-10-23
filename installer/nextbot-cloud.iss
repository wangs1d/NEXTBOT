; Nextbot Cloud（云端连接版）Windows 安装包（Inno Setup 6）
; 打包入口：scripts/release/build-installer-cloud.ps1（只组 app staging，再调 ISCC 编译本文件）
;
; 与 byok 版（nextbot.iss）的关键差异：
;   - AppId 独立：AppId 相同会互相覆盖升级（内测版被云端版安装动作顶掉），永不可共用。
;   - 无 runtime：模型跑在运营方云端（HTTP_BASE 烤入 https://api.nextbot.top），
;     用户在「设置-模型服务」填自己的模型 API Key，经 wss 上送、服务端内存驻留。
;   - 更新通道独立：客户端 PAI_EDITION=cloud → 更新检查请求
;     GET /api/client/manifest?edition=cloud → ECS config/client-manifest.cloud.json。
;     本安装器就是该清单 url 指向的更新载体（应用内下载后静默安装，Inno /SILENT 原生支持）。

#ifndef AppVersion
#define AppVersion "0.1.0"
#endif

; staging 目录由打包脚本经 /DStage 传入（短路径 E:\NBCloudStage，避开深路径上限）
#ifndef Stage
#define Stage "E:\NBCloudStage"
#endif

; Edition 固定 cloud（保留与 byok 版相同的 /D 传参形态，将来细分仍走同一开关）
#ifndef Edition
#define Edition "cloud"
#endif

#define MyAppId "{{8F3D2A91-7B4E-4C6D-9A52-1E3F8B7C6D40}}"
#define MyAppName "Nextbot Cloud"
#define MyAppPublisher "Nextbot Cloud"
#define MyOutputBase "Nextbot-Cloud-Setup"
#define MyDirName "{autopf}\Nextbot-Cloud"
#define MyIconName "Nextbot Cloud"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={#MyDirName}
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\windows_dist\installer
OutputBaseFilename={#MyOutputBase}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayIcon={app}\NEXTBOT.exe

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "{#Stage}\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyIconName}"; Filename: "{app}\NEXTBOT.exe"
Name: "{autodesktop}\{#MyIconName}"; Filename: "{app}\NEXTBOT.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NEXTBOT.exe"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 故意不删 %APPDATA%\Nextbot（用户模型 Key 与数据），安装器只管应用目录

[Code]
// 安装前停掉旧版本残留进程（限定路径在本应用目录内，不误杀系统其他进程；
// cloud 版无本地 runtime，路径匹配天然只命中应用自身）
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrorCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'),
    '/C powershell -NoProfile -Command "Get-Process NEXTBOT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(800);
  Result := '';
end;
