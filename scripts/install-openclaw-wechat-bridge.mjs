/**
 * 安装微信消息桥 OpenClaw 插件，并写入 ~/.openclaw/openclaw.json 插件配置。
 * 读取 server/.env 与 server/.env.local。
 */
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const pluginDir = join(root, "openclaw-plugins", "nextbot-wechat-bridge");

dotenvConfig({ path: join(serverDir, ".env"), quiet: true });
dotenvConfig({ path: join(serverDir, ".env.local"), override: true, quiet: true });

const port = Number(process.env.PORT ?? "3000");
const bridgeToken = process.env.WECHAT_CLAW_BRIDGE_TOKEN?.trim() ?? "";
const defaultActorId =
  process.env.WECHAT_CLAW_BRIDGE_ACTOR_ID?.trim() ||
  process.env.DESKTOP_BRIDGE_USER_ID?.trim() ||
  "session-mvp-001";

function openclawCmd() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "npm", "openclaw.cmd");
  }
  return "openclaw";
}

async function main() {
  const cmd = openclawCmd();
  console.log("[wechat-bridge] 安装 OpenClaw 插件…");
  const quotedDir = pluginDir.includes(" ") ? `"${pluginDir}"` : pluginDir;
  try {
    execSync(`${process.platform === "win32" ? `"${cmd}"` : cmd} plugins install --link ${quotedDir}`, {
      stdio: "inherit",
      shell: true,
      windowsHide: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already installed|Linked plugin path/i.test(msg)) {
      console.warn(`[wechat-bridge] 插件安装提示: ${msg}`);
    }
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    /* new */
  }

  const plugins = config.plugins ?? {};
  plugins.allow = ["openclaw-weixin", "nextbot-wechat-bridge", "moonshot"];
  const entries = plugins.entries ?? {};
  entries["nextbot-wechat-bridge"] = {
    enabled: true,
    config: {
      serverBaseUrl: `http://127.0.0.1:${port}`,
      ...(bridgeToken ? { bridgeToken } : {}),
      defaultActorId,
      channels: ["openclaw-weixin"],
    },
  };
  plugins.entries = entries;
  config.plugins = plugins;

  const gateway = config.gateway ?? {};
  if (gateway.mode !== "local") {
    gateway.mode = "local";
    config.gateway = gateway;
  }

  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`[wechat-bridge] 已写入 ${configPath}`);
  console.log("[wechat-bridge] 请设置 server/.env.local: WECHAT_CLAW_BRIDGE_ENABLED=1");
  console.log("[wechat-bridge] 重启 npm run dev:all 与 Gateway 后，微信消息将走主服务 AgentCore。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
