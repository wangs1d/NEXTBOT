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

; WebView2 运行时独立安装包（微软官方 Evergreen Standalone x64，约 215MB）。
; 由打包脚本缓存并传入；缺文件时 ISCC 会直接报错，不允许退化成联网下载。
#ifndef WebView2Installer
#define WebView2Installer "..\windows_dist\redist\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
#endif

#ifndef Edition
#define Edition "internal"
#endif

; 签名：build-installer.ps1 带 -CertThumbprint 时传 /DSignedSetup=1 并注册 SignTool=nextbot，
; Setup 本体与卸载器由 ISCC 签，包内自有二进制在打包脚本里签。未签名时下载侧的
; SmartScreen「未知发布者」拦不住，下面这些元数据只是降噪：发布者 + 官方站点 + 版本号。

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
; 签名开关只能落在 [Setup] 段内：段外的裸文本会让 ISCC 报 "Text is not inside a section"。
; SignTool 名对应 build-installer.ps1 传给 ISCC 的 /Snextbot=。
#ifdef SignedSetup
SignTool=nextbot
SignedUninstaller=yes
#endif
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://nextbot.top
AppSupportURL=https://nextbot.top
AppUpdatesURL=https://nextbot.top
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName={#MyAppName}
SetupIconFile=..\client\flutter_app\assets\tray_icon.ico
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
; 运行时缺失才解出（已装的机器省一次 215MB 解包）；安装结束自动删除。
Source: "{#WebView2Installer}"; DestDir: "{tmp}"; DestName: "ms-edge-webview2-setup.exe"; Flags: deleteafterinstall; Check: NeedsWebView2

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

// 内置浏览器（webview_windows）依赖 WebView2 运行时：Win11 自带，老 Win10 /
// 精简系统可能没有。缺失时插件的 CreateCoreWebView2EnvironmentWithOptions 直接
// 失败且 Dart 侧静默吞掉——表现是浏览器面板一直空白。这里装机时检测并补齐。
// 检测口径按微软文档：HKLM(WOW6432Node) / HKCU 两处 EdgeUpdate Clients 的 pv 值。
function WebView2Installed: Boolean;
var
  Ver: String;
begin
  Result :=
    RegQueryStringValue(HKLM64, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Ver) or
    RegQueryStringValue(HKCU,  'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Ver) or
    RegQueryStringValue(HKLM,  'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Ver);
  if Result then
    Result := (Ver <> '') and (Ver <> '0.0.0.0');
end;

// [Files] 的 Check：已装就不要把这 215MB 解到临时目录。
function NeedsWebView2: Boolean;
begin
  Result := not WebView2Installed;
end;

procedure EnsureWebView2;
var
  ErrorCode: Integer;
  Installer: String;
begin
  if WebView2Installed then Exit;
  // 静默安装（/SILENT、/VERYSILENT）不能弹窗：MSG 框会直接返回默认「否」= 跳过。
  if not WizardSilent then
    if TaskDialogMsgBox('需要安装 Microsoft Edge WebView2 运行时',
        '内置浏览器（网页抓取、比价、行程页预览）依赖 WebView2 运行时，本机未检测到。' #13#10 #13#10 +
        '「是」= 现在安装（安装包内已附带，约 1-2 分钟，装到当前用户，不需管理员权限）。' +
        '「否」= 稍后自行安装，期间浏览器功能不可用，其余功能不受影响。',
        mbConfirmation, MB_YESNO, [], 0) <> IDYES then Exit;
  Installer := ExpandConstant('{tmp}\ms-edge-webview2-setup.exe');
  if FileExists(Installer) then
    Exec(Installer, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  if not WebView2Installed then
    TaskDialogMsgBox('WebView2 运行时未安装成功',
      '安装包内的运行时未能装上（可能被杀软拦截）。内置浏览器需要它。' #13#10 +
      '手动安装：搜索「下载 Microsoft Edge WebView2 运行时」，从微软官网安装后重启本应用。',
      mbInformation, MB_OK, [], 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then EnsureWebView2;
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
  if TaskDialogMsgBox('是否同时删除用户数据？',
      '选择「否」将保留登录状态与本地数据，下次安装后可直接登录使用。' #13#10 +
      '选择「是」将删除登录态、API Key 与聊天记录，且不可恢复。',
      mbConfirmation, MB_YESNO, [], 0) = IDYES then
  begin
    DelTree(ExpandConstant('{userappdata}\Nextbot'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\PrivateAgent'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\top.nextbot'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\com.example'), True, True, True);
  end;
end;
