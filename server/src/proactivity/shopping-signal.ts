/**
 * 购物/订单信号派生（2026-10-19，handoff probe 的数据源半边）。
 *
 * 定位（用户定调）：订单状态**不该是模型现打外部接口查的**，而该由「主动搜集
 * 数据源」持续汇入跨源库（SourceStore，stream="shopping"）——手机通知捕捉
 * （phone.msg.report → MessageHubService）天然是最丰富的订单事件源：美团/饿了么
 * 的「骑手已取货 / 已送达」通知都会被手机桥捕捉上报。
 *
 * 本模块只做一件确定性的事：从入站通知里**认出订单类信号**，派生成 shopping 流
 * 的 Signal 喂进 SensorKernel（→ onSignal → SourceStore.feed）。零 LLM，关键词
 * 白名单，误报的代价只是多一条查询结果。
 *
 * 查询半边在 tools/shopping-tools.ts 的 order.status（只读跨源库）。
 */
import type { Signal } from "./sensors/types.js";

/** 订单类通知词（命中即派生 shopping 信号；白名单从严，宁漏勿滥） */
const ORDER_NOTIFY_RE =
  /(美团|饿了么|外卖|骑手|已送达|已签收|配送中|已接单|取餐|订单已|下单成功|已发货|待取货|包裹)/;

/** djb2：fingerprint 稳定去重用（同内容同指纹，跨窗口不重复分发） */
function hash32(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export type OrderNotifyInput = {
  actorId: string;
  /** 来源平台（meituan / eleme / android_notify…原样透传） */
  platform: string;
  /** 通知标题（如「美团外卖」） */
  title?: string;
  /** 通知正文（如「您的订单已送达，请及时取餐」） */
  text: string;
  /** 信号时刻（缺省 Date.now；测试注入） */
  at?: number;
};

/**
 * 从一条入站通知派生订单信号；非订单类返回 null（调用方直接跳过）。
 */
export function deriveOrderSignal(input: OrderNotifyInput): Signal | null {
  const platform = String(input.platform ?? "").trim();
  const title = String(input.title ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!text && !title) return null;
  const haystack = `${title} ${text}`;
  if (!ORDER_NOTIFY_RE.test(haystack)) return null;

  const at = input.at ?? Date.now();
  const summary = `${title ? `${title}：` : ""}${text}`.replace(/\s+/g, " ").trim();
  return {
    stream: "shopping",
    actorId: input.actorId || undefined,
    at,
    fingerprint: `order:${hash32(`${platform}|${summary}`)}`,
    salience: "medium",
    delta: `【${platform || "通知"}】${summary.slice(0, 160)}`,
    payload: {
      platform,
      title,
      text: text.slice(0, 300),
      source: "phone_capture",
    },
  };
}
