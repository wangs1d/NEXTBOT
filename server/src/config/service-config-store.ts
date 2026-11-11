/**
 * 运行时服务接入配置（内测 byok 形态）：模型 / TTS 等外部服务的用户自配密钥。
 *
 * 背景：内测期服务端不代充模型/语音额度，用户在客户端「服务接入」页自行填
 * API Key。配置经 PUT /api/service-config 保存并即时写入 process.env 热生效——
 * 主对话 provider 由 MutableExternalChatProvider 代理热替换；TtsService 按密钥
 * 变化惰性重建客户端；旁路 LLM（resolve-provider）每次调用动态读 env，天然热生效。
 * 重启后由 create-app-services 启动时重放，与桌面端 byok 的 %APPDATA%\Nextbot\config.env
 * 启动注入同一时序语义。
 *
 * 密钥存放分两处：
 * - data/service-config.json 只留非密钥字段（providerId / baseUrl / model / tts.provider）
 * - 密钥进加密仓 service-secrets/machine.enc（见 service-secrets-vault）；没配主密钥时
 *   退回明文文件那份（状态口如实报 encryptedAtRest:false），不为加密牺牲可用性
 *
 * 邮箱授权码不在这里：它是「这个人这个邮箱」的凭据，改由邮箱注册表按 actor 加密保存
 * （mail-watch/pass/<actor>.enc），本文件里只剩老装机的存量字段，重放时挪进加密仓。
 *
 * 多租户云端（ACCESS_AUTH_REQUIRED=1）**整条装机配置链**关闭：用户自有 key 一律走
 * session.init 上送 + 按 actor 加密落盘（PUT 返回 409，见
 * routes/http/service-config.ts），启动时也不重放这份文件。平台默认模型 provider
 * 由部署方在 server/.env 独立显式声明，与用户配置彻底分离。
 *
 * 2026-11-12 根因：本文件过去承担了「平台默认 provider」的隐职责——
 * applyServiceConfigToEnv 会把 .env 里显式写的 EXTERNAL_MODEL_PROVIDER 静默覆写成
 * openai，于是运维声明与代码行为互相打架。现在 applyServiceConfigToEnv 在云端形态
 * 跳过 model 段（守卫），即使有人误调 applyPersistedServiceConfig 也不会把一份
 * 用户自配 key 变成全站 provider。这个守卫是防回归闸，勿删。
 *
 * env 语义与桌面端写 config.env 完全同键：OPENAI_API_KEY / OPENAI_BASE_URL /
 * OPENAI_MODEL（OpenAI 兼容网关）；单机形态下显式置 EXTERNAL_MODEL_PROVIDER=openai，
 * 防止部署机残留的 MOONSHOT/MINIMAX 等密钥在 auto 模式下抢占用户自配的绑定。
 */

import { isAccessAuthRequired } from "./env.js";
import { getDataDir } from "./data-dir.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import {
  loadServiceSecrets,
  saveServiceSecrets,
  serviceSecretsEncryptedAtRest,
} from "../services/service-secrets-vault.js";

export { serviceSecretsEncryptedAtRest };

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

/** 内存视图：非密钥字段来自文件，密钥来自加密仓（无主密钥时退回文件里的明文存量）。 */
export type ServiceConfigFile = {
  version: 1;
  updatedAt: string;
  model?: ModelServiceConfig;
  tts?: TtsServiceConfig;
  /** 老文件里那份没有归属的 IMAP 授权码，只读不写；新提交一律走邮箱注册表 */
  legacyMailPass?: string;
};

/** 落盘形态：密钥字段只可能出现在历史明文文件里，迁移后一律不写。 */
type ServiceConfigOnDisk = {
  version: 1;
  updatedAt: string;
  model?: Partial<Omit<ModelServiceConfig, "apiKey">> & { apiKey?: string };
  tts?: Partial<Omit<TtsServiceConfig, "apiKey">> & { apiKey?: string };
  mail?: { pass?: string; updatedAt?: string };
};

export type ServiceConfigPatch = {
  model?: Omit<ModelServiceConfig, "updatedAt">;
  tts?: Omit<TtsServiceConfig, "updatedAt">;
};

/** 密钥脱敏：只留尾 4 位，供状态角标（任何接口都不下发完整密钥） */
export function maskServiceKey(key: string | undefined): string | null {
  const k = (key ?? "").trim();
  if (!k) return null;
  return k.length <= 4 ? `****${k}` : `****${k.slice(-4)}`;
}

export function serviceConfigFilePath(dir: string = getDataDir()): string {
  return join(dir, "service-config.json");
}

async function readOnDisk(dir: string): Promise<ServiceConfigOnDisk | null> {
  let raw: string;
  try {
    raw = await readFile(serviceConfigFilePath(dir), "utf8");
  } catch {
    return null; // 文件缺失/不可读：视为无持久化配置（与 model-providers 同一容错哲学）
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceConfigOnDisk>;
    if (parsed.version !== 1) return null;
    return parsed as ServiceConfigOnDisk;
  } catch {
    return null;
  }
}

/** 文件字段 + 加密仓密钥 → 内存视图。密文里有值就以密文为准（那是最后一次保存的）。 */
function toView(disk: ServiceConfigOnDisk): ServiceConfigFile {
  const secrets = loadServiceSecrets();
  const view: ServiceConfigFile = {
    version: 1,
    updatedAt: disk.updatedAt,
  };
  if (disk.model) {
    view.model = {
      providerId: disk.model.providerId ?? "custom",
      baseUrl: disk.model.baseUrl ?? "",
      model: disk.model.model ?? "",
      apiKey: secrets?.modelApiKey || disk.model.apiKey || "",
      updatedAt: disk.model.updatedAt ?? disk.updatedAt,
    };
  }
  if (disk.tts) {
    view.tts = {
      provider: disk.tts.provider === "openai" ? "openai" : "minimax",
      apiKey: secrets?.ttsApiKey || disk.tts.apiKey || "",
      updatedAt: disk.tts.updatedAt ?? disk.updatedAt,
    };
  }
  const legacyMail = secrets?.mailboxPass || disk.mail?.pass || "";
  if (legacyMail) view.legacyMailPass = legacyMail;
  return view;
}

/**
 * 存量明文迁移：把文件里的 model/tts 密钥与老邮箱授权码挪进加密仓，然后把明文从
 * 文件里删掉。主密钥缺失时不挪也不删——宁可留着可用的明文，也不写一把解不开的密文。
 */
async function migratePlaintextSecrets(disk: ServiceConfigOnDisk, dir: string): Promise<boolean> {
  if (!serviceSecretsEncryptedAtRest()) return false;
  const plaintext = {
    modelApiKey: disk.model?.apiKey?.trim(),
    ttsApiKey: disk.tts?.apiKey?.trim(),
    mailboxPass: disk.mail?.pass?.trim(),
  };
  const hasPlaintext = Boolean(plaintext.modelApiKey || plaintext.ttsApiKey || plaintext.mailboxPass);
  if (!hasPlaintext) return false;
  if (!saveServiceSecrets(plaintext)) return false;
  const next: ServiceConfigOnDisk = {
    version: 1,
    updatedAt: disk.updatedAt,
    ...(disk.model
      ? {
          model: {
            providerId: disk.model.providerId,
            baseUrl: disk.model.baseUrl,
            model: disk.model.model,
            updatedAt: disk.model.updatedAt,
          },
        }
      : {}),
    ...(disk.tts ? { tts: { provider: disk.tts.provider, updatedAt: disk.tts.updatedAt } } : {}),
  };
  await writeJsonAtomic(serviceConfigFilePath(dir), next);
  return true;
}

export async function readServiceConfigFile(
  dir: string = getDataDir(),
): Promise<ServiceConfigFile | null> {
  const disk = await readOnDisk(dir);
  return disk ? toView(disk) : null;
}

/** 把服务接入配置写入 env（只写有值的块；不做删除——撤销接入请清空文件后重启） */
export function applyServiceConfigToEnv(
  cfg: ServiceConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  opts: { sharedTenant?: boolean } = {},
): void {
  // 防回归闸：多租户云端下装机配置不再是任何人的模型来源，平台默认 provider
  // 只认 server/.env。绝不在这里覆写部署方显式声明的 EXTERNAL_MODEL_PROVIDER。
  const sharedTenant = opts.sharedTenant ?? isAccessAuthRequired();
  const model = cfg.model;
  if (model && model.apiKey.trim() && !sharedTenant) {
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
  // 老文件那份无归属授权码交给 env 链，由邮箱注册表按「整机唯一账号」收编（收编后
  // 改按 actor 加密保存）。新提交走 POST /api/mail-watch/pass，不再写机器级 env，也
  // 不再点亮 MAIL_WATCH_ENABLED——账号接入自带开盯语义（MailWatchService.applyAccount）。
  const legacyMail = cfg.legacyMailPass?.trim();
  if (legacyMail && !env.MAIL_WATCH_PASS?.trim()) env.MAIL_WATCH_PASS = legacyMail;
}

/** 启动时重放持久化配置（create-app-services 在解析 externalChat 之前调用）。返回应用了的配置。 */
export async function applyPersistedServiceConfig(
  dir: string = getDataDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceConfigFile | null> {
  const disk = await readOnDisk(dir);
  if (!disk) return null;
  const migrated = await migratePlaintextSecrets(disk, dir);
  const cfg = migrated ? ((await readOnDisk(dir)) ?? disk) : disk;
  const view = toView(cfg);
  applyServiceConfigToEnv(view, env);
  return view;
}

/** 合并保存一个补丁并即时应用到 env；返回落盘后的完整配置。 */
export async function saveServiceConfigPatch(
  patch: ServiceConfigPatch,
  dir: string = getDataDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceConfigFile> {
  const disk = (await readOnDisk(dir)) ?? {
    version: 1 as const,
    updatedAt: new Date(0).toISOString(),
  };
  const now = new Date().toISOString();
  const next: ServiceConfigOnDisk = {
    version: 1,
    updatedAt: now,
    ...(disk.model ? { model: { ...disk.model } } : {}),
    ...(disk.tts ? { tts: { ...disk.tts } } : {}),
    // 老文件的邮箱存量原样带着走（挪进密文后才抹，见下）
    ...(disk.mail ? { mail: { ...disk.mail } } : {}),
  };
  if (patch.model) {
    next.model = {
      ...(next.model ?? {}),
      providerId: patch.model.providerId,
      baseUrl: patch.model.baseUrl,
      model: patch.model.model,
      updatedAt: now,
    };
  }
  if (patch.tts) {
    next.tts = { ...(next.tts ?? {}), provider: patch.tts.provider, updatedAt: now };
  }
  // 密钥进加密仓；主密钥缺失时写不进密文，就把明文留在文件里保证单机装机仍可用
  saveServiceSecrets({
    ...(patch.model ? { modelApiKey: patch.model.apiKey } : {}),
    ...(patch.tts ? { ttsApiKey: patch.tts.apiKey } : {}),
  });
  const durable = loadServiceSecrets();
  if (patch.model) {
    next.model = { ...(next.model ?? {}), apiKey: patch.model.apiKey };
  }
  if (patch.tts) {
    next.tts = { ...(next.tts ?? {}), apiKey: patch.tts.apiKey };
  }
  // 密文里已经有等价副本的字段才从文件里抹掉：没有副本就留着，别把在用的凭据弄丢
  if (durable?.modelApiKey && next.model) delete next.model.apiKey;
  if (durable?.ttsApiKey && next.tts) delete next.tts.apiKey;
  if (durable?.mailboxPass && next.mail) delete next.mail;
  await writeJsonAtomic(serviceConfigFilePath(dir), next);
  const view = toView(next);
  applyServiceConfigToEnv(view, env);
  return view;
}
