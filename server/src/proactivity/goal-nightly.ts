/**
 * GoalNightlyJob —— 目标夜间日批（L3）的调度与开口（2026-10-19）。
 *
 * 补的是哪一环：内省引擎（goal-introspector.ts）早就写好了，但只有 HTTP 查询
 * 在读它——没人排期，于是闲置衰减 / 过期 / 语义复核的副作用在生产**从不发生**。
 * 本模块只干两件事：到点在夜里跑一遍；把 finding 交给主动性出口开口。
 *
 * 纪律：
 *  - 出口只用注入的 emit（装配层接 proactivityHub.submitIntent），频控 / 静默
 *    时段 / 负反馈抑制由那条管道统一处理，这里不新增闸门。
 *  - 按天去重：同一进程内一天只跑一次（跨进程重启的小窗口由内省器自身的
 *    冷却戳兜住，重复跑不会重复开口）。
 *  - single-flight：上一轮没跑完不叠下一轮。
 *  - GOAL_NIGHTLY=0 一键关闭。
 */
import { dayKeyOf } from "./goal-board.js";
import type { GoalIntrospector, IntrospectFinding } from "./goal-introspector.js";
import type { ProactiveIntent, ProactiveIntentKind } from "./proactivity-types.js";
import type { ExternalChatProvider } from "../external-model/types.js";

/** 每晚执行时刻（本地时，默认 3 点） */
const DEFAULT_HOUR_OF_DAY = 3;
/** 轮询步长：每 10 分钟看一眼到点没有 */
const TICK_MS = 10 * 60_000;

export type GoalNightlyProposal = {
  actorId: string;
  kind: ProactiveIntentKind;
  importance: "low" | "medium" | "high";
  title: string;
  summary: string;
  source: NonNullable<ProactiveIntent["source"]>;
};

export type GoalNightlyDeps = {
  introspector: GoalIntrospector;
  /** 登记过的 actor（装配层用 proactivityHub.exportActors） */
  listActors: () => string[];
  /** 开口出口（装配层接 proactivityHub.submitIntent；fire-and-forget） */
  emit: (proposal: GoalNightlyProposal) => void;
  nowFn?: () => number;
  hourOfDay?: number;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
};

export type GoalNightlyRunReport = { actors: number; findings: number; delivered: number };

/** 各动作的开口标题（kind 统一走 life_reminder，标题只影响台账可读性） */
const ACTION_TITLE: Record<string, string> = {
  ask_stale: "在办目标还作数吗",
  suggest_replan: "在办目标换个走法",
  expire: "在办目标已停掉",
  verified_met: "在办目标其实办成了",
};

/** 各动作的开口重要度（作废只是归档，不需要抢注意力） */
const ACTION_IMPORTANCE: Record<string, "low" | "medium" | "high"> = {
  ask_stale: "medium",
  suggest_replan: "medium",
  expire: "low",
  verified_met: "medium",
};

/** 每晚执行时刻读取：GOAL_NIGHTLY_HOUR（0-23，本地时）覆盖默认 */
function readHourOfDay(env: Record<string, string | undefined>): number | null {
  const raw = env.GOAL_NIGHTLY_HOUR?.trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
}

export class GoalNightlyJob {
  private readonly nowFn: () => number;
  private readonly hourOfDay: number;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDayKey = "";
  private running = false;
  private lastReport: GoalNightlyRunReport | null = null;

  constructor(private readonly deps: GoalNightlyDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.env = deps.env ?? process.env;
    this.hourOfDay = deps.hourOfDay ?? readHourOfDay(this.env) ?? DEFAULT_HOUR_OF_DAY;
    this.log = deps.log ?? ((m) => console.log(`[GoalNightly] ${m}`));
  }

  enabled(): boolean {
    return this.env.GOAL_NIGHTLY !== "0";
  }

  /**
   * 到点判定（可测）：本地时等于 hourOfDay 且今天还没跑过 → 起一轮。
   * @returns 本轮是否触发
   */
  maybeRun(now = this.nowFn()): boolean {
    if (!this.enabled()) return false;
    if (new Date(now).getHours() !== this.hourOfDay) return false;
    const key = dayKeyOf(now);
    if (key === this.lastDayKey) return false;
    this.lastDayKey = key;
    void this.runOnce(`夜间日批 ${key}`);
    return true;
  }

  /** 跑一轮：逐 actor 内省 → 需要开口的转提案 */
  async runOnce(reason = "夜间日批"): Promise<GoalNightlyRunReport> {
    if (!this.enabled()) return { actors: 0, findings: 0, delivered: 0 };
    if (this.running) return this.lastReport ?? { actors: 0, findings: 0, delivered: 0 };
    this.running = true;
    let actors = 0;
    let findings = 0;
    let delivered = 0;
    try {
      for (const actorId of this.deps.listActors()) {
        actors += 1;
        let list: IntrospectFinding[] = [];
        try {
          list = await this.deps.introspector.runNightlyForActor(actorId);
        } catch (err) {
          // 单个 actor 失败不拖垮整晚（与夜间任务既有纪律一致）
          this.log(`内省失败（跳过该 actor）: ${actorId} ${err}`);
          continue;
        }
        findings += list.length;
        for (const f of list) {
          if (!f.message || f.action === "decay") continue;
          this.deps.emit({
            actorId,
            kind: "life_reminder",
            importance: ACTION_IMPORTANCE[f.action] ?? "medium",
            title: ACTION_TITLE[f.action] ?? "在办目标回顾",
            summary: f.message,
            source: "goal_introspect",
          });
          delivered += 1;
        }
      }
      this.lastReport = { actors, findings, delivered };
      this.log(`${reason}完成：${actors} 个 actor / ${findings} 条 finding / ${delivered} 条开口`);
      return this.lastReport;
    } finally {
      this.running = false;
    }
  }

  /** 起调度（进程内一天一次；unref 不阻止进程退出） */
  start(): void {
    if (this.timer) return;
    if (!this.enabled()) {
      this.log("已按 GOAL_NIGHTLY=0 关闭");
      return;
    }
    this.timer = setInterval(() => this.maybeRun(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.log(`已启动：每晚 ${this.hourOfDay}:00 内省在办目标`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  status(): { enabled: boolean; hourOfDay: number; lastDayKey: string; lastReport: GoalNightlyRunReport | null } {
    return { enabled: this.enabled(), hourOfDay: this.hourOfDay, lastDayKey: this.lastDayKey, lastReport: this.lastReport };
  }
}

/**
 * 语义验收器工厂（装配层用）：一次 flash 补全 → 一行 JSON 结论。
 *
 * 纪律：只做**终审**（每夜 ≤5 个），失败/解析不出/模型不可用 → null，
 * 由 goal-verifier 回落到确定性结论——验收器故障绝不把办成的事判死。
 */
export function createGoalSemanticVerifier(chat: ExternalChatProvider): (input: {
  title: string;
  successCriteria?: string;
  steps: Array<{ title: string; status: string; note?: string }>;
}) => Promise<{ verdict: "met" | "partial" | "failed"; note: string } | null> {
  return async (input) => {
    if (!chat?.isEnabled?.()) return null;
    const prompt = [
      "你是目标验收员。判断下面这个生活目标有没有真正达成，只输出一行 JSON，不要解释。",
      `目标：${input.title}`,
      `达成判据：${input.successCriteria ?? "（未给出，按目标本身理解）"}`,
      "执行记录：",
      ...input.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.note ? `（${s.note}）` : ""}`),
      '严格输出 JSON：{"verdict":"met|partial|failed","note":"一句中文理由"}',
      "判据：达成的实质证据齐全才判 met；只做了一部分判 partial；基本没办成判 failed。",
    ].join("\n");
    try {
      let full = "";
      await chat.streamCompletion(
        `goal-verify-${Date.now()}`,
        { text: prompt },
        (delta: string) => {
          full += delta;
        },
        undefined,
        {
          systemPromptOverride: prompt,
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 0,
        },
      );
      return parseVerdict(full);
    } catch {
      return null;
    }
  };
}

/** 从模型输出里抠出验收 JSON（宽容：允许前后有废话/代码块围栏） */
function parseVerdict(raw: string): { verdict: "met" | "partial" | "failed"; note: string } | null {
  const m = /\{[\s\S]*?\}/.exec(raw ?? "");
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { verdict?: unknown; note?: unknown };
    const verdict = parsed.verdict;
    if (verdict !== "met" && verdict !== "partial" && verdict !== "failed") return null;
    const note = typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim().slice(0, 200) : "语义终审结论";
    return { verdict, note };
  } catch {
    return null;
  }
}
