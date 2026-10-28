// 统一主动性管道类型（架构见 docs/proactivity-architecture.md §4 L1-L5）
// 所有触发源只提交 ProactiveProposal，仲裁/投递/反馈由管道统一承担。

import type { ActionUtilityResult, AuthorizationLevel, RiskDimensions, ValueDimensions } from "./action-utility.js";

export type ProactiveImportance = "critical" | "high" | "medium" | "low";

export type PresenceState = "active" | "idle" | "offline";

/** 效用评估元数据：声明了 utility 的提案在仲裁链最前面过三分支判定（方案 A/B） */
export type ProposalUtilityMeta = {
  risk: RiskDimensions;
  authorization: AuthorizationLevel;
  /** 价值维度缺省时仲裁层按重要度派生（deriveNotifyValue） */
  value?: ValueDimensions;
};

/** 一次主动提案：发现"值得主动"的唯一提交格式（提案-仲裁分离，源只举证不投递） */
export type ProactiveProposal = {
  proposalId: string;
  actorId: string;
  kind: string;
  /** must=用户点名要的事（日程/提醒/预警），绕过社交预算；social=主动社交行为 */
  tier: "must" | "social";
  importance: ProactiveImportance;
  /** 指纹去重键（如 schedule_upcoming:{taskId}:{runAt}）：待发区内同键合并 */
  dedupKey: string;
  title: string;
  summary: string;
  /** 触发证据（诊断接口展示"为什么提案"） */
  evidence: string[];
  /** 现成文案：有值则零 LLM 直投；无值走 speak 闭环（现有 ProactionCortex，唯一 LLM 点） */
  directText?: string;
  createdAt: number;
  /** 最早可发时刻 ms（提前量/择时下界） */
  deliverAfter?: number;
  /** 保质期 ms：过期作废（如会议开始后"提前提醒"提案无意义） */
  expiresAt?: number;
  /** 是否允许打断进行中的对话（critical 默认允许） */
  interruptible?: boolean;
  source: string;
  /**
   * 共享发现层共同键（2026-10-19）：本提案"属于哪个主题"（目标=goalId，
   * 其余=主体词）。直达车道据此在开口前读走其它层的同主题发现（预留，不拼正文）。
   */
  subject?: string;
  /** 是否在请用户拍板（是则不参与跨源重复降档） */
  needsUser?: boolean;
  /**
   * 本次开口从共享发现层读走的 finding 指纹（composeBeforeOpen 预留所得）。
   * 随提案持久化：deferred 挂起后真的投递出去（flushDue 重裁决 delivered）才能结算
   * 成消费，被丢弃则释放回总线。管道 decide 依提案最终去向结算，调用方无需关心。
   */
  findingFingerprints?: string[];
  /** 代办结果详情（仅 action.* 提案）：键值对形式（商品/金额/渠道...），
   * 投递成功后随提案落入助手动态台账，客户端详情浮层直接展示 */
  detail?: Record<string, string>;
  /** 效用评估输入（方案 A/B）：缺省不评估，既有提案仲裁行为不变 */
  utility?: ProposalUtilityMeta;
  /** 提案级确认（ask_first）：确认文案投递后登记待确认，批准回调 onProposalApproved */
  confirmAction?: { label: string };
  /**
   * 定向投递（2026-10-13）：缺省 = 全部在线设备 fan-out（旧行为）；声明为
   * "mobile" 时投递只面向手机端——桌面在线不构成对手机的送达，也不让桌面
   * 收到重复通知（到点提醒的手机离线补达用：挂起待手机重连 / 升级手机推送）。
   */
  targetDeviceClass?: "mobile" | "desktop";
};

export type ProposalVerdict =
  | "delivered"
  | "deferred"
  | "merged"
  | "suppressed"
  | "silenced"
  | "throttled"
  | "expired"
  | "dropped";

/** 一次触达的生命周期结果（delivered 为初始态，由客户端回传更新） */
export type ProactiveOutcome =
  | "delivered"
  | "viewed"
  | "accepted"
  | "dismissed"
  | "snoozed"
  | "ignored"
  | "replied";

/**
 * 触达通道：
 *  - in_app：两端在线 WS fan-out 直推
 *  - mobile_push：两端离线时必达/critical 升级手机系统推送
 *  （offline_inbox 站内信兜底已删除 2026-10-14：站内信职责是后台→用户的
 *    平台消息/更新通知，不承载聊天式提醒；离线无推送通道一律挂起待重连）
 */
export type DeliveryChannel = "in_app" | "mobile_push";

/** 仲裁结果（决策链可解释：verdict + 每步原因） */
export type ArbitrationDecision = {
  proposal: ProactiveProposal;
  verdict: ProposalVerdict;
  reasonChain: string[];
  deliverAfter?: number;
  /** 效用评估结果（声明了 utility 的提案附带；silenced 判定的留痕数据源） */
  utility?: ActionUtilityResult;
};
