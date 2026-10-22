// 日程事实主张库（ScheduleAssertionStore）—— upload 树枝的权威层（2026-10-22）。
//
// 架构语义：用户上传的课表/行程表不是「一次性事件流」，而是「从现在起持续成立的
// 未来事实主张（Assertion）」。同一文档重传 = 版本链推进：新版是权威快照，
// 旧版里新版没有的条目降级为 superseded（不删除、不主动说，只退出冲突匹配）。
// 时态纪律对齐项目铁律：runAt 是 event_time，observedAt 是 observed_at，
// "计划到期"不改变 status——降级只走版本链，绝不由时间流逝擅自改写。
//
// 消费方：assertion-conflict-watcher（消息树枝的日程变动信号 × 本库主张 →
// 模型修正事件 → 主动性板块开口）。持久化 data/proactivity/schedule-assertions.json。
import { createHash } from "node:crypto";

import { readJson, writeJson } from "../persist-file.js";

export type ScheduleAssertionInput = {
  /** 主体词（冲突匹配键；调用方用 primarySubjectOf 推导或显式给） */
  subject: string;
  /** 人话标题（如「高等数学」） */
  title: string;
  /** 事件时间 ms（周课表填首次上课时间） */
  runAt: number;
  durationMinutes?: number;
  /** 对应已建日程 id（calendar.batch_create 回填） */
  taskId?: string;
};

export type ScheduleAssertion = {
  assertionId: string;
  actorId: string;
  /** 版本链 id（同 actor + 同 sourceName 归同一条链） */
  documentId: string;
  sourceName: string;
  version: number;
  subject: string;
  title: string;
  runAt: number;
  durationMinutes: number | null;
  /** scheduled=现行主张；superseded=被更新版本取代（退出冲突匹配） */
  status: "scheduled" | "superseded";
  observedAt: number;
  taskId?: string;
};

export type IngestResult = {
  documentId: string;
  version: number;
  /** 新版快照条数 */
  asserted: number;
  /** 被新版取代的旧条目数 */
  superseded: number;
};

type PersistedStore = {
  documents?: Record<string, { version: number }>;
  assertions?: ScheduleAssertion[];
};

export type ScheduleAssertionDeps = {
  persistPath: string;
  nowFn?: () => number;
};

function assertionIdOf(actorId: string, documentId: string, subject: string, runAt: number): string {
  return createHash("sha1").update(`${actorId}|${documentId}|${subject}|${runAt}`).digest("hex").slice(0, 16);
}

export class ScheduleAssertionStore {
  private readonly documents = new Map<string, { version: number }>();
  private readonly assertions = new Map<string, ScheduleAssertion>();
  private readonly nowFn: () => number;

  constructor(private readonly deps: ScheduleAssertionDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    const raw = readJson<PersistedStore>(deps.persistPath, {});
    for (const [id, doc] of Object.entries(raw.documents ?? {})) this.documents.set(id, doc);
    for (const a of raw.assertions ?? []) this.assertions.set(a.assertionId, a);
  }

  private flush(): void {
    writeJson(this.deps.persistPath, {
      documents: Object.fromEntries(this.documents),
      assertions: [...this.assertions.values()],
    });
  }

  /**
   * 上传文档入库（版本链）。同一 actor + sourceName 重传 → 版本 +1；
   * 新版快照全量替换：新版里没有的旧条目 → superseded（退出冲突匹配，不删除）。
   * 内容与旧版完全一致时仍推进版本（幂等无害：旧条目按 assertionId 幂等覆盖）。
   */
  ingestDocument(
    actorId: string,
    sourceName: string,
    items: ScheduleAssertionInput[],
    opts: { taskIdByIndex?: Array<string | undefined> } = {},
  ): IngestResult {
    const clean = items
      .map((it, idx) => ({
        subject: String(it.subject ?? "").trim(),
        title: String(it.title ?? "").trim(),
        runAt: Number(it.runAt),
        durationMinutes: Number.isFinite(Number(it.durationMinutes)) && Number(it.durationMinutes) > 0 ? Math.round(Number(it.durationMinutes)) : null,
        taskId: opts.taskIdByIndex?.[idx] ?? it.taskId,
      }))
      .filter((it) => it.subject.length > 0 && it.title.length > 0 && Number.isFinite(it.runAt) && it.runAt > 0);
    if (clean.length === 0) {
      return { documentId: "", version: 0, asserted: 0, superseded: 0 };
    }
    const documentId = createHash("sha1").update(`${actorId}|${sourceName}`).digest("hex").slice(0, 12);
    const prevVersion = this.documents.get(documentId)?.version ?? 0;
    const version = prevVersion + 1;
    const now = this.nowFn();

    // 旧版条目先全部降级，再由新版快照按 assertionId 幂等恢复；
    // superseded 在快照落定后统计（被新版恢复的不算）
    if (prevVersion > 0) {
      for (const a of this.assertions.values()) {
        if (a.actorId === actorId && a.documentId === documentId && a.status === "scheduled") {
          a.status = "superseded";
        }
      }
    }
    for (const it of clean) {
      const id = assertionIdOf(actorId, documentId, it.subject, it.runAt);
      const existing = this.assertions.get(id);
      this.assertions.set(id, {
        assertionId: id,
        actorId,
        documentId,
        sourceName,
        version,
        subject: it.subject,
        title: it.title,
        runAt: it.runAt,
        durationMinutes: it.durationMinutes,
        status: "scheduled",
        observedAt: now,
        ...(it.taskId ? { taskId: it.taskId } : existing?.taskId ? { taskId: existing.taskId } : {}),
      });
    }
    this.documents.set(documentId, { version });
    this.flush();
    const superseded = [...this.assertions.values()].filter(
      (a) => a.actorId === actorId && a.documentId === documentId && a.status === "superseded",
    ).length;
    return { documentId, version, asserted: clean.length, superseded };
  }

  /** 某文档现行主张（诊断/回显确认闭环用） */
  activeByDocument(actorId: string, documentId: string): ScheduleAssertion[] {
    return [...this.assertions.values()].filter(
      (a) => a.actorId === actorId && a.documentId === documentId && a.status === "scheduled",
    );
  }

  /**
   * 冲突匹配（零 LLM 确定性）：时间窗内的现行主张 × 文本关键词命中。
   * 匹配口径从严（宁漏不误）：subject 或 title（≥2 字）作为子串出现在文本里。
   * 命中按 runAt 升序返回，调用方取第一条。
   */
  findConflicts(
    actorId: string,
    opts: { windowStart: number; windowEnd: number; text: string; limit?: number },
  ): ScheduleAssertion[] {
    const text = String(opts.text ?? "");
    if (!text) return [];
    const hits: ScheduleAssertion[] = [];
    for (const a of this.assertions.values()) {
      if (a.actorId !== actorId || a.status !== "scheduled") continue;
      if (a.runAt < opts.windowStart || a.runAt > opts.windowEnd) continue;
      if ((a.subject.length >= 2 && text.includes(a.subject)) || (a.title.length >= 2 && text.includes(a.title))) {
        hits.push(a);
        if (hits.length >= (opts.limit ?? 1)) break;
      }
    }
    return hits.sort((x, y) => x.runAt - y.runAt);
  }

  /** 全 actor 现行主张数（诊断/测试用） */
  stats(): { documents: number; scheduled: number; superseded: number } {
    let scheduled = 0;
    let superseded = 0;
    for (const a of this.assertions.values()) {
      if (a.status === "scheduled") scheduled += 1;
      else superseded += 1;
    }
    return { documents: this.documents.size, scheduled, superseded };
  }
}
