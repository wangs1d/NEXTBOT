/**
 * 注册开机自启（仅 Windows）：今日简报等定时能力依赖服务端常驻。
 * 优先创建当前用户"登录时"计划任务（隐藏窗口、无执行时限、登录延迟 15s 等网络），
 * 无管理员权限创建失败时退回 HKCU Run 键（功能等价）。
 * 用法：npm run autostart:install
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const TASK_NAME = "NextbotServer";
const RUN_VALUE_NAME = "NextbotServer";
// 旧版名（2026-10-23 前的注册名），注册成功后顺带清理，避免双重拉起
const LEGACY_TASK_NAME = "PrivateAgentServer";
const LEGACY_RUN_VALUE_NAME = "PrivateAgentServer";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// 登录后延迟启动：等桌面/网络栈就绪，避免开机竞态
const LOGON_DELAY_S = 15;

if (process.platform !== "win32") {
  console.error("仅支持 Windows；macOS/Linux 请用 launchd/systemd 实现同等能力。");
  process.exit(1);
}

const nodeExe = process.execPath;
const wscriptExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
const vbsPath = path.join(SCRIPT_DIR, "autostart-launcher.vbs");
const launcherScript = path.join(SCRIPT_DIR, "autostart-server.mjs");
if (!fs.existsSync(launcherScript)) {
  console.error(`未找到启动器：${launcherScript}`);
  process.exit(1);
}

// 生成 VBS 壳：wscript 以窗口样式 0 运行，登录拉起时全程无黑色控制台闪现
const vbsQuote = (s) => s.replace(/"/g, '""');
fs.writeFileSync(
  vbsPath,
  [
    "' 由 install-autostart.mjs 生成（含本机绝对路径，勿手工编辑；重装自启会覆盖）",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${vbsQuote(ROOT)}"`,
    `sh.Run """${vbsQuote(nodeExe)}"" ""${vbsQuote(launcherScript)}""", 0, False`,
    "",
  ].join("\r\n"),
  "utf8",
);

function runPs(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, encoding: "utf8" },
  );
}

function registerTask() {
  const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  const ps = [
    `$action = New-ScheduledTaskAction -Execute '${wscriptExe}' -Argument '"${vbsPath}"'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User '${user}'`,
    `$trigger.Delay = 'PT${LOGON_DELAY_S}S'`,
    `$principal = New-ScheduledTaskPrincipal -UserId '${user}' -LogonType Interactive -RunLevel Limited`,
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'NextBot 服务端开机自启（今日简报等定时任务依赖）' -Force | Out-Null`,
    "Write-Output '__REGISTER_OK__'",
  ].join("; ");
  const r = runPs(ps);
  return r.status === 0 && (r.stdout ?? "").includes("__REGISTER_OK__");
}

function registerRunKey() {
  const data = `"${wscriptExe}" "${vbsPath}"`;
  const r = spawnSync("reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE_NAME, "/t", "REG_SZ", "/d", data, "/f"], {
    windowsHide: true,
    encoding: "utf8",
  });
  return r.status === 0;
}

function removeRunKey(valueName = RUN_VALUE_NAME) {
  spawnSync("reg.exe", ["delete", RUN_KEY, "/v", valueName, "/f"], { windowsHide: true, stdio: "ignore" });
}

function removeTask(taskName = TASK_NAME) {
  spawnSync("schtasks.exe", ["/end", "/tn", taskName], { windowsHide: true, stdio: "ignore" });
  spawnSync("schtasks.exe", ["/delete", "/tn", taskName, "/f"], { windowsHide: true, stdio: "ignore" });
}

console.log("正在注册开机自启…");
if (registerTask()) {
  // 此前若用过 Run 键方式（含旧版注册名），清理残留避免双重拉起
  removeRunKey();
  removeRunKey(LEGACY_RUN_VALUE_NAME);
  removeTask(LEGACY_TASK_NAME);
  console.log(`✓ 已创建计划任务「${TASK_NAME}」：每次登录后 ${LOGON_DELAY_S} 秒隐藏启动服务端栈`);
} else if (registerRunKey()) {
  removeTask();
  removeTask(LEGACY_TASK_NAME);
  console.log("✓ 已写入当前用户 Run 键：登录后隐藏启动服务端栈");
  console.log("  （计划任务创建失败，通常因缺少管理员权限；Run 键方式功能等价）");
} else {
  console.error("✗ 计划任务与 Run 键均注册失败，请用管理员权限重试：npm run autostart:install");
  process.exit(1);
}

console.log("  拉起内容：scripts/autostart/autostart-server.mjs（默认 dev 模式，与 npm run dev:all 一致；");
console.log("  端口已占用自动跳过，崩溃自动退避重启）。生产模式见 README「开机自启」一节。");
console.log(`  立即验证：schtasks /run /tn ${TASK_NAME}；查看状态：npm run autostart:status`);
