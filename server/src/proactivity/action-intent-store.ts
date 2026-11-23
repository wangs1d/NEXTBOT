/**
 * 动作意图存储（ActionIntentStore）——「通知即界面」的唯一真相源。
 *
 * 为什么要有这一层（2026-11-13）：
 *   聊天卡上的按钮和通知栏里的按钮**必须是同一个动作的两种渲染面**。
 *   如果通知栏另起一条链路，就会出现两套语义、两套审计、两套失败处理——
 *   用户在通知栏点了「取消续费」，聊天里的卡还显示「待确认」，两边对不上。
 *
 * 一条 ActionIntent 的生命周期：
 *   register → 客户端拿到带按钮的通知 → 用户点按钮 → 客户端带 token 回执行端点
 *   → 验签 → 幂等执行 → 标记 executed → 回执以第二条通知/气泡回传。
 *
 * 风险分级（决定按钮语义与有效期）：
 *   L0 可逆（取消续费 / 关闭夜间任务）→ 通知栏可直接执行，TTL 24h
 *   L1 轻微不可逆（改签已出票的航班）→ 通知栏可执行，TTL 2h
 *   L2 花钱 / 不可逆（支付、注销）→ 通知栏**不放执行按钮**，只给「去确认」，TTL 30min
 *
 * 落盘 data/proactivity/action-intents.json（可选）：重启后未过期的意图仍可执行
 * （通知可能几小时后才被看到，不能因为服务重启就作废）。
 */
import { readJson, writeJson } from "./persist-file.js";

/** 风险分级：决定通知栏是否放执行按钮、有效期长短 */
export type ActionRisk = "L0" | "L1" | "L2";

/** 动作类型：execute=直接执行；input=需要用户补一句（RemoteInput 内联回复） */
export type ActionIntentActionKind = "execute" | "input";

export type ActionIntentAction = {
  /** 动作标识（服务端解释；聊天卡与通知栏共用同一个） */
  actionId: string;
  /** 按钮文案：动作短语，2–5 字最佳 */
  label: string;
  kind: ActionIntentActionKind;
  /** kind=input 时的输入框提示 */
  inputLabel?: string;
  /** kind=input 时是否允许自由输入（false=只能从 inputChoices 里选） */
  allowFreeFormInput?: boolean;
  /** kind=input 的枚举候选项 */
  inputChoices?: string[];
  /** 执行载荷（服务端解释；客户端只透传，不解释） */
  payload?: Record<string, unknown>;
};

export type ActionIntentState = "pending" | "executed" | "expired" | "cancelled";

export type ActionIntent = {
  intentId: string;
  actorId: string;
  /** 业务类别（proactivity / shopping / travel …），用于诊断与审计归类 */
  kind: string;
  /** 通知标题：写「已发生的事」，不是 Agent 的寒暄 */
  title: string;
  /** 通知正文：事实 */
  body: string;
  /** 一句话方案说明：Agent 已算好的方案 / 按下去会发生什么 */
  summary?: string;
  risk: ActionRisk;
  actions: ActionIntentAction[];
  createdAt: number;
  expiresAt: number;
  state: ActionIntentState;
  /** 已执行过的 actionId：同一 intent 的每个 action 各自幂等一次 */
  executedActions: string[];
  /** 关联的投递 id（回执与 outcome 回灌用） */
  deliveryId?: string;
  /**
   * 通知栏回复线程的第几轮（2026-11-29 §4.3）。
   *
   * 为什么轮次要落在意图上而不是内存里：一条通知可能几小时后才被回，重启后
   * 「这是第几轮」必须还在（否则第 4 轮又长出一个回复框，永远收不了口）。
   * rootIntentId = 最初那条通知对应的意图 id；同一线程的所有轮次共用它，
   * 客户端据此把 agent 的回复**原地更新到同一条通知**（通知 id 由它算出）。
   * 第一轮只有 round=1、没有 root（它自己就是根）。
   */
  replyRound?: { rootIntentId?: string; round: number };
  /** 最近一次执行结果（回执文案来源） */
  lastResult?: { actionId: string; ok: boolean; message: string; at: number };
};

interface ActionIntentFileShape {
  version: 1;
  entries: ActionIntent[];
}

let idSeq = 0;

export function nextIntentId(prefix = "ai"): string {
  idSeq = (idSeq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** 风险分级的默认有效期（ms）：L0 可逆放最长，L2 花钱动作最短 */
export const RISK_TTL_MS: Record<ActionRisk, number> = {
  L0: 24 * 60 * 60_000,
  L1: 2 * 60 * 60_000,
  L2: 30 * 60_000,
};

/** 终态条目的保留期（ms）：过了就删，避免意图文件无限堆积 */
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export class ActionIntentStore {
  private readonly entries = new Map<string, ActionIntent>();
  private dirty = false;
  private readonly nowFn: () => number;

  constructor(private readonly path?: string, nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
    if (path) {
      const raw = readJson<ActionIntentFileShape>(path, { version: 1, entries: [] });
      const now = this.nowFn();
      for (const e of raw.entries ?? []) {
        // 过期即弃：恢复时就不把过期条目带回来（避免发出一个点下去必失败的按钮）
        if (e.expiresAt > now) this.entries.set(e.intentId, e);
      }
    }
  }

  /** 登记一条动作意图（自动剔除过期并落盘） */
  register(entry: Omit<ActionIntent, "intentId"> & { intentId?: string }): ActionIntent {
    this.pruneExpired();
    const intent: ActionIntent = {
      ...entry,
      intentId: entry.intentId ?? nextIntentId(),
    };
    this.entries.set(intent.intentId, intent);
    this.dirty = true;
    this.flush();
    return intent;
  }

  get(intentId: string): ActionIntent | undefined {
    const e = this.entries.get(intentId);
    if (!e) return undefined;
    if (e.expiresAt <= this.nowFn() && e.state === "pending") {
      e.state = "expired";
      this.dirty = true;
      this.flush();
    }
    return e;
  }

  /**
   * 标记某个 action 已执行（幂等依据）。
   *
   * **一个意图只拍一次板**：同一批按钮是**互斥**决策（好就这么办 / 稍后再说 /
   * 不用了），拍完一个其余全部作废——否则用户连点两个就会同时"接受"又"推迟"，
   * 状态自相矛盾。
   */
  markExecuted(
    intentId: string,
    actionId: string,
    result: { ok: boolean; message: string },
  ): ActionIntent | undefined {
    const e = this.entries.get(intentId);
    if (!e) return undefined;
    if (!e.executedActions.includes(actionId)) e.executedActions.push(actionId);
    e.state = "executed";
    e.lastResult = { actionId, ok: result.ok, message: result.message, at: this.nowFn() };
    this.dirty = true;
    this.flush();
    return e;
  }

  /**
   * 剔除过期未执行的意图，并清掉过了保留期的终态条目。
   *
   * 保留期 7 天：执行/取消/过期的条目只作审计留痕，不再需要可执行性，
   * 但也不能无限堆积（action-intents.json 是会一直写的）。
   */
  pruneExpired(now = this.nowFn()): void {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (e.expiresAt <= now && e.state === "pending") {
        e.state = "expired";
        this.dirty = true;
        changed = true;
      }
    }
    // 终态条目过了保留期 → 直接删除（审计已落在 lastResult / outcome 台账里）
    for (const [id, e] of this.entries) {
      if (e.state !== "pending" && now - e.createdAt > RETENTION_MS) {
        this.entries.delete(id);
        this.dirty = true;
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    writeJson(this.path, { version: 1, entries: [...this.entries.values()] } satisfies ActionIntentFileShape);
    this.dirty = false;
  }
}
