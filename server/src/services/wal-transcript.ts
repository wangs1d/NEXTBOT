import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveDataPath } from "../config/data-dir.js";
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

type WalRawEntry = {
  ts?: string;
  actorId?: string;
  userText?: string;
  assistantText?: string;
  messageId?: string;
  context?: string;
  /** 出口补写的本轮媒体卡（2026-11-09）；旧行/无媒体轮缺省。 */
  mediaCards?: unknown[];
  /** 出口补写的真·分绿泡对账数组（2026-11-13）；旧行/非分泡轮缺省。 */
  bubbles?: Array<{ id?: unknown; text?: unknown }>;
  /** 出口补写的用户照片 URL（2026-11-18）；旧行/无图轮缺省。 */
  userImageUrls?: string[];
};

export type WalTranscriptTurn = {
  /** 轮次时刻（ms）；WAL 条目缺 ts 时 null（客户端按顺序兜底）。 */
  ts: number | null;
  userText: string;
  assistantText: string;
  clientMessageId?: string;
  /** 本轮媒体卡（照片/视频卡原样透传，供历史回填重建图片气泡）。 */
  mediaCards?: unknown[];
  /** 用户随消息发出的照片 URL（2026-11-18），供历史回填真实缩略图。 */
  userImageUrls?: string[];
  /**
   * 本轮分泡对账数组（2026-11-13）：真实分泡轮逐泡透传，客户端回填按泡
   * 重建多条消息；旧行/塌缩/单泡轮缺省 → 客户端降级单泡（现状行为）。
   */
  bubbles?: Array<{ id: string; text: string }>;
};

/** 文件名即日期（YYYY-MM-DD.jsonl），字典序=时间序，倒序读最近的先。 */
function isWalDayFile(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

/**
 * 服务端 WAL 转史回溯天数（2026-11-22 恢复为 90 天）。
 *
 * 全量聊天文本保存在手机/电脑本地；服务端只回溯最近 90 天，与回放上限
 * 200 条一起控制 ECS 在 12 并发下的读盘与内存开销。换设备时云端只回填
 * 最近一段，更早历史仍在本机本地库。保留上限防止误配成无限读爆目录。
 */
const DEFAULT_WAL_MAX_DAYS = 90;

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

/**
 * 单轮删除墓碑（2026-11-22）：WAL 是 append-only，删一条只改 chat thread
 * 不碰 WAL，导致换设备/重连拉 ?full=1 时已删轮次复活。每条删除记一个
 * messageId 墓碑（per-actor Set），转史读取时按 clientMessageId 过滤。
 * 与 cleared-at（全清时间点）互补：一个管单轮，一个管全量。
 */
const DELETED_TURNS_FILE = "deleted-turns.json";

type DeletedTurnsMap = Record<string, string[]>;

async function readDeletedTurnsMap(dir: string): Promise<DeletedTurnsMap> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, DELETED_TURNS_FILE), "utf8")) as DeletedTurnsMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 记录一批已删轮次 messageId（幂等：Set 去重；只增不减）。 */
export async function tombstoneActorTurns(
  dir: string,
  actorId: string,
  messageIds: string[],
): Promise<void> {
  const clean = messageIds.map((id) => id?.trim()).filter((id): id is string => !!id);
  if (clean.length === 0) return;
  const map = await readDeletedTurnsMap(dir);
  const set = new Set(map[actorId] ?? []);
  let changed = false;
  for (const id of clean) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  map[actorId] = [...set];
  try {
    await writeFile(join(dir, DELETED_TURNS_FILE), JSON.stringify(map), "utf8");
  } catch {
    // 落盘失败 = 墓碑不生效（下次拉取可能复活已删轮次），静默不影响删除主流程
  }
}

/** 生产路径：给某 actor 的单轮删除记墓碑。 */
export function deleteActorTranscriptTurns(
  actorId: string,
  messageIds: string[],
): Promise<void> {
  const dir = resolveDataPath(getShortTermMemoryConfig().walDir);
  return tombstoneActorTurns(dir, actorId, messageIds);
}

/** 生产路径：清空某 actor 的聊天记录可见性（clear-all 接线用）。 */
export function clearActorTranscript(actorId: string, atMs = Date.now()): Promise<void> {
  const dir = resolveDataPath(getShortTermMemoryConfig().walDir);
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
  maxDays = DEFAULT_WAL_MAX_DAYS,
): Promise<WalTranscriptTurn[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter(isWalDayFile).sort();
  } catch {
    return []; // 目录不存在 = 没有任何历史，静默空转
  }
  if (names.length > maxDays) names = names.slice(-maxDays);
  const clearedAt = (await readClearedAtMap(dir))[actorId] ?? 0;
  const deletedIds = new Set((await readDeletedTurnsMap(dir))[actorId] ?? []);

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
      // 单轮删除墓碑：已删轮次不下发（按 messageId 精确匹配；旧行无 id 时墓碑
      // 亦按 ts+userText 合成的 key 写入，两端一致）。放在去重之前，确保被删的
      // 轮次即使有重复行也不会漏过。
      if (deletedIds.has(key)) continue;
      if (byKey.has(key)) continue;
      const turn: WalTranscriptTurn = { ts, userText, assistantText };
      if (entry.messageId?.trim()) turn.clientMessageId = entry.messageId.trim();
      if (Array.isArray(entry.mediaCards) && entry.mediaCards.length > 0) {
        turn.mediaCards = entry.mediaCards;
      }
      if (Array.isArray(entry.userImageUrls) && entry.userImageUrls.length > 0) {
        turn.userImageUrls = entry.userImageUrls.filter(
          (u): u is string => typeof u === "string" && u.startsWith("/agent/images/"),
        );
      }
      // 分泡对账数组透传（2026-11-13）：只收 id+text 均非空串的泡，且整轮
      // 至少一泡才挂字段——单泡塌缩轮（bubbles 长度 1）也透传，客户端按泡
      // 重建后形态与当轮一致；空/脏结构静默忽略（旧行兼容）。
      if (Array.isArray(entry.bubbles)) {
        const cleanBubbles = entry.bubbles
          .filter(
            (b): b is { id: string; text: string } =>
              !!b &&
              typeof b === "object" &&
              typeof b.id === "string" &&
              typeof b.text === "string" &&
              b.text.trim().length > 0,
          )
          .map((b) => ({ id: b.id, text: b.text }));
        if (cleanBubbles.length > 0) turn.bubbles = cleanBubbles;
      }
      byKey.set(key, turn);
    }
  }

  return [...byKey.values()]
    // 清空点之前的轮次不下发（ts 缺省的兜底行保留，避免误删仅存的记录）
    .filter((t) => t.ts == null || t.ts > clearedAt)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || 0);
}

/** 生产路径：默认 WAL 目录下读某 actor 的转史（近 90 天回溯，见 DEFAULT_WAL_MAX_DAYS）。 */
export function readActorTranscript(actorId: string, maxDays = DEFAULT_WAL_MAX_DAYS): Promise<WalTranscriptTurn[]> {
  const dir = resolveDataPath(getShortTermMemoryConfig().walDir);
  return readActorTranscriptFromWal(dir, actorId, maxDays);
}
