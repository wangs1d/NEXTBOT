/**
 * 女性关怀加密存贮的种子/查看工具（E2E 测试辅助，也用于人工排障）。
 *
 *   node scripts/e2e/wellness-store.mjs seed   # 预置 session-mvp-001 的周期数据（预测=今天+2天，今天触发临近提醒）
 *   node scripts/e2e/wellness-store.mjs show   # 解密打印 period-care / safety-guard 两个存储的当前内容
 *
 * 密钥加载顺序与 src/services/wellness-crypto.ts 保持一致。
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

config({ path: join(process.cwd(), ".env") });
config({ path: join(process.cwd(), ".env.local") });

const secret =
  process.env.WELLNESS_DATA_SECRET?.trim() ||
  process.env.BROWSER_SESSION_SECRET?.trim() ||
  process.env.SESSION_SECRET?.trim() ||
  "dev-insecure-wellness-key-change-me";
const key = scryptSync(secret, "nextbot-wellness-v1", 32);

function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptJson(payload) {
  const buf = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"));
}

function localDateKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const ACTOR = process.env.E2E_ACTOR ?? "session-mvp-001";
const periodDir = join(process.cwd(), "data", "period-care");
const safetyDir = join(process.cwd(), "data", "safety-guard");

async function seed() {
  // 两次开始日：今天-54 与 今天-26 → 周期长度样本 28 天 → 预测下次开始 = 今天+2，
  // 默认提前 2 天提醒 → 提醒日=今天；reminderHour=0 保证任意时刻的 tick 都命中。
  const store = {
    version: 1,
    cycles: [
      { id: randomUUID(), startDate: localDateKey(-54), createdAt: new Date().toISOString() },
      { id: randomUUID(), startDate: localDateKey(-26), createdAt: new Date().toISOString() },
    ],
    logs: [],
    settings: {
      reminderEnabled: true,
      reminderDaysBefore: 2,
      reminderHour: 0,
    },
    sentReminderKeys: [],
  };
  await mkdir(periodDir, { recursive: true });
  await writeFile(join(periodDir, `${ACTOR}.json`), encryptJson(store), "utf8");
  console.log(`[seed] 已写入加密周期数据 → data/period-care/${ACTOR}.json（预测开始日=${localDateKey(2)}）`);
}

async function show() {
  for (const [label, dir] of [["period-care", periodDir], ["safety-guard", safetyDir]]) {
    console.log(`\n===== ${label} =====`);
    try {
      const raw = await readFile(join(dir, `${ACTOR}.json`), "utf8");
      console.log(JSON.stringify(decryptJson(raw), null, 2));
    } catch (error) {
      console.log(`（无数据或解密失败：${error.message}）`);
    }
  }
}

const mode = process.argv[2] ?? "show";
if (mode === "seed") await seed();
else if (mode === "show") await show();
else if (mode === "set-mobile") {
  // 直接往加密安全档案写入本人手机号（跳过模型，测试借口来电 needsSetup 之后的链路）
  const phone = process.argv[3];
  if (!phone) {
    console.error("用法：... set-mobile <手机号>");
    process.exit(1);
  }
  await mkdir(safetyDir, { recursive: true });
  let store = { version: 1, contacts: [], settings: {}, sosHistory: [] };
  try {
    const raw = await readFile(join(safetyDir, `${ACTOR}.json`), "utf8");
    store = decryptJson(raw);
  } catch {}
  store.settings = { ...store.settings, myMobileNumber: phone };
  await writeFile(join(safetyDir, `${ACTOR}.json`), encryptJson(store), "utf8");
  console.log(`[set-mobile] 已写入 myMobileNumber=${phone} → data/safety-guard/${ACTOR}.json`);
} else {
  console.error("用法：node scripts/e2e/wellness-store.mjs [seed|show|set-mobile <手机号>]");
  process.exit(1);
}
