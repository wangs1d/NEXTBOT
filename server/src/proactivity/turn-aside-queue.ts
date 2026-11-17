// 顺嘴搭车队列（P1，2026-10-01）：low 级主动意图不再即时推送，
// 挂起等用户下一轮对话，以受控方式织进回复末尾（括号旁注形态，P2 定稿）。
//
// 动机：低打扰主动消息单独推一条气泡本身就打断（为一句轻关怀弹一条消息，
// 打扰成本 > 信息价值）；用户正在聊天时，「顺着当前回复末尾带一句」才是
// 低打扰的正确形态。队列只做挂起/限频/过期三件事，不做任何判断——
// 该不该说、怎么说由两端的既有闸门与主模型负责。
//
// 治理参数：
//   - TTL：挂起 2 小时无人接话——low 作废（低价值消息不值得隔夜补刀），
//     medium 升级回正常通道（超时升级，2026-10-01 扩面）：等不到搭车就自己弹，
//     不能因为用户没聊天就永远不说
//   - 同 kind 最小间隔 4 小时（同一类关怀一天最多顺嘴一次）
//   - 每 actor 队列上限 3 条（防堆积后一轮连塞多条）
//   - 每轮最多取 1 条（回复尾巴只挂一个旁注）
//
// TTL 收窄（2026-10-09）：6h → 2h。6 小时的挂起窗口让「昨晚的小事今天顺嘴提起」
// 成为常态——旁注不带时间锚时，模型会把旧事当此刻说（「刚才你说好饿」家族）。
// 缩短窗口 + 织入时带发生时间（见 formatTurnAsidePrompt），双管齐下。
//
// 仅内存态：低优先级挂起消息重启丢失可接受（少提一句无感知，
// 与 pending 确认/提醒等必达语义不同，不落盘）。
//
// 回滚开关：PROACTIVITY_TURN_ASIDE=0 全局关闭，两条挂起点（hub.speakFeedback /
// proactive-outreach-executor）回退为即时推送的旧行为；
// PROACTIVITY_TURN_ASIDE_MEDIUM=0 收窄回 low-only（扩面回滚开关）。
// PROACTIVITY_TURN_ASIDE_TTL_MIN=<分钟> 覆盖挂起 TTL。

/** 挂起条目 TTL 默认 2 小时（毫秒；可用 PROACTIVITY_TURN_ASIDE_TTL_MIN 覆盖） */
function resolveAsideTtlMs(): number {
  const raw = process.env.PROACTIVITY_TURN_ASIDE_TTL_MIN?.trim();
  const min = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(min) && min > 0) return min * 60_000;
  return 2 * 60 * 60_000;
}
const ASIDE_TTL_MS = resolveAsideTtlMs();
/** 同 kind 两次顺嘴投递的最小间隔（毫秒） */
const ASIDE_KIND_GAP_MS = 4 * 60 * 60_000;
/** 每 actor 挂起上限 */
const ASIDE_QUEUE_CAP = 3;
/** 过期扫描周期（medium 超时升级不能依赖用户恰好聊天触发 take） */
const ASIDE_SWEEP_MS = 5 * 60_000;

export type TurnAsideItem = {
  id: string;
  actorId: string;
  kind: string;
  title: string;
  /** 织入提示：给主模型的事实依据（来自意图 summary，确定性数据） */
  hint: string;
  /** 挂起前的重要度（medium 过期升级回正常通道；low 过期直接作废） */
  importance: "low" | "medium";
  /**
   * 所指向事件的绝对时刻（ms）。织入时按当前时钟现算"还剩/已过"，
   * 不在条目里缓存任何相对措辞（缓存就会在隔轮重放时失真）。
   */
  eventAt?: number;
  /** 共享发现层共同键（2026-10-19 二期）：取货织入时据此合并同主题发现 */
  subject?: string;
  createdAt: number;
  expiresAt: number;
};

/** 搭车通道全局开关（默认开；PROACTIVITY_TURN_ASIDE=0 回退即时推送旧行为） */
export function isTurnAsideEnabled(): boolean {
  const raw = process.env.PROACTIVITY_TURN_ASIDE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** medium 扩面开关（默认开；PROACTIVITY_TURN_ASIDE_MEDIUM=0 收窄回 low-only） */
export function isTurnAsideMediumEnabled(): boolean {
  const raw = process.env.PROACTIVITY_TURN_ASIDE_MEDIUM?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/**
 * 去掉旁注正文里"写下时算的倒计时"（「35 分钟后」「1 小时内开始」「还有半小时」）。
 *
 * 队列可挂 2 小时，倒计时离开生成时刻就失真；留着会被主模型当成此刻复述
 * （实证：18:45 复述 17:40 写入的「35 分钟后」→「现在还有半个多小时」）。
 * 只清分钟/小时级的相对倒计时，绝对时刻（18:15）与"N 天后"这类日期描述保留。
 */
function stripStaleCountdown(text: string): string {
  return text
    .replace(/(?:还有|还剩)\s*(?:\d+|半|一|两|几)\s*个?\s*(?:多)?\s*(?:分钟|小时)(?:左右)?/g, "")
    .replace(/\s*\d+\s*个?\s*(?:分钟|小时)\s*(?:后|内)(?:开始|出发)?/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 事件剩余/已过时长：用**织入这一刻**的 now 现算，是旁注里唯一可信的相对时间。
 * 无 eventAt 则零输出（不猜、不拿 createdAt 冒充事件时刻）。
 */
function eventDistanceLabel(eventAt: number | undefined, now: number): string {
  if (typeof eventAt !== "number" || !Number.isFinite(eventAt)) return "";
  const diff = eventAt - now;
  if (Math.abs(diff) < 60_000) return "（该事件就在此刻）";
  const totalMin = Math.round(Math.abs(diff) / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const span =
    hours > 0 ? `${hours} 小时${mins > 0 ? `${mins} 分钟` : ""}` : `${totalMin} 分钟`;
  return diff > 0 ? `（该事件还有约 ${span}）` : `（该事件已过约 ${span}）`;
}

/** 旁注形态定稿（P2）：块正文给主模型的织入指令与事实 */
export function formatTurnAsidePrompt(item: TurnAsideItem, now: number = Date.now()): string {
  const age = timerAgeLabel(item.createdAt, now);
  const body = stripStaleCountdown(item.hint) || stripStaleCountdown(item.title);
  const distance = eventDistanceLabel(item.eventAt, now);
  return [
    `【顺嘴机会】`,
    `（后台攒下的一件小事，发生于${age}。值得提就在回复末尾顺嘴一句，形态=括号旁注，如「（顺嘴一句：…）」，一句话即可；与本轮话题不搭就别提，绝不硬塞；若已时隔较久，须按当时的语境说、不要用「刚才/刚刚」；块内若有「N 分钟后/还有多久」这类倒计时，都是写下这条时的旧值，不得当作此刻，要提就按【当前时间】重新核对。）`,
    body,
    ...(distance ? [distance] : []),
  ].join("\n");
}

/** 相对年龄标签（分钟/小时，供旁注说明"发生于多久前"） */
function timerAgeLabel(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

let seq = 0;

export class TurnAsideQueue {
  private readonly queue = new Map<string, TurnAsideItem[]>();
  /** 最近一次实际织入（take 交付）的时间：actorId → kind → at */
  private readonly lastDelivered = new Map<string, Map<string, number>>();
  private readonly nowFn: () => number;
  /** medium 条目过期升级回调（装配层接 hub 重投正常通道） */
  private onExpire: ((item: TurnAsideItem) => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { nowFn?: () => number }) {
    this.nowFn = opts?.nowFn ?? Date.now;
  }

  /** 升级回调晚接线（队列先于 hub 构造；hub 就绪后再挂） */
  setOnExpire(fn: ((item: TurnAsideItem) => void) | null): void {
    this.onExpire = fn;
  }

  /**
   * 挂起一条 low/medium 主动意图。同 kind 已在挂起中、或距上次织入不足间隔时
   * 拒绝（返回 false，调用方回退原有即时推送路径——不静默吞消息）。
   */
  tryEnqueue(intent: {
    actorId: string;
    kind: string;
    title: string;
    summary?: string;
    /** 调用方可能传完整重要度联合（ProactiveIntent 直接透传）；仅 low/medium 落队列 */
    importance?: "low" | "medium" | "high" | "critical";
    /** 共享发现层共同键（ProactiveIntent 直接透传；取货织入时合并同主题发现） */
    subject?: string;
    /** 所指向事件的绝对时刻（有则织入时现算剩余/已过；无则不输出相对时间） */
    eventAt?: number;
  }): boolean {
    const now = this.nowFn();
    const list = this.queue.get(intent.actorId) ?? [];
    if (list.some((x) => x.kind === intent.kind)) return false;
    const last = this.lastDelivered.get(intent.actorId)?.get(intent.kind);
    if (last != null && now - last < ASIDE_KIND_GAP_MS) return false;
    list.unshift({
      id: `aside-${now.toString(36)}-${seq++}`,
      actorId: intent.actorId,
      kind: intent.kind,
      title: intent.title,
      hint: (intent.summary ?? "").slice(0, 160),
      importance: intent.importance === "medium" ? "medium" : "low",
      ...(intent.subject ? { subject: intent.subject } : {}),
      ...(typeof intent.eventAt === "number" && Number.isFinite(intent.eventAt)
        ? { eventAt: intent.eventAt }
        : {}),
      createdAt: now,
      expiresAt: now + ASIDE_TTL_MS,
    });
    if (list.length > ASIDE_QUEUE_CAP) list.length = ASIDE_QUEUE_CAP;
    this.queue.set(intent.actorId, list);
    this.ensureSweep();
    return true;
  }

  /**
   * 取一条织入本轮回复（每轮至多一条，取走即视为已交付——主模型是否真的
   * 顺嘴由它自行裁量，队列不校验文本）。无可用条目返回 null。
   */
  takeForTurn(actorId: string): TurnAsideItem | null {
    const now = this.nowFn();
    const list = this.queue.get(actorId);
    if (!list || list.length === 0) return null;
    // 越靠前越新，取第一条未过期的；过期的就地出队（medium 走升级回调）
    while (list.length > 0) {
      const item = list.shift()!;
      if (now > item.expiresAt) {
        this.expireItem(item);
        continue;
      }
      const byKind = this.lastDelivered.get(actorId) ?? new Map<string, number>();
      byKind.set(item.kind, now);
      this.lastDelivered.set(actorId, byKind);
      return item;
    }
    return null;
  }

  /** 诊断用：仍挂起的条目（过期未清理的也算，展示原始队列） */
  pending(actorId?: string): TurnAsideItem[] {
    if (actorId) return [...(this.queue.get(actorId) ?? [])];
    return [...this.queue.values()].flat();
  }

  /** 清理全部过期条目（诊断/测试用；low 丢弃、medium 升级回调） */
  prune(): number {
    const now = this.nowFn();
    const expired: TurnAsideItem[] = [];
    for (const [actorId, list] of this.queue) {
      const kept = list.filter((x) => {
        if (now <= x.expiresAt) return true;
        expired.push(x);
        return false;
      });
      if (kept.length === 0) this.queue.delete(actorId);
      else this.queue.set(actorId, kept);
    }
    for (const item of expired) this.expireItem(item);
    return expired.length;
  }

  /** 停机/测试：停掉过期扫描定时器 */
  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** 过期收口：low 静默作废（原语义），medium 交升级回调（超时升级） */
  private expireItem(item: TurnAsideItem): void {
    if (item.importance !== "medium" || !this.onExpire) return;
    try {
      this.onExpire(item);
    } catch (err) {
      console.log(`[TurnAsideQueue] 过期升级回调失败（忽略）kind=${item.kind}: ${err}`);
    }
  }

  /** 首次入队后启动过期扫描（medium 升级不能依赖用户恰好触发 take） */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.prune();
      } catch (err) {
        console.log(`[TurnAsideQueue] 过期扫描失败（忽略）: ${err}`);
      }
    }, ASIDE_SWEEP_MS);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }
}
