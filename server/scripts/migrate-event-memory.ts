/**
 * 事件记忆层（L0）回填与 price-history 迁移。
 *
 * 默认 dry-run：只统计、不写库。加 `--apply` 才真正写入（写前自动备份
 * agentic-memory.db）。幂等：事件 id 由 messageId / (ts+文本) 稳定派生，
 * 重复跑不会叠加。
 *
 * 用法：
 *   cd server && npx tsx scripts/migrate-event-memory.ts            # 干跑
 *   cd server && npx tsx scripts/migrate-event-memory.ts --apply    # 落库
 *
 * 数据源：
 *   - <data>/turn-wal/*.jsonl      每行一轮对话 → kind=chat_turn
 *   - <data>/shopping/price-history.json → kind=price_compare
 */

import "../src/config/load-server-env.js";

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { getDataDir } from "../src/config/data-dir.js";
import { getAgenticSqlitePath, openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  buildTurnEvent,
  looksLikeAccessoryPrice,
  type MemoryEventRecord,
} from "../src/agentic-memory/event-builder.js";
import { EventMemoryStore } from "../src/agentic-memory/event-store.js";
import { isEphemeralActorId } from "../src/agent/actor-id.js";

const APPLY = process.argv.includes("--apply");

type WalLine = {
  ts?: string;
  actorId?: string;
  userText?: string;
  assistantText?: string;
  messageId?: string;
  context?: "main" | "notes";
};

type PriceHistoryEntry = {
  ts: string;
  actorId: string;
  query: string;
  platform: string;
  minPriceCny: number | null;
};

async function main(): Promise<void> {
  const dataDir = getDataDir();
  const dbPath = getAgenticSqlitePath();
  console.log(`[migrate-event-memory] 数据根: ${dataDir}`);
  console.log(`[migrate-event-memory] 事件库: ${dbPath}`);
  console.log(`[migrate-event-memory] 模式: ${APPLY ? "APPLY（写入）" : "DRY-RUN（只统计）"}`);

  const events: MemoryEventRecord[] = [];
  const walDir = join(dataDir, "turn-wal");
  let walFiles = 0;
  let walLines = 0;
  let walSkipped = 0;

  if (existsSync(walDir)) {
    const files = (await readdir(walDir)).filter((name) => name.endsWith(".jsonl")).sort();
    walFiles = files.length;
    for (const name of files) {
      const raw = await readFile(join(walDir, name), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        walLines += 1;
        let entry: WalLine;
        try {
          entry = JSON.parse(line) as WalLine;
        } catch {
          walSkipped += 1;
          continue;
        }
        const ts = entry.ts?.trim();
        const actorId = entry.actorId?.trim();
        const userText = entry.userText ?? "";
        if (!ts || !actorId || isEphemeralActorId(actorId) || !userText.trim()) {
          walSkipped += 1;
          continue;
        }
        const event = buildTurnEvent({
          actorId,
          userText,
          assistantText: entry.assistantText ?? "",
          ts,
          sessionId: undefined,
          messageId: entry.messageId,
          context: entry.context === "notes" ? "notes" : "main",
        });
        event.payload = { ...event.payload, source: "turn-wal-backfill" };
        events.push(event);
      }
    }
  }

  let priceEntries = 0;
  let priceInvalid = 0;
  const priceFile = join(dataDir, "shopping", "price-history.json");
  if (existsSync(priceFile)) {
    try {
      const parsed = JSON.parse(await readFile(priceFile, "utf8")) as { entries?: PriceHistoryEntry[] };
      for (const entry of parsed.entries ?? []) {
        if (!entry?.ts || !entry.actorId || !entry.query) continue;
        priceEntries += 1;
        const invalid = looksLikeAccessoryPrice(entry.query, entry.minPriceCny);
        if (invalid) priceInvalid += 1;
        const priceText =
          entry.minPriceCny == null ? "未拿到有效报价" : `最低 ¥${entry.minPriceCny}（${entry.platform}）`;
        const event = buildTurnEvent({
          actorId: entry.actorId,
          userText: `比价 ${entry.query}`,
          assistantText: invalid ? `${entry.platform} 返回 ¥${entry.minPriceCny}，疑似配件/非整机价，不作为有效报价` : priceText,
          ts: entry.ts,
          toolTraces: [
            {
              toolName: "shopping.compare.prices",
              input: { query: entry.query },
              ok: entry.minPriceCny != null || !invalid,
              result: { products: [{}], platform: entry.platform, priceCny: entry.minPriceCny },
            },
          ],
        });
        event.kind = "price_compare";
        event.status = invalid ? "invalid" : "ok";
        event.payload = {
          query: entry.query,
          platform: entry.platform,
          minPriceCny: entry.minPriceCny,
          source: "price-history",
          ...(invalid ? { suspect: "accessory" } : {}),
        };
        event.refs = { source: "price-history", ts: entry.ts };
        events.push(event);
      }
    } catch (err) {
      console.warn("[migrate-event-memory] price-history 读取失败（跳过）:", err);
    }
  }

  const byKind = events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[migrate-event-memory] turn-wal: ${walFiles} 个文件 / ${walLines} 行，跳过 ${walSkipped} 行`,
  );
  console.log(`[migrate-event-memory] price-history: ${priceEntries} 条（invalid ${priceInvalid} 条）`);
  console.log(`[migrate-event-memory] 待写入事件: ${events.length} 条`, byKind);

  if (!APPLY) {
    console.log("[migrate-event-memory] DRY-RUN 结束；加 --apply 落库。");
    return;
  }

  if (existsSync(dbPath)) {
    // WAL 库不能直接拷文件（在线写入时可能拷到半截）；VACUUM INTO 走 SQLite 取一致性快照。
    const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const src = new Database(dbPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    console.log(`[migrate-event-memory] 已备份原库: ${backup}`);
  }

  const store = new EventMemoryStore(openAgenticSqlite(dbPath));
  try {
    let written = 0;
    for (const event of events) {
      store.upsertEvent(event);
      written += 1;
    }
    console.log(`[migrate-event-memory] 写入完成: ${written} 条，库内现有 ${store.stats().events} 条事件`);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error("[migrate-event-memory] 失败:", err);
  process.exitCode = 1;
});
