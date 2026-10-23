import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/**
 * 女性关怀敏感数据加密（周期记录 / 情绪日志 / 紧急联系人）。
 *
 * 与 browser-session-crypto.ts 同一套 AES-256-GCM 结构，但使用独立派生盐与
 * 独立环境变量 `WELLNESS_DATA_SECRET`：轮换浏览器会话密钥不影响关怀数据，
 * 反之亦然；未单独配置时回退共享密钥，保证开箱即用（docs/women-care-proposal.md §D.1）。
 */
function deriveKey(): Buffer {
  const secret =
    process.env.WELLNESS_DATA_SECRET?.trim() ||
    process.env.BROWSER_SESSION_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    "dev-insecure-wellness-key-change-me";
  return scryptSync(secret, "nextbot-wellness-v1", 32);
}

/** 加密任意 JSON（iv + tag + ciphertext，base64）。 */
export function encryptWellnessJson(value: unknown): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** 解密 {@link encryptWellnessJson} 的载荷；密钥不匹配 / 数据损坏时抛错。 */
export function decryptWellnessJson<T>(payload: string): T {
  const key = deriveKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 28) throw new Error("无效的关怀数据加密载荷");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}
