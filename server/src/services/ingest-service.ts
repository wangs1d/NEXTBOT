/**
 * 数据入口（Ingest）——统一上传服务的编排层。
 *
 * 一句话：**用户自己往里塞数据，系统负责认、抽、去重、等他确认、再落库。**
 * 不依赖为每个来源写适配器（见 ingest-types 的形态分类），也不依赖我手工配环境变量。
 *
 * ## 两段式：preview → commit
 *
 * 抽取结果**不直接落库**。原因是 LLM/视觉抽取必然有误差：把「周三」读成「周二」、
 * 把「第3-4节」读成「第1-2节」，静默入库后用户要等到错过一节课才发现。
 * 所以先给一份可勾选的草稿（带证据片段与置信度），用户确认哪些要，才写台账。
 *
 * 这一条也守住了项目铁律：**不预测，只验证**。抽取是"猜"，commit 是"用户认了"。
 *
 * ## 重复上传 = 更新，不是新增
 *
 * 课表每学期换、行程表每周变，用户一定会重传同一张表。所以：
 *   - 台账按 `item.key`（kind + 归一化标题 + 周几节次）索引，不按时间
 *   - 重传时做 diff：new / updated / unchanged，预览页明确标出"这条是改期"
 *   - 用户只传一次也算数：unchanged 不会重复写
 *
 * 为什么 key 里不放时间：一门课换教室/改期时用户想的是"更新那一条"，
 * 若时间进键就会变成两条重复的课。时间变化由 diff 处理。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import {
  detectPayloadKind,
  validateIngestItem,
  type IngestExtractResult,
  type IngestItem,
  type IngestPayload,
} from "./ingest-types.js";
import {
  extractImage,
  extractProse,
  extractStructured,
  extractTabular,
  xlsxBase64ToText,
  type IngestChatLike,
  type IngestVisionExtract,
} from "./ingest-extractors.js";
import {
  materializeIngestedClasses,
  removeIngestedClassSchedules,
  type IngestSchedulePort,
} from "./ingest-schedule-bridge.js";

// ---------------------------------------------------------------------- //
// 类型
// ---------------------------------------------------------------------- //

/** 台账条目：条目本身 + 入库元信息（不参与 key 计算） */
export interface IngestLedgerEntry extends IngestItem {
  /** 首次入库时间（ISO） */
  firstSeenAt: string;
  /** 最后一次被上传覆盖的时间（ISO） */
  updatedAt: string;
  /** 来源描述（"上传的 ics" / "粘贴的文本" / "截图"），仅供展示与排查 */
  sourceLabel: string;
  /**
   * 课表条目对应的日程 taskId（真实排期在日程服务里，台账只做去重索引）。
   * 缺省 = 这条没落成日程（无节次/无时刻，或未装配日程服务）。
   */
  scheduleTaskId?: string;
}

interface IngestLedgerFile {
  version: 1;
  updatedAt: string;
  items: Record<string, IngestLedgerEntry>;
}

export type IngestChangeKind = "new" | "updated" | "unchanged";

export interface IngestDraftItem extends IngestItem {
  change: IngestChangeKind;
  /** 变更前的时间/地点（对照展示用，仅 change=updated 时有） */
  previous?: { startsAt?: string; dueAt?: string; location?: string; title?: string };
}

export interface IngestPreview {
  draftId: string;
  extractor: string;
  /** 默认勾选：confidence >= 0.6 且 change != unchanged */
  items: IngestDraftItem[];
  dropped: { count: number; reason: string }[];
  /** 需要用户补的外部条件（如缺校历） */
  needs?: string[];
  /** 抽取级失败（此时 items 为空且必须把 error 展示给用户） */
  error?: string;
  summary: { total: number; newCount: number; updatedCount: number; unchangedCount: number };
}

export interface IngestCommitResult {
  written: number;
  added: number;
  updated: number;
  skipped: number;
  /** 台账里当前总条目数 */
  totalInLedger: number;
  /**
   * 课表物化结果：class 条目已写进日程服务（真实载体），台账只留索引。
   * 未装配日程服务时整个字段缺省——不假装成功。
   */
  scheduled?: {
    created: number;
    updated: number;
    skipped: { key: string; title: string; reason: string }[];
  };
}

export interface IngestServiceOptions {
  /** 统一时间源（铁律：禁 Date.now()） */
  now?: () => Date;
  chat?: IngestChatLike | null;
  visionExtract?: IngestVisionExtract | null;
  /** 数据根目录，缺省 <cwd>/data/ingest */
  rootDir?: string;
  /** ics 展开窗口天数 */
  lookaheadDays?: number;
  /**
   * 日程服务（可选）：课表条目落成 `weekly` 日程 = 项目里已有的提醒/展示链。
   * 未注入时课表只进台账、不排期（预览/台账仍可用，如实不假装）。
   */
  scheduleTasks?: IngestSchedulePort | null;
  /** 物化日程用的时区（缺省 Asia/Shanghai，与日程服务默认一致） */
  timezone?: string;
}

interface DraftFile {
  version: 1;
  draftId: string;
  actorId: string;
  sessionId: string;
  createdAtMs: number;
  extractor: string;
  sourceLabel: string;
  items: IngestDraftItem[];
  dropped: { count: number; reason: string }[];
  needs?: string[];
  error?: string;
}

/** 草稿存活时间：预览后不确认就丢弃。抽取是用户当下的事，隔天再确认反而危险。 */
const DRAFT_TTL_MS = 2 * 3_600_000;
/** 草稿目录最多留多少个，防手滑反复上传。 */
const DRAFT_MAX_KEEP = 20;

/** actorId 清洗：只允许安全字符，防路径穿越（照 file-processing-service 惯例）。 */
function safeActorDir(actorId: string): string {
  const cleaned = (actorId ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "default";
}

/** 来源描述：给用户看"这份数据是哪来的"，不参与任何分支逻辑。 */
function labelOf(payload: IngestPayload, kind: string): string {
  if (kind === "image") return "上传的截图";
  if (kind === "structured") return payload.fileName?.trim() || "粘贴的日历（ics）";
  if (kind === "tabular") return payload.fileName?.trim() || "粘贴的表格";
  return payload.hint?.trim() || "粘贴的文本";
}

// ---------------------------------------------------------------------- //
// 服务
// ---------------------------------------------------------------------- //

export class IngestService {
  private readonly rootDir: string;
  private readonly draftDir: string;
  private readonly nowFn: () => Date;

  constructor(private readonly opts: IngestServiceOptions = {}) {
    this.rootDir = resolve(opts.rootDir ?? join(process.cwd(), "data", "ingest"));
    this.draftDir = join(this.rootDir, "drafts");
    this.nowFn = opts.now ?? (() => new Date());
    try {
      mkdirSync(this.draftDir, { recursive: true });
    } catch {
      // 并发初始化时目录可能已存在
    }
  }

  private now(): Date {
    return this.nowFn();
  }

  private ledgerPath(actorId: string): string {
    return join(this.rootDir, `ledger-${safeActorDir(actorId)}.json`);
  }

  private readLedger(actorId: string): IngestLedgerFile {
    return readJson<IngestLedgerFile>(this.ledgerPath(actorId), {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      items: {},
    });
  }

  /**
   * 抽一遍，生成草稿。**不写台账**。
   *
   * 载体形态由 detectPayloadKind 判定；无论用户说这是"课表"还是"排班"，
   * 只要内容是 ics 就走确定性解析。hint 只当下游提示词，不改变分支。
   */
  async preview(input: {
    actorId: string;
    sessionId?: string;
    payload: IngestPayload;
  }): Promise<IngestPreview> {
    const { payload } = input;
    const kind = detectPayloadKind(payload);
    const now = this.now();
    const sourceLabel = labelOf(payload, kind);

    // Excel 是二进制：先解成表格文本，再走同一套表格抽取。
    // 解不出来必须报错——"上传成功但一条都没有"是最难排查的失败形态。
    let text = payload.text ?? "";
    if (!text && payload.fileBase64) {
      const decoded = xlsxBase64ToText(payload.fileBase64);
      if (!decoded) {
        return {
          draftId: "",
          extractor: "xlsx",
          items: [],
          dropped: [{ count: 1, reason: "Excel 解不出可读的表格内容" }],
          error:
            "这个表格文件解不出内容（可能是扫描件、加密文件或旧版 .xls 格式）。可以另存为 .xlsx / .csv 再传，或直接把表格内容复制粘贴进来。",
          summary: { total: 0, newCount: 0, updatedCount: 0, unchangedCount: 0 },
        };
      }
      text = decoded;
    }

    let result: IngestExtractResult;
    switch (kind) {
      case "structured":
        result = extractStructured(text, now, this.opts.lookaheadDays);
        break;
      case "tabular":
        result = extractTabular(text);
        break;
      case "image":
        result = await extractImage(payload.imageBase64 ?? "", payload.imageMimeType ?? "image/png", {
          visionExtract: this.opts.visionExtract,
          hint: payload.hint,
        });
        break;
      default:
        result = await extractProse(text, {
          chat: this.opts.chat ?? null,
          now,
          hint: payload.hint,
          sessionId: input.sessionId ?? `ingest:${safeActorDir(input.actorId)}`,
        });
        break;
    }

    // 二次闸门：抽取器已经过滤过一遍，这里防抽取器漏网的非法条目
    const clean = result.items.filter((it) => validateIngestItem(it) === null);
    const dropped = [...result.dropped];
    const invalidCount = result.items.length - clean.length;
    if (invalidCount > 0) dropped.push({ count: invalidCount, reason: "条目字段不完整" });

    // 一条都没抽到且抽取器没给原因 → 补一个能读懂的结论。
    // "上传成功但一条都没有"是最难自查的失败形态，必须明确说出来。
    const error =
      result.error ??
      (clean.length === 0
        ? "没有从这份材料里识别出任何时间事项。可能是内容里没有明确的日期/周几，或者格式没被认出来——可以换一张只截课表区域的图，或把表格内容复制粘贴进来。"
        : undefined);

    const items = this.markChanges(input.actorId, clean);
    const draftId = randomUUID();
    this.writeDraft({
      version: 1,
      draftId,
      actorId: input.actorId,
      sessionId: input.sessionId ?? "",
      createdAtMs: now.getTime(),
      extractor: result.extractor,
      sourceLabel,
      items,
      dropped,
      needs: result.needs,
      error,
    });

    return {
      draftId,
      extractor: result.extractor,
      items,
      dropped,
      needs: result.needs,
      error,
      summary: {
        total: items.length,
        newCount: items.filter((i) => i.change === "new").length,
        updatedCount: items.filter((i) => i.change === "updated").length,
        unchangedCount: items.filter((i) => i.change === "unchanged").length,
      },
    };
  }

  /**
   * 确认入库。`keys` 缺省 = 全部（含 unchanged，幂等覆盖）。
   *
   * 只写用户勾选的条目：预览页取消勾选的**不落库**，且不会因为"上次传过"
   * 就偷偷留下——用户明确不要的东西要真的没有。
   *
   * ## 课表去日程（2026-10-22 收编）
   *
   * `kind === "class"` 的条目**真实载体是日程**（`weekly` 重复），不是台账：
   * 这样它会到点提醒、进「今日安排」、被 schedule-sensor 扫进世界板。
   * 台账只留条目做「重传=更新」的去重索引，并回写 `scheduleTaskId`。
   * 所以先物化、后落台账——顺序反了就会出现"台账有课、日程没有"的半截状态。
   */
  async commit(input: { actorId: string; draftId: string; keys?: string[] }): Promise<IngestCommitResult> {
    const draft = this.readDraft(input.draftId);
    if (!draft) {
      return { written: 0, added: 0, updated: 0, skipped: 0, totalInLedger: 0 };
    }
    // 草稿归属校验：拿别人的 draftId 写不进自己的台账
    if (safeActorDir(draft.actorId) !== safeActorDir(input.actorId)) {
      return { written: 0, added: 0, updated: 0, skipped: 0, totalInLedger: 0 };
    }

    const wanted = input.keys ? new Set(input.keys) : null;
    const selected = draft.items.filter((it) => (wanted ? wanted.has(it.key) : true));

    const ledger = this.readLedger(input.actorId);
    const nowIso = this.now().toISOString();
    let added = 0;
    let updated = 0;

    const schedulePort = this.opts.scheduleTasks ?? null;
    const materialized = await materializeIngestedClasses(
      selected.filter((it) => it.kind === "class"),
      schedulePort,
      {
        sessionId: `ingest:${safeActorDir(input.actorId)}`,
        timezone: this.opts.timezone?.trim() || "Asia/Shanghai",
        now: this.now(),
      },
    );

    for (const item of selected) {
      const prev = ledger.items[item.key];
      const { change: _change, previous: _previous, ...pure } = item;
      // 物化失败时保留旧指针，否则下次重传认不出这条课已经建过日程，会重复建
      const scheduleTaskId = materialized.taskIds[item.key] ?? prev?.scheduleTaskId;
      ledger.items[item.key] = {
        ...pure,
        firstSeenAt: prev?.firstSeenAt ?? nowIso,
        updatedAt: nowIso,
        sourceLabel: draft.sourceLabel,
        ...(scheduleTaskId ? { scheduleTaskId } : {}),
      };
      if (prev) updated += 1;
      else added += 1;
    }

    if (selected.length > 0) {
      ledger.updatedAt = nowIso;
      writeJson(this.ledgerPath(input.actorId), ledger);
    }

    return {
      written: selected.length,
      added,
      updated,
      skipped: draft.items.length - selected.length,
      totalInLedger: Object.keys(ledger.items).length,
      ...(schedulePort
        ? {
            scheduled: {
              created: materialized.created,
              updated: materialized.updated,
              skipped: materialized.skipped,
            },
          }
        : {}),
    };
  }

  /** 台账全量（按时间排序：有绝对时刻的按时间，周几节次的按周几/节次）。 */
  list(actorId: string): { items: IngestLedgerEntry[]; updatedAt: string } {
    const ledger = this.readLedger(actorId);
    const items = Object.values(ledger.items).sort(compareItems);
    return { items, updatedAt: ledger.updatedAt };
  }

  /**
   * 删条目（用户在入口页手动清理）。keys 为空则整体清空。
   *
   * 课表条目的日程要跟着走：用户说"这门课不要了"，指的是提醒也别再响。
   * 只删台账会把课留在日程里继续提醒，是最让人困惑的失败形态。
   */
  async remove(input: {
    actorId: string;
    keys?: string[];
  }): Promise<{ removed: number; totalInLedger: number; removedSchedules: number }> {
    const ledger = this.readLedger(input.actorId);
    const keys = input.keys?.length ? input.keys : Object.keys(ledger.items);
    const removedKeys: string[] = [];
    for (const key of keys) {
      if (ledger.items[key]) {
        delete ledger.items[key];
        removedKeys.push(key);
      }
    }
    const removedSchedules = await removeIngestedClassSchedules(
      removedKeys,
      this.opts.scheduleTasks ?? null,
    );
    if (removedKeys.length > 0) {
      ledger.updatedAt = this.now().toISOString();
      writeJson(this.ledgerPath(input.actorId), ledger);
    }
    return {
      removed: removedKeys.length,
      totalInLedger: Object.keys(ledger.items).length,
      removedSchedules,
    };
  }

  /**
   * 截止项直读（供 ddl-radar 的 fromIngested 用）。
   *
   * 只返回 kind=deadline 且有绝对截止时刻的条目——课表没有绝对日期，
   * 混进 DDL 会让"今天要交"里冒出一门周二的高数课。
   */
  listDeadlines(actorId: string): Array<{
    key: string;
    title: string;
    dueAt: string;
    category?: string;
    sourceLabel: string;
  }> {
    const { items } = this.list(actorId);
    return items
      .filter((it) => it.kind === "deadline" && it.dueAt && Number.isFinite(Date.parse(it.dueAt)))
      .map((it) => ({
        key: it.key,
        title: it.title,
        dueAt: it.dueAt as string,
        category: it.category,
        sourceLabel: it.sourceLabel,
      }));
  }

  /** 供装配层判断能力是否可用（入口页据此显示"能不能读图"）。 */
  capability(): { llm: boolean; vision: boolean } {
    return {
      llm: Boolean(this.opts.chat?.isEnabled?.()),
      vision: Boolean(this.opts.visionExtract),
    };
  }

  // ---- 内部 -----------------------------------------------------------

  /** 对比台账，标出每条是新增/更新/未变。 */
  private markChanges(actorId: string, items: IngestItem[]): IngestDraftItem[] {
    const ledger = this.readLedger(actorId);
    return items.map((item) => {
      const prev = ledger.items[item.key];
      if (!prev) return { ...item, change: "new" as const };
      // 周几/节次变了也是"更新"：课表搬教室、调课时段是常态，
      // 只比 startsAt 会把它当"未变"，用户看不到改动。
      const slotChanged =
        (prev.weeklySlot?.weekday ?? 0) !== (item.weeklySlot?.weekday ?? 0) ||
        (prev.weeklySlot?.periods ?? []).join(",") !== (item.weeklySlot?.periods ?? []).join(",") ||
        (prev.weeklySlot?.weeks ?? "") !== (item.weeklySlot?.weeks ?? "");
      const changed =
        prev.startsAt !== item.startsAt ||
        prev.dueAt !== item.dueAt ||
        prev.location !== item.location ||
        prev.title !== item.title ||
        slotChanged;
      if (!changed) return { ...item, change: "unchanged" as const };
      return {
        ...item,
        change: "updated" as const,
        previous: {
          startsAt: prev.startsAt,
          dueAt: prev.dueAt,
          location: prev.location,
          title: prev.title,
        },
      };
    });
  }

  private draftPath(draftId: string): string {
    const safe = (draftId ?? "").replace(/[^a-zA-Z0-9-]/g, "");
    return join(this.draftDir, `${safe}.json`);
  }

  private writeDraft(draft: DraftFile): void {
    writeJson(this.draftPath(draft.draftId), draft);
    this.pruneDrafts(draft.createdAtMs);
  }

  private readDraft(draftId: string): DraftFile | null {
    const path = this.draftPath(draftId);
    if (!path || !existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as DraftFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 清过期草稿 + 限制总数。失败不影响主流程（草稿是临时物）。 */
  private pruneDrafts(nowMs: number): void {
    try {
      const entries = readdirSync(this.draftDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const p = join(this.draftDir, f);
          return { path: p, mtimeMs: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      entries.forEach((e, idx) => {
        if (e.mtimeMs < nowMs - DRAFT_TTL_MS || idx >= DRAFT_MAX_KEEP) {
          try {
            unlinkSync(e.path);
          } catch {
            /* 并发删除忽略 */
          }
        }
      });
    } catch {
      /* 目录不可读时静默：草稿清理不是关键路径 */
    }
  }
}

/** 排序：有绝对时刻的在前（按时间升序），周几节次的在后（按周几、节次升序）。 */
function compareItems(a: IngestLedgerEntry, b: IngestLedgerEntry): number {
  const aTime = a.dueAt ?? a.startsAt;
  const bTime = b.dueAt ?? b.startsAt;
  if (aTime && bTime) return Date.parse(aTime) - Date.parse(bTime);
  if (aTime) return -1;
  if (bTime) return 1;
  const aw = a.weeklySlot ?? { weekday: 8, periods: [99] };
  const bw = b.weeklySlot ?? { weekday: 8, periods: [99] };
  if (aw.weekday !== bw.weekday) return aw.weekday - bw.weekday;
  return (aw.periods[0] ?? 99) - (bw.periods[0] ?? 99);
}
