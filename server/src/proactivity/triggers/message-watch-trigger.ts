// 消息监控触发器（proactivity 触发源之一）：盯用户手机入站消息，
// 识别「日程变动」类信号（延迟/改期/取消…）→ 主动提案告知用户。
//
// 数据链路：微信桥 / 通用消息桥 → MessageHubService.ingestInbound()
//   → onInbound 回调 → 本触发器识别 → ProactivePipeline.submitProposal()
//   → 仲裁投递（对话流摘要弹窗）+ action.* 台账落库（「代办足迹」卡）。
//
// actorId 归一：渠道隔离的入站会话 id 形如 `actorId@wechat`（对话线程/记忆按
// 渠道隔离），但主动提案的触达目标（WS 设备）与代办足迹台账都按**基础 actor**
// 归属——客户端查询带的是裸 actorId，设备也绑定在裸 actorId 上。此处统一剥回
// 基础 actor，否则提案投不出去、足迹客户端也查不到。
//
// 识别策略（v1 零 LLM，确定性规则）：日程变动动词 ×（日程语境词 | 时间表达）双条件
// 命中才提案，黑名单先行排除通知/营销噪声；同会话 10 分钟冷却 + dedupKey 指纹防重。
import { createHash } from "node:crypto";
import { resolveBaseActorId } from "../../agent/master-chat-session.js";
import type { MessageHubInboundInput } from "../../services/message-hub-service.js";
import type { ProactiveProposal } from "../pipeline-types.js";

export type MessageWatchDeps = {
  submitProposal: (p: ProactiveProposal) => void;
  /** 提案时间基准（单测注入固定时钟） */
  now?: () => number;
  /** 提案重要度（默认 high）：静默时段(23-7点) high 会被顺延到早7点，
   * 设为 critical 可立即投递（紧急日程变动夜间唤醒场景） */
  importance?: ProactiveProposal["importance"];
};

/** 日程变动动词：命中其一才考虑提案 */
const CHANGE_VERB = /(推迟|延迟|延误|延后|改期|改到|换到|改个时间|改时间|提前|取消|时间有变|有变动)/;
/** 日程语境词或时间表达：与动词同时命中才提案，避免「取消订单」类误报 */
const SCHEDULE_CONTEXT = /(会议|开会|周会|例会|课|上课|面试|预约|约|日程|安排|航班|车|火车|飞机|放映|球局|饭局)|(\d{1,2}[:：点]\d{0,2})|(上午|下午|傍晚|晚上|明天|后天|今晚|明晚)/;
/** 明确的噪声：通知/营销/系统短信，直接忽略 */
const NOISE = /(验证码|校验码|取件码|快递|物流|退订|回复TD|流量|话费|账单|积分|优惠券|贷款|中奖|招聘|快递单号)/;

/** 同一会话的提案冷却：群聊刷屏时不重复打扰 */
const PER_CONVERSATION_COOLDOWN_MS = 10 * 60 * 1000;
/** 超长文本（文章/邮件正文类）不作为变动信号 */
const MAX_TEXT_LENGTH = 300;

export function detectScheduleChange(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return null;
  if (NOISE.test(trimmed)) return null;
  if (!CHANGE_VERB.test(trimmed)) return null;
  if (!SCHEDULE_CONTEXT.test(trimmed)) return null;
  const verb = trimmed.match(CHANGE_VERB)![0]!;
  return verb;
}

export class MessageWatchTrigger {
  private readonly lastProposalAt = new Map<string, number>();

  constructor(private readonly deps: MessageWatchDeps) {}

  /** MessageHub 入站消息统一回调：同步、零 LLM、异常静默（不阻断消息落库主链路） */
  handleInbound(input: MessageHubInboundInput): void {
    try {
      const verb = detectScheduleChange(input.text);
      if (verb == null) return;

      // 触达与足迹按基础 actor 归属（渠道 scoped 会话只隔离对话，不隔离主动性）
      const actorId = resolveBaseActorId(input.actorId);
      const now = (this.deps.now ?? Date.now)();
      const cooldownKey = `${actorId}:${input.channelId}`;
      const last = this.lastProposalAt.get(cooldownKey);
      if (last != null && now - last < PER_CONVERSATION_COOLDOWN_MS) return;
      this.lastProposalAt.set(cooldownKey, now);

      const sender = input.senderName?.trim() || input.participantName?.trim() || input.channelId;
      // 共同键（2026-10-19 二期）：从命中的「日程语境词」里取（会议/航班/面试…），
      // 而不是留给推断从长句里挑出「日程变动」这种无区分度的词。取不到语境词
      //（只有时间表达）时不硬给——退回推断兜底，宁可不给键也不给假键。
      const ctxWord = input.text.trim().match(SCHEDULE_CONTEXT)?.[1]?.trim();
      let excerpt = input.text.trim().replace(/\s+/g, " ").slice(0, 120);
      // 消息正文自带「发件人：」前缀时摘要去重，避免 summary 出现「李雷：李雷：…」
      if (sender && excerpt.startsWith(`${sender}：`)) {
        excerpt = excerpt.slice(sender.length + 1).trim();
      }
      const fingerprint = createHash("sha1")
        .update(`${actorId}|${input.channelId}|${excerpt}`)
        .digest("hex")
        .slice(0, 16);

      this.deps.submitProposal({
        proposalId: `mw_${fingerprint}`,
        actorId,
        // action.* 前缀：投递成功后由投递层自动落入代办足迹台账
        kind: "action.schedule_change",
        tier: "must",
        importance: this.deps.importance ?? "high",
        dedupKey: `schedule_change:${fingerprint}`,
        title: "发现日程变动",
        summary: `${sender ?? "联系人"}：${excerpt}`,
        evidence: [
          "message_watch",
          `platform:${input.platform}`,
          `keyword:${verb}`,
          `channel:${input.channelId}`,
        ],
        directText:
          `刚帮你盯着消息呢——${sender ?? "有人"}发来「${excerpt}」，` +
          `看起来涉及日程变动。要我帮你改日程或者提醒相关的人吗？`,
        createdAt: now,
        // 不设 expiresAt：静默时段被顺延到早7点的提案仍然有效
        // （「昨晚说会议改期」早上告知依旧有用），由 dedupKey 防重
        source: "message_watch",
        // 共同键：日程语境词（会议/航班/面试…）；取不到则缺省，由管道推断兜底
        ...(ctxWord ? { subject: ctxWord } : {}),
        detail: {
          来源: platformLabel(input.platform),
          发件人: sender ?? "未知",
          原文: excerpt,
        },
        // 待确认动作（2026-10-01）：通知升半级——不只弹提醒，附「让助手处理」
        // 确认入口。效用声明走 ask_first 分支（代用户对外做事必须先问），
        // 批准经管道 onProposalApproved 派后台任务起草处理建议（LLM 只花在
        // 用户点头之后，决策链仍零 LLM）。
        utility: {
          risk: {
            reversible: true,
            financialImpact: "none",
            dataSensitivity: "personal",
            thirdPartyImpact: true,
          },
          authorization: "none",
        },
        confirmAction: { label: "让助手处理" },
      });
    } catch {
      /* 监控失败不影响消息主链路 */
    }
  }
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "wechat": return "微信";
    case "qq": return "QQ";
    case "feishu": return "飞书";
    case "sms": return "短信";
    default: return "手机消息";
  }
}
