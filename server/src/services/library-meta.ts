/**
 * 资料库「产物 → 对话」归属表。
 *
 * 图片（data/images/<actor>/）与文件（data/user-files/<actor>/）落盘时只知道
 * actorId，不知道是哪一次对话产出的。资料库要按「每次对话」折叠成一张卡，
 * 需要在落盘时额外记一笔 fileName → sessionId 的映射。
 *
 * 存储：data/library-meta/<actorId>.json
 *   { "images": { "<fileName>": { "sessionId": "...", "at": "ISO" } }, "files": { ... } }
 *
 * 历史产物没有映射，资料库按「历史记录」组兜底展示；映射缺失不影响产物本身。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "../config/data-dir.js";

export type LibraryMediaKind = "images" | "files";

/**
 * 产出资料所属的「这次对话」粒度信息。
 *
 * 2026-11-12：主对话是单一会话（sessionId=actorId 恒定），只按 sessionId 折叠会把
 * 主对话全部产物挤进一张卡。落盘时额外记 `chatUserMessageId`（触发本轮工具执行的
 * 用户消息 id）作为轮次键，卡标题取用户请求原文前 40 字。
 */
export type MediaTurnInfo = {
  /** 触发本轮的 `chat.user_message.messageId`；空 = 无法细分，按会话/时间聚类兜底 */
  turnId?: string;
  /** 用户请求原文片段（≤40 字），资料库卡片标题 */
  title?: string;
};

type MediaSessionEntry = { sessionId: string; at: string; hidden?: boolean; turnId?: string; title?: string };
type LibraryMetaFile = {
  images?: Record<string, MediaSessionEntry>;
  files?: Record<string, MediaSessionEntry>;
};

const cache = new Map<string, LibraryMetaFile>();

function sanitizeActorId(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
}

function metaPath(actorId: string): string {
  return join(getDataDir(), "library-meta", `${sanitizeActorId(actorId)}.json`);
}

function loadMeta(actorId: string): LibraryMetaFile {
  const key = sanitizeActorId(actorId);
  const hit = cache.get(key);
  if (hit) return hit;
  const path = metaPath(actorId);
  let parsed: LibraryMetaFile = {};
  try {
    if (existsSync(path)) {
      parsed = JSON.parse(readFileSync(path, "utf8")) as LibraryMetaFile;
    }
  } catch {
    parsed = {};
  }
  cache.set(key, parsed);
  return parsed;
}

/** 记录某个落盘产物属于哪次对话（sessionId 为空时跳过，归入历史组）。 */
export function recordMediaSession(
  actorId: string,
  kind: LibraryMediaKind,
  fileName: string,
  sessionId?: string,
  /** hidden=true 的产物不进资料库（购物比价商品图、扫码截图等工具性图片） */
  hidden = false,
  /** 轮次归属（2026-11-12）：主对话按「每次对话」细分成卡的依据 */
  turn?: MediaTurnInfo,
): void {
  const sid = sessionId?.trim();
  const name = fileName.trim();
  if (!sid && !hidden) return;
  const meta = loadMeta(actorId);
  const bucket = (meta[kind] ??= {});
  const turnId = turn?.turnId?.trim();
  const title = turn?.title?.trim();
  bucket[name] = {
    sessionId: sid ?? "",
    at: new Date().toISOString(),
    ...(hidden ? { hidden: true } : {}),
    ...(turnId ? { turnId } : {}),
    ...(title ? { title } : {}),
  };
  try {
    const path = metaPath(actorId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(meta), "utf8");
  } catch (e) {
    console.warn(`[library-meta] 写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 该产物是否被排除在资料库之外（购物/扫码等工具性图片）。 */
export function isMediaHidden(
  actorId: string,
  kind: LibraryMediaKind,
  fileName: string,
): boolean {
  return loadMeta(actorId)[kind]?.[fileName]?.hidden === true;
}

/** 查单个落盘产物归属的对话；没有记录返回空串（历史产物）。 */
export function mediaSessionOf(
  actorId: string,
  kind: LibraryMediaKind,
  fileName: string,
): string {
  return loadMeta(actorId)[kind]?.[fileName]?.sessionId ?? "";
}

/** 查单个落盘产物的完整归属条目（含轮次）；没有记录返回 null。 */
export function mediaEntryOf(
  actorId: string,
  kind: LibraryMediaKind,
  fileName: string,
): MediaSessionEntry | null {
  return loadMeta(actorId)[kind]?.[fileName] ?? null;
}

/**
 * 从工具执行上下文提取轮次归属（资料库「每次对话一张卡」用）。
 * 入参走结构化类型，避免 library-meta 反向依赖 tool-registry。
 */
export function mediaTurnFromContext(ctx: {
  chatUserMessageId?: string;
  userText?: string;
}): MediaTurnInfo | undefined {
  const turnId = ctx.chatUserMessageId?.trim();
  const text = ctx.userText?.trim().replace(/\s+/g, " ");
  if (!turnId && !text) return undefined;
  return {
    ...(turnId ? { turnId } : {}),
    ...(text ? { title: text.slice(0, 40) } : {}),
  };
}
