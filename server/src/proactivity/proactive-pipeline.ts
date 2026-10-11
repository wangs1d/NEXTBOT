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
import type { ArbitrationDecision, ProactiveOutcome, ProactiveProposal } from "./pipeline-types.js";
import { OutcomeStore } from "./outcome-store.js";
import type { PresenceService } from "./presence-service.js";
import { ProposalStore } from "./proposal-store.js";
import { SilenceLog } from "./silence-log.js";
import { CONFIRMATION_TTL_MS, type PendingConfirmation, PendingConfirmationStore } from "./pending-confirmation-store.js";
import { topicKeyOfProposal, TopicDismissTracker } from "./topic-dismiss-tracker.js";

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
   * 移动端推送通道（离线必达升级）：两端都不在线时，必达层/critical 提案
   * 改走手机系统推送（App 被杀也能收到）。未注入 = 通道禁用，离线一律挂起待重连。
   */
  mobilePush?: import("./mobile-push-service.js").MobilePushChannel;
  /**
   * 站内信兜底通道（离线社交层落信箱，2026-10-10）：
   * social 层 + medium 及以上的提案在两端离线且无手机推送通道时，落站内信
   * （客户端下次打开即见），而非挂到 TTL 静默作废。未注入 = 走旧挂起语义。
   * env PROACTIVITY_OFFLINE_INBOX=0 可整体关闭。
   */
  inbox?: {
    send(input: {
      actorId: string;
      title: string;
      body: string;
      kind?: string;
      importance?: string;
      /** 幂等键：重复投递同一 id 不产生第二条 */
      messageId?: string;
    }): Promise<{ deliveredLive: boolean }>;
  };
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
   * critical 提案升级钩子（接线 intelligent-reminder 的 popup→tts_alarm→phone_call
   * 三级升级链）：送达 ≠ 被看到——critical 直投成功后调此钩子挂起「未确认即升级」
   * 监听，用户确认（reminder.acknowledge）即停链。未注入 = 无升级链（仅投递）。
   */
  escalate?: (p: ProactiveProposal, deliveryId: string) => void;
  /**
   * 话题级 dismiss 追踪（2026-10-01）：同话题连续 dismiss 达阈值时投一条
   * 「要不要少提这类」建议（不自动静音，静音仍走用户明说的抑制表）。
   * 未注入 = 无话题维度学习。
   */
  topicDismiss?: TopicDismissTracker;
};

/** 正反馈 outcome 集合（自适应冷却的方向判定） */
const POSITIVE = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);

/** 离线推送重试退避（推送失败后 5min 再试，防 provider 连打；成功即出队不会重复推） */
const OFFLINE_PUSH_RETRY_MS = 5 * 60_000;

/** 离线挂起重仲裁退避序列：首次挂起不退避（重连后下一次 flush 即达），此后逐级
 * 拉长封顶 30min——否则设备长期离线时同一提案每 30s 被重新仲裁一次（实测运行
 * 数据中同一提案被裁决 198 次全是 offline_wait_reconnect），白耗 CPU 并污染决策日志 */
const OFFLINE_REDECIDE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** 单提案重裁决硬上限：超过即放弃（过期作废语义，原因已留痕） */
const MAX_REDECISIONS = 200;

export class ProactivePipeline {
  private readonly store: ProposalStore;
  private readonly silenceLog: SilenceLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private pushSeq = 0;
  /** dedupKey → 重裁决次数（deferred 类；投递/出队即清零） */
  private readonly redecides = new Map<string, number>();

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
    if (this.store.wasDeliveredRecently(p.dedupKey, now) || !this.store.enqueue(p)) {
      const merged: ArbitrationDecision = {
        proposal: p,
        verdict: "merged",
        reasonChain: [`dedup:${p.dedupKey}`],
      };
      this.store.logDecision(merged);
      return merged;
    }
    return this.decide(p);
  }

  /** 推进到期延迟提案（deferred/offline 挂起的在在场变化后重仲裁；at 可注入推进时钟） */
  flushDue(now = Date.now()): void {
    for (const p of this.store.listPending()) {
      if ((p.deliverAfter ?? 0) <= now) this.decide(p, now);
    }
  }

  /** 客户端回传触达结果 → 落库 + 自适应冷却（负反馈即时惩罚；接受率>0.6 回升） */
  recordOutcome(deliveryId: string, outcome: ProactiveOutcome): boolean {
    const prev = this.deps.outcomes.findByDeliveryId(deliveryId);
    if (!prev) return false;
    this.deps.outcomes.record({ ...prev, outcome, at: Date.now() });
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
    };
  }

  /** 沉默决策检索（支持「你上周为什么没提醒我 XX」反问） */
  searchSilences(opts: Parameters<SilenceLog["search"]>[0]) {
    return this.silenceLog.search(opts);
  }

  /**
   * 离线兜底（2026-10-10 重构，对症 97 条 offline_wait_reconnect 静默作废）：
   * 两端都不在线（或 WS 投递竞态失败）时按优先级分层兜底：
   *   ① must/critical 且手机推送可用 → 手机系统推送（现状，最高优先级）
   *   ② social + medium 及以上 → 落站内信（客户端下次打开即见，不丢）
   *   ③ 其余（low social）→ 维持原挂起语义（低频轻消息不值得沉淀到收件箱）
   * 兜底成功即出队并记 outcome（不会在重连后重复投递）。
   * 站内信兜底可用 env PROACTIVITY_OFFLINE_INBOX=0 关闭（回退旧挂起语义）。
   */
  private attemptOfflinePush(p: ProactiveProposal): void {
    const clock = () => this.deps.nowFn?.() ?? Date.now();
    const push = this.deps.mobilePush;

    // ① 必达层/critical：手机系统推送优先（通道可用时）
    if (push && (p.tier === "must" || p.importance === "critical") && push.hasChannel(p.actorId)) {
      this.store.reschedule(p.dedupKey, clock() + OFFLINE_PUSH_RETRY_MS);
      const deliveryId = `dp_${clock().toString(36)}_${(this.pushSeq++).toString(36)}`;
      void push
        .push({ actorId: p.actorId, title: p.title, body: p.directText ?? p.summary, importance: p.importance, kind: p.kind, deliveryId })
        .then((result) => {
          if (!result.ok) {
            console.log(`[ProactivePipeline] 离线推送失败（保留待发区重试）kind=${p.kind} provider=${result.provider} reason=${result.reason}`);
            return;
          }
          if (!this.store.take(p.dedupKey)) return; // 已被 WS 重连直投抢先
          this.store.markDelivered(p.dedupKey, clock());
          this.deps.outcomes.record({
            deliveryId,
            actorId: p.actorId,
            kind: p.kind,
            channel: "mobile_push",
            outcome: "delivered",
            at: Date.now(),
            ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
          });
          console.log(`[ProactivePipeline] 离线推送已送达 kind=${p.kind} provider=${result.provider} actor=${p.actorId}`);
        })
        .catch((err) => {
          console.log(`[ProactivePipeline] 离线推送异常（忽略）kind=${p.kind}: ${err}`);
        });
      return;
    }

    // ② 其余（social 层；或 must/critical 但推送通道不可用）：落站内信兜底。
    //    attemptOfflineInbox 内部按重要度过滤（only medium+ 才沉淀），
    //    轻消息（low）仍维持原挂起语义，避免收件箱被灌爆。
    this.attemptOfflineInbox(p);
  }

  /**
   * 落站内信兜底（社交层离线主兜底）：medium 及以上才沉淀，low 保持挂起语义
   * （轻消息进收件箱会污染「助手动态」心智）。落信箱即视为已投递（用户下次
   * 打开必见），记 outcome channel=offline_inbox，避免重连重复直推。
   */
  private attemptOfflineInbox(p: ProactiveProposal): void {
    if (!this.deps.inbox || this.offlineInboxDisabled()) return;
    // 只兜中等价值以上的消息；low social 仍走原挂起（避免收件箱被灌爆）
    const rank: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
    if ((rank[p.importance] ?? 0) < 1) return;
    const clock = () => this.deps.nowFn?.() ?? Date.now();
    const messageId = `proactive:${p.dedupKey}`;
    void this.deps.inbox
      .send({
        actorId: p.actorId,
        title: p.title,
        body: p.directText ?? p.summary,
        kind: `proactive:${p.kind}`,
        importance: p.importance,
        messageId,
      })
      .then((result) => {
        // 落盘成功即视为送达（deliveredLive=false 表示用户当前离线，打开即见）
        if (!this.store.take(p.dedupKey)) return; // 已被 WS 重连直投抢先
        this.store.markDelivered(p.dedupKey, clock());
        this.deps.outcomes.record({
          deliveryId: `di_${clock().toString(36)}_${(this.pushSeq++).toString(36)}`,
          actorId: p.actorId,
          kind: p.kind,
          channel: "offline_inbox",
          outcome: "delivered",
          at: Date.now(),
          ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
        });
        console.log(
          `[ProactivePipeline] 离线落站内信 kind=${p.kind} actor=${p.actorId} live=${result?.deliveredLive === true}`,
        );
      })
      .catch((err) => {
        // 落信箱失败：保留待发区（重连即达），不丢
        console.log(`[ProactivePipeline] 离线落站内信失败（保留待发区）kind=${p.kind}: ${err}`);
      });
  }

  /** 站内信兜底总开关（env PROACTIVITY_OFFLINE_INBOX=0 关；缺省开） */
  private offlineInboxDisabled(): boolean {
    return process.env.PROACTIVITY_OFFLINE_INBOX === "0";
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
        source: "commitment-board",
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

  /** 仲裁并执行（提案已在待发区内；delivered 出队投递，deferred 更新时刻，其余出队） */
  private decide(p: ProactiveProposal, at?: number): ArbitrationDecision {
    const decision = arbitrate(p, this.buildContext(p, at));
    this.store.logDecision(decision);
    if (decision.verdict !== "deferred") this.redecides.delete(p.dedupKey);
    switch (decision.verdict) {
      case "delivered": {
        if (this.dispatch(p)) {
          this.store.take(p.dedupKey);
          this.store.markDelivered(p.dedupKey, this.deps.nowFn?.() ?? Date.now());
          this.registerProposalConfirmationIfNeeded(p, decision);
        } else {
          // 竞态：仲裁时设备在线、发送时已全部掉线 → 保留待发区稍后重试（重连即达）
          this.store.reschedule(p.dedupKey, (this.deps.nowFn?.() ?? Date.now()) + DELIVERY_RETRY_MS);
          this.attemptOfflinePush(p);
        }
        break;
      }
      case "deferred": {
        const now = this.deps.nowFn?.() ?? Date.now();
        if (decision.reasonChain.includes("offline_wait_reconnect")) {
          const n = (this.redecides.get(p.dedupKey) ?? 0) + 1;
          this.redecides.set(p.dedupKey, n);
          if (n > MAX_REDECISIONS) {
            // 挂起超限：设备长期离线且提案无保质期——放弃（信息已过时，留痕即可）
            this.store.take(p.dedupKey);
            this.redecides.delete(p.dedupKey);
            console.log(`[ProactivePipeline] 挂起重裁决超限（${MAX_REDECISIONS} 次）放弃 kind=${p.kind} dedupKey=${p.dedupKey}`);
            break;
          }
          // 首次离线挂起不退避（重连后下一次 flush 立即直推）；仍离线才逐级拉长
          if (n >= 2) {
            const step = OFFLINE_REDECIDE_BACKOFF_MS[Math.min(n - 2, OFFLINE_REDECIDE_BACKOFF_MS.length - 1)];
            this.store.reschedule(p.dedupKey, now + step);
          }
        } else if (decision.deliverAfter !== undefined) {
          this.store.reschedule(p.dedupKey, decision.deliverAfter);
        }
        if (decision.reasonChain.includes("offline_wait_reconnect")) this.attemptOfflinePush(p);
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
    return decision;
  }

  /**
   * 执行投递：directText 直推全部在线设备（电脑端 + 手机端 fan-out）；无 directText 走
   * speak 兜底（装配层 → hub 直达车道模板直投，零 LLM）。投递失败（两端都不在线）
   * 返回 false，由 decide 改判重试——预算计数与 outcome 都只在真正送达后记录。
   */
  private dispatch(p: ProactiveProposal): boolean {
    if (p.directText) {
      const result = this.deps.delivery.deliver(p, p.directText, p.title);
      if (!result.ok) return false;
      this.deps.outcomes.record({
        deliveryId: result.deliveryId,
        actorId: p.actorId,
        kind: p.kind,
        channel: "in_app",
        outcome: "delivered",
        at: Date.now(),
        ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
      });
      if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind);
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
    if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind);
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
      socialCanTrigger: (actorId, kind, importance) =>
        this.deps.governor.canTrigger(actorId, kind, importance, undefined, { awake: presence === "active" }),
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
