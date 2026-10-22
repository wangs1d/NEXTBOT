/**
 * 用户画像写入调度（2026-10-22 三层写入架构）：
 *
 *   T0（每轮，零 LLM）：turn-wal 全文追加 + 对完整 userText 跑画像抽取 hint
 *       正则，命中即标记 profileCandidate（本模块供标记判据，标记本体在
 *       TurnWalService.append 落盘时写入）。
 *   T1（当轮，零额外调用）：仅 personalFact / 明确「记住」的高信号轮由统一
 *       抽取捎带 profileOps（ingest.ts 侧按 isProfileWriteBatchMode 收窄）。
 *   T2（夜间，每 actor 每天最多 1 次 LLM）：本模块 consolidateProfileFromWal
 *       读 turn-wal 自 checkpoint 以来的候选轮全文（user 侧 only），一次批量
 *       extractUnified（带当前画像上下文）产出 profileOps，交调用方注入的
 *       落位口（UserProfileAggregator.applyProfileOpsFromUnified）确定性写入。
 *
 * 完整性保证：画像管线只读 WAL 原文，从不读 recap/压缩视图；checkpoint
 * at-least-once（抽取失败不推进，下晚重试；applyOps 幂等吸收重复）；输入
 * 超预算时分晚处理（checkpoint 只推进到本次实际处理到的位置）。
 *
 * 回滚开关：PROFILE_WRITE_SCHEDULING=legacy 回到「低信号轮也捎带、无夜间批」的旧行为。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { getShortTermMemoryConfig, getCalendarDay } from "./short-term-memory-config.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import type { UnifiedExtraction, UnifiedProfileOp } from "../agentic-memory/unified-extractor.js";

export function isProfileWriteBatchMode(): boolean {
  const raw = process.env.PROFILE_WRITE_SCHEDULING?.trim().toLowerCase();
  if (!raw) return true; // 默认 batch
  return raw !== "legacy" && raw !== "0" && raw !== "off" && raw !== "false";
}

/* ───────────────────────── checkpoint ───────────────────────── */

export interface ProfileExtractCheckpoint {
  /** actorId → 已处理到的最后一条 WAL 条目 ts（ISO） */
  actors: Record<string, string>;
}

function defaultCheckpointFile(): string {
  return (
    process.env.PROFILE_EXTRACT_CHECKPOINT_FILE?.trim() ||
    join(process.cwd(), "data", "profile-extract-checkpoint.json")
  );
}

export async function loadProfileCheckpoint(file = defaultCheckpointFile()): Promise<ProfileExtractCheckpoint> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ProfileExtractCheckpoint;
    if (parsed && typeof parsed.actors === "object" && parsed.actors) return parsed;
  } catch {
    /* 无文件/坏 JSON → 空表（从头扫，靠幂等吸收） */
  }
  return { actors: {} };
}

export async function saveProfileCheckpoint(
  checkpoint: ProfileExtractCheckpoint,
  file = defaultCheckpointFile(),
): Promise<void> {
  await writeJsonAtomic(file, checkpoint);
}

/* ───────────────────────── WAL 候选读取 ───────────────────────── */

export interface WalProfileCandidate {
  ts: string;
  userText: string;
  assistantText: string;
  highSignal: boolean;
}

export interface WalTurnEntry extends WalProfileCandidate {
  /** T0 hint 正则命中（高信号恒真）；false=普通闲聊轮（夜间预算补齐用） */
  candidate: boolean;
}

const MAX_SCAN_DAYS = 60;

/**
 * 读 turn-wal 中该 actor 自 sinceTs（不含）以来的**全部**条目（含非候选）。
 * 按天文件扫描（与 TurnWalService 写入同一天切分口径），ts 升序返回。
 * 天数护栏：只扫最近 MAX_SCAN_DAYS 天，避免 checkpoint 丢失后全量重扫。
 */
export async function readWalTurns(
  actorId: string,
  sinceTs: string,
  opts?: { walDir?: string },
): Promise<WalTurnEntry[]> {
  const cfg = getShortTermMemoryConfig();
  const dir = opts?.walDir ?? join(process.cwd(), cfg.walDir);
  let dayFiles: string[];
  try {
    dayFiles = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return []; // WAL 目录不存在 → 无候选
  }

  // 空 checkpoint（首次运行）→ 不设起始天，靠 MAX_SCAN_DAYS 护栏限制扫描窗口
  const startDay = sinceTs ? getCalendarDay(new Date(sinceTs)) : "";
  const out: WalTurnEntry[] = [];
  for (const f of dayFiles) {
    const day = f.slice(0, 10);
    if (day < startDay) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.actorId !== actorId) continue;
      const ts = typeof entry.ts === "string" ? entry.ts : "";
      if (!ts || ts <= sinceTs) continue;
      // 天数护栏：只扫最近 MAX_SCAN_DAYS 天，避免 checkpoint 丢失后全量重扫
      if (dayFiles.indexOf(f) < dayFiles.length - MAX_SCAN_DAYS) continue;
      out.push({
        ts,
        userText: typeof entry.userText === "string" ? entry.userText : "",
        assistantText: typeof entry.assistantText === "string" ? entry.assistantText : "",
        highSignal: entry.highSignal === true,
        candidate: entry.profileCandidate === true,
      });
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/** 读自 sinceTs 以来的候选条目（T2 主输入；兼容旧导出）。 */
export async function readWalProfileCandidates(
  actorId: string,
  sinceTs: string,
  opts?: { walDir?: string },
): Promise<WalProfileCandidate[]> {
  const turns = await readWalTurns(actorId, sinceTs, opts);
  return turns
    .filter((t) => t.candidate)
    .map(({ ts, userText, assistantText, highSignal }) => ({ ts, userText, assistantText, highSignal }));
}

/* ───────────────────────── 夜间批抽取（T2） ───────────────────────── */

const TRANSCRIPT_BUDGET_CHARS = 12_000;
const PER_TURN_CAP_CHARS = 800;

export interface ProfileConsolidationStats {
  actorId: string;
  /** WAL 中命中的候选轮数 */
  candidates: number;
  /** 本次实际送入 LLM 的候选轮数（预算截断后） */
  processed: number;
  /** 预算补齐：送入 LLM 的非候选轮数（hint 漏标的第二次机会） */
  topUpProcessed: number;
  /** LLM 产出的 profileOps 条数 */
  opsCount: number;
  /** 落位是否成功 */
  applied: boolean;
  checkpointAdvanced: boolean;
  /** true = 抽取失败（不推进 checkpoint，下晚重试） */
  extractionFailed?: boolean;
}

export interface ProfileBatchDeps {
  /** 当前画像全文（注入批量抽取上下文） */
  readProfile: () => Promise<string> | string;
  /** 确定性落位口（生产传 UserProfileAggregator.applyProfileOpsFromUnified） */
  applyOps: (ops: UnifiedProfileOp[]) => Promise<boolean> | boolean;
  /** 抽取口（测试注入 fake；生产默认 extractUnified） */
  extractFn?: (
    text: string,
    opts: { profileContext: { currentProfile: string }; actorId: string },
  ) => Promise<UnifiedExtraction | null>;
}

/**
 * 对单个 actor 跑一次画像批抽取。无候选 → 零 LLM 直接返回。
 * checkpoint 只在「抽取成功且落位成功」时推进到最后一条已处理候选的 ts。
 */
export async function consolidateProfileFromWal(
  actorId: string,
  deps: ProfileBatchDeps,
  opts?: { walDir?: string; checkpointFile?: string; untilTs?: string },
): Promise<ProfileConsolidationStats> {
  const checkpointFile = opts?.checkpointFile;
  const checkpoint = await loadProfileCheckpoint(checkpointFile);
  const sinceTs = checkpoint.actors[actorId] ?? "";

  const turns = await readWalTurns(actorId, sinceTs, { walDir: opts?.walDir });
  const candidates = turns.filter((t) => t.candidate);
  const stats: ProfileConsolidationStats = {
    actorId,
    candidates: candidates.length,
    processed: 0,
    topUpProcessed: 0,
    opsCount: 0,
    applied: false,
    checkpointAdvanced: false,
  };

  const renderTurn = (t: WalProfileCandidate): string =>
    `[${t.ts.slice(5, 16).replace("T", " ")}] 用户: ${t.userText.slice(0, PER_TURN_CAP_CHARS)}`;

  // 纯闲聊天（零候选）：不调 LLM，但推进 checkpoint 越过该段——否则扫描窗口
  // 随闲聊无限增长。漏标损失由「highSignal 恒候选 + memory.recall_history
  // 当轮回查」双兜底，可接受。
  if (candidates.length === 0) {
    const lastTs = turns.length > 0 ? turns[turns.length - 1]!.ts : "";
    if (lastTs) {
      const next = await loadProfileCheckpoint(checkpointFile);
      next.actors[actorId] = lastTs;
      await saveProfileCheckpoint(next, checkpointFile);
      stats.checkpointAdvanced = true;
    }
    return stats;
  }

  // 预算补齐（2026-10-22，取代「每周全量兜底扫描」提案）：候选优先装满预算，
  // 剩余空间按 ts 序用非候选轮补位——hint 正则漏标的陈述由此获得第二次进
  // LLM 的机会，召回上限拉到预算内 100%，且不新增任务/状态/LLM 调用。
  const included: WalProfileCandidate[] = [];
  let used = 0;
  for (const c of candidates) {
    const text = renderTurn(c);
    if (used + text.length > TRANSCRIPT_BUDGET_CHARS) break;
    used += text.length;
    included.push(c);
  }
  stats.processed = included.length;
  if (included.length > 0) {
    for (const t of turns) {
      if (t.candidate) continue;
      const text = renderTurn(t);
      if (used + text.length > TRANSCRIPT_BUDGET_CHARS) break;
      used += text.length;
      included.push(t);
      stats.topUpProcessed += 1;
    }
  }
  if (included.length === 0) return stats;
  included.sort((a, b) => a.ts.localeCompare(b.ts));
  const lines = included.map(renderTurn);
  const lastTs = included[included.length - 1]!.ts;

  const currentProfile = (await deps.readProfile()) || "";
  const extractFn =
    deps.extractFn ??
    (async (text: string, o: { profileContext: { currentProfile: string }; actorId: string }) => {
      const { extractUnified } = await import("../agentic-memory/unified-extractor.js");
      return extractUnified(text, o);
    });
  let extraction: UnifiedExtraction | null = null;
  try {
    extraction = await extractFn(lines.join("\n"), {
      profileContext: { currentProfile },
      actorId,
    });
  } catch {
    extraction = null;
  }
  if (!extraction) {
    stats.extractionFailed = true;
    return stats; // 不推进 checkpoint，下晚重试
  }

  const ops = extraction.profileOps ?? [];
  stats.opsCount = ops.length;
  if (ops.length > 0) {
    stats.applied = await deps.applyOps(ops);
    if (!stats.applied) return stats; // 落位失败不推进
  }

  const next = await loadProfileCheckpoint(checkpointFile);
  next.actors[actorId] = lastTs;
  await saveProfileCheckpoint(next, checkpointFile);
  stats.checkpointAdvanced = true;
  return stats;
}

/**
 * 默认落位口（生产）：懒建 UserProfileAggregator 并复用其唯一写入路径。
 * 与 bootstrap 的聚合器实例分离——夜间低并发窗口，双方都过 store.write 的
 * 净噪器与写后校验，串台风险可忽略。
 */
let defaultConsolidator: ((actorId: string) => Promise<ProfileConsolidationStats>) | null = null;

export function getDefaultProfileConsolidator(): (
  actorId: string,
) => Promise<ProfileConsolidationStats> {
  if (!defaultConsolidator) {
    defaultConsolidator = async (actorId) => {
      const { createUserProfileAggregator } = await import("../brain/user-profile-aggregator.js");
      const agg = createUserProfileAggregator();
      return consolidateProfileFromWal(actorId, {
        readProfile: () => agg.readProfile(actorId),
        applyOps: (ops) => agg.applyProfileOpsFromUnified(actorId, ops),
      });
    };
  }
  return defaultConsolidator;
}
