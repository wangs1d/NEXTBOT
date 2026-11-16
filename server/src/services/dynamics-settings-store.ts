// 动态页的「消息设置」持久层（2026-11-16 改版）。
//
// 三件事落在这里：
//   1. 来源规则 —— 银行短信 / 电商营销 / 快递通知 / 群聊通知 是否进入动态页。
//      规则在入口层生效：不进入的内容不落台账、不发信号，只在「已拦截」里计数。
//   2. 拦截计数 —— 只记原因与来源，不存正文（可审计但不泄露内容）。
//   3. 订阅相关的用户动作 —— 忽略某条订阅建议 / 续费前提醒（按订阅 id）。
//
// 存储沿用 persist-file.ts（tmp 原子替换），条目量级很小。
import { join } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";

/** 来源规则 id */
export type SourceRuleId = "bankSms" | "ecommerceMarketing" | "parcelNotice" | "groupChat";

/** 规则动作：进入 / 不进入（入口层直接丢弃） */
export type SourceRuleAction = "enter" | "block";

/** 拦截原因 */
export type BlockedReason = "marketing" | "otp" | "duplicateParcel" | "sourceRule" | "groupChat";

export type SourceRule = {
  id: SourceRuleId;
  title: string;
  action: SourceRuleAction;
};

export type BlockedEvent = {
  at: number;
  reason: BlockedReason;
  source: string;
};

export type BlockedSummary = {
  /** 本周（周一 00:00 起）拦截总数 */
  total: number;
  /** 分类计数（只回计数，不展示正文） */
  byReason: Record<BlockedReason, number>;
  since: number;
};

const RULE_META: ReadonlyArray<{ id: SourceRuleId; title: string; action: SourceRuleAction }> = [
  { id: "bankSms", title: "银行短信", action: "enter" },
  { id: "ecommerceMarketing", title: "电商营销", action: "block" },
  { id: "parcelNotice", title: "快递通知", action: "enter" },
  { id: "groupChat", title: "群聊通知", action: "block" },
];

const DEFAULT_RULES: Record<SourceRuleId, SourceRuleAction> = {
  bankSms: "enter",
  ecommerceMarketing: "block",
  parcelNotice: "enter",
  groupChat: "block",
};

const BLOCKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOCKED = 500;

type PersistedShape = {
  version: 1;
  rules: Record<SourceRuleId, SourceRuleAction>;
  blocked: BlockedEvent[];
  dismissedSubscriptions: string[];
  subscriptionReminders: Record<string, number>;
};

export class DynamicsSettingsStore {
  private readonly filePath: string;
  private readonly nowFn: () => number;
  private state: PersistedShape = {
    version: 1,
    rules: { ...DEFAULT_RULES },
    blocked: [],
    dismissedSubscriptions: [],
    subscriptionReminders: {},
  };
  private loaded = false;

  constructor(private readonly opts: { dataPath: string; now?: () => number }) {
    this.filePath = join(opts.dataPath, "dynamics-settings.json");
    this.nowFn = opts.now ?? Date.now;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson<PersistedShape>(this.filePath, this.state);
    this.state = {
      version: 1,
      rules: { ...DEFAULT_RULES, ...(raw?.rules ?? {}) },
      blocked: Array.isArray(raw?.blocked) ? raw.blocked : [],
      dismissedSubscriptions: Array.isArray(raw?.dismissedSubscriptions)
        ? raw.dismissedSubscriptions.filter((s): s is string => typeof s === "string")
        : [],
      subscriptionReminders:
        raw?.subscriptionReminders && typeof raw.subscriptionReminders === "object"
          ? raw.subscriptionReminders
          : {},
    };
    this.prune();
  }

  /** 全部来源规则（带标题，供设置页直接渲染） */
  rules(): SourceRule[] {
    this.load();
    return RULE_META.map((r) => ({ ...r, action: this.state.rules[r.id] ?? r.action }));
  }

  /** 是否允许进入动态页（未知 id 默认放行） */
  allows(id: SourceRuleId): boolean {
    this.load();
    return (this.state.rules[id] ?? "enter") === "enter";
  }

  setRule(id: SourceRuleId, action: SourceRuleAction): SourceRule[] {
    this.load();
    if (!RULE_META.some((r) => r.id === id)) return this.rules();
    this.state.rules[id] = action === "block" ? "block" : "enter";
    this.persist();
    return this.rules();
  }

  /** 记一条拦截（只存原因+来源，不存正文） */
  recordBlocked(reason: BlockedReason, source: string, at?: number): void {
    this.load();
    this.state.blocked.push({ at: at ?? this.nowFn(), reason, source });
    this.prune();
    this.persist();
  }

  /** 本周（周一 00:00 起）拦截统计 */
  blockedThisWeek(now = this.nowFn()): BlockedSummary {
    this.load();
    const since = startOfWeek(now);
    const byReason: Record<BlockedReason, number> = {
      marketing: 0,
      otp: 0,
      duplicateParcel: 0,
      sourceRule: 0,
      groupChat: 0,
    };
    let total = 0;
    for (const e of this.state.blocked) {
      if (e.at < since) continue;
      total += 1;
      byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    }
    return { total, byReason, since };
  }

  dismissSubscription(id: string): void {
    this.load();
    if (!this.state.dismissedSubscriptions.includes(id)) {
      this.state.dismissedSubscriptions.push(id);
      this.persist();
    }
  }

  isSubscriptionDismissed(id: string): boolean {
    this.load();
    return this.state.dismissedSubscriptions.includes(id);
  }

  remindSubscription(id: string, at?: number): void {
    this.load();
    // 默认提前 3 天；调用方可传更精确的时刻
    this.state.subscriptionReminders[id] = at ?? this.nowFn() + 3 * 24 * 60 * 60 * 1000;
    this.persist();
  }

  subscriptionReminder(id: string): number | null {
    this.load();
    return this.state.subscriptionReminders[id] ?? null;
  }

  /** 全部订阅提醒（扫描时回填 remindAt 用） */
  allSubscriptionReminders(): Record<string, number> {
    this.load();
    return { ...this.state.subscriptionReminders };
  }

  private prune(): void {
    const cutoff = this.nowFn() - BLOCKED_RETENTION_MS;
    this.state.blocked = this.state.blocked.filter((e) => e.at >= cutoff).slice(-MAX_BLOCKED);
  }

  private persist(): void {
    writeJson(this.filePath, this.state);
  }
}

/** 本周一 00:00（本地时区） */
export function startOfWeek(at: number): number {
  const d = new Date(at);
  const day = d.getDay(); // 0=周日
  const diff = (day + 6) % 7; // 周一=0
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff, 0, 0, 0, 0);
  return start.getTime();
}
