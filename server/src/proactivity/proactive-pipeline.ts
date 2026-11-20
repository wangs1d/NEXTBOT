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
import { primarySubjectOf, type DiscoveryLayer, type OpenedBody } from "./discovery-layer.js";
import { registerIntentForProposal } from "./notification-actions.js";

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
   * 离线信箱（2026-11-19）：social 层提案在两端都离线时落一条站内信，
   * 不 push、不响铃，用户下次打开 App 可见。
   *
   * 为什么恢复这条链路：此前（2026-10-14）为了「站内信只承载平台消息」删掉了它，
   * 结果是**用户不在电脑前 = 主动性彻底消失**——而主动感恰恰最常发生在人离开时。
   * 落库后即出队（markDelivered），重连不再补推，避免同一句话出现两遍。
   */
  offlineInbox?: {
    send(input: {
      actorId: string;
      title: string;
      body: string;
      kind?: string;
      importance?: "low" | "normal" | "high" | "critical";
      messageId?: string;
    }): Promise<unknown>;
  };
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
};

/** 正反馈 outcome 集合（自适应冷却的方向判定） */
const POSITIVE = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);

/** 离线推送重试退避（推送失败后 5min 再试，防 provider 连打；成功即出队不会重复推） */
const OFFLINE_PUSH_RETRY_MS = 5 * 60_000;
/** 离线落信箱失败的重试退避（同上） */
const OFFLINE_INBOX_RETRY_MS = 5 * 60_000;

/** 离线挂起重仲裁退避序列：首次挂起不退避（重连后下一次 flush 即达），此后逐级
 * 拉长封顶 30min——否则设备长期离线时同一提案每 30s 被重新仲裁一次（实测运行
 * 数据中同一提案被裁决 198 次全是 offline_wait_reconnect），白耗 CPU 并污染决策日志 */
const OFFLINE_REDECIDE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** 单提案重裁决硬上限：超过即放弃（过期作废语义，原因已留痕） */
const MAX_REDECISIONS = 200;

/** reachGate 判「时机不对」后的重判间隔（等用户从专注里出来，不急着立刻再问） */
const REACH_GATE_RETRY_MS = 20 * 60_000;
/** 同一提案最多被 reachGate 延后几次（防「永远等时机」把消息饿死） */
const REACH_MAX_DEFERS = 4;

/** 未回复自动结算窗口：social 消息发出后这么久没有任何对话，按「忽略」记负样本 */
const UNANSWERED_WINDOW_MS = 6 * 60 * 60_000;
/** 自动结算扫描间隔（避免每 30s flush 都遍历一遍 outcomes） */
const UNANSWERED_SWEEP_MS = 30 * 60_000;

export class ProactivePipeline {
  private readonly store: ProposalStore;
  private readonly silenceLog: SilenceLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private pushSeq = 0;
  /** dedupKey → 重裁决次数（deferred 类；投递/出队即清零） */
  private readonly redecides = new Map<string, number>();
  /** dedupKey → 被 reachGate 延后的次数（防「永远等时机」饿死消息） */
  private readonly reachDefers = new Map<string, number>();
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
    if (this.store.wasDeliveredRecently(proposal.dedupKey, now) || !this.store.enqueue(proposal)) {
      // 被去重丢弃 / 入队失败：用户没看到这条，读走的发现释放回总线（信息不蒸发）
      if (this.deps.discovery && proposal.findingFingerprints?.length) {
        this.deps.discovery.settle(proposal.findingFingerprints, "dropped");
      }
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

  /** 推进到期延迟提案（deferred/offline 挂起的在在场变化后重仲裁；at 可注入推进时钟） */
  flushDue(now = Date.now()): void {
    // 运行期僵尸清理（2026-11-12）：启动清理只覆盖重启，长驻进程内 defer-forever
    // 的挂起提案靠这里每轮兜底（48h 超龄 + 无 firedAt 才丢，补推提案豁免）。
    this.store.pruneStale(now);
    // 未回复结算（2026-11-19）：social 消息发出后长期无声 → 记「忽略」负样本，
    // 让 noteOutcome 的自适应冷却真的学到「这类话他不看」。忽略是主要负样本。
    this.sweepUnanswered(now);
    for (const p of this.store.listPending()) {
      if ((p.deliverAfter ?? 0) <= now) this.decide(p, now);
    }
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
   * 离线兜底（2026-10-14 收敛）：两端都不在线（或 WS 投递竞态失败）时——
   *   ① must/critical 且手机推送可用 → 手机系统推送（App 被杀也能收到）
   *   ② 其余一律维持挂起语义（重连后直推；重裁决退避防 CPU 空转）。
   * 站内信兜底已按用户定调整体删除（2026-10-14）：站内信职责是后台→用户的
   * 平台消息/更新通知，不承载聊天式提醒；此前 social 层落信箱链路移除。
   */
  private attemptOfflinePush(p: ProactiveProposal): void {
    const clock = () => this.deps.nowFn?.() ?? Date.now();
    const push = this.deps.mobilePush;

    // ① 必达层/critical：手机系统推送优先（通道可用时）
    if (push && (p.tier === "must" || p.importance === "critical") && push.hasChannel(p.actorId)) {
      this.store.reschedule(p.dedupKey, clock() + OFFLINE_PUSH_RETRY_MS);
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
            actionIntent = intentService.renderForClient(intent);
          }
        } catch (err) {
          console.log(`[ProactivePipeline] 离线推送动作意图签发失败（忽略）kind=${p.kind}: ${err}`);
        }
      }
      void push
        .push({
          actorId: p.actorId,
          title: p.title,
          body: p.directText ?? p.summary,
          importance: p.importance,
          kind: p.kind,
          deliveryId,
          ...(intentId ? { intentId } : {}),
          ...(actionIntent ? { actionIntent } : {}),
        })
        .then((result) => {
          if (!result.ok) {
            console.log(`[ProactivePipeline] 离线推送失败（保留待发区重试）kind=${p.kind} provider=${result.provider} reason=${result.reason}`);
            return;
          }
          if (!this.store.take(p.dedupKey)) return; // 已被 WS 重连直投抢先
          this.store.markDelivered(p.dedupKey, clock());
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
            tier: p.tier,
            ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
          });
          console.log(`[ProactivePipeline] 离线推送已送达 kind=${p.kind} provider=${result.provider} actor=${p.actorId}`);
        })
        .catch((err) => {
          console.log(`[ProactivePipeline] 离线推送异常（忽略）kind=${p.kind}: ${err}`);
        });
      return;
    }

    // ② social 层：落离线信箱（不 push、不响铃），用户下次打开 App 可见。
    //    2026-11-19 恢复这条链路（10-14 曾为「站内信只承载平台消息」整体删除）：
    //    结果是「用户不在电脑前 = 主动性消失」，而主动感最常发生在人离开的时候。
    //    落库后即出队，重连不再补推——同一句话出现两遍比没出现更伤。
    const inbox = this.deps.offlineInbox;
    if (inbox && p.tier === "social") {
      this.store.reschedule(p.dedupKey, clock() + OFFLINE_INBOX_RETRY_MS);
      const deliveryId = `di_${clock().toString(36)}_${(this.pushSeq++).toString(36)}`;
      void inbox
        .send({
          actorId: p.actorId,
          title: p.title || "助手",
          body: String(p.directText ?? p.summary),
          kind: `proactive:${p.kind}`,
          importance: p.importance === "critical" || p.importance === "high" ? "high" : "normal",
          // 幂等键：同一条提案重试不会在信箱里长出第二条
          messageId: `proactive:${p.dedupKey}`,
        })
        .then(() => {
          if (!this.store.take(p.dedupKey)) return; // 已被 WS 重连直投抢先
          this.store.markDelivered(p.dedupKey, clock());
          if (this.deps.discovery && p.findingFingerprints?.length) {
            this.deps.discovery.settle(p.findingFingerprints, "delivered");
          }
          this.deps.outcomes.record({
            deliveryId,
            actorId: p.actorId,
            kind: p.kind,
            channel: "offline_inbox",
            outcome: "delivered",
            at: clock(),
            tier: p.tier,
            ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
          });
          console.log(`[ProactivePipeline] 离线落信箱 kind=${p.kind} actor=${p.actorId}`);
        })
        .catch((err) => {
          console.log(`[ProactivePipeline] 离线落信箱失败（保留待发区重试）kind=${p.kind}: ${err}`);
        });
      return;
    }

    // ③ 其余（must 但无推送通道）：维持挂起语义——保留待发区等重连直推。
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
    const decision = this.applyReachGate(p, arbitrate(p, this.buildContext(p, at)), at);
    this.store.logDecision(decision);
    if (decision.verdict !== "deferred") this.redecides.delete(p.dedupKey);
    // 提案最终去向 → 共享发现层预留结算：delivered=消费 / pending=维持预留（等真投递）/ dropped=释放
    let disposition: "delivered" | "pending" | "dropped" = "dropped";
    switch (decision.verdict) {
      case "delivered": {
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
        disposition = "pending";
        if (decision.reasonChain.includes("offline_wait_reconnect")) {
          const n = (this.redecides.get(p.dedupKey) ?? 0) + 1;
          this.redecides.set(p.dedupKey, n);
          if (n > MAX_REDECISIONS) {
            // 挂起超限：设备长期离线且提案无保质期——放弃（信息已过时，留痕即可）
            // 读走的发现释放回总线（这次开口等于没说，不能吞掉别人的发现）
            this.store.take(p.dedupKey);
            this.redecides.delete(p.dedupKey);
            disposition = "dropped";
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
    if (this.deps.discovery && p.findingFingerprints?.length) {
      this.deps.discovery.settle(p.findingFingerprints, disposition);
    }
    return decision;
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
        tier: p.tier,
        ...(topicKeyOfProposal(p) ? { topic: topicKeyOfProposal(p) } : {}),
      });
      if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind, undefined, "social");
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
      // tier=social：走社交类独立日预算（不和事务类抢额度，见 FrequencyGovernor）
      socialCanTrigger: (actorId, kind, importance) =>
        this.deps.governor.canTrigger(actorId, kind, importance, undefined, {
          awake: presence === "active",
          tier: "social",
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
