// 情报服务（IntelService）—— 统一入口 → 面板 → 判断 → 成稿 → 投递 的唯一编排者。
//
//   ① 入口闸：一次性口令/营销/账号流水挡在面板之外（VIP 白名单直通）
//   ② 提炼：目录行（brief）进面板索引，详情留在面板，不进模型上下文
//   ③ 判断：模型只看目录行，一次调用同时给出 now / later / never 与开口草稿
//   ④ 成稿：草稿过了事实校验就直接用；缺稿、编造、跨天失真才升级重写
//   ⑤ 投递：交给统一管道；说出后条目从面板删除，留历史与墓碑
//
// 没有每日配额、没有最小间隔、没有关键词分类：频率由判断本身与回执反馈调控。
// 模型不可用时条目留在面板（attempts/lastError 可见），恢复后重判，不生造话术。
import { createHash } from "node:crypto";

import type { PresenceState } from "../pipeline-types.js";
import { IntelGate, createIntelGate } from "./intel-gate.js";
import { checkJudgeDraft } from "./intel-draft.js";
import { extractBrief, extractDetail } from "./intel-refine.js";
import { IntelStore } from "./intel-store.js";
import { formatRelativeClock } from "./intel-time.js";
import type {
  IntelComposer,
  IntelDirectoryLine,
  IntelEntry,
  IntelGateStats,
  IntelIngestInput,
  IntelJudge,
  IntelJudgeFeedback,
  IntelJudgeInput,
  IntelJudgeResult,
} from "./intel-types.js";

export type IntelDeliverRequest = { entry: IntelEntry; message: string };

export type IntelServiceDeps = {
  dataPath: string;
  nowFn?: () => number;
  presence: { getPresence(actorId: string, at?: number): PresenceState };
  inConversation: (actorId: string) => boolean;
  actors: () => string[];
  judge: IntelJudge;
  compose: IntelComposer;
  /** 投递：delivered=已交给统一管道；retry=通道暂不可用（留到下轮）；dropped=管道明确不投（静音/过期） */
  deliver: (req: IntelDeliverRequest) => Promise<"delivered" | "retry" | "dropped">;
  /** 最近投递回执（用户接受/忽略/静音），喂给判断 */
  feedback?: () => IntelJudgeFeedback["recentOutcomes"];
  styleBrief?: (actorId: string) => Promise<string | null> | string | null;
  /** 说话风格卡：进判断上下文，让一次调用就写出带本人语气的草稿 */
  voiceCard?: () => string | null;
  gate?: IntelGate;
  vipSenders?: readonly string[];
  /** 说出后模型认为日后仍需记得的事（承诺/待办），交给记忆模块自行遗忘 */
  onMemoryCandidate?: (actorId: string, candidate: string, meta: { entryId: string; eventKey: string }) => void;
  /** 巡检间隔：处理到点开口、重试未判断项 */
  tickMs?: number;
  /** 同一轮到达的多封消息合成一次判断（机制性合批） */
  batchDelayMs?: number;
  /** 单次判断最多带几条目录行 */
  maxBatch?: number;
  /** 单次成稿最多几条（保证每句都被认真写） */
  composeBatch?: number;
  autoTicker?: boolean;
};

export type IntelPanelGroup = {
  source: string;
  items: Array<{
    id: string;
    brief: string;
    state: string;
    receivedAt: number;
    when: string;
    dueAt?: number;
    dueWhen?: string;
    needDetail?: boolean;
  }>;
};

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_BATCH_DELAY_MS = 1_000;
const DEFAULT_MAX_BATCH = 20;
const DEFAULT_COMPOSE_BATCH = 5;
/** 判断/成稿失败后的退避：30s → 1m → 2m … 封顶 30min（坏格式不至于每分钟重烧一次调用） */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

function retryDelayFor(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export class IntelService {
  readonly store: IntelStore;
  readonly gate: IntelGate;
  private readonly deps: IntelServiceDeps;
  private readonly nowFn: () => number;
  private readonly tickMs: number;
  private readonly batchDelayMs: number;
  private readonly maxBatch: number;
  private readonly composeBatch: number;
  private readonly autoTicker: boolean;
  private readonly busy = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastJudgeAt: number | null = null;
  private lastJudgeError: string | null = null;
  private lastComposeAt: number | null = null;
  private lastComposeError: string | null = null;
  /** 判断草稿直接开口的条数 / 因不合格升级重写的条数 */
  private draftReused = 0;
  private draftEscalated = 0;

  constructor(deps: IntelServiceDeps) {
    this.deps = deps;
    this.nowFn = deps.nowFn ?? Date.now;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.batchDelayMs = deps.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
    this.maxBatch = deps.maxBatch ?? DEFAULT_MAX_BATCH;
    this.composeBatch = deps.composeBatch ?? DEFAULT_COMPOSE_BATCH;
    this.autoTicker = deps.autoTicker !== false;
    this.store = new IntelStore({ dataPath: deps.dataPath, nowFn: this.nowFn });
    this.gate = deps.gate ?? createIntelGate({ vipSenders: deps.vipSenders, nowFn: this.nowFn });
  }

  start(): void {
    if (!this.autoTicker || this.timer) return;
    this.timer = setInterval(() => void this.reviewAll(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.store.flush();
  }

  /** 统一入口：闸口 → 提炼 → 入面板。被挡/重复的事件返回 null。 */
  ingest(input: IntelIngestInput): IntelEntry | null {
    const verdict = this.gate.check({
      source: input.source,
      title: input.title,
      text: input.text,
      ...(input.from ? { from: input.from } : {}),
    });
    if (!verdict.allow) return null;

    const eventKey = input.eventKey?.trim()
      ? `event:${input.eventKey.trim()}`
      : input.externalId
        ? `${input.source}:${input.externalId}`
        : `${input.source}:${fingerprint(input)}`;
    // 同一事件已经说过且已从面板删除：重复通知不再开口（墓碑）。
    // 仍在面板里的（含已发未确认）走合并更新，补充信息可以被重新判断。
    if (!this.store.get(eventKey) && this.store.wasSaid(eventKey)) return null;

    const now = this.nowFn();
    const ref = `${input.source}:${input.externalId ?? "content"}`;
    const entry: IntelEntry = {
      id: eventKey,
      eventKey,
      actorId: input.actorId,
      source: input.source,
      receivedAt: now,
      updatedAt: now,
      version: 1,
      refs: [ref],
      raw: {
        source: input.source,
        title: input.title,
        text: input.text,
        ...(input.from ? { from: input.from } : {}),
        ...(input.date ? { date: input.date } : {}),
      },
      brief: input.brief?.trim() || extractBrief(input.title, input.text),
      detail:
        input.detail?.trim() ||
        extractDetail({
          title: input.title,
          text: input.text,
          source: input.source,
          ...(input.from ? { from: input.from } : {}),
          ...(input.date ? { date: input.date } : {}),
        }),
      state: "new",
      attempts: 0,
    };
    const { entry: stored } = this.store.ingest(entry);
    this.schedule(stored.actorId);
    return stored;
  }

  /** 邮件入口（营销过滤在 MailWatch 侧；这里统一走闸口与面板） */
  ingestMail(mail: {
    actorId: string;
    subject: string;
    textSnippet?: string;
    from?: string;
    date?: string;
    messageId?: string;
  }): IntelEntry | null {
    return this.ingest({
      actorId: mail.actorId,
      source: "email",
      title: mail.subject || "(无主题)",
      text: mail.textSnippet ?? "",
      ...(mail.from ? { from: mail.from } : {}),
      ...(mail.date ? { date: mail.date } : {}),
      ...(mail.messageId ? { externalId: mail.messageId } : {}),
    });
  }

  /** 立即处理某用户；结论为 now 的当轮成稿并投递 */
  async evaluate(actorId: string): Promise<void> {
    if (this.busy.has(actorId)) {
      this.rerun.add(actorId);
      return;
    }
    this.busy.add(actorId);
    this.rerun.delete(actorId);
    try {
      const now = this.nowFn();
      this.store.sweep(now);
      await this.judgeNew(actorId, now);
      await this.composeDue(actorId);
      await this.deliverReady(actorId);
    } finally {
      this.busy.delete(actorId);
      if (this.rerun.has(actorId)) {
        this.rerun.delete(actorId);
        void this.evaluate(actorId);
      }
    }
  }

  /** 巡检：所有有未处理事项的用户 */
  async reviewAll(): Promise<void> {
    const actors = new Set<string>([...this.store.activeActors(), ...this.deps.actors()]);
    for (const actorId of actors) {
      if (!actorId) continue;
      try {
        await this.evaluate(actorId);
      } catch (err) {
        console.log(`[IntelService] 巡检失败（忽略）actor=${actorId}: ${err}`);
      }
    }
  }

  /** 用户已回应某条「已发未确认」 */
  acknowledge(id: string): boolean {
    return this.store.acknowledge(id);
  }

  /** 面板目录（渐进披露：只有摘要，没有详情） */
  query(actorId: string, opts: { source?: string; limit?: number } = {}): IntelPanelGroup[] {
    const entries = this.store
      .panel(actorId)
      .filter((e) => !opts.source || e.source === opts.source)
      .slice(0, Math.max(1, Math.min(100, opts.limit ?? 50)));
    return this.panelGroups(entries);
  }

  /** 读某条详情（只在面板内；已说出/已删除的只能读到历史里的那句话） */
  read(actorId: string, id: string): {
    entry?: {
      id: string;
      source: string;
      from?: string;
      receivedAt: number;
      when: string;
      brief: string;
      detail: string;
      state: string;
      judgment?: { verdict: string; reason: string };
      spoken?: { message: string; at: number; needsConfirm?: boolean };
    };
    history?: { id: string; source: string; message: string; at: number; when: string; needsConfirm?: boolean; acknowledged?: boolean };
  } | null {
    const now = this.nowFn();
    const entry = this.store.get(id);
    if (entry && entry.actorId === actorId) {
      return {
        entry: {
          id: entry.id,
          source: entry.source,
          ...(entry.raw.from ? { from: entry.raw.from } : {}),
          receivedAt: entry.receivedAt,
          when: formatRelativeClock(entry.receivedAt, now),
          brief: entry.brief,
          detail: entry.detail,
          state: entry.state,
          ...(entry.judgment
            ? { judgment: { verdict: entry.judgment.verdict, reason: entry.judgment.reason } }
            : {}),
          ...(entry.composed?.message && entry.spokenAt !== undefined
            ? {
                spoken: {
                  message: entry.composed.message,
                  at: entry.spokenAt,
                  ...(entry.composed.needsConfirm ? { needsConfirm: true } : {}),
                },
              }
            : {}),
        },
      };
    }
    const hist = this.store.findHistory(id);
    if (hist && hist.actorId === actorId) {
      return {
        history: {
          id: hist.id,
          source: hist.source,
          message: hist.message,
          at: hist.at,
          when: formatRelativeClock(hist.at, now),
          ...(hist.needsConfirm ? { needsConfirm: true } : {}),
          ...(hist.acknowledged !== undefined ? { acknowledged: hist.acknowledged } : {}),
        },
      };
    }
    return null;
  }

  status(): {
    pending: number;
    judged: number;
    spokenToday: number;
    lastJudgeAt: number | null;
    lastJudgeError: string | null;
    lastComposeAt: number | null;
    lastComposeError: string | null;
    /** 判断草稿直接开口 vs 升级重写 */
    drafts: { reused: number; escalated: number };
    gate: IntelGateStats;
    store: ReturnType<IntelStore["stats"]>;
    panel: IntelPanelGroup[];
    recent: Array<{
      id: string;
      title: string;
      verdict: string;
      reason: string;
      message: string;
      dueAt?: number;
      attempts: number;
      lastError?: string;
    }>;
  } {
    const now = this.nowFn();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const stats = this.store.stats(now);
    const recentEntries = [...this.store.panel(), ...this.store.historyFor(undefined, 20)]
      .map((row) => {
        const isEntry = "judgment" in row || "attempts" in row;
        if (isEntry) {
          const e = row as IntelEntry;
          return {
            at: e.spokenAt ?? e.judgment?.judgedAt ?? e.updatedAt,
            id: e.id,
            title: e.brief,
            verdict: e.judgment?.verdict ?? e.state,
            reason: e.judgment?.reason ?? "",
            message: e.composed?.message ?? "",
            ...(e.dueAt !== undefined ? { dueAt: e.dueAt } : {}),
            attempts: e.attempts,
            ...(e.lastError ? { lastError: e.lastError } : {}),
          };
        }
        const h = row as { id: string; source: string; brief: string; message: string; at: number };
        return { at: h.at, id: h.id, title: h.brief, verdict: "spoken", reason: "", message: h.message, attempts: 1 };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);
    return {
      pending: stats.new,
      judged: stats.held + stats.toCompose,
      spokenToday: this.store.spokenSince(startOfDay.getTime()),
      lastJudgeAt: this.lastJudgeAt,
      lastJudgeError: this.lastJudgeError ?? this.store.pendingErrors()[0] ?? null,
      lastComposeAt: this.lastComposeAt,
      lastComposeError: this.lastComposeError,
      drafts: { reused: this.draftReused, escalated: this.draftEscalated },
      gate: this.gate.stats(),
      store: stats,
      panel: this.panelGroups(this.store.panel().slice(0, 100)),
      recent: recentEntries,
    };
  }

  private panelGroups(entries: IntelEntry[]): IntelPanelGroup[] {
    const now = this.nowFn();
    const groups = new Map<string, IntelPanelGroup["items"]>();
    for (const e of entries) {
      const list = groups.get(e.source) ?? [];
      list.push({
        id: e.id,
        brief: e.brief,
        state: e.state,
        receivedAt: e.receivedAt,
        when: formatRelativeClock(e.receivedAt, now),
        ...(e.dueAt !== undefined ? { dueAt: e.dueAt, dueWhen: formatRelativeClock(e.dueAt, now) } : {}),
        ...(e.judgment?.needDetail ? { needDetail: true } : {}),
      });
      groups.set(e.source, list);
    }
    return [...groups.entries()].map(([source, items]) => ({ source, items }));
  }

  private schedule(actorId: string): void {
    const prev = this.timers.get(actorId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(actorId);
      void this.evaluate(actorId);
    }, this.batchDelayMs);
    t.unref?.();
    this.timers.set(actorId, t);
  }

  private feedback(actorId: string): IntelJudgeFeedback {
    return {
      recentSpoken: this.store
        .recentSpoken(8, actorId)
        .map((h) => ({ at: h.at, message: h.message })),
      recentOutcomes: this.deps.feedback?.() ?? [],
    };
  }

  private lineOf(entry: IntelEntry, withDetail = false): IntelDirectoryLine {
    return {
      id: entry.id,
      source: entry.source,
      ...(entry.raw.from ? { from: entry.raw.from } : {}),
      at: entry.receivedAt,
      brief: entry.brief,
      state: entry.state,
      ...(entry.dueAt !== undefined ? { dueAt: entry.dueAt } : {}),
      ...(withDetail ? { detail: entry.detail } : {}),
    };
  }

  private async styleBriefOf(actorId: string): Promise<string | null> {
    try {
      return (await this.deps.styleBrief?.(actorId)) ?? null;
    } catch {
      return null;
    }
  }

  private judgeContext(
    actorId: string,
    now: number,
    styleBrief: string | null,
  ): Omit<IntelJudgeInput, "lines"> {
    return {
      now,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      presence: this.deps.presence.getPresence(actorId, now),
      inConversation: this.deps.inConversation(actorId),
      feedback: this.feedback(actorId),
      styleBrief,
      voiceCard: this.voiceCardOf(),
    };
  }

  private voiceCardOf(): string | null {
    try {
      return this.deps.voiceCard?.() ?? null;
    } catch {
      return null;
    }
  }

  /** 第一遍只看目录行；模型点名 needDetail 的条目再带详情判一次（最多 2 条） */
  private async judgeNew(actorId: string, now: number): Promise<void> {
    const entries = this.store.listToJudge(actorId, now).slice(0, this.maxBatch);
    if (entries.length === 0) return;
    const styleBrief = await this.styleBriefOf(actorId);
    const ctx = this.judgeContext(actorId, now, styleBrief);
    try {
      const first = await this.deps.judge({
        ...ctx,
        lines: entries.map((e) => this.lineOf(e, false)),
      });
      const merged = new Map<string, IntelJudgeResult>(first.map((r) => [r.id, r]));

      const wantDetail = first
        .filter((r) => r.needDetail && r.verdict !== "never")
        .map((r) => entries.find((e) => e.id === r.id))
        .filter((e): e is IntelEntry => Boolean(e));
      let followupError: string | null = null;
      if (wantDetail.length > 0) {
        try {
          const second = await this.deps.judge({
            ...ctx,
            lines: wantDetail.map((e) => this.lineOf(e, true)),
          });
          for (const r of second) merged.set(r.id, r);
        } catch (err) {
          // 追问失败不推翻第一遍结论：判断已经给出，只是没看到详情
          followupError = `详情追问失败：${String(err instanceof Error ? err.message : err).slice(0, 160)}`;
        }
      }

      for (const entry of entries) {
        const judgment = merged.get(entry.id);
        if (!judgment) {
          this.store.fail(entry.id, "模型未返回该条判断", now, retryDelayFor(entry.attempts + 1));
          continue;
        }
        this.store.applyJudgment(entry.id, judgment, now);
      }
      this.lastJudgeAt = this.nowFn();
      this.lastJudgeError = followupError;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
      this.lastJudgeError = msg;
      for (const entry of entries) {
        this.store.fail(entry.id, msg, now, retryDelayFor(entry.attempts + 1));
      }
    }
  }

  /** 判断写好的草稿过校验即直接开口；不合格的那几条才升级去成稿重写 */
  private async composeDue(actorId: string): Promise<void> {
    const now = this.nowFn();
    const entries = this.store.listToCompose(actorId, now).slice(0, this.composeBatch);
    if (entries.length === 0) return;

    const needRewrite: IntelEntry[] = [];
    for (const entry of entries) {
      const check = checkJudgeDraft(entry, now);
      if (!check.ok) {
        needRewrite.push(entry);
        this.draftEscalated += 1;
        continue;
      }
      this.draftReused += 1;
      this.store.markComposed(
        entry.id,
        {
          id: entry.id,
          message: entry.judgment?.draft ?? "",
          ...(entry.judgment?.needsConfirm ? { needsConfirm: true } : {}),
          ...(entry.judgment?.memoryCandidate ? { memoryCandidate: entry.judgment.memoryCandidate } : {}),
        },
        now,
      );
    }
    if (needRewrite.length === 0) return;
    const styleBrief = await this.styleBriefOf(actorId);
    try {
      const results = await this.deps.compose({
        actorId,
        now,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        presence: this.deps.presence.getPresence(actorId, now),
        inConversation: this.deps.inConversation(actorId),
        items: needRewrite.map((e) => ({
          id: e.id,
          source: e.source,
          ...(e.raw.from ? { from: e.raw.from } : {}),
          at: e.receivedAt,
          brief: e.brief,
          detail: e.detail,
        })),
        styleBrief,
        recentSpoken: this.store.recentSpoken(5, actorId).map((h) => ({ at: h.at, message: h.message })),
      });
      const byId = new Map(results.map((r) => [r.id, r]));
      for (const entry of needRewrite) {
        const result = byId.get(entry.id);
        if (!result) {
          this.store.fail(entry.id, "模型未返回该条成稿", now, retryDelayFor(entry.attempts + 1));
          continue;
        }
        this.store.markComposed(entry.id, result, now);
      }
      this.lastComposeAt = this.nowFn();
      this.lastComposeError = null;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
      this.lastComposeError = msg;
      for (const entry of needRewrite) {
        this.store.fail(entry.id, msg, now, retryDelayFor(entry.attempts + 1));
      }
    }
  }

  /** 投递已成稿的条目；成功即从面板删除（未确认事项留观） */
  private async deliverReady(actorId: string): Promise<void> {
    for (const entry of this.store.listReadyToDeliver(actorId, this.nowFn())) {
      const message = entry.composed?.message;
      if (!message) continue;
      try {
        const result = await this.deps.deliver({ entry, message });
        if (result === "delivered") {
          const delivered = this.store.markDelivered(entry.id, this.nowFn());
          const candidate = delivered?.composed?.memoryCandidate;
          if (candidate) {
            try {
              this.deps.onMemoryCandidate?.(entry.actorId, candidate, {
                entryId: entry.id,
                eventKey: entry.eventKey,
              });
            } catch {
              /* 记忆写入失败不影响已投递 */
            }
          }
        } else if (result === "dropped") {
          this.store.drop(entry.id, "统一管道判定不投（静音/过期）");
        } else {
          this.store.fail(entry.id, "投递通道暂不可用");
        }
      } catch (err) {
        this.store.fail(entry.id, String(err instanceof Error ? err.message : err));
      }
    }
  }
}

function fingerprint(input: IntelIngestInput): string {
  return createHash("sha1")
    .update(`${input.source}|${input.title}|${input.text}|${input.date ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}
