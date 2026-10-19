/**
 * 方案 D：承诺驱动的主动触发源（CommitmentTrigger）。
 *
 * 承诺板（agentic-memory/commitment-board）的扫描循环负责承诺状态机——
 * deadline 临近 → 梯度提醒、超时未完成 → 按 escalationPolicy 升级、
 * 依赖满足 → 通知推进；本触发源是它在主动性架构（提案-仲裁分离）里的
 * 适配层：把承诺事件映射为带效用元数据（方案 A）的 ProactiveProposal
 * 提交统一管道，由仲裁链决定投递 / 先问 / 沉默。
 *
 * 效用维度映射（确定性规则，与承诺方差异化文案对齐）：
 *   - 代发催促（needsAuthorization）：不可逆 + 影响第三方 + 无授权 → ask_first
 *     （管道投递的即确认请求文案，用户同意后才真正执行）；
 *   - 自动提取的承诺按置信度折算期望价值（低置信低价值 → 可被仲裁沉默）；
 *   - 手动/确认过的承诺视为用户显式授权（kind=must 直投语义）。
 */
import {
  commitmentProposalFromEvent,
  composeCommitmentNudgeText,
  type CommitmentEvent,
  type CommitmentRecord,
  type CommitmentScanReport,
} from "../../agentic-memory/commitment-board.js";
import {
  deriveNotifyValue,
  type AuthorizationLevel,
  type RiskDimensions,
} from "../action-utility.js";
import type { ProactiveProposal, ProposalUtilityMeta } from "../pipeline-types.js";

/** 承诺板最小外观（便于测试注入 fake；生产传 CommitmentBoard 实例） */
export interface CommitmentBoardFacade {
  setNotifier(notifier: ((event: CommitmentEvent) => void) | null): void;
  scanOnce?(now?: Date): Promise<CommitmentScanReport>;
}

export type CommitmentTriggerDeps = {
  board: CommitmentBoardFacade;
  /** 统一管道入口（ProactivePipeline.submitProposal 的薄包装） */
  submit: (p: ProactiveProposal) => void;
  now?: () => number;
};

let proposalSeq = 0;

export class CommitmentTrigger {
  private attached = false;

  constructor(private readonly deps: CommitmentTriggerDeps) {}

  /** 接线：承诺板事件 → 本触发源（装配层在 board 构造后调用） */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.deps.board.setNotifier((event) => {
      this.handleEvent(event);
    });
  }

  /** 单轮扫描直通（驱动承诺状态机；缺省由 board 自身 startScan 周期驱动） */
  async scan(now?: Date): Promise<CommitmentScanReport | null> {
    return this.deps.board.scanOnce ? this.deps.board.scanOnce(now) : null;
  }

  /** 事件 → 提案（导出供测试与诊断；内部接线自动调用） */
  handleEvent(event: CommitmentEvent): ProactiveProposal | null {
    const draft = commitmentProposalFromEvent(event);
    if (!draft) return null; // 信息性事件（superseded 等）保持沉默

    const c = event.commitment;
    const now = this.deps.now?.() ?? Date.now();
    const proposal: ProactiveProposal = {
      proposalId: `commitment_${c.id}_${event.type}_${now.toString(36)}_${(proposalSeq++).toString(36)}`,
      actorId: c.actorId,
      kind: draft.kind,
      tier: draft.tier,
      importance: draft.importance,
      dedupKey: draft.dedupKey,
      title: draft.title,
      summary: event.message,
      evidence: [
        ...c.evidenceLedgerIds.map((id) => `ledger:${id}`),
        `commitment=${c.id}`,
        `committedBy=${c.committedBy}`,
        `source=${c.source}`,
      ],
      directText: draft.directText,
      createdAt: now,
      source: "commitment-board",
      // 共同键（2026-10-19 二期）：同一条承诺的多次事件（临近提醒 / 超时升级 / 依赖满足）
      // 共享同一 subject（承诺 id）——于是它们不再各弹一条，而由共享发现层合并进同一条开口，
      // 同一承诺不会碎片化。相当于目标侧用 goalId 做共同键的同构做法。
      subject: c.id,
      utility: utilityForEvent(event, draft.needsAuthorization, draft.importance),
      // 代催类：确认文案投递后登记提案级待确认，用户批准才真正落地
      ...(draft.needsAuthorization ? { confirmAction: { label: "代发催促" } } : {}),
      // 代催执行数据（批准后 sendCommitmentNudge 读取）：目标渠道 + 承诺 id
      ...(draft.contact
        ? {
            detail: {
              commitmentId: c.id,
              contactPlatform: draft.contact.platform,
              contactChannelId: draft.contact.channelId,
              ...(draft.contact.participantName ? { contactName: draft.contact.participantName } : {}),
            },
          }
        : {}),
    };
    this.deps.submit(proposal);
    return proposal;
  }
}

// ============================================================
// 代催真实外发（ask_first 批准后的执行端）
// ============================================================

/** 代催外发依赖（结构化最小外观，便于单测注入 fake） */
export interface CommitmentNudgeSenderDeps {
  /** message-hub 外发落库（自动 upsert 会话） */
  createOutbound: (input: {
    actorId: string;
    platform: string;
    channelId: string;
    text: string;
    participantId?: string;
    participantName?: string;
    title?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
  /** 平台网关真实外发（微信/QQ/飞书 HTTP bridge；未配置 URL 时 delivered=false 本地排队） */
  gatewaySend: (input: {
    actorId: string;
    platform: string;
    channelId: string;
    text: string;
  }) => Promise<{
    ok: boolean;
    delivered?: boolean;
    message?: string | null;
    externalMessageId?: string | null;
  }>;
  /** 承诺板读取（文案组装 + 状态复核：仅 active 才代催） */
  getCommitment: (id: string) => CommitmentRecord | null;
  /** 承诺板 notes 审计（代发留痕，escalation 时间线可追溯） */
  updateCommitmentNotes: (id: string, notes: string) => unknown;
}

/**
 * 执行一次代催真实外发（提案级确认批准后由装配层回调）。
 * 从提案 detail 取目标渠道（contactPlatform/contactChannelId），文案由
 * composeCommitmentNudgeText 确定性组装；网关返回 delivered=false（bridge
 * 未配置）仍算已提交——消息落入 message-hub 会话，用户可在消息中心看到。
 */
export async function sendCommitmentNudge(
  deps: CommitmentNudgeSenderDeps,
  proposal: ProactiveProposal,
): Promise<{ sent: boolean; delivered: boolean; detail: string }> {
  const d = proposal.detail ?? {};
  const commitmentId = d.commitmentId;
  const platform = d.contactPlatform;
  const channelId = d.contactChannelId;
  if (!commitmentId || !platform || !channelId) {
    return { sent: false, delivered: false, detail: "提案缺少代催目标渠道（承诺未登记 contact）" };
  }
  const commitment = deps.getCommitment(commitmentId);
  if (!commitment) {
    return { sent: false, delivered: false, detail: `承诺不存在：${commitmentId}` };
  }
  if (commitment.status !== "active") {
    return { sent: false, delivered: false, detail: `承诺状态已变更为 ${commitment.status}，跳过代催` };
  }

  const text = composeCommitmentNudgeText(commitment);
  const sendResult = await deps.gatewaySend({ actorId: proposal.actorId, platform, channelId, text });
  await deps.createOutbound({
    actorId: proposal.actorId,
    platform,
    channelId,
    text,
    participantName: d.contactName,
    title: d.contactName ? `与 ${d.contactName} 的会话` : undefined,
    meta: {
      delivered: sendResult.delivered === true,
      platformMessage: sendResult.message ?? "",
      nudgeFor: commitmentId,
      origin: "commitment-nudge",
    },
  });
  deps.updateCommitmentNotes(
    commitmentId,
    `已代发催促（platform=${platform} delivered=${sendResult.delivered ? "yes" : "queued"}）`,
  );
  return {
    sent: true,
    delivered: sendResult.delivered === true,
    detail: sendResult.delivered
      ? "催促消息已送达对方会话"
      : `消息已提交${sendResult.message ? `（${sendResult.message}）` : "，待渠道可用后送出"}`,
  };
}

/**
 * 效用元数据映射（零 LLM；importance 直接取承诺板产出的草稿——单一事实源）：
 *   代催（needsAuthorization）→ 不可逆 + 第三方 + 无授权（规则 3 ask_first）；
 *   其余为通知类：可逆无风险，授权按承诺来源（manual=显式 / auto=隐式），
 *   期望价值 = 重要度基线 × 自动提取置信度（低置信承诺可被沉默）。
 */
export function utilityForEvent(
  event: CommitmentEvent,
  needsAuthorization: boolean,
  importance: "critical" | "high" | "medium" | "low",
): ProposalUtilityMeta {
  const c = event.commitment;
  const risk: RiskDimensions = needsAuthorization
    ? { reversible: false, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: true }
    : { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false };
  const authorization: AuthorizationLevel = needsAuthorization
    ? "none"
    : c.source === "manual"
      ? "explicit"
      : "implicit";
  const notify = deriveNotifyValue(importance);
  // 置信度折算带下限（P1-2）：待确认承诺不折算——确认是消解不确定性的动作，
  // 价值不打折；自动提取的 active 承诺 0.7 + 0.3×conf，保证温和提醒档
  // （medium，0.45 基线 × factor ≥ 0.315 > 0.3 打扰成本）不会被效用评估
  // 整档静默——降噪改由 tier=social 频控承担，silence 只留给真正的低净效用。
  const factor =
    c.status === "pending_confirmation"
      ? 1
      : c.source === "auto" && c.confidence !== null
        ? Math.round((0.7 + 0.3 * c.confidence) * 1000) / 1000
        : 1;
  return {
    risk,
    authorization,
    value: {
      expectedValue: Math.round(notify.expectedValue * factor * 1000) / 1000,
      interruptionCost: notify.interruptionCost,
    },
  };
}
