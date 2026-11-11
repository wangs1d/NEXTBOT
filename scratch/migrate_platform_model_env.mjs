// 根因方案 A：把「平台默认模型 provider」从「装机配置重放」里拆出来，
// 显式写进部署方 .env（EXTERNAL_MODEL_PROVIDER + OPENAI_*）。
// 密钥沿用加密仓里那份存量（同一把 key，职责从「用户自配」改称「平台默认」），
// 全程不打印明文；原 .env 先备份。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ENV_PATH = "/opt/nextbot/server/.env";

// 主密钥/NEXTBOT_DATA_DIR 由 systemd 注入运行进程；从 /proc 继承，避免明文过手
const pid = execFileSync("systemctl", ["show", "-p", "MainPID", "--value", "nextbot"], {
  encoding: "utf8",
}).trim();
for (const kv of fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")) {
  if (kv.startsWith("MODEL_KEY_SECRET=") || kv.startsWith("NEXTBOT_DATA_DIR=")) {
    const [k, ...rest] = kv.split("=");
    process.env[k] = rest.join("=");
  }
}
if (!process.env.MODEL_KEY_SECRET) {
  console.error("ABORT: 运行进程里没有 MODEL_KEY_SECRET，解不开加密仓");
  process.exit(2);
}

const { applyPersistedServiceConfig } = await import(
  "/opt/nextbot/server/dist/config/service-config-store.js"
);
const view = await applyPersistedServiceConfig();
const key = view?.model?.apiKey?.trim() ?? "";
if (!key) {
  console.error("ABORT: 加密仓里没有 modelApiKey，拒绝写半套 .env");
  process.exit(3);
}
const baseUrl = (view.model.baseUrl || "https://api.deepseek.com").trim();
const model = (view.model.model || "deepseek-chat").trim();

const desired = {
  EXTERNAL_MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: key,
  OPENAI_BASE_URL: baseUrl,
  OPENAI_MODEL: model,
};

const original = fs.readFileSync(ENV_PATH, "utf8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${ENV_PATH}.bak-platform-${stamp}`;
fs.writeFileSync(backup, original, { mode: 0o600 });

const lines = original.split(/\r?\n/);
for (const [k, v] of Object.entries(desired)) {
  const i = lines.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) lines[i] = `${k}=${v}`;
  else lines.push(`${k}=${v}`);
}
let next = lines.join("\n");
if (!next.endsWith("\n")) next += "\n";
fs.writeFileSync(ENV_PATH, next, { mode: 0o600 });

// 自检：确认四键都写对，但不回显值
const check = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
const report = {};
for (const k of Object.keys(desired)) {
  const line = check.find((l) => l.startsWith(`${k}=`));
  report[k] = line ? line.slice(k.length + 1).length : -1;
}
console.log("MIGRATED", JSON.stringify({ backup, keyLen: key.length, baseUrl, model, writtenValueLens: report }));
