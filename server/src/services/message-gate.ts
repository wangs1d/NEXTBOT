// 消息入口闸（2026-10-14 定调）：不是所有入站消息都进 MessageHub——
// 与用户内容无关的垃圾（验证码/营销群发/物流模板）在入口直接挡住，
// 不落库、不进传感内核、不触发任何主动链路。
//
// 设计原则（零 LLM、确定性、宁误放不误杀反向平衡）：
//  - 强模板特征（验证码/退订指令/贷款中奖）命中即挡——这类 99% 是系统群发
//  - 营销堆词做密度判定（≥2 个商业词才挡）——单词误杀率高（"包邮"也可能出现在
//    朋友的闲聊里）
//  - 豁免先行：人际触达（请尽快回复/速回）、日程变动信号（航班取消/会议改期）、
//    财务白名单平台（alipay 通知监听本身已筛过）优先放行
//  - MESSAGE_HUB_GATE=off 全局关闸（排障/回退用）
//
// 拦截语义：gated 消息对外表现为「不存在」——调用方拿到合成壳
// （conversation/message 对象齐备、unreadCount=0），但库里查不到、不产生未读。

import type { MessageHubInboundInput } from "./message-hub-service.js";
import { detectScheduleChange } from "../proactivity/triggers/message-watch-trigger.js";

export type MessageGateVerdict = {
  gated: boolean;
  /** 拦截原因（strong_noise / commercial_density），放行时缺省 */
  reason?: string;
};

/** 强模板特征：命中即挡。验证码/码类、退订指令、金融诈骗模板。 */
const STRONG_NOISE_RE =
  /(验证码|校验码|动态码|取件码|回复TD|退订回[T]|回T退订|拒收请回复|中奖|贷款|催收|逾期还款|额度(申请|提升|已满))/;

/** 商业推广词：密度判定（去重后 ≥2 个不同词才挡）。 */
const COMMERCIAL_WORDS_RE =
  /(优惠券|秒杀|限时|折扣|满减|包邮|领券|抽奖|积分兑换|会员日|新品上市|新品上架|活动价|立减|砍价|拼团|特惠|直降|促销|大促|上新|扫码进店|点击购买)/g;

/** 人际触达信号：有人找用户本人，优先放行（用户相关的强证据）。 */
const HUMAN_URGENT_RE = /(请尽快回复|尽快回复|马上回电|速回|回个电话|回电)/;

/** 白名单平台：alipay（通知监听自身已按包名筛选）、friend（站内好友消息，
 * 产品内建的人际通道，模板垃圾无法由此进入——「我中奖了哈哈」这类玩笑话
 * 绝不能被强模板特征静默吞掉）。 */
const GATE_EXEMPT_PLATFORMS = new Set<string>(["alipay", "friend"]);

export function gateInboundMessage(input: MessageHubInboundInput): MessageGateVerdict {
  if (process.env.MESSAGE_HUB_GATE === "off") return { gated: false };
  if (GATE_EXEMPT_PLATFORMS.has(input.platform)) return { gated: false };
  // 通知捕捉（2026-10-18）：端侧通知监听白名单已筛过来源（同 alipay 豁免逻辑），
  // 且取件码/验证码/物流进度正是用户向 agent 检索的高价值信息——
  // 捕捉走「全量镜像、消费时过滤」分层，入口闸不再二次裁决内容价值。
  if (input.meta?.source === "phone_capture") return { gated: false };
  const text = input.text ?? "";
  if (text.trim().length === 0) return { gated: false };
  if (HUMAN_URGENT_RE.test(text)) return { gated: false };
  // 日程变动信号（航班取消/会议改期等）是用户相关的强证据，放行
  if (detectScheduleChange(text) != null) return { gated: false };
  if (STRONG_NOISE_RE.test(text)) return { gated: true, reason: "strong_noise" };
  const hits = new Set(text.match(COMMERCIAL_WORDS_RE) ?? []);
  if (hits.size >= 2) return { gated: true, reason: "commercial_density" };
  return { gated: false };
}
