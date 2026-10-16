import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getShortTermMemoryConfig } from "./short-term-memory-config.js";

/**
 * turn WAL → 全量聊天转史（2026-10-12 P1 根修）：
 *
 * 病根：聊天记录 UI 一直拿「LLM 上下文线程」当转史——线程是滑动窗口 + 摘要，
 * 窗口外原文被折叠后从线程移除，换设备/清数据后 /api/chat-data/history 最多回填
 * 窗口内那十几条。全量轮次原文其实每天都在落盘（turn WAL，JSONL，含 userText/
 * assistantText/messageId/ts），只是从未暴露给客户端。
 *
 * 本模块把 WAL 反解为按时间升序的对话转史（user/assistant 成对），供
 * /api/chat-data/history?full=1 下发。与线程彻底分离：LLM 记忆归线程管，
 * 聊天记录归 WAL 管——ChatGPT/Coze 同构。
 */

export type WalTranscriptTurn = {
  /** 轮次时刻（ms）；WAL 条目缺 ts 时 null（客户端按顺序兜底）。 */
  ts: number | null;
  userText: string;
  assistantText: string;
  clientMessageId?: string;
};

type WalRawEntry = {
  ts?: string;
  actorId?: string;
  userText?: string;
  assistantText?: string;
  messageId?: string;
  context?: string;
};

/** 文件名即日期（YYYY-MM-DD.jsonl），字典序=时间序，倒序读最近的先。 */
function isWalDayFile(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

/**
 * 「清空对话」可见性标记（2026-10-16）：WAL 是 append-only 审计日志，清空
 * 不删行，改记 per-actor 的 cleared-at（ms），转史读取时过滤清空点之前的轮次。
 * 否则换设备拉取 ?full=1 会复活用户已明确清掉的对话（手机端既有缺口，
 * 桌面端接入跨端回填前必须先堵上）。文件存在 WAL 目录内，日期文件过滤
 * 不会把它误读成 WAL 数据。
 */
const CLEARED_AT_FILE = "cleared-at.json";

type ClearedAtMap = Record<string, number>;

async function readClearedAtMap(dir: string): Promise<ClearedAtMap> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, CLEARED_AT_FILE), "utf8")) as ClearedAtMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 记录某 actor 的清空时刻（幂等：只前进不回退；重复清空取更大值）。 */
export async function setActorTranscriptClearedAt(
  dir: string,
  actorId: string,
  atMs = Date.now(),
): Promise<void> {
  const map = await readClearedAtMap(dir);
  if (atMs <= (map[actorId] ?? 0)) return;
  map[actorId] = atMs;
  try {
    await writeFile(join(dir, CLEARED_AT_FILE), JSON.stringify(map), "utf8");
  } catch {
    // 落盘失败 = 清空不生效（下次拉取仍见旧历史），静默不影响主流程
  }
}

/** 生产路径：清空某 actor 的聊天记录可见性（clear-all 接线用）。 */
export function clearActorTranscript(actorId: string, atMs = Date.now()): Promise<void> {
  const dir = join(process.cwd(), getShortTermMemoryConfig().walDir);
  return setActorTranscriptClearedAt(dir, actorId, atMs);
}

function entryTsMs(entry: WalRawEntry): number | null {
  const raw = entry.ts;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 从 WAL 目录反解某 actor 的全量转史。dir 由调用方注入（生产取
 * getShortTermMemoryConfig().walDir；测试传临时目录）。
 * - 只取主会话轮（context 缺省视为 main，notes 轮不入聊天记录）；
 * - 同 messageId / 同 ts+userText 去重（重试/幂等补写会产生重复行）；
 * - 按 ts 升序返回；空轮（user+assistant 全空）跳过。
 */
export async function readActorTranscriptFromWal(
  dir: string,
  actorId: string,
  maxDays = 90,
): Promise<WalTranscriptTurn[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter(isWalDayFile).sort();
  } catch {
    return []; // 目录不存在 = 没有任何历史，静默空转
  }
  if (names.length > maxDays) names = names.slice(-maxDays);
  const clearedAt = (await readClearedAtMap(dir))[actorId] ?? 0;

  const byKey = new Map<string, WalTranscriptTurn>();
  for (const name of names) {
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      continue; // 单文件读取失败不影响其余天
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: WalRawEntry;
      try {
        entry = JSON.parse(trimmed) as WalRawEntry;
      } catch {
        continue; // 半截行（进程被杀）跳过，不影响其余
      }
      if (entry.actorId !== actorId) continue;
      if (entry.context === "notes") continue;
      const userText = (entry.userText ?? "").trim();
      const assistantText = (entry.assistantText ?? "").trim();
      if (!userText && !assistantText) continue;
      const ts = entryTsMs(entry);
      const key = entry.messageId?.trim() || `${ts ?? name}:${userText.slice(0, 80)}`;
      if (byKey.has(key)) continue;
      const turn: WalTranscriptTurn = { ts, userText, assistantText };
      if (entry.messageId?.trim()) turn.clientMessageId = entry.messageId.trim();
      byKey.set(key, turn);
    }
  }

  return [...byKey.values()]
    // 清空点之前的轮次不下发（ts 缺省的兜底行保留，避免误删仅存的记录）
    .filter((t) => t.ts == null || t.ts > clearedAt)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || 0);
}

/** 生产路径：默认 WAL 目录下读某 actor 的转史。 */
export function readActorTranscript(actorId: string, maxDays = 90): Promise<WalTranscriptTurn[]> {
  const dir = join(process.cwd(), getShortTermMemoryConfig().walDir);
  return readActorTranscriptFromWal(dir, actorId, maxDays);
}
