import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

function deriveKey(): Buffer {
  const secret =
    process.env.BROWSER_SESSION_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    "dev-insecure-browser-session-key-change-me";
  return scryptSync(secret, "nextbot-browser-session-v1", 32);
}

export function encryptJson(value: unknown): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptJson<T>(payload: string): T {
  const key = deriveKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 28) throw new Error("无效的加密 Cookie 载荷");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}
