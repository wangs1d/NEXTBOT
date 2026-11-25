// 统一主动性管道（ProactivePipeline）—— docs/proactivity-architecture.md 的 L1→L5 落地。
// 唯一入口 submitProposal：去重 → 仲裁（纯规则零 LLM）→ 投递（在线 WS / 离线 MessageHub）
// → 结果反馈（outcome 回灌自适应冷却）。周期 flush 推进延迟提案并落盘。
// 与 ProactivityHub 分工：本管道承接确定性提案源（日程/提醒/预警等 must 层）；
// legacy 出站路径（ProactiveOutboundMessageService）已收敛为提案源（2026-09-05），
// hub 快路径（对话/问候/兴趣等 social 层）仍走 LifeSignalHub→ProactionCortex 直发
// （分段拟人节奏），投递层已统一到 DeliveryService。
import { arbitrate, DELIVERY_RETRY_MS, IN_CONVERSATION_WINDOW_MS, type ArbiterContext } from "./arbiter.js";
import type { ProactiveDeliveryService } from "./delivery-service.js";
import { readJson, writeJson } from "./persist-file.js";
import type { ArbitrationDecision, ProactiveImportance, ProactiveOutcome, ProactiveProposal, ProposalVerdict } from "./pipeline-types.js";
import { normalizeSurface, OutcomeStore } from "./outcome-store.js";
import type { PresenceService } from "./presence-service.js";
import { ProposalStore } from "./proposal-store.js";
import { SilenceLog } from "./silence-log.js";
import { CONFIRMATION_TTL_MS, type PendingConfirmation, PendingConfirmationStore } from "./pending-confirmation-store.js";
import { topicKeyOfProposal, TopicDismissTracker } from "./topic-dismiss-tracker.js";
import { primarySubjectOf, type DiscoveryLayer, type OpenedBody } from "./discovery-layer.js";
import { registerIntentForProposal } from "./notification-actions.js";
import { explainTiming } from "./explain.js";
import type { TouchpointPlan, TouchpointPlanner } from "./touchpoint-planner.js";
import { emitHook } from "../services/hooks/index.js";
import { getTurnWalService, type TurnWalEntry } from "../services/turn-wal-service.js";

export type ProactivePipelineDeps = {
  /** 数据目录（默认 data/proactivity）：proposals.json / frequency.json / known-actors.json */
  dataPath: string;
  governor: import("./frequency-governor.js").FrequencyGovernor;
  suppression: {
    isSuppressed(actorId: string, kind: string, text?: string): { suppressed: boolean; reason: string };
  };
  presence: PresenceService;
  /**
   * 最近一次"对话"时刻（对话驱动，非设备活跃）：判定「对话进行中」用。
   * 未注入时退回 presence.lastActivityAt（设备活跃驱动，桌面同步频繁刷新时
   * 会把"用户在电脑前"误判成"对话中"，导致社交提案被 90s 一轮无限顺延）。
   */
  lastConversationAt?: (actorId: string) => number | null;
  delivery: ProactiveDeliveryService;
  outcomes: OutcomeStore;
  /** 无 directText 提案的 speak 兜底（装配层接线 hub.submitIntent；直达车道
   *  常开时渲染模板零 LLM，仅 PROACTIVITY_DIRECT_LANE=0 回退 ProactionCortex 闭环才花 LLM） */
  speak?: (p: ProactiveProposal) => void;
  flushIntervalMs?: number;
  /** known actor 持久化（重启恢复主动性资格，hub 状态的存取薄包装） */
  exportActors?: () => Array<{ actorId: string; lastInteractionAt: number }>;
  restoreActors?: (entries: Array<{ actorId: string; lastInteractionAt: number }>) => void;
  /** 可注入时钟（测试确定性；默认 Date.now） */
  nowFn?: () => number;
  /**
   * 移动端推送通道（离线唯一提醒出口，2026-11-23 定调）：两端都不在线时，
   * **所有 tier** 的提案一律改走手机系统推送（App 被杀也能收到）。未注入 =
   * 通道禁用，离线一律挂起待重连（重连后直推进对话流），不再落站内信。
   */
  mobilePush?: import("./mobile-push-service.js").MobilePushChannel;
  /**
   * 离线推送成功后的对话留底（2026-11-25 用户拍板）：把推送正文落成主会话
   * 轮次（userText 空 + assistantText），打开 App 拉历史时对话里能看到同一条。
   * 未注入 = 写 turn WAL；测试注入捕获器，避免动真实数据目录。
   */
  transcriptAppend?: (entry: TurnWalEntry) => Promise<void> | void;
  /**
   * 动作意图服务（2026-11-13「通知即界面」）：离线推送路径也要签发动作意图——
   * 厂商通道渲染不出按钮，但点开通知能进 App 处理这个决策。
   */
  actionIntents?: import("./action-intent-service.js").ActionIntentService | null;
  /**
   * 沉默日志（方案 B）：verdict=silenced 的效用评估留痕，支持
   * 「你上周为什么没提醒我 XX」反问检索。未注入时管道内建一份
   * （与 hub 共享同一实例由装配层注入，这里只兜底）。
   */
  silenceLog?: SilenceLog;
  /**
   * 挂起确认存储（与 hub 共享同一实例）：ask_first 且带 confirmAction 的提案
   * 投递确认文案后在此登记，批准经 hub resolver 回流到 onProposalApproved。
   */
  confirmations?: PendingConfirmationStore;
  /** 提案级确认的批准动作（装配层定义：如承诺代催的落地行为 + 助手动态留痕） */
  onProposalApproved?: (p: ProactiveProposal) => void;
  /** 分级触达钩子：提案级 ask_first 登记后回调（装配层经 ReachRouter 投递+升级） */
  onPendingConfirmation?: (entry: PendingConfirmation) => void;
  /**
   * critical 提案升级钩子（已闲置，2026-11-05 升级链斩断：装配层不再注入）。
   * 保留可选接口位仅作兼容，当前无任何调用方注入；电话仅保留为
   * intelligent-reminder 的显式 initialLevel。
   */
  escalate?: (p: ProactiveProposal, deliveryId: string) => void;
  /**
   * 话题级 dismiss 追踪（2026-10-01）：同话题连续 dismiss 达阈值时投一条
   * 「要不要少提这类」建议（不自动静音，静音仍走用户明说的抑制表）。
   * 未注入 = 无话题维度学习。
   */
  topicDismiss?: TopicDismissTracker;
  /**
   * 共享发现层（2026-10-19）：本管道是**所有**触发源的共同底（文档自述"任何触发源只调这
   * 一个方法"），所以"发现怎么汇总、开口前读什么"的唯一收口放在这里——write 登记本次发现
   * → composeBeforeOpen 读合成（同 subject 未消费的他人发现 + 实体命中上下文）→ noteSpoken
   * 按 verdict 决定是否消费。未注入 = 退化为原行为（既有单测不受影响）。
   */
  discovery?: DiscoveryLayer;
  /**
   * 社交提案的期望效用择时（ReachDecisionService.decide 的薄包装，2026-11-19）：
   * 让「用户是不是正忙、这类消息他还愿不愿意看」进入投递前的最后一道判断，
   * 而不只是靠静默/对话中/离线三个粗维度。
   *
   * 只在 verdict=delivered 且 tier=social 时调用；返回 null = 放行。
   * drop 转 silenced（留痕可解释），defer/batch 转 deferred（等 pause 再投）。
   * 装配层用 PROACTIVITY_REACH_GATE=0 一键关。
   */
  reachGate?: (p: ProactiveProposal) => {
    action: "send_now" | "defer" | "batch" | "drop";
    reason: string;
  } | null;
  /**
   * 每日触点计划（2026-11-23 §3.4）：非紧急候选先排槽，到点合并说。
   *
   * 未注入 = 完全维持旧的即时通道行为（老装配/测试可单独跑）。注入后本字段是
   * **唯一的排槽点**：不能同时让某个触发源自己算「几点发」，否则同一个 slot 里
   * 会出现两套时刻口径，合并也就无从谈起。
   */
  planner?: TouchpointPlanner | null;
  /**
   * 「多聊点」档判据（§3.10）：为真时 AgentPulse 不等触点即时开口。
   * 未注入 = 全员按正常档排槽（不改变现有行为）。
   */
  pulseImmediate?: (actorId: string) => boolean;
};

/** 正反馈 outcome 集合（自适应冷却的方向判定） */
const POSITIVE = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);

/** reachGate 判「时机不对」后的重判间隔（等用户从专注里出来，不急着立刻再问） */
const REACH_GATE_RETRY_MS = 20 * 60_000;
/** 同一提案最多被 reachGate 延后几次（防「永远等时机」把消息饿死） */
const REACH_MAX_DEFERS = 4;

/** 手机通话中 / 勿扰时非必达提案的重判间隔（2026-11-23 M1） */
const PHONE_QUIET_RETRY_MS = 10 * 60_000;

/** 未回复自动结算窗口：social 消息发出后这么久没有任何对话，按「忽略」记负样本 */
const UNANSWERED_WINDOW_MS = 6 * 60 * 60_000;
/** 自动结算扫描间隔（避免每 30s flush 都遍历一遍 outcomes） */
const UNANSWERED_SWEEP_MS = 30 * 60_000;

/** 同触点合并时的排序权重：重要的先说（critical 排最前） */
const IMPORTANCE_RANK: Record<ProactiveImportance, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

/** 裁决后已彻底离开待发区的去向（不再重试）：槽位据此把候选退回/标记已说 */
const VERDICTS_OUT_OF_QUEUE: ReadonlySet<ProposalVerdict> = new Set<ProposalVerdict>([
  "delivered", "suppressed", "silenced", "expired", "dropped", "merged",
]);

/**
 * 离线推送失败的有界重试（2026-11-25 用户拍板）：一次失败就丢会把大量主动消息
 * 吞掉——推送偶尔 5xx/超时并不代表内容过期。失败留在待发区按退避重试，
 * 总时限按内容时效封顶（提案自带 expiresAt 优先），过了就如实丢并留痕。
 */
const PUSH_RETRY_BACKOFF_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
const PUSH_RETRY_MAX_ATTEMPTS = 8;
/** 无 expiresAt 时的重试总时限：必达类 6h、社交类 2h（内容时效是消息价值的一部分） */
const PUSH_RETRY_WINDOW_MUST_MS = 6 * 60 * 60_000;
const PUSH_RETRY_WINDOW_SOCIAL_MS = 2 * 60 * 60_000;
/** 华为 token 失效：重试同一个死 token 没有意义，直接丢，等客户端重注册 */
const PUSH_DEAD_TOKEN_HINT = "80300002";

/**
 * 同触点多条候选 → 一条正文（§3.4 步骤 2）。
 *
 * 正文取各条已渲染好的话术（directText 优先，退回 summary）逐行拼接：合并是
 * 「一次开口说完几件事」，不是「让 LLM 把几件事改写成一段」——前者零成本，
 * 且不会把提醒的原文改写成不像提醒的话。按钮/详情跟随主提案（一次开口只承载
 * 一组拍板项，MAX_NOTIFY_ACTIONS 本来也只放得下两个）。
 */
function mergeIntoSlotText(
  host: ProactiveProposal,
  rest: ProactiveProposal[],
): ProactiveProposal {
  const bodyOf = (p: ProactiveProposal): string => String(p.directText ?? p.summary ?? "").trim();
  const lines = [host, ...rest].map(bodyOf).filter((t) => t.length > 0);
  const fingerprints = [...new Set([host, ...rest].flatMap((p) => p.findingFingerprints ?? []))];
  const summary = lines.join("\n") || host.summary;
  return {
    ...host,
    summary,
    ...(host.directText !== undefined ? { directText: summary } : {}),
    evidence: [...host.evidence, ...rest.flatMap((p) => p.evidence)],
    findingFingerprints: fingerprints.length > 0 ? fingerprints : undefined,
  };
}

export class ProactivePipeline {
  private readonly store: ProposalStore;
  private readonly silenceLog: SilenceLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private pushSeq = 0;
  /** dedupKey → 被 reachGate 延后的次数（防「永远等时机」饿死消息） */
  private readonly reachDefers = new Map<string, number>();
  /**
   * dedupKey → 离线推送已失败次数（有界重试账本，2026-11-25）。
   * 进程内即可：即使重启清零，总时限仍由 createdAt + 窗口兜底，不会无限重试。
   */
  private readonly pushRetries = new Map<string, number>();
  /** 上次未回复结算扫描时刻（UNANSWERED_SWEEP_MS 节流） */
  private lastUnansweredSweepAt = 0;

  constructor(private readonly deps: ProactivePipelineDeps) {
    this.store = new ProposalStore(`${deps.dataPath}/proposals.json`);
    this.silenceLog = deps.silenceLog ?? new SilenceLog(`${deps.dataPath}/silence-log.json`);
    this.flushIntervalMs = deps.flushIntervalMs ?? 30_000;
    // 重启恢复：频控状态（预算/冷却）+ 已知 actor —— 否则重启后 agent 永不主动
    const govSnapshot = readJson<import("./frequency-governor.js").GovernorSnapshot | null>(
      `${deps.dataPath}/frequency.json`,
      null,
    );
    if (govSnapshot) this.deps.governor.restore(govSnapshot);
    const actors = readJson<Array<{ actorId: string; lastInteractionAt: number }>>(
      `${deps.dataPath}/known-actors.json`,
      [],
    );
    if (actors.length) this.deps.restoreActors?.(actors);
  }

  /**
   * 投递出口（2026-11-29 §4.3）：通知栏回复的应答要复用同一个出站三件套
   * （WS 直投 / 落流补发 / 横幅归属），但**不能**走 submitProposal→仲裁——
   * 那会把给用户回话当成一次主动打扰而被频控闸掉。装配层经此取用。
   */
  get deliveryService(): ProactiveDeliveryService {
    return this.deps.delivery;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.flushDue();
        this.persist();
      } catch (err) {
        console.log(`[ProactivePipeline] flush 失败（忽略）: ${err}`);
      }
    }, this.flushIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushDue();
    this.persist();
  }

  /** 统一入口：任何触发源只调这一个方法（fire-and-forget，绝不阻塞调用方） */
  submitProposal(p: ProactiveProposal): ArbitrationDecision {
    const now = this.deps.nowFn?.() ?? Date.now();
    // ─── 共享发现层收口（2026-10-19）───
    // 所有触发源（邮件/日历/目标/承诺/提醒/早报/承诺代催…）都汇到这一个方法，所以"发现
    // 怎么汇总、开口前读什么"只在这里发生一次：先把本次发现登记进总线，再读合成（同
    // subject 可读的他人发现 + 实体命中上下文），零 LLM 拼进正文；重复开口的等级降一档。
    // 读走的发现在开口瞬间就被**预留**（第二个出口读不到，杜绝各说一遍），但预留≠消费：
    // decide 依提案最终去向结算——delivered 才转消费，deferred 维持预留（等真投递），
    // 被去重/抑制/丢弃则释放回总线。这是"之后的信息都走共享层"的结构性保证，而不是让
    // N 个生产者各自打补丁。
    let proposal = p;
    if (this.deps.discovery) {
      const subject = (p.subject ?? primarySubjectOf(`${p.title} ${p.summary}`) ?? "").trim();
      if (p.directText !== undefined) {
        // 唯一开口入口：登记本次发现 + 读合成（读走即预留），返回 branded 正文与结算句柄。
        // handle.body 是 OpenedBody，投递出口只认它——管道是唯一被授权把正文说出去的地方。
        const handle = this.deps.discovery.openMouth({
          subject,
          actorId: p.actorId,
          source: p.source,
          content: p.summary,
          body: p.directText,
          importance: p.importance,
          needsUser: p.needsUser === true,
        });
        proposal = {
          ...p,
          directText: handle.body,
          importance: handle.importance,
          // 读走的 finding 随提案带上：decide 依最终去向结算（消费/维持预留/释放）
          ...(handle.fingerprints.length ? { findingFingerprints: [...handle.fingerprints] } : {}),
        };
      } else {
        // 无 directText 的提案走 hub 的 speak 闭环（LLM 话术），本次不在管道读合成——
        // 发现留在总线上，由那句真正带正文的开口合并带走；这里只按重复状态调等级。
        this.deps.discovery.write({ subject, actorId: p.actorId, source: p.source, content: p.summary });
        const preview = this.deps.discovery.previewOpen(subject, p.importance, p.needsUser === true);
        proposal = { ...p, importance: preview.importance };
      }
    }
    // ─── 触点排槽（2026-11-23 §3.4）───
    // 排槽发生在入队之前：slot 的时刻靠 deliverAfter 表达，到点由既有 30s flush 触发，
    // 计划层因此不需要任何自己的定时器（文档硬约束：不新增轮询器）。
    proposal = this.applySlotPlan(proposal, now);
    if (this.store.wasDeliveredRecently(proposal.dedupKey, now) || !this.store.enqueue(proposal)) {
      // 被去重丢弃 / 入队失败：用户没看到这条，读走的发现释放回总线（信息不蒸发）
      if (this.deps.discovery && proposal.findingFingerprints?.length) {
        this.deps.discovery.settle(proposal.findingFingerprints, "dropped");
      }
      // 槽位里也不留它：排槽登记过的候选要退回去，否则容量与「这个 slot 到底有没有
      // 东西」都会算错（空槽本该 skipped，却被幽灵候选顶成待投递）
      if (proposal.slotId) this.deps.planner?.releaseCandidate(proposal.dedupKey);
      const merged: ArbitrationDecision = {
        proposal,
        verdict: "merged",
        reasonChain: [`dedup:${proposal.dedupKey}`],
      };
      this.store.logDecision(merged);
      return merged;
    }
    // decide 内部按提案最终去向结算预留（delivered=消费 / pending=维持预留 / dropped=释放）
    return this.decide(proposal);
  }

  /**
   * 排槽（§3.4 步骤 1）。排不进槽（无落点）与排槽异常都按即时通道放行——
   * 「计划层没想好」不是把用户的消息吞掉的正当理由：晚说一步可接受，漏说才发现。
   */
  private applySlotPlan(p: ProactiveProposal, now: number): ProactiveProposal {
    const planner = this.deps.planner;
    if (!planner || p.slotId) return p;
    try {
      // §3.10「多聊点」档：AgentPulse 不等触点，想到就说（其余档仍排槽，安静档/正常档
      // 的差别由预算与槽数承担）
      const chattyPulse = p.kind === "agent_pulse" && this.deps.pulseImmediate?.(p.actorId) === true;
      const at = planner.assign(
        p.actorId,
        p,
        now,
        chattyPulse ? { immediate: true, reason: "tier_chatty_pulse" } : undefined,
      );
      if (at.kind !== "slot") return p;
      return {
        ...p,
        slotId: at.slot.slotId,
        deliverAfter: Math.max(p.deliverAfter ?? 0, at.slot.windowStart),
      };
    } catch (err) {
      console.log(`[ProactivePipeline] 排槽异常（按即时通道放行）kind=${p.kind}: ${err}`);
      return p;
    }
  }

  /** 推进到期延迟提案（deferred/offline 挂起的在在场变化后重仲裁；at 可注入推进时钟） */
  flushDue(now = Date.now()): void {
    // 运行期僵尸清理（2026-11-12）：启动清理只覆盖重启，长驻进程内 defer-forever
    // 的挂起提案靠这里每轮兜底（48h 超龄 + 无 firedAt 才丢，补推提案豁免）。
    this.store.pruneStale(now);
    // 未回复结算（2026-11-19）：social 消息发出后长期无声 → 记「忽略」负样本，
    // 让 noteOutcome 的自适应冷却真的学到「这类话他不看」。忽略是主要负样本。
    this.sweepUnanswered(now);
    // 槽位生命周期推进（§3.4）：到点开槽，窗口走完还空着就 skipped——
    // 空槽是合法结果，不是需要补的欠账。
    try {
      this.deps.planner?.sweep(now);
    } catch { /* 计划层异常不阻断投递 */ }
    const bySlot = new Map<string, ProactiveProposal[]>();
    const immediate: ProactiveProposal[] = [];
    for (const p of this.store.listPending()) {
      if ((p.deliverAfter ?? 0) > now) continue;
      if (!p.slotId) {
        immediate.push(p);
        continue;
      }
      const list = bySlot.get(p.slotId) ?? [];
      list.push(p);
      bySlot.set(p.slotId, list);
    }
    for (const p of immediate) this.decide(p, now);
    // 同触点候选一次说完（§3.4 步骤 2）：攒了几条就一次开口，而不是连着弹三条
    // 通知——「合并成一条」是触点计划这个特性的存在理由。
    for (const [slotId, group] of bySlot) this.flushSlot(slotId, group, now);
  }

  /**
   * 一个触点槽到点：单条走正常裁决链，多条拼成一条正文再走。
   * 合并只拼接现成话术、不叫 LLM 重写——素材本来就是写好的话，且每次开口仍只
   * 过一次 speak/render，条数增多不会把成本线性拉起来（PRD §14 风险表）。
   */
  private flushSlot(slotId: string, group: ProactiveProposal[], now: number): void {
    const planner = this.deps.planner;
    planner?.markOpen(slotId, now);
    const host = [...group].sort(
      (a, b) =>
        (IMPORTANCE_RANK[a.importance] ?? 9) - (IMPORTANCE_RANK[b.importance] ?? 9) ||
        a.createdAt - b.createdAt,
    );
    const first = host[0];
    if (!first) return;
    // 槽的触发条件还没成立（早安 = 当天首次解锁，§3.4）：本轮不说，候选原地留着，
    // 下一轮 flush 再看——不新增定时器，也不因为"到点了"就硬播。
    if (!this.slotTriggerFired(slotId, first.actorId, now)) return;
    const rest = host.slice(1);
    if (rest.length === 0) {
      this.settleSlot(slotId, first, this.decide(first, now), now);
      return;
    }
    // 被合并的候选先出队并记指纹：内容随正文一起说了，但 dedupKey 不是 host 的，
    // 不取出来下一轮 flush 会把它们当未投递再各弹一次。
    for (const r of rest) {
      this.store.take(r.dedupKey);
      this.store.markDelivered(r.dedupKey, now);
      this.store.logDecision({
        proposal: r,
        verdict: "merged",
        reasonChain: [`slot:${slotId} 同触点合并 → ${first.dedupKey}`],
      });
    }
    const merged = mergeIntoSlotText(first, rest);
    this.settleSlot(slotId, merged, this.decide(merged, now), now);
  }

  /**
   * 槽的触发条件是否成立。目前只有 `first_unlock`（早安）需要判：
   * 手机状态拿得到却还没解锁 → 不播；从来没有手机状态（纯桌面用户、状态过期）→
   * 不拦，否则早安对这部分用户永远消失（§3.4 改的是时机，不是取消播报）。
   */
  private slotTriggerFired(slotId: string, actorId: string, now: number): boolean {
    const slot = this.deps.planner?.slotOf(slotId);
    if (!slot || slot.trigger !== "first_unlock") return true;
    const presence = this.deps.presence;
    if (!presence.hasPhoneSignal(actorId, now)) return true;
    return presence.firstUnlockToday(actorId, now) !== null;
  }

  /**
   * 槽位去向跟随裁决结果：只有真发出去了才算这个触点用过（sent）；被用户规则
   * 丢掉就退回候选（不谎报已说）；被仲裁挂起/限流则原样留在槽里，下一轮再试。
   */
  private settleSlot(slotId: string, p: ProactiveProposal, d: ArbitrationDecision, now: number): void {
    const planner = this.deps.planner;
    if (d.verdict === "delivered") planner?.markSent(slotId, now);
    else if (VERDICTS_OUT_OF_QUEUE.has(d.verdict)) planner?.releaseCandidate(p.dedupKey);
  }

  /**
   * 未回复自动结算：delivered 的 social 提案，超过窗口仍没有任何对话 → ignored；
   * 期间用户说过话 → replied（宽松判定：主动消息通常就是引子，用户接着说话即算接住）。
   *
   * 只处理 tier=social：must 是用户点名要的事，处理完没回话不该被当成忽略。
   * 这是客户端没上报反馈时唯一的学习信号，否则 agent 永远不知道自己烦不烦人。
   */
  sweepUnanswered(now = Date.now()): number {
    if (now - this.lastUnansweredSweepAt < UNANSWERED_SWEEP_MS) return 0;
    this.lastUnansweredSweepAt = now;
    let settled = 0;
    for (const r of this.deps.outcomes.recent(200)) {
      if (r.outcome !== "delivered") continue;
      if (r.tier !== "social") continue;
      if (now - r.at < UNANSWERED_WINDOW_MS) continue;
      const lastConv = this.deps.lastConversationAt?.(r.actorId) ?? null;
      const replied = lastConv !== null && lastConv > r.at;
      this.deps.outcomes.record({ ...r, outcome: replied ? "replied" : "ignored", at: now });
      this.deps.governor.noteOutcome(r.kind, replied);
      settled += 1;
      console.log(
        `[ProactivePipeline] 未回复结算 kind=${r.kind} actor=${r.actorId} → ${replied ? "replied" : "ignored"}`,
      );
    }
    return settled;
  }

  /** 客户端回传触达结果 → 落库 + 自适应冷却（负反馈即时惩罚；接受率>0.6 回升） */
  /**
   * 记录一次触达结果。meta.surface 标明用户是在哪个面上做的决定
   * （notification / chat / widget / dynamics / desktop / action_intent），只进 hook 载荷做归因，
   * 不影响频控语义。
   */
  recordOutcome(
    deliveryId: string,
    outcome: ProactiveOutcome,
    meta?: { surface?: string; ref?: string },
  ): boolean {
    const prev = this.deps.outcomes.findByDeliveryId(deliveryId);
    if (!prev) return false;
    const at = Date.now();
    const surface = normalizeSurface(meta?.surface);
    this.deps.outcomes.record({
      ...prev,
      outcome,
      at,
      // 面归因（§4.6/§12.2 漏斗）只认第一次表态来自哪个面，后续补记不覆盖；
      // latencyMs = 送达→表态，§12.1 客户端事件同名口径
      ...(surface && !prev.surface ? { surface } : {}),
      ...(prev.createdAt ? { latencyMs: Math.max(0, at - prev.createdAt) } : {}),
    });
    // 统一回灌出口（2026-11-23 M1）：落库即发 hook，下游 subscribeType("proactive.outcome") 接入。
    // emitHook 内部不抛、订阅者异步执行，不会拖慢或打断这里的频控更新。
    emitHook(
      "proactive.outcome",
      {
        deliveryId,
        kind: prev.kind,
        outcome,
        channel: prev.channel,
        ...(prev.tier ? { tier: prev.tier } : {}),
        ...(prev.topic ? { topic: prev.topic } : {}),
        ...(meta?.surface ? { surface: meta.surface } : {}),
        ...(meta?.ref ? { ref: meta.ref } : {}),
        at,
      },
      { actorId: prev.actorId, source: "proactive-pipeline" },
    );
    // viewed = 应用内已展示（impression），非用户决策：不算负反馈，
    // 也不进接受率分母（outcome-store.acceptanceRate 排除），避免污染学习信号
    if (!POSITIVE.has(outcome) && outcome !== "delivered" && outcome !== "viewed") {
      this.deps.governor.noteOutcome(prev.kind, false);
      // 话题维度学习（2026-10-01）：同话题连续 dismiss 达阈值 → 投一条
      // 低打扰建议（不自动静音；正反馈清零 streak）
      if (prev.topic) {
        const suggestion = this.deps.topicDismiss?.note(prev.actorId, prev.topic);
        if (suggestion) this.submitMuteSuggestion(suggestion);
      }
    } else if (POSITIVE.has(outcome) && prev.topic) {
      this.deps.topicDismiss?.resetTopic(prev.actorId, prev.topic);
    }
    const rate = this.deps.outcomes.acceptanceRate(prev.kind);
    if (rate !== null && rate > 0.6) this.deps.governor.noteOutcome(prev.kind, true);
    return true;
  }

  /** 话题静音建议（fire-and-forget）：正常走仲裁链，频控/静默/抑制语义全部继承 */
  private submitMuteSuggestion(s: { actorId: string; topic: string; count: number }): void {
    const display = s.topic.startsWith("发件人:") ? s.topic.slice(4) : `「${s.topic}」相关`;
    const decision = this.submitProposal({
      proposalId: `mute_${Date.now().toString(36)}`,
      actorId: s.actorId,
      kind: "mute_suggest",
      tier: "social",
      importance: "medium",
      dedupKey: `mute_suggest:${s.actorId}:${s.topic}`,
      title: `少提「${display}」？`,
      summary: `连续 ${s.count} 条相关提醒被划掉`,
      evidence: [`topic:${s.topic}`, `dismissed:${s.count}`],
      directText:
        `连着几条${display}提醒都被你划掉了。以后少提这类的话，直接跟我说` +
        `「别再提醒我这个」；想继续就当我没说。`,
      createdAt: Date.now(),
      source: "topic_dismiss",
    });
    console.log(
      `[ProactivePipeline] 话题 dismiss 建议已提交 kind=mute_suggest topic=${s.topic} verdict=${decision.verdict}`,
    );
  }

  /** 反馈端点用：按 deliveryId 取投递记录（actorId/kind），供话题静音等关联动作 */
  describeDelivery(deliveryId: string): ReturnType<OutcomeStore["findByDeliveryId"]> {
    return this.deps.outcomes.findByDeliveryId(deliveryId);
  }

  /** 显式用户反馈（不经投递记录，如简报卡片上的按钮）：直接回灌频控自适应冷却 */
  noteKindFeedback(kind: string, positive: boolean): void {
    this.deps.governor.noteOutcome(kind, positive);
  }

  /** 诊断快照（GET /api/proactivity/diagnostics）："为什么发/没发"全程可解释 */
  diagnostics() {
    return {
      pending: this.store.listPending(),
      recentDecisions: this.store.recentDecisions(30),
      recentOutcomes: this.deps.outcomes.recent(20),
      budget: this.deps.governor.usageSnapshot(),
      presence: {
        onlineCount: this.deps.presence.listOnline().length,
        online: this.deps.presence.listOnline(),
      },
      offlinePush: { enabled: !!this.deps.mobilePush },
      // 沉默决策留痕（方案 B）：最近效用评估后主动选择不动作的提案
      recentSilences: this.silenceLog.recent(10),
      // 触点计划（§3.4）：今天给谁排了哪几个触点、各自攒了什么、有没有说出去
      touchpoints: this.touchpointSnapshot(),
    };
  }

  /**
   * 触点计划诊断快照（§3.4 验收第 4 条）：范围取「在线 ∪ 已知用户」前 20 人——
   * 诊断接口不是数据导出，看得清比列得全重要。未装配 planner 时为空数组。
   */
  private touchpointSnapshot(): Array<{ actorId: string; plan: TouchpointPlan; dropped: string | null }> {
    const planner = this.deps.planner;
    if (!planner) return [];
    const ids = new Set<string>([
      ...this.deps.presence.listOnline(),
      ...(this.deps.exportActors?.().map((a) => a.actorId) ?? []),
    ]);
    return [...ids].slice(0, 20).map((actorId) => ({ actorId, ...planner.snapshot(actorId) }));
  }

  /** 沉默决策检索（支持「你上周为什么没提醒我 XX」反问） */
  searchSilences(opts: Parameters<SilenceLog["search"]>[0]) {
    return this.silenceLog.search(opts);
  }

  /**
   * 某人的触点计划（§3.4 验收「计划本身看得见」）：今天几个触点、各自几点、
   * 依据是什么、攒了哪几条、说没说出去，外加「为什么有条没排进去」。
   */
  planSnapshot(actorId: string): { plan: TouchpointPlan; dropped: string | null } | null {
    return this.deps.planner?.snapshot(actorId) ?? null;
  }

  /**
   * 漏斗视图数据源（2026-11-23 §12.2）：把三段既有留痕按窗口切给聚合层。
   * 裁决与结果是环形缓冲，窗口拉大不等于数据变全——聚合层会在响应里标注口径边界。
   */
  funnelWindow(days = 7, now = Date.now()) {
    const fromMs = now - days * 24 * 60 * 60_000;
    return {
      decisions: this.store
        .recentDecisions(200)
        .filter((d) => (d.proposal?.createdAt ?? 0) >= fromMs),
      outcomes: this.deps.outcomes
        .recent(2000)
        .filter((o) => (o.createdAt ?? o.at) >= fromMs),
      silences: this.silenceLog.recent(500).filter((s) => s.at >= fromMs),
    };
  }

  /**
   * 离线送达：两端都不在线（或 WS 投递竞态失败）时，手机系统推送是主出口。
   *
   * 2026-11-25 用户拍板改为**有界重试**：一次推送失败不代表内容过期（厂商接口
   * 偶发 5xx/超时很常见），此前「失败即丢」把大量主动消息吞掉了。现在失败留在
   * 待发区按退避重试，总时限按内容时效封顶（提案自带 expiresAt 优先；没有则
   * 必达 6h / 社交 2h），到点仍未送达才如实丢弃并留痕。token 失效不重试。
   */
  private attemptOfflinePush(p: ProactiveProposal): void {
    const clock = () => this.deps.nowFn?.() ?? Date.now();
    const push = this.deps.mobilePush;

    if (push && push.hasChannel(p.actorId)) {
      const deliveryId = `dp_${clock().toString(36)}_${(this.pushSeq++).toString(36)}`;
      // 「通知即界面」：离线推送同样签发动作意图。厂商通道渲染不出按钮（系统模板），
      // 但通知里带上 intentId → 点开进 App 能直接处理这个决策（降级路径同一套语义）。
      let intentId = "";
      let actionIntent = null;
      const intentService = this.deps.actionIntents;
      if (intentService) {
        try {
          const intent = registerIntentForProposal(intentService, p, {
            title: p.title,
            body: String(p.directText ?? p.summary),
            deliveryId,
          });
          if (intent) {
            intentId = intent.intentId;
            // withOpenChat（2026-11-30 §4.4）：厂商通知渲染不出按钮，点开进的是决策
            // 半屏页——页上除了那两个执行按钮，还要留一个「打开对话」的出口。
            // 这枚动作与那两个走同一条 execute 链路（同一套签发/幂等/审计）。
            actionIntent = intentService.renderForClient(intent, { withOpenChat: true });
          }
        } catch (err) {
          console.log(`[ProactivePipeline] 离线推送动作意图签发失败（忽略）kind=${p.kind}: ${err}`);
        }
      }
      void push
        .push({
          actorId: p.actorId,
          // 华为通道强制 title 非空（80100003 Illegal payload）
          title: p.title ?? "提醒",
          body: p.directText ?? p.summary ?? p.title ?? "点击查看详情",
          importance: p.importance,
          kind: p.kind,
          deliveryId,
          // 透传写穿的本地消息 id：同一件事重试多次也只落一条
          stableKey: p.dedupKey,
          ...(intentId ? { intentId } : {}),
          ...(actionIntent ? { actionIntent } : {}),
        })
        .then((result) => {
          if (!result.ok) {
            this.handlePushFailure(p, deliveryId, String(result.reason ?? ""));
            return;
          }
          // 送达：这时才出队消费（失败要留在待发区重试）
          this.store.take(p.dedupKey);
          this.pushRetries.delete(p.dedupKey);
          this.store.markDelivered(p.dedupKey, clock());
          // 对话留底（2026-11-25 用户拍板）：系统推送是离线时主出口，但此前的
          // 结果是「推完对话里什么都不留」——点开通知只看得到主界面、找不到内容。
          // 这里把同一条正文落成主会话轮次（userText 空 + assistantText），
          // /api/chat-data/history?full=1 回填后对话里就是同一条消息。
          // 只在推送成功时写一次：在线直投由客户端本地持久化，两端各写会重复。
          const keptText = String(p.directText ?? p.summary ?? p.title ?? "").trim();
          if (keptText) {
            const append =
              this.deps.transcriptAppend ??
              ((entry: TurnWalEntry) => getTurnWalService().append(entry));
            void Promise.resolve(
              append({
                ts: new Date(clock()).toISOString(),
                actorId: p.actorId,
                userText: "",
                assistantText: keptText,
                messageId: `proactive-${p.proposalId}`,
                context: "main",
              }),
            ).catch((err) => {
              console.log(
                `[ProactivePipeline] 离线推送对话留底失败（忽略）kind=${p.kind}: ${err}`,
              );
            });
          }
          // 手机推送真的送达 → 读走的发现此刻结算成消费（否则会随预留到期释放、被再合并一遍）
          if (this.deps.discovery && p.findingFingerprints?.length) {
            this.deps.discovery.settle(p.findingFingerprints, "delivered");
          }
          this.deps.outcomes.record({
            deliveryId,
            actorId: p.actorId,
            kind: p.kind,
            channel: "mobile_push",
            outcome: "delivered",
            at: clock(),
            createdAt: clock(),
            tier: p.tier,
            ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
          });
          console.log(`[ProactivePipeline] 离线推送已送达 kind=${p.kind} provider=${result.provider} actor=${p.actorId}`);
        })
        .catch((err) => {
          // 通道抛异常与「返回失败」同待遇：可重试，别静默吞掉
          this.handlePushFailure(p, deliveryId, String(err));
        });
      return;
    }

    // 无推送通道（没有注册 token / 未配置 provider）：重试也不会变好，如实丢弃。
    // 站内信不承载聊天式提醒（只做平台/运营消息）。
    this.store.take(p.dedupKey);
    this.pushRetries.delete(p.dedupKey);
    console.log(
      `[ProactivePipeline] 离线且无推送通道（丢弃，不重试）kind=${p.kind} actor=${p.actorId}`,
    );
  }

  /**
   * 推送失败后的去向：能重试就退避重排，过了内容时效才丢。
   * token 失效（80300002）重试同一个死 token 没有意义——直接丢，客户端重注册后
   * 新提案会走新 token。
   */
  private handlePushFailure(p: ProactiveProposal, deliveryId: string, reason: string): void {
    const now = this.deps.nowFn?.() ?? Date.now();
    const attempts = (this.pushRetries.get(p.dedupKey) ?? 0) + 1;
    this.pushRetries.set(p.dedupKey, attempts);

    const windowMs =
      p.tier === "must" || p.importance === "high" || p.importance === "critical"
        ? PUSH_RETRY_WINDOW_MUST_MS
        : PUSH_RETRY_WINDOW_SOCIAL_MS;
    const deadline = Math.min(p.expiresAt ?? Number.POSITIVE_INFINITY, p.createdAt + windowMs);
    const backoff =
      PUSH_RETRY_BACKOFF_MS[
        Math.min(attempts - 1, PUSH_RETRY_BACKOFF_MS.length - 1)
      ] ?? PUSH_RETRY_BACKOFF_MS[PUSH_RETRY_BACKOFF_MS.length - 1]!;
    const tokenDead = reason.includes(PUSH_DEAD_TOKEN_HINT);
    const canRetry =
      !tokenDead && attempts < PUSH_RETRY_MAX_ATTEMPTS && now + backoff <= deadline;

    if (canRetry) {
      this.store.reschedule(p.dedupKey, now + backoff);
      console.log(
        `[ProactivePipeline] 离线推送失败，${Math.round(backoff / 60_000)} 分钟后重试` +
          `（第 ${attempts} 次，最晚 ${new Date(deadline).toLocaleString("zh-CN")}）` +
          `kind=${p.kind} reason=${reason}`,
      );
      return;
    }

    // 超出重试窗口 / token 失效 / 次数用尽：如实丢弃并留痕（不制造"还在补"的假象）
    this.store.take(p.dedupKey);
    this.pushRetries.delete(p.dedupKey);
    this.deps.outcomes.record({
      deliveryId,
      actorId: p.actorId,
      kind: p.kind,
      channel: "mobile_push",
      outcome: "ignored",
      at: now,
      createdAt: now,
      tier: p.tier,
      ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
    });
    if (this.deps.discovery && p.findingFingerprints?.length) {
      this.deps.discovery.settle(p.findingFingerprints, "dropped");
    }
    const why = tokenDead
      ? "push token 失效，等客户端重注册"
      : attempts >= PUSH_RETRY_MAX_ATTEMPTS
        ? "重试次数用尽"
        : "超出内容时效";
    console.log(
      `[ProactivePipeline] 离线推送最终失败（丢弃：${why}）kind=${p.kind} attempts=${attempts} reason=${reason}`,
    );
  }

  /**
   * 提案级 ask_first 登记：ask_first 分支 + 提案声明 confirmAction（如承诺代催
   * 「发送前会先经你确认」）时，确认文案投递后在共享存储登记待确认——
   * 用户回复「可以」经 hub resolver 回流 resolveProposalConfirmation。
   * 普通通知类 ask_first 提案不登记（投递即完成，无后续动作可批准）。
   */
  private registerProposalConfirmationIfNeeded(p: ProactiveProposal, decision: ArbitrationDecision): void {
    if (!this.deps.confirmations) return;
    if (decision.utility?.branch !== "ask_first" || !p.confirmAction) return;
    this.deps.confirmations.register({
      actorId: p.actorId,
      kind: p.kind,
      steps: [],
      rationale: p.title,
      createdAt: this.deps.nowFn?.() ?? Date.now(),
      expiresAt: (this.deps.nowFn?.() ?? Date.now()) + CONFIRMATION_TTL_MS,
      origin: "pipeline",
      proposal: p,
    });
    console.log(`[ProactivePipeline] 提案级待确认已登记 kind=${p.kind} label=${p.confirmAction.label}`);
    const registered = this.deps.confirmations.list(p.actorId).slice(-1)[0];
    if (registered) this.deps.onPendingConfirmation?.(registered);
  }

  /**
   * 提案级确认推进（hub resolver 委托入口；条目已由 hub 从共享存储取出）：
   * 批准 → onProposalApproved 落地动作 + speak 回执；拒绝静默关闭。
   */
  resolveProposalConfirmation(entry: PendingConfirmation, approved: boolean): { executed: boolean } {
    if (!approved) return { executed: false };
    const proposal =
      entry.proposal ??
      ({
        proposalId: `confirm_${entry.confirmId}`,
        actorId: entry.actorId,
        kind: entry.kind,
        tier: "must",
        importance: "medium",
        dedupKey: `confirm:${entry.confirmId}`,
        title: entry.rationale,
        summary: entry.rationale,
        evidence: [],
        createdAt: entry.createdAt,
        source: "confirm-flow",
      } as ProactiveProposal);
    try {
      this.deps.onProposalApproved?.(proposal);
    } catch (err) {
      console.log(`[ProactivePipeline] 提案批准回调失败（忽略）kind=${proposal.kind}: ${err}`);
    }
    // 回执：经 speak 兜底车道告知用户「已按确认推进」
    this.deps.speak?.({
      ...proposal,
      title: `已确认：${entry.rationale.slice(0, 40)}`,
      summary: "好的，已按你的确认推进。",
      directText: undefined,
      dedupKey: `confirm_ack:${entry.confirmId}`,
    });
    return { executed: true };
  }

  /**
   * 通知栏动作（2026-11-13「通知即界面」）：把一条**已投递**的提案重新入队，
   * 推迟到 deliverAfter 再重投一次（用户点「稍后再说」）。
   *
   * 为什么不走 submitProposal：那条路有 24h 已投递指纹去重，会把这次明确的
   * 「推迟」判成重复投递直接丢弃——用户点了「稍后再说」却再也没被提醒，
   * 是最伤信任的一种失灵。这里直接入队，绕开指纹判定。
   */
  requeueProposal(proposal: ProactiveProposal, deliverAfter: number): boolean {
    const now = this.deps.nowFn?.() ?? Date.now();
    const next: ProactiveProposal = {
      ...proposal,
      createdAt: now,
      deliverAfter,
    };
    const ok = this.store.enqueue(next);
    this.store.flush();
    return ok;
  }

  /**
   * 通知栏动作（2026-11-13）：推进一条待确认（ask_first 提案的批准/拒绝）。
   * 与用户在对话里回「可以」走的是同一条路（hub resolver → resolveProposalConfirmation），
   * 所以两条路径的语义、审计、失败处理完全一致。
   */
  resolveConfirmationByKind(
    actorId: string,
    kind: string,
    approved: boolean,
  ): { ok: boolean; message: string } {
    const store = this.deps.confirmations;
    if (!store) return { ok: false, message: "确认存储未装配" };
    const entry = store
      .list(actorId)
      .filter((e) => e.origin === "pipeline" && e.kind === kind)
      .slice(-1)[0];
    if (!entry) {
      return { ok: false, message: "这条确认已经不在了（可能已经处理过）" };
    }
    store.take(entry.confirmId);
    if (!approved) {
      // 拒绝：静默关掉 + 一句回执（不回执的话用户不知道点没点上）
      this.deps.speak?.({
        proposalId: `confirm_decline_${entry.confirmId}`,
        actorId,
        kind: entry.kind,
        tier: "must",
        importance: "medium",
        dedupKey: `confirm_decline:${entry.confirmId}`,
        title: "好，先不做",
        summary: "好的，这事先不做了。",
        evidence: [],
        createdAt: this.deps.nowFn?.() ?? Date.now(),
        source: "confirm-flow",
      });
      return { ok: true, message: "好，这事先不做了" };
    }
    const res = this.resolveProposalConfirmation(entry, true);
    return res.executed
      ? { ok: true, message: "好，已按你的确认推进" }
      : { ok: false, message: "这项暂时推进不了" };
  }

  /** 仲裁并执行（提案已在待发区内；delivered 出队投递，deferred 更新时刻，其余出队） */
  private decide(p: ProactiveProposal, at?: number): ArbitrationDecision {
    const decision = this.applyPhoneQuiet(
      p,
      this.applyReachGate(p, arbitrate(p, this.buildContext(p, at)), at),
      at,
    );
    this.store.logDecision(decision);
    // 提案最终去向 → 共享发现层预留结算：delivered=消费 / pending=维持预留（等真投递）/ dropped=释放
    let disposition: "delivered" | "pending" | "dropped" = "dropped";
    switch (decision.verdict) {
      case "delivered": {
        // 可解释（§3.10）：把这条消息真正经过的那道闸翻成一句人话，随正文下发
        p.why = explainTiming(p, decision.reasonChain);
        if (this.dispatch(p)) {
          this.store.take(p.dedupKey);
          this.store.markDelivered(p.dedupKey, this.deps.nowFn?.() ?? Date.now());
          this.registerProposalConfirmationIfNeeded(p, decision);
          disposition = "delivered";
        } else {
          // 竞态：仲裁时设备在线、发送时已全部掉线 → 保留待发区稍后重试（重连即达）
          this.store.reschedule(p.dedupKey, (this.deps.nowFn?.() ?? Date.now()) + DELIVERY_RETRY_MS);
          this.attemptOfflinePush(p);
          disposition = "pending";
        }
        break;
      }
      case "deferred": {
        const now = this.deps.nowFn?.() ?? Date.now();
        if (decision.reasonChain.includes("offline_wait_reconnect")) {
          // 时效信息不靠「等手机上线再补」兜底（2026-11-24 用户拍板）：离线这一刻
          // 就交给系统推送。2026-11-25 起推送失败会在内容时效内退避重试（见
          // handlePushFailure），不再一次失败就吞掉。
          this.attemptOfflinePush(p);
          disposition = "dropped";
        } else if (decision.deliverAfter !== undefined) {
          // 非离线原因的延迟（通话中 / 勿扰 / 排槽窗口）仍按点重裁决——
          // 这是「挑合适时机说」的正常调度，不是「等人上线补旧账」的兜底。
          disposition = "pending";
          this.store.reschedule(p.dedupKey, decision.deliverAfter);
        }
        break;
      }
      case "silenced":
        // 效用评估后主动选择不动作（区别于 suppressed 的负反馈抑制）：出队 + 沉默日志留痕
        this.store.take(p.dedupKey);
        this.silenceLog.record({
          at: this.deps.nowFn?.() ?? Date.now(),
          actorId: p.actorId,
          kind: p.kind,
          title: p.title,
          dedupKey: p.dedupKey,
          source: p.source,
          scope: "proposal",
          netUtility: decision.utility?.netUtility ?? 0,
          riskScore: decision.utility?.riskScore ?? 0,
          valueScore: decision.utility?.valueScore ?? 0,
          reason: decision.utility?.reason ?? decision.reasonChain.join(";"),
        });
        break;
      default:
        this.store.take(p.dedupKey); // expired / suppressed / throttled：出队（原因已留痕）
        break;
    }
    if (this.deps.discovery && p.findingFingerprints?.length) {
      this.deps.discovery.settle(p.findingFingerprints, disposition);
    }
    return decision;
  }

  /**
   * 手机静默闸（2026-11-23 M1）：手机上报通话中 / 系统勿扰时，非必达提案延后重判。
   *
   * 放在 reachGate 之后：前面的闸都放行了，最后看一眼「人此刻是不是在打电话 / 开了勿扰」。
   * must 层与 critical 不受影响（日程到点、闹钟类必须到）；系统勿扰本身对这些也有自己的放行规则。
   * 不设次数上限：通话/勿扰结束即放行，长时间勿扰由提案自身 expiresAt 兜底。
   */
  private applyPhoneQuiet(
    p: ProactiveProposal,
    decision: ArbitrationDecision,
    at?: number,
  ): ArbitrationDecision {
    if (decision.verdict !== "delivered") return decision;
    if (p.tier === "must" || p.importance === "critical") return decision;
    const now = at ?? this.deps.nowFn?.() ?? Date.now();
    // 测试与旧装配可能注入只有 getPresence 的精简 presence：没有该能力 = 不设闸
    const quiet = (this.deps.presence as Partial<PresenceService>).phoneQuietReason;
    const reason = typeof quiet === "function" ? quiet.call(this.deps.presence, p.actorId, now) : null;
    if (!reason) return decision;
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: [...decision.reasonChain, `phone_quiet:${reason}`],
      deliverAfter: now + PHONE_QUIET_RETRY_MS,
    };
  }

  /**
   * 社交提案的最后一道路径判断（2026-11-19）：把期望效用决策接进管道。
   *
   * 为什么放在仲裁之后：arbiter 管的是「硬约束」（静默/离线/对话中/频控），
   * 这里管「软分寸」——用户此刻多忙、这类消息他还愿不愿意看。
   * 两者是乘法关系，不是替代关系。
   *
   * 防饿死：同一提案最多被延后 REACH_MAX_DEFERS 次，之后强制放行——
   * 「一直觉得时机不对」最后变成「永远不说」是比打扰更糟的失灵。
   */
  private applyReachGate(
    p: ProactiveProposal,
    decision: ArbitrationDecision,
    at?: number,
  ): ArbitrationDecision {
    if (decision.verdict !== "delivered") return decision;
    if (p.tier !== "social") return decision;
    // 元反馈类不能过这道闸：它是「少提这类？」的收口，被抑制掉用户就没法表达不满了
    if (p.source === "topic_dismiss") return decision;
    if (!this.deps.reachGate) return decision;

    let gate: { action: "send_now" | "defer" | "batch" | "drop"; reason: string } | null = null;
    try {
      gate = this.deps.reachGate(p);
    } catch (err) {
      // 决策层异常绝不能吞掉消息：回退到「仲裁怎么说就怎么做」
      console.log(`[ProactivePipeline] reachGate 异常（放行）kind=${p.kind}: ${err}`);
      return decision;
    }
    if (!gate || gate.action === "send_now") {
      this.reachDefers.delete(p.dedupKey);
      return decision;
    }

    const defers = this.reachDefers.get(p.dedupKey) ?? 0;
    if (defers >= REACH_MAX_DEFERS) {
      this.reachDefers.delete(p.dedupKey);
      return {
        ...decision,
        reasonChain: [...decision.reasonChain, `reach_gate:forced_send(已延后${defers}次)`],
      };
    }
    this.reachDefers.set(p.dedupKey, defers + 1);
    const now = at ?? this.deps.nowFn?.() ?? Date.now();
    const chain = [...decision.reasonChain, `reach_gate:${gate.action}:${gate.reason}`];

    if (gate.action === "drop") {
      return { proposal: p, verdict: "silenced", reasonChain: chain };
    }
    // defer / batch：管道层没有聚合出口，batch 一律按「等会儿再说」处理
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: chain,
      deliverAfter: now + REACH_GATE_RETRY_MS,
    };
  }

  /**
   * 执行投递：directText 直推全部在线设备（电脑端 + 手机端 fan-out）；无 directText 走
   * speak 兜底（装配层 → hub 直达车道模板直投，零 LLM）。投递失败（两端都不在线）
   * 返回 false，由 decide 改判重试——预算计数与 outcome 都只在真正送达后记录。
   */
  private dispatch(p: ProactiveProposal): boolean {
    if (p.directText) {
      // 正文在 submitProposal 里已经过 openMouth 闸；本方法是**唯一**被授权把正文投出去的
      // 地方（无发现层回退时由本类作为唯一编排者铸造）。外部模块想投递，只能拿到 openMouth
      // 产出的 OpenedBody——绕过开口闸会在 delivery.deliver 这里编译不过，而非靠约定。
      const result = this.deps.delivery.deliver(p, p.directText as OpenedBody, p.title);
      if (!result.ok) return false;
      this.deps.outcomes.record({
        deliveryId: result.deliveryId,
        actorId: p.actorId,
        kind: p.kind,
        channel: "in_app",
        outcome: "delivered",
        // 用注入时钟：未回复结算按 now-r.at 算年龄，混用真实时间会让窗口判定失效
        at: this.deps.nowFn?.() ?? Date.now(),
        createdAt: this.deps.nowFn?.() ?? Date.now(),
        tier: p.tier,
        // 触点槽类别（§4.6 slotKind）：slotId 形如 tp:<actor>:<date>:<kind>，取末段
        ...(p.slotId ? { slotKind: p.slotId.split(":").pop() } : {}),
        ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
      });
      // 冷却记账与裁决同键：跟进类按这件事（dedupKey）记，不同事件互不占冷却
      if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind, undefined, "social", p.dedupKey);
      // critical 提案挂起升级链（送达 ≠ 被看到；fire-and-forget 不影响投递主链路）
      if (p.importance === "critical" && this.deps.escalate) {
        try {
          this.deps.escalate(p, result.deliveryId);
        } catch (err) {
          console.log(`[ProactivePipeline] 升级钩子失败（忽略）kind=${p.kind}: ${err}`);
        }
      }
      return true;
    }
    this.deps.speak?.(p);
    if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind, undefined, undefined, p.dedupKey);
    return true;
  }

  private buildContext(p: ProactiveProposal, at?: number): ArbiterContext {
    const now = at ?? this.deps.nowFn?.() ?? Date.now();
    const presence = this.deps.presence.getPresence(p.actorId, now);
    // 对话进行中：注入了对话时刻依赖就用它（null=从未对话，绝不算对话中）；
    // 未注入才退回设备活跃时刻（对话 ≠ 设备活跃——桌面同步会持续刷新活跃）
    const last = this.deps.lastConversationAt
      ? this.deps.lastConversationAt(p.actorId)
      : this.deps.presence.lastActivityAt(p.actorId);
    return {
      now,
      presence,
      inConversation: presence === "active" && last !== null && now - last <= IN_CONVERSATION_WINDOW_MS,
      isSuppressed: (actorId, kind, text) => this.deps.suppression.isSuppressed(actorId, kind, text),
      // 用户活跃（在设备前）时告知频控：静默时段的低打扰消息不算惊扰（见 arbitrate）
      // tier=social：走社交类独立日预算（不和事务类抢额度，见 FrequencyGovernor）
      // identity=dedupKey：跟进类大类的冷却按「这件事」计（§3.5 限制是同一事件最多
      // 跟进 1 次，不是同一类话一天一次）——B 事件的跟进不该被 A 事件的冷却吞掉，
      // 跨事件的合并与顺延归 §3.4 的触点容量管
      socialCanTrigger: (actorId, kind, importance) =>
        this.deps.governor.canTrigger(actorId, kind, importance, undefined, {
          awake: presence === "active",
          tier: "social",
          identity: p.dedupKey,
        }),
    };
  }

  private persist(): void {
    this.store.flush();
    this.deps.outcomes.flush();
    this.deps.topicDismiss?.flush();
    writeJson(`${this.deps.dataPath}/frequency.json`, this.deps.governor.snapshot());
    const actors = this.deps.exportActors?.();
    if (actors?.length) writeJson(`${this.deps.dataPath}/known-actors.json`, actors);
  }
}

export { IN_CONVERSATION_WINDOW_MS };
