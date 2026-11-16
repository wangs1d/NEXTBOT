/**
 * bill_parcel.list / bill_parcel.summary —— 账单与快递汇总查询（2026-11-13）。
 *
 * **只读本地台账，不现打外部接口。**账单/快递条目由邮件与短信两条链路持续汇入
 * （MailWatchService → BillParcelIngestService / MessageHub onInbound → BillParcelLedger），
 * 本工具只做本地查询——采到什么报什么，库里没有就如实说没有，绝不编造。
 *
 * 与 order.status 的分工：那个查的是「外卖/订单当前状态」（实时语义），
 * 这里查的是「识别并汇总下来的账单与快递条目」（台账语义）。用户问
 * "这个月话费扣了多少""我最近有快递吗，取件码多少"走的是这一组。
 */
import type { ToolHandler, ToolRegistry } from "./tool-registry.js";
import type { BillParcelLedger } from "../services/bill-parcel-ledger.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type BillParcelToolsDeps = {
  ledger: BillParcelLedger;
};

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function createBillParcelListHandler(deps: BillParcelToolsDeps): ToolHandler {
  return async (input: Record<string, unknown>, context) => {
    const actorId = resolveActorId(context);
    const category = input.category === "bill" || input.category === "parcel" ? input.category : undefined;
    const entries = deps.ledger.list({
      category,
      actorId,
      limit: asInt(input.limit, 20, 1, 100),
      ...(input.days != null
        ? { since: Date.now() - asInt(input.days, 30, 1, 365) * 24 * 60 * 60 * 1000 }
        : {}),
    });
    if (entries.length === 0) {
      return {
        ok: true,
        hasEntries: false,
        summary: "台账里还没有识别到账单或快递条目（邮件与短信链路上暂时没有相关内容）",
        hint: "如实告知用户当前没有识别到账单/快递，不要编造单号或金额",
      };
    }
    return {
      ok: true,
      hasEntries: true,
      entries: entries.map((e) => ({
        category: e.category,
        source: e.source,
        title: e.title,
        amount: e.amount,
        billType: e.billType,
        trackingNo: e.trackingNo,
        pickupCode: e.pickupCode,
        carrier: e.carrier,
        occurredAt: new Date(e.occurredAt).toISOString(),
        excerpt: e.excerpt.slice(0, 200),
      })),
      summary: `识别到 ${entries.length} 条账单/快递条目，最新一条：${entries[0]?.title ?? ""}`,
      hint: "按时间从新到旧列出。金额字段为 null 表示原文里没写金额，不要自己换算",
    };
  };
}

export function createBillParcelSummaryHandler(deps: BillParcelToolsDeps): ToolHandler {
  return async (input: Record<string, unknown>, context) => {
    const actorId = resolveActorId(context);
    const days = asInt(input.days, 30, 1, 365);
    const s = deps.ledger.summary({ actorId, days });
    if (s.bills.count === 0 && s.parcels.count === 0) {
      return {
        ok: true,
        hasEntries: false,
        summary: `最近 ${days} 天没有识别到账单或快递条目`,
        hint: "如实告知用户没有数据，不要编造合计金额",
      };
    }
    const parts: string[] = [];
    if (s.bills.count > 0) {
      parts.push(
        `账单 ${s.bills.count} 笔` +
          (s.bills.amountCount > 0 ? `，合计 ¥${s.bills.totalAmount}` : "（原文未含金额，无法合计）"),
      );
    }
    if (s.parcels.count > 0) {
      parts.push(
        `快递 ${s.parcels.count} 件` +
          (s.parcels.awaitingPickup > 0 ? `，其中 ${s.parcels.awaitingPickup} 件待取` : ""),
      );
    }
    return {
      ok: true,
      hasEntries: true,
      window: { days: s.window.days, from: new Date(s.window.from).toISOString(), to: new Date(s.window.to).toISOString() },
      bills: s.bills,
      parcels: {
        count: s.parcels.count,
        awaitingPickup: s.parcels.awaitingPickup,
        byCarrier: s.parcels.byCarrier,
        latestPickup: s.parcels.latestPickup
          ? {
              title: s.parcels.latestPickup.title,
              pickupCode: s.parcels.latestPickup.pickupCode,
              occurredAt: new Date(s.parcels.latestPickup.occurredAt).toISOString(),
            }
          : null,
      },
      recent: s.recent.map((e) => ({
        category: e.category,
        source: e.source,
        title: e.title,
        amount: e.amount,
        occurredAt: new Date(e.occurredAt).toISOString(),
      })),
      summary: `最近 ${days} 天：${parts.join("；")}`,
      hint: "合计只统计原文里写了金额的条目；没有金额的账单不要并入合计",
    };
  };
}

export function registerBillParcelTools(registry: ToolRegistry, deps: BillParcelToolsDeps): void {
  registry.register("bill_parcel.list", createBillParcelListHandler(deps));
  registry.register("bill_parcel.summary", createBillParcelSummaryHandler(deps));
}

// ─── LLM 可见的工具定义 ────────────────────────────────────────────────

export const BILL_PARCEL_LIST_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "bill_parcel.list",
    description:
      "查询已识别并汇总下来的账单与快递条目明细（来自邮件与短信自动识别）。" +
      "回答「我最近有哪些快递」「取件码是多少」「有哪些账单」时调用。" +
      "可按类别过滤（bill=账单 / parcel=快递），可限定最近天数。" +
      "返回里 amount 为 null 表示原文没写金额，不要自己换算或编造。",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["bill", "parcel"], description: "可选：按类别过滤" },
        days: { type: "integer", description: "可选：只看最近 N 天（缺省不限，上限 365）" },
        limit: { type: "integer", description: "可选：返回条数（缺省 20，上限 100）" },
      },
      additionalProperties: false,
    },
  },
};

export const BILL_PARCEL_SUMMARY_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "bill_parcel.summary",
    description:
      "汇总最近一段时间的账单与快递（来自邮件与短信自动识别）：" +
      "账单笔数与金额合计（按话费/还款/银行卡等分组）、快递件数与待取件数量。" +
      "回答「这个月话费扣了多少」「我最近有快递吗」时调用。" +
      "注意：合计只统计原文里写了金额的条目，没写金额的不并入合计。",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "可选：汇总最近 N 天（缺省 30，上限 365）" },
      },
      additionalProperties: false,
    },
  },
};

/** 供 LLM 侧汇总的内置工具定义。 */
export const BILL_PARCEL_CHAT_TOOLS: ChatCompletionTool[] = [
  BILL_PARCEL_LIST_CHAT_TOOL,
  BILL_PARCEL_SUMMARY_CHAT_TOOL,
];

/** 工具元数据（供 tool-search 索引用）。 */
export const BILL_PARCEL_TOOL_METADATA = [
  {
    name: "bill_parcel.list",
    displayName: "账单快递明细",
    description: "查询邮件与短信中识别出的账单与快递条目（含金额、单号、取件码）",
    tags: ["账单", "快递", "取件码", "话费", "物流", "bill", "parcel", "tracking"],
  },
  {
    name: "bill_parcel.summary",
    displayName: "账单快递汇总",
    description: "汇总最近一段时间的账单金额与快递件数、待取件清单",
    tags: ["账单", "快递", "汇总", "话费", "bill", "parcel", "summary"],
  },
];
