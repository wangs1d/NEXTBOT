// 映射执行器（MappingExecutor）—— 主动性「决策=程序对号入座」的落地（L2）。
//
// 设计定稿（2026-09-24 用户拍板）：LLM 不参与决策。规则表（mapping-rules.ts，
// 一条规则=一个场景：状态条件 + 模板正文/动作元数据）每分钟读一次世界状态板
// （WorldBoard），命中即产出 AttentionEvent 交仲裁层（ArbiterV2）裁决投递。
//
// 与旧 EvaluatorChain 的差别：规则消费的是**整理后的分层状态**（幂等"现在"），
// 不是信号缓冲窗口——没有水位、没有批处理，状态没变结论不变，天然幂等。
// 全零 LLM；规则私有状态与事件去重指纹落盘（重启不重发、计时不清零）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProactiveImportance } from "./pipeline-types.js";
import type { AttentionUrgency } from "./arbiter-v2.js";
import type { BoardLayerName, WorldBoard } from "./world-board.js";

/** 执行器产出的事件：仲裁与投递的唯一中间格式（原 evaluator-chain 格式，平移保留） */
export type AttentionEvent = {
  id: string;
  at: number;
  /** 规则 id（诊断与防重） */
  kind: string;
  urgency: AttentionUrgency;
  /** 管道提案 kind（映射频控冷却表，如 greeting / life_reminder） */
  proposalKind: string;
  tier: "must" | "social";
  importance: ProactiveImportance;
  title: string;
  /** 模板直出的用户可见文本（零 LLM） */
  body: string;
  dedupKey: string;
  salience: "high" | "medium" | "low";
  /** ask_first 提案的确认按钮文案（如承诺代催） */
  confirmLabel?: string;
  /** 事件背景（呼叫场景喂给对话 LLM 的上下文；模板事件可为空） */
  summary?: string;
  /** 提案保质期 ms（如临日会议提醒在会议开始后即无意义） */
  expiresAt?: number;
  /** "always" = 该事件优先走真实来电汇报；缺省按路由白名单/critical 判定 */
  callPolicy?: "always";
  actorId?: string;
};

/** 规则可消费的外部数据源（查询型程序数据：日程/承诺/天气/未读/兴趣/记忆） */
export type RuleServices = {
  listTodayTasks?: () => Array<{ title: string; runAt?: number | string }>;
  commitmentsDue?: (withinMs: number) => Array<{ id: string; title: string; dueAt?: number }>;
  weatherLine?: () => string | null;
  unreadSenders?: () => string[];
  readyGoals?: () => Array<{ title: string; body: string }>;
  interestLines?: () => string[];
  recallMemory?: (query: string, limit: number) => Promise<string[]> | string[];
  /**
   * 感知 → 目标桥（2026-10-10）：某 actor 的"一句话目标上下文"（如
   * 「你还在推进「学英语」，下一步是「背 20 个词」」）。规则文案据此从
   * "碎片化场景"升级为"带目标上下文"（对齐 Muse 的目标驱动）。
   * 未注入 = 规则文案不带目标上下文（行为回退）。
   */
  activeGoalLine?: (actorId: string) => string | null;
};

/** 规则执行上下文：只看状态板 + 自己的私有状态（查询型服务经 buildBoardRules
 *  闭包注入，不走 ctx——历史 ctx.services 字段零消费已删） */
export type RuleContext = {
  actorId: string;
  now: Date;
  nowMs: number;
  /** 世界状态板该 actor 的四层只读视图 */
  board: Partial<Record<BoardLayerName, Record<string, unknown>>>;
  /** 规则私有状态（跨 tick 保留，落盘） */
  state: Map<string, unknown>;
};

/** 规则产出（执行器补 id/at/kind 后成为 AttentionEvent；kind 缺省用规则 id，
 *  一个规则可产出多个诊断 kind，如 meeting_soon / meeting_soon_early） */
export type RuleOutcome = Omit<AttentionEvent, "id" | "at" | "actorId"> & { kind?: string };

/** 一条映射规则 = 一个场景（加场景=加一行，不改执行器） */
export type BoardRule = {
  id: string;
  /** 规则最小运行间隔 ms（缺省 60s；内部去重/冷却自行保证不骚扰） */
  tickEveryMs?: number;
  /** 消费的状态板层（诊断展示用） */
  layers: BoardLayerName[];
  eval(ctx: RuleContext): RuleOutcome[] | Promise<RuleOutcome[]>;
};

export type MappingExecutorOptions = {
  board: WorldBoard;
  rules: BoardRule[];
  defaultActorId?: () => string | null;
  dataPath?: string;
  nowFn?: () => number;
  /** 全局 tick 步长（缺省 60s；规则内部再按各自 tickEveryMs 节流） */
  tickIntervalMs?: number;
  /**
   * 活跃 actor 过滤（2026-10-01 P0 配额窃取根修）：tickAll 只评估此判定为
   * 活跃的 actor。单用户机上状态板是测试 actor 坟场（E2E/bench 永不过期），
   * 规则状态若按插入序全局消费，先到的测试 actor 会吃掉当天配额，真实用户
   * 永远轮空（审计实证：16 天 60 事件 0 条归真实用户）。缺省不过滤（兼容测试）。
   */
  isActiveActor?: (actorId: string) => boolean;
};

const EVENT_DEDUP_MAX = 400;
const STATE_SAVE_MIN_INTERVAL_MS = 60_000;

/** 事件审计单条记录（events.ndjson；每一次主动事件的裁决全链留痕） */
export type EventAuditRecord = {
  at: number;
  eventId: string;
  kind: string;
  urgency: string;
  actorId: string;
  /** 仲裁动作（deliver_now / wait_for_pause / log） */
  action: string;
  cost?: number;
  /** 管道 verdict（deliver_now 时有值） */
  verdict?: string;
  title: string;
  /**
   * 归属判定留痕（2026-10-19）：这条场景信号被判定为"某个在办目标的事"时记下
   * 目标与命中词——回答"这条为什么被提了等级/为什么带上了目标文案"。
   */
  goalId?: string;
  goalMatchedOn?: string;
  /** 该开口在窗口内与另一源的开口重复（已按跨源去重降档，2026-10-19） */
  goalRepeat?: boolean;
};

const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 追加事件审计（轮转同信号日志；落盘失败静默） */
export function appendEventAudit(logPath: string, rec: EventAuditRecord): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath) && statSync(logPath).size > EVENT_LOG_MAX_BYTES) {
      try {
        renameSync(logPath, `${logPath}.1`);
      } catch {
        /* 轮转失败继续追加 */
      }
    }
    appendFileSync(logPath, `${JSON.stringify(rec)}\n`);
  } catch {
    /* 审计失败不影响主链路 */
  }
}

/** 序列化规则状态：Map/Set 展开为标记对象，其余 JSON 原生 */
function serializeValue(v: unknown): unknown {
  if (v instanceof Map) return { __t: "map", e: [...v].map(([k, val]) => [k, serializeValue(val)]) };
  if (v instanceof Set) return { __t: "set", e: [...v].map((x) => serializeValue(x)) };
  return v;
}

function deserializeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as { __t?: string; e?: unknown };
    if (rec.__t === "map" && Array.isArray(rec.e)) {
      return new Map(rec.e.map(([k, val]) => [k, deserializeValue(val)]));
    }
    if (rec.__t === "set" && Array.isArray(rec.e)) {
      return new Set(rec.e.map((x) => deserializeValue(x)));
    }
  }
  return v;
}

export class MappingExecutor {
  private readonly listeners = new Set<(event: AttentionEvent) => void>();
  private readonly state = new Map<string, Map<string, unknown>>();
  private readonly eventFingerprints = new Map<string, number>(); // dedupKey:day → at（LRU）
  private readonly lastRunAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly statePath: string | null;
  private lastStateSaveAt = 0;
  private stateDirty = false;

  constructor(private readonly opts: MappingExecutorOptions) {
    this.tickIntervalMs = opts.tickIntervalMs ?? 60_000;
    this.nowFn = opts.nowFn ?? Date.now;
    this.statePath = opts.dataPath ? join(opts.dataPath, "mapping-state.json") : null;
    this.restoreState();
    for (const rule of opts.rules) this.register(rule);
  }

  register(rule: BoardRule): void {
    this.lastRunAt.set(rule.id, this.nowFn() - (rule.tickEveryMs ?? this.tickIntervalMs));
    // 保留 restoreState() 恢复的历史状态（register 在构造后调用，不能清空已恢复状态）
    if (!this.state.has(rule.id)) this.state.set(rule.id, new Map());
  }

  onEvent(listener: (event: AttentionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 规则状态概览（fabric 诊断探针：id/消费层/状态键数/周期） */
  probes(): Array<{ id: string; layers: string[]; stateKeys: number; tickEveryMs: number }> {
    return this.opts.rules.map((r) => ({
      id: r.id,
      layers: [...r.layers],
      stateKeys: this.state.get(r.id)?.size ?? 0,
      tickEveryMs: r.tickEveryMs ?? this.tickIntervalMs,
    }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tickAll();
      } catch (err) {
        console.log(`[MappingExecutor] tick 失败（忽略）: ${err}`);
      }
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(
      `[MappingExecutor] 已启动 rules=${this.opts.rules.length}（tick=${Math.round(this.tickIntervalMs / 1000)}s，状态板决策，零 LLM）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persistState(true);
  }

  /** 全量 tick（活跃 actor × 所有到期规则）；测试可直调 */
  tickAll(now: number = this.nowFn()): void {
    const actors = this.opts.board.knownActors();
    const fallback = this.opts.defaultActorId?.() ?? null;
    let ids = actors.length > 0 ? actors : fallback ? [fallback] : [];
    // 活跃过滤：只评估在真正交互的用户（测试 actor 坟场不进 tick、不吃配额）
    if (this.opts.isActiveActor && ids.length > 0) {
      ids = ids.filter((id) => {
        try {
          return this.opts.isActiveActor!(id);
        } catch {
          return false;
        }
      });
    }
    for (const actorId of ids) this.tickActor(actorId, now);
    this.stateDirty = true;
    this.persistState();
  }

  /** 单 actor tick（测试/E2E 直调；规则按各自 tickEveryMs 节流） */
  async tickActor(actorId: string, now: number = this.nowFn()): Promise<void> {
    const board = this.opts.board.getBoard(actorId) ?? undefined;
    const nowDate = new Date(now);
    for (const rule of this.opts.rules) {
      const every = rule.tickEveryMs ?? this.tickIntervalMs;
      const last = this.lastRunAt.get(rule.id) ?? 0;
      if (now - last < every) continue;
      this.lastRunAt.set(rule.id, now);
      try {
        const outcomes = await rule.eval({
          actorId,
          now: nowDate,
          nowMs: now,
          board: board ?? {},
          state: this.stateFor(rule.id, actorId),
        });
        for (const outcome of outcomes ?? []) this.dispatch(rule.id, outcome, actorId, now);
      } catch (err) {
        console.log(`[MappingExecutor] 规则 ${rule.id} 失败（忽略）: ${err}`);
      }
    }
  }

  /**
   * 规则状态按 actor 分键（2026-10-01 P0）：返回「规则内部状态 Map 中该
   * (ruleId, actorId) 切片」的视图——规则读写 state 都落进自己的切片，
   * 不同用户互不覆盖/互不吃配额。旧全局键（升级前落盘）惰性迁移到
   * 首个评估的活跃 actor 名下，避免升级即清零。
   */
  private stateFor(ruleId: string, actorId: string): Map<string, unknown> {
    const ruleState = this.state.get(ruleId) ?? new Map<string, unknown>();
    this.state.set(ruleId, ruleState);
    const nsKey = `@${actorId}`;
    let slice = ruleState.get(nsKey) as Map<string, unknown> | undefined;
    if (!slice) {
      slice = new Map();
      // 惰性迁移：切片首次创建时，把升级前的全局散键收编（@ 前缀键除外）。
      // 若全局键已被某个 actor 消费过（多 actor 场景），归首个到达者——
      // 单用户机上即真实用户，测试 actor 有活跃过滤挡在 tickAll 外。
      let migrated = false;
      for (const [k, v] of ruleState) {
        if (k.startsWith("@")) continue;
        if (!migrated) {
          slice.set(k, v);
          migrated = true;
        }
        ruleState.delete(k);
      }
      ruleState.set(nsKey, slice);
    }
    return slice;
  }

  private dispatch(ruleId: string, outcome: RuleOutcome, actorId: string, at: number): void {
    // 事件级去重（同 dedupKey 一天内只发一次；按 actor 分键——不同用户互不挤占）
    const fp = `${actorId}::${outcome.dedupKey || `${ruleId}:${at}`}`;
    const dayKey = `${fp}:${new Date(at).toISOString().slice(0, 10)}`;
    if (this.eventFingerprints.has(dayKey)) return;
    this.eventFingerprints.set(dayKey, at);
    this.stateDirty = true;
    while (this.eventFingerprints.size > EVENT_DEDUP_MAX) {
      const oldest = this.eventFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.eventFingerprints.delete(oldest);
    }
    const event: AttentionEvent = {
      ...outcome,
      kind: outcome.kind ?? ruleId,
      at,
      actorId,
      id: `ev_${ruleId}_${at.toString(36)}`,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 单订阅者失败不影响其他 */
      }
    }
  }

  /** 重启恢复：规则 state + 事件去重指纹（重启不重发、计时不清零） */
  private restoreState(): void {
    if (!this.statePath) return;
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        rules?: Record<string, Record<string, unknown>>;
        eventFingerprints?: Array<[string, number]>;
      };
      for (const [id, kv] of Object.entries(raw.rules ?? {})) {
        const map = this.state.get(id) ?? new Map<string, unknown>();
        for (const [k, v] of Object.entries(kv)) map.set(k, deserializeValue(v));
        this.state.set(id, map);
      }
      for (const [k, at] of raw.eventFingerprints ?? []) this.eventFingerprints.set(k, at);
      console.log(
        `[MappingExecutor] 状态已恢复 rules=${Object.keys(raw.rules ?? {}).length} fingerprints=${raw.eventFingerprints?.length ?? 0}`,
      );
    } catch {
      /* 损坏文件按空状态处理 */
    }
  }

  /** 状态落盘（节流：脏标记 + 最小间隔） */
  private persistState(force = false): void {
    if (!this.statePath || !this.stateDirty) return;
    const now = this.nowFn();
    if (!force && now - this.lastStateSaveAt < STATE_SAVE_MIN_INTERVAL_MS) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const rules: Record<string, Record<string, unknown>> = {};
      for (const [id, map] of this.state) {
        if (map.size === 0) continue;
        const kv: Record<string, unknown> = {};
        for (const [k, v] of map) kv[k] = serializeValue(v);
        rules[id] = kv;
      }
      writeFileSync(this.statePath, JSON.stringify({ rules, eventFingerprints: [...this.eventFingerprints] }));
      this.stateDirty = false;
      this.lastStateSaveAt = now;
    } catch {
      /* 落盘失败不影响评估主链路 */
    }
  }
}
