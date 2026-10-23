/**
 * 启动本地服务；端口已占用则跳过（绑定探测，启动前再检一次）。
 */
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isTcpPortInUse } from "./port-in-use.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

// Set console codepage to UTF-8 on Windows to avoid garbled Chinese output.
if (isWin) {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

/** server 最后启动，减少与其它进程抢 3000 的竞态；
 *  --remote：server 项切换为 runtime 守护进程（内部端口 3211，
 *  gateway 随 dev-server-watch 一并拉起，对外仍占 3000） */
const isRemote = process.argv.includes("--remote");
const SERVICES = [
  isRemote
    ? { name: "runtime", port: 3211, npmScript: "dev:all:runtime" }
    : { name: "server", port: 3000, npmScript: "dev:all:server" },
];

function spawnNpm(args, opts = {}) {
  return spawn("npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    ...opts,
  });
}

function runAndWait(childFactory) {
  return new Promise((resolve, reject) => {
    const child = childFactory();
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`process exited with ${code}`));
    });
    child.on("error", reject);
  });
}

async function filterAvailable(services) {
  const available = [];
  for (const svc of services) {
    if (!(await isTcpPortInUse(svc.port))) available.push(svc);
  }
  return available;
}

let toStart = await filterAvailable(SERVICES);

if (toStart.length === 0) {
  process.exit(0);
}

await runAndWait(() => spawnNpm(["run", "build", "-w", "@nextbot/agent-world"]));

toStart = await filterAvailable(toStart);

if (toStart.length === 0) {
  process.exit(0);
}

const children = [];
for (const svc of toStart) {
  if (await isTcpPortInUse(svc.port)) continue;
  children.push(spawnNpm(["run", svc.npmScript]));
}

if (children.length === 0) {
  process.exit(0);
}

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1500).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (code !== 0 && code !== null) shutdown(code ?? 1);
  });
}

// 保持进程长驻，收到终止信号时由 shutdown 统一退出
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 定期心跳避免被部分运行时标记为"空闲"；永不主动 exit
setInterval(() => {}, 2_147_483_647); // ~24.8 天一次，等效永久保持
