/**
 * 按机器（单机形态）的服务密钥加密仓。
 *
 * 为什么还要落盘：本地 runtime 的自配密钥要在重启后续上，而明文
 * data/service-config.json 等于把 OpenAI / MiniMax / IMAP 凭据摊在数据根里。
 * 主密钥缺失时拒写盘，调用方继续用文件里那份——不为「加密」降级成一把能用源码
 * 常量解开的密文。
 *
 * 多租户云端不经这里：那份文件是「一个用户的 key 全站生效」的单用户形态，云端
 * 一律按 actor 存（model-keys / mail-watch/pass）。
 */

import { createEncryptedRecordStore } from "./secret-vault.js";

export interface ServiceSecretsRecord {
  /** OpenAI 兼容网关密钥（模型服务与 openai 形态的 TTS 共用） */
  modelApiKey: string;
  /** MiniMax TTS 密钥 */
  ttsApiKey: string;
  /** 老 service-config.json 里那份没有归属的 IMAP 授权码（存量，交给邮箱注册表收编） */
  mailboxPass?: string;
  savedAt: string;
}

/** 本仓只有一份机器级记录：槽名固定，不做多槽 */
const SLOT = "machine";

function isServiceSecrets(v: unknown): v is ServiceSecretsRecord {
  const r = v as Partial<ServiceSecretsRecord> | null;
  return Boolean(r && typeof r.savedAt === "string");
}

const vault = createEncryptedRecordStore<ServiceSecretsRecord>({
  dirName: "service-secrets",
  deriveSalt: "nextbot-service-config-v1",
  secretEnvNames: ["MODEL_KEY_SECRET", "WELLNESS_DATA_SECRET", "BROWSER_SESSION_SECRET", "SESSION_SECRET"],
  validate: isServiceSecrets,
});

/** 主密钥是否可用（不可用时不写盘，密钥继续留在明文文件里）。 */
export function serviceSecretsEncryptedAtRest(): boolean {
  return vault.enabled();
}

/** 取回密文里的密钥；主密钥缺失或解不开返回 null。 */
export function loadServiceSecrets(): ServiceSecretsRecord | null {
  return vault.load(SLOT);
}

/**
 * 合并写回：未提供的字段保持原值，显式传空串表示清掉。
 * 三者全空时删掉密文文件。返回是否落到密文里。
 */
export function saveServiceSecrets(patch: Partial<Omit<ServiceSecretsRecord, "savedAt">>): boolean {
  const existing = vault.load(SLOT);
  const next: ServiceSecretsRecord = {
    modelApiKey: patch.modelApiKey ?? existing?.modelApiKey ?? "",
    ttsApiKey: patch.ttsApiKey ?? existing?.ttsApiKey ?? "",
    mailboxPass: patch.mailboxPass ?? existing?.mailboxPass,
    savedAt: new Date().toISOString(),
  };
  if (!next.modelApiKey && !next.ttsApiKey && !next.mailboxPass) {
    vault.remove(SLOT);
    return true;
  }
  return vault.save(SLOT, next);
}
