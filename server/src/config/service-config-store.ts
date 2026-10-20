/**
 * 运行时服务接入配置（内测 byok 形态）：模型 / TTS / 邮箱等外部服务的用户自配密钥。
 *
 * 背景：内测期服务端不代充模型/语音额度，用户在客户端「服务接入」页自行填
 * API Key。配置经 PUT /api/service-config 写入本文件（data/service-config.json）
 * 并即时写入 process.env 热生效——主对话 provider 由 MutableExternalChatProvider
 * 代理热替换；TtsService 按密钥变化惰性重建客户端；旁路 LLM（resolve-provider）
 * 每次调用动态读 env，天然热生效。重启后由 create-app-services 启动时重放本文件，
 * 与桌面端 byok 的 %APPDATA%\PrivateAgent\config.env 启动注入同一时序语义。
 *
 * env 语义与桌面端写 config.env 完全同键：OPENAI_API_KEY / OPENAI_BASE_URL /
 * OPENAI_MODEL（OpenAI 兼容网关），并显式置 EXTERNAL_MODEL_PROVIDER=openai，
 * 防止部署机残留的 MOONSHOT/MINIMAX 等密钥在 auto 模式下抢占用户自配的绑定。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";

export type ModelServiceConfig = {
  /** 服务商标识（目录 id 或 custom）；信息性字段，绑定语义看 baseUrl/model */
  providerId: string;
  /** OpenAI 兼容网关地址 */
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: string;
};

export type TtsServiceConfig = {
  /** minimax：写 MINIMAX_API_KEY；openai：复用模型服务的 OPENAI_API_KEY */
  provider: "minimax" | "openai";
  apiKey: string;
  updatedAt: string;
};

/** 邮箱接入（邮箱盯梢）：只存 IMAP 授权码，host/user 沿用登录邮箱域自动接入（auto-mail-account）。 */
export type MailServiceConfig = {
  /** IMAP 授权码 / 应用专用密码（非邮箱登录密码） */
  pass: string;
  updatedAt: string;
};

export type ServiceConfigFile = {
  version: 1;
  updatedAt: string;
  model?: ModelServiceConfig;
  tts?: TtsServiceConfig;
  mail?: MailServiceConfig;
};

export type ServiceConfigPatch = {
  model?: Omit<ModelServiceConfig, "updatedAt">;
  tts?: Omit<TtsServiceConfig, "updatedAt">;
  mail?: Omit<MailServiceConfig, "updatedAt">;
};

/** 密钥脱敏：只留尾 4 位，供状态回显（绝不下发完整 key） */
export function maskServiceKey(key: string | undefined): string | null {
  const k = (key ?? "").trim();
  if (!k) return null;
  return k.length <= 4 ? `****${k}` : `****${k.slice(-4)}`;
}

export function serviceConfigFilePath(dir: string = join(process.cwd(), "data")): string {
  return join(dir, "service-config.json");
}

export async function readServiceConfigFile(
  dir: string = join(process.cwd(), "data"),
): Promise<ServiceConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(serviceConfigFilePath(dir), "utf8");
  } catch {
    return null; // 文件缺失/不可读：视为无持久化配置（与 model-providers 同一容错哲学）
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceConfigFile>;
    if (parsed.version !== 1) return null;
    return parsed as ServiceConfigFile;
  } catch {
    return null;
  }
}

/** 把服务接入配置写入 env（只写有值的块；不做删除——撤销接入请清空文件后重启） */
export function applyServiceConfigToEnv(
  cfg: ServiceConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const model = cfg.model;
  if (model && model.apiKey.trim()) {
    env.OPENAI_API_KEY = model.apiKey.trim();
    if (model.baseUrl.trim()) env.OPENAI_BASE_URL = model.baseUrl.trim();
    if (model.model.trim()) env.OPENAI_MODEL = model.model.trim();
    // 显式钉住槽位：目录商全部走 OpenAI 兼容网关；否则 auto 会优先探其它厂商密钥
    env.EXTERNAL_MODEL_PROVIDER = "openai";
  }
  const tts = cfg.tts;
  if (tts && tts.provider === "minimax" && tts.apiKey.trim()) {
    env.MINIMAX_API_KEY = tts.apiKey.trim();
  }
  // tts.provider === "openai"：复用模型服务的 OPENAI_API_KEY，无需单独 env
  const mail = cfg.mail;
  if (mail && mail.pass.trim()) {
    // 邮箱盯梢按 env 键启动（MailWatchService 构造期读 env）；enabled 随之点亮
    env.MAIL_WATCH_PASS = mail.pass.trim();
    env.MAIL_WATCH_ENABLED = "1";
  }
}

/** 启动时重放持久化配置（create-app-services 在解析 externalChat 之前调用）。返回应用了的配置。 */
export async function applyPersistedServiceConfig(
  dir: string = join(process.cwd(), "data"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceConfigFile | null> {
  const cfg = await readServiceConfigFile(dir);
  if (!cfg) return null;
  applyServiceConfigToEnv(cfg, env);
  return cfg;
}

/** 合并保存一个补丁并即时应用到 env；返回落盘后的完整配置。 */
export async function saveServiceConfigPatch(
  patch: ServiceConfigPatch,
  dir: string = join(process.cwd(), "data"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceConfigFile> {
  const existing = (await readServiceConfigFile(dir)) ?? {
    version: 1 as const,
    updatedAt: new Date(0).toISOString(),
  };
  const now = new Date().toISOString();
  const next: ServiceConfigFile = {
    ...existing,
    updatedAt: now,
    ...(patch.model ? { model: { ...patch.model, updatedAt: now } } : {}),
    ...(patch.tts ? { tts: { ...patch.tts, updatedAt: now } } : {}),
    ...(patch.mail ? { mail: { ...patch.mail, updatedAt: now } } : {}),
  };
  await writeJsonAtomic(serviceConfigFilePath(dir), next);
  applyServiceConfigToEnv(next, env);
  return next;
}
