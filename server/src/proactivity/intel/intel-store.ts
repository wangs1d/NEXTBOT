// 情报面板（IntelPanelStore）—— 采集与开口之间的落点。
//
// 面板只放「还没处理完」的事：new（等判断）/ held（到点说）/ to_compose（等成稿投递）/
// unconfirmed（已发未确认）。说出去之后条目从面板删除，只留：
//   history  最近说过的话（judge 的密度输入 + 面板已读）
//   tombstone 同一事件说过一次的记号（重复通知不再开口）
// 判断本身不在这里做；这里只维护身份、状态机与 TTL。时间一律存 epoch ms。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  IntelComposeResult,
  IntelEntry,
  IntelHistoryItem,
  IntelJudgeResult,
  IntelTombstone,
} from "./intel-types.js";

/** 面板上限（只裁已放弃的历史；未处理完的永不因容量被裁） */
const MAX_ITEMS = 500;
const MAX_HISTORY = 200;
const MAX_TOMBSTONES = 200;
/** 未判断条目最长停留（模型长期不可用时，过期消息没有再说一次的价值） */
const NEW_TTL_MS = 7 * 24 * 3600_000;
/** 判了「到点说」但一直没到点/没说的最长停留 */
const HELD_TTL_MS = 7 * 24 * 3600_000;
/** 已发未确认的默认追问窗口 */
export const DEFAULT_CONFIRM_WINDOW_MS = 2 * 3600_000;
/** 同一事件键的重复通知抑制窗口 */
const SAID_WINDOW_MS = 24 * 3600_000;

export type IntelStoreOptions = {
  dataPath: string;
  nowFn?: () => number;
  disablePersist?: boolean;
};

type StoreFile = {
  items: IntelEntry[];
  history: IntelHistoryItem[];
  tombstones: IntelTombstone[];
};

export class IntelStore {
  private readonly file: string;
  private readonly nowFn: () => number;
  private readonly disablePersist: boolean;
  private readonly items = new Map<string, IntelEntry>();
  private history: IntelHistoryItem[] = [];
  private tombstones: IntelTombstone[] = [];

  constructor(opts: IntelStoreOptions) {
    this.file = join(opts.dataPath, "proactivity", "intel-panel.json");
    this.nowFn = opts.nowFn ?? Date.now;
    this.disablePersist = opts.disablePersist === true;
    if (!this.disablePersist) this.load();
  }

  /** 入池：同一事件重复到达只保留一条；补充信息会升级版本并重新判断 */
  ingest(entry: IntelEntry): { entry: IntelEntry; isNew: boolean } {
    const prev = this.items.get(entry.id);
    if (!prev) {
      this.items.set(entry.id, entry);
      this.trim();
      this.flush();
      return { entry, isNew: true };
    }
    prev.raw = entry.raw;
    prev.brief = entry.brief || prev.brief;
    prev.detail = entry.detail || prev.detail;
    prev.source = entry.source;
    prev.receivedAt = Math.min(prev.receivedAt, entry.receivedAt);
    prev.updatedAt = Math.max(prev.updatedAt, entry.updatedAt);
    prev.version += 1;
    for (const ref of entry.refs) if (!prev.refs.includes(ref)) prev.refs.push(ref);
    // 补充信息到达：旧结论可能已过期，统一回到待判断（dropped 有真更新也允许重判）
    if (
      prev.state === "held" ||
      prev.state === "to_compose" ||
      prev.state === "unconfirmed" ||
      prev.state === "dropped"
    ) {
      prev.state = "new";
      delete prev.judgment;
      delete prev.dueAt;
      delete prev.composed;
      delete prev.confirmBy;
      delete prev.spokenAt;
    }
    prev.lastError = undefined;
    delete prev.nextRetryAt;
    this.flush();
    return { entry: prev, isNew: false };
  }

  get(id: string): IntelEntry | undefined {
    return this.items.get(id);
  }

  /** 等判断（失败的条目按退避时刻放行） */
  listToJudge(actorId?: string, now = this.nowFn()): IntelEntry[] {
    return this.filter((e) => e.state === "new" && (e.nextRetryAt ?? 0) <= now, actorId);
  }

  /** 到点该成稿/投递的（held 已经由 sweep 提升为 to_compose） */
  listToCompose(actorId?: string, now = this.nowFn()): IntelEntry[] {
    return this.filter(
      (e) => e.state === "to_compose" && !e.composed && (e.dueAt ?? 0) <= now && (e.nextRetryAt ?? 0) <= now,
      actorId,
    );
  }

  /** 已成稿、等投递（投递失败重投同一句，不重新成稿） */
  listReadyToDeliver(actorId?: string, now = this.nowFn()): IntelEntry[] {
    return this.filter(
      (e) => e.state === "to_compose" && Boolean(e.composed) && (e.nextRetryAt ?? 0) <= now,
      actorId,
    );
  }

  /** 面板视图：只有还没处理完的事 */
  panel(actorId?: string): IntelEntry[] {
    return this.filter(
      (e) =>
        e.state === "new" || e.state === "held" || e.state === "to_compose" || e.state === "unconfirmed",
      actorId,
    ).sort((a, b) => b.receivedAt - a.receivedAt);
  }

  activeActors(): string[] {
    const out = new Set<string>();
    for (const e of this.items.values()) {
      if (e.state === "new" || e.state === "held" || e.state === "to_compose" || e.state === "unconfirmed") {
        out.add(e.actorId);
      }
    }
    return [...out];
  }

  /** 写入判断结论：now → 待成稿；later → 等到点；never → 放弃 */
  applyJudgment(id: string, judgment: IntelJudgeResult, at = this.nowFn()): void {
    const e = this.items.get(id);
    if (!e) return;
    e.judgment = { ...judgment, judgedAt: at };
    e.lastError = undefined;
    delete e.nextRetryAt;
    if (judgment.verdict === "never") {
      e.state = "dropped";
      delete e.dueAt;
    } else {
      e.state = judgment.verdict === "now" ? "to_compose" : "held";
      e.dueAt = judgment.verdict === "now" ? at : (judgment.dueAt ?? at);
      if (judgment.expiresAt !== undefined) e.expiresAt = judgment.expiresAt;
    }
    this.flush();
  }

  /** 成稿完成：投递前写入，投递失败重投同一句 */
  markComposed(id: string, result: IntelComposeResult, at = this.nowFn()): void {
    const e = this.items.get(id);
    if (!e) return;
    e.composed = {
      message: result.message,
      at,
      ...(result.needsConfirm ? { needsConfirm: true } : {}),
      ...(result.memoryCandidate ? { memoryCandidate: result.memoryCandidate } : {}),
    };
    e.lastError = undefined;
    delete e.nextRetryAt;
    this.flush();
  }

  /**
   * 已投递：从面板删除，写历史与墓碑。
   * needsConfirm 的事项留在面板 unconfirmed，等到用户回应或窗口过期。
   */
  markDelivered(id: string, at = this.nowFn(), confirmWindowMs = DEFAULT_CONFIRM_WINDOW_MS): IntelEntry | null {
    const e = this.items.get(id);
    if (!e) return null;
    const message = e.composed?.message ?? e.brief;
    e.spokenAt = at;
    this.pushHistory({
      id: e.id,
      eventKey: e.eventKey,
      actorId: e.actorId,
      source: e.source,
      brief: e.brief,
      message,
      at,
      ...(e.composed?.needsConfirm ? { needsConfirm: true, acknowledged: false } : {}),
    });
    this.pushTombstone({ eventKey: e.eventKey, topic: e.brief, message, at });
    if (e.composed?.needsConfirm) {
      e.state = "unconfirmed";
      e.confirmBy = at + confirmWindowMs;
      this.flush();
      return e;
    }
    this.items.delete(id);
    this.flush();
    return e;
  }

  /** 用户已经回应（工具侧显式确认或后续对话证实），已发未确认可以关闭 */
  acknowledge(id: string): boolean {
    const e = this.items.get(id);
    const target = e ?? null;
    if (!target || target.state !== "unconfirmed") return false;
    const hist = this.history.find((h) => h.id === id);
    if (hist) hist.acknowledged = true;
    this.items.delete(id);
    this.flush();
    return true;
  }

  /** 放弃：通道明确拒投 / 过期 / 模型判 never */
  drop(id: string, reason?: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.state = "dropped";
    if (reason) e.lastError = reason.slice(0, 200);
    delete e.dueAt;
    delete e.confirmBy;
    this.flush();
  }

  /** 判断/成稿/投递失败：留在原状态，按 retryInMs 退避 */
  fail(id: string, error: string, at = this.nowFn(), retryInMs = 0): void {
    const e = this.items.get(id);
    if (!e) return;
    e.attempts += 1;
    e.lastError = error.slice(0, 200);
    if (retryInMs > 0) e.nextRetryAt = at + retryInMs;
    else delete e.nextRetryAt;
    this.flush();
  }

  /**
   * 时钟推进：held 到点 → to_compose；过期 → dropped；已发未确认窗口结束 → 落历史。
   * 机械留存，不做判断。
   */
  sweep(now = this.nowFn()): { promoted: number; expired: number; confirmClosed: number } {
    let promoted = 0;
    let expired = 0;
    let confirmClosed = 0;
    for (const [id, e] of [...this.items]) {
      if (e.state === "held" && (e.dueAt ?? 0) <= now) {
        e.state = "to_compose";
        e.dueAt = now;
        promoted += 1;
        continue;
      }
      if (e.state === "unconfirmed") {
        const deadline = e.confirmBy ?? e.expiresAt;
        if (deadline !== undefined && deadline <= now) {
          const hist = this.history.find((h) => h.id === id);
          if (hist) hist.acknowledged = false;
          this.items.delete(id);
          confirmClosed += 1;
        }
        continue;
      }
      if (e.state === "held" || e.state === "new" || e.state === "to_compose") {
        const deadline =
          e.state === "held"
            ? Math.min(e.expiresAt ?? Infinity, (e.dueAt ?? e.receivedAt) + HELD_TTL_MS)
            : e.expiresAt ?? e.receivedAt + (e.state === "new" ? NEW_TTL_MS : HELD_TTL_MS);
        if (deadline <= now) {
          e.state = "dropped";
          if (!e.lastError) e.lastError = "过期未处理";
          this.items.delete(id);
          expired += 1;
        }
      }
    }
    if (promoted + expired + confirmClosed > 0) this.flush();
    return { promoted, expired, confirmClosed };
  }

  /** 同一事件键最近说过没有（墓碑去重） */
  wasSaid(eventKey: string, now = this.nowFn(), withinMs = SAID_WINDOW_MS): IntelTombstone | null {
    for (const t of this.tombstones) {
      if (t.eventKey === eventKey && now - t.at <= withinMs) return t;
    }
    return null;
  }

  /** 最近说过的话（判断密度与重复感的输入） */
  recentSpoken(limit = 8, actorId?: string): IntelHistoryItem[] {
    return this.history
      .filter((h) => (actorId === undefined || h.actorId === actorId) && h.message)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  historyFor(actorId?: string, limit = 20): IntelHistoryItem[] {
    return this.history
      .filter((h) => actorId === undefined || h.actorId === actorId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  findHistory(id: string): IntelHistoryItem | undefined {
    return this.history.find((h) => h.id === id);
  }

  /** 指定时刻之后说过的条数（状态面板的当日开口数） */
  spokenSince(since: number, actorId?: string): number {
    return this.history.filter((h) => h.at >= since && (actorId === undefined || h.actorId === actorId)).length;
  }

  /** 未处理项上的错误（模型不可用/投递失败），状态面板如实展示 */
  pendingErrors(): string[] {
    return this.filter(
      (e) =>
        (e.state === "new" || e.state === "to_compose") && e.lastError !== undefined,
    ).map((e) => e.lastError as string);
  }

  stats(now = this.nowFn()): {
    total: number;
    new: number;
    held: number;
    toCompose: number;
    unconfirmed: number;
    dropped: number;
    history: number;
    tombstones: number;
    overdue: number;
  } {
    let pendingNew = 0;
    let held = 0;
    let toCompose = 0;
    let unconfirmed = 0;
    let dropped = 0;
    let overdue = 0;
    for (const e of this.items.values()) {
      if (e.state === "new") pendingNew += 1;
      else if (e.state === "held") {
        held += 1;
        if ((e.dueAt ?? 0) <= now) overdue += 1;
      } else if (e.state === "to_compose") toCompose += 1;
      else if (e.state === "unconfirmed") unconfirmed += 1;
      else dropped += 1;
    }
    return {
      total: this.items.size,
      new: pendingNew,
      held,
      toCompose,
      unconfirmed,
      dropped,
      history: this.history.length,
      tombstones: this.tombstones.length,
      overdue,
    };
  }

  flush(): void {
    if (this.disablePersist) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload: StoreFile = {
        items: [...this.items.values()],
        history: this.history,
        tombstones: this.tombstones,
      };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.file);
    } catch {
      /* 落盘失败降级为内存态，不阻塞判断与投递 */
    }
  }

  private pushHistory(item: IntelHistoryItem): void {
    this.history.unshift(item);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
  }

  private pushTombstone(t: IntelTombstone): void {
    this.tombstones.unshift(t);
    if (this.tombstones.length > MAX_TOMBSTONES) this.tombstones.length = MAX_TOMBSTONES;
  }

  private filter(pred: (e: IntelEntry) => boolean, actorId?: string): IntelEntry[] {
    const out: IntelEntry[] = [];
    for (const e of this.items.values()) {
      if (actorId !== undefined && e.actorId !== actorId) continue;
      if (pred(e)) out.push(e);
    }
    return out;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const file = raw as Partial<StoreFile>;
      if (Array.isArray(file.items)) {
        for (const row of file.items) {
          if (!isEntry(row)) continue;
          this.items.set(row.id, row);
        }
      }
      if (Array.isArray(file.history)) {
        this.history = file.history.filter(isHistory).slice(0, MAX_HISTORY);
      }
      if (Array.isArray(file.tombstones)) {
        this.tombstones = file.tombstones.filter(isTombstone).slice(0, MAX_TOMBSTONES);
      }
    } catch {
      /* 文件损坏按空面板处理 */
    }
  }

  private trim(): void {
    if (this.items.size <= MAX_ITEMS) return;
    const removable = [...this.items.values()]
      .filter((e) => e.state === "dropped")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const e of removable) {
      if (this.items.size <= MAX_ITEMS) break;
      this.items.delete(e.id);
    }
  }
}

function isEntry(v: unknown): v is IntelEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.actorId === "string" &&
    typeof o.source === "string" &&
    typeof o.receivedAt === "number" &&
    typeof o.brief === "string" &&
    typeof o.detail === "string" &&
    typeof o.state === "string" &&
    Array.isArray(o.refs) &&
    Boolean(o.raw) &&
    typeof (o.raw as Record<string, unknown>).title === "string"
  );
}

function isHistory(v: unknown): v is IntelHistoryItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.actorId === "string" &&
    typeof o.source === "string" &&
    typeof o.message === "string" &&
    typeof o.at === "number"
  );
}

function isTombstone(v: unknown): v is IntelTombstone {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.eventKey === "string" && typeof o.message === "string" && typeof o.at === "number";
}
