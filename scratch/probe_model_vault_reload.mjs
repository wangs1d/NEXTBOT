// 生产只读探针：验证 model-keys 加密仓在「全新进程」里能解回绑定
// （等价于服务端重启后的 ensureVaultLoaded），不打印任何密钥明文。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const pid = execFileSync("systemctl", ["show", "-p", "MainPID", "--value", "nextbot"], {
  encoding: "utf8",
}).trim();
for (const kv of fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")) {
  if (kv.startsWith("MODEL_KEY_SECRET=") || kv.startsWith("NEXTBOT_DATA_DIR=")) {
    const [k, ...rest] = kv.split("=");
    process.env[k] = rest.join("=");
  }
}
const { loadModelKeys, modelKeyVaultEnabled } = await import(
  "/opt/nextbot/server/dist/services/model-key-vault.js"
);
const { entries, undecryptable } = loadModelKeys();
console.log(
  "VAULT_RELOAD",
  JSON.stringify({
    vaultEnabled: modelKeyVaultEnabled(),
    count: entries.length,
    undecryptable,
    hasProbeActor: entries.some((e) => e.actorId.includes("inst_probe_vault_")),
    actors: entries.map((e) => e.actorId).slice(0, 5),
    keysRecovered: entries.every((e) => Boolean(e.apiKey)),
  }),
);
