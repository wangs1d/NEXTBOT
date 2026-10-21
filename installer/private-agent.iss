; PrivateAgent Windows 安装包（Inno Setup 6）
; 打包入口：scripts/release/build-installer.ps1（负责 staging，再调 ISCC 编译本文件）
; 发行版本（/DEdition 由打包脚本传入）：
;   internal —— 内测版（默认）：全量能力，AppId 固定为历史 GUID；
;   oss      —— 开源版（GitHub 发行）：内测独占能力已剔除。
; 两版必须使用不同 AppId / 安装目录 / 快捷方式名：AppId 相同会互相覆盖升级
; （内测版会被开源版的安装动作顶掉），永不可共用。

#ifndef AppVersion
#define AppVersion "0.1.0"
#endif

; staging 目录由打包脚本经 /DStage 传入（默认短路径 E:\PAStage，避开深路径上限）
#ifndef Stage
#define Stage "E:\PAStage"
#endif

#ifndef Edition
#define Edition "internal"
#endif

#if Edition == "oss"
#define MyAppId "{{C11EB7C6-FACF-4AF9-A5F7-CF91B8B65F94}}"
#define MyAppName "Nextbot OSS"
#define MyAppPublisher "Nextbot OSS"
#define MyOutputBase "Nextbot-Setup-OSS"
#define MyDirName "{autopf}\Nextbot-OSS"
#define MyIconName "Nextbot OSS"
#else
#define MyAppId "{{D4A7F1B8-6C2E-4F9A-B3D8-91E05A7C4216}}"
#define MyAppName "Nextbot"
#define MyAppPublisher "Nextbot"
#define MyOutputBase "Nextbot-Setup"
#define MyDirName "{autopf}\Nextbot"
#define MyIconName "Nextbot"
#endif

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
Source: "{#Stage}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyIconName}"; Filename: "{app}\NEXTBOT.exe"
Name: "{autodesktop}\{#MyIconName}"; Filename: "{app}\NEXTBOT.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NEXTBOT.exe"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 故意不删 %APPDATA%\PrivateAgent（用户 key 与数据），安装器只管应用目录

[Code]
// 安装前停掉旧版本残留进程（限定路径在本应用目录内，不误杀系统其他 node）
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrorCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'),
    '/C powershell -NoProfile -Command "Get-Process node,private_ai_agent,NEXTBOT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(800);
  Result := '';
end;
