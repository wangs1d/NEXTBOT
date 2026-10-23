; Nextbot Windows 安装包（Inno Setup 6）
; 打包入口：scripts/release/build-installer.ps1（负责 staging，再调 ISCC 编译本文件）
; 发行版本（/DEdition 由打包脚本传入）：
;   internal —— 内测版（默认）：全量能力，AppId 固定为历史 GUID；
;   oss      —— 开源版（GitHub 发行）：内测独占能力已剔除。
; 两版必须使用不同 AppId / 安装目录 / 快捷方式名：AppId 相同会互相覆盖升级
; （内测版会被开源版的安装动作顶掉），永不可共用。

#ifndef AppVersion
#define AppVersion "0.1.0"
#endif

; staging 目录由打包脚本经 /DStage 传入（默认短路径 E:\NBStage，避开深路径上限）
#ifndef Stage
#define Stage "E:\NBStage"
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
; 用户数据默认保留（Windows 惯例：卸载只删应用目录，重装后直接登录可用）。
; 是否删除由卸载时 CurUninstallStepChanged 询问用户显式决定，见 [Code]。

[Code]
// 停掉本应用目录内的残留进程：runtime node 常驻不随应用退出而杀
// （LocalRuntimeManager 设计如此），安装/卸载前统一清场。
// 限定路径在 {app} 内，不误杀系统其他 node。
procedure StopAppProcesses;
var
  ErrorCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'),
    '/C powershell -NoProfile -Command "Get-Process node,NEXTBOT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(800);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopAppProcesses;
  Result := '';
end;

// 卸载第一步询问是否同时删除用户数据（登录态 / API Key / 聊天记录 / 窗口
// 位置）。默认「否」：保留数据是 Windows 桌面端惯例（Chrome/VS Code/Telegram
// 同款策略）。勾选删除时清四处：
//   %APPDATA%\Nextbot      —— 统一数据目录（server data/ + byok config.env + runtime.log
//                             + 窗口位置，2026-10-23 起运行期产物全部收拢到这里）
//   %APPDATA%\PrivateAgent —— 旧版用户数据目录（2026-10-23 前的 config.env / runtime.log /
//                             window_positions.ini），保留条目用于升级用户清残留
//   %APPDATA%\top.nextbot   —— 现行 org 的应用支持目录（登录态/历史库/安装身份）
//   %APPDATA%\com.example   —— 更早 org 残留（Flutter 脚手架默认名时期的落盘）
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usUninstall then Exit;
  StopAppProcesses;
  if TaskDialogMsgBox('', '是否同时删除用户数据？',
      '选择「否」将保留登录状态与本地数据，下次安装后可直接登录使用。' #13#10 +
      '选择「是」将删除登录态、API Key 与聊天记录，且不可恢复。',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2, []) = IDYES then
  begin
    DelTree(ExpandConstant('{userappdata}\Nextbot'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\PrivateAgent'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\top.nextbot'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\com.example'), True, True, True);
  end;
end;
