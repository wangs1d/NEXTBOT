// 生产只读探针：验证「平台默认 provider 仅靠 .env 四键即可构造」，不打印任何密钥明文。
// 结论用于根因方案 A：把平台 provider 与「装机配置重放」解耦。
import { applyPersistedServiceConfig } from "/opt/nextbot/server/dist/config/service-config-store.js";

const original = { ...process.env };
const view = await applyPersistedServiceConfig();
const key = view?.model?.apiKey ?? "";
console.log("VAULT_MODEL", JSON.stringify({
  hasKey: Boolean(key),
  keyLen: key.length,
  baseUrl: view?.model?.baseUrl ?? null,
  model: view?.model?.model ?? null,
}));

// 还原 env，模拟「云端不重放装机配置」的进程状态
for (const k of Object.keys(process.env)) {
  if (!(k in original)) delete process.env[k];
}
Object.assign(process.env, original);

// 只靠部署方显式声明的四键
process.env.EXTERNAL_MODEL_PROVIDER = "openai";
process.env.OPENAI_API_KEY = key;
process.env.OPENAI_BASE_URL = view?.model?.baseUrl || "https://api.deepseek.com";
process.env.OPENAI_MODEL = view?.model?.model || "deepseek-chat";

const { createExternalChatProviderFromEnv } = await import(
  "/opt/nextbot/server/dist/external-model/resolve-provider.js"
);
const provider = createExternalChatProviderFromEnv();
console.log("ENV_ONLY_PROVIDER", JSON.stringify({
  constructed: Boolean(provider),
  className: provider?.constructor?.name ?? null,
  enabled: provider?.isEnabled?.() ?? null,
}));
