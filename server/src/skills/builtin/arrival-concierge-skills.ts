import { resolveActorId } from "../../agent/actor-id.js";
import type { ArrivalMonitorService } from "../../services/arrival-concierge/arrival-monitor-service.js";
import type { BookingService } from "../../services/booking/booking-service.js";
import { travelTicketStore } from "../../skills/travel-planning/travel-ticket-store.js";
import type { SkillDefinition } from "../types.js";

/**
 * 内置 Skill：到站管家（接站 / 接机 / 到站打车）。
 *
 * 与 arrival-monitor-service 配合：
 *   - travel.arrival-monitor  开/关某张票的航班/高铁动态监控
 *   - travel.arrival-status   查询行程动态快照（阶段/延误/航站楼）
 *   - travel.pickup-set       录入接站人（姓名 + 手机号/平台会话）
 *   - travel.pickup-send      发送接站通知（用户确认草稿后真实外发）
 *   - travel.arrival-ride     到站约车：走统一预订层 ride 域（真实下单，
 *                             两阶段确认）
 */

type Deps = {
  arrivalMonitor: ArrivalMonitorService;
  bookingService: BookingService;
};

/** 选票：显式 ticketId 优先（须属于本人），否则取本人最近一张未过期的机票/火车票。 */
function resolveTicket(
  input: Record<string, unknown>,
  actorId: string,
): { ok: true; ticketId: string } | { ok: false; error: string } {
  const explicit = typeof input.ticketId === "string" ? input.ticketId.trim() : "";
  if (explicit) {
    const owned = travelTicketStore.get(explicit, actorId);
    return owned
      ? { ok: true, ticketId: explicit }
      : { ok: false, error: "票不存在或不属于当前用户" };
  }
  const upcoming = travelTicketStore.listUpcoming(10, actorId).filter((t) => t.type !== "hotel");
  if (upcoming.length === 0) {
    return { ok: false, error: "票夹里没有进行中的机票/火车票。可把行程短信/邮件发给 agent（travel.parse-ticket 自动归档）" };
  }
  return { ok: true, ticketId: upcoming[0].ticketId };
}

export function createArrivalConciergeBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { arrivalMonitor, bookingService } = deps;

  const arrival_monitor: SkillDefinition = {
    metadata: {
      name: "travel.arrival-monitor",
      version: "1.0.0",
      displayName: "到站监控开关",
      description:
        "开启/关闭某张机票/火车票的到站监控：agent 会动态跟踪航班/车次状态（票面时间 + 实时 API + 设备定位兜底），" +
        "快到时（到达前 45 分钟）提醒行程动态，落地后按接站人设置通知来接、或提案到站约车。" +
        "出票确认（booking.travel-issue）后建议主动开启；不传 ticketId 时作用于最近一张进行中的票。",
      kind: "builtin",
      tags: ["travel", "arrival", "monitor", "接站", "接机", "到站"],
      icon: "🛬",
      parameters: [
        { name: "action", type: "string", required: true, description: "enable / disable" },
        { name: "ticketId", type: "string", required: false, description: "票夹 ticketId（缺省取最近一张机票/火车票）" },
      ],
      outputSchema: { ok: "boolean", summary: "结果说明" },
      permissions: ["storage:write"],
      timeoutMs: 15_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ticket = resolveTicket(input, actorId);
      if (!ticket.ok) return { ok: false, error: ticket.error, actorId };
      const action = input.action === "disable" ? "disable" : "enable";
      const result =
        action === "enable"
          ? arrivalMonitor.enable(ticket.ticketId, actorId)
          : arrivalMonitor.disable(ticket.ticketId, actorId);
      return { ok: result.ok, actorId, ticketId: ticket.ticketId, summary: result.summary };
    },
  };

  const arrival_status: SkillDefinition = {
    metadata: {
      name: "travel.arrival-status",
      version: "1.0.0",
      displayName: "查询行程动态",
      description:
        "查询机票/火车票的实时行程动态：当前阶段（未出发/已出发/即将到达/已到达）、预计到达时间、晚点分钟数、航站楼等。" +
        "用户问「飞机几点到」「高铁晚点没」「快到了吗」时调用。",
      kind: "builtin",
      tags: ["travel", "arrival", "航班", "高铁", "动态"],
      icon: "📡",
      parameters: [
        { name: "ticketId", type: "string", required: false, description: "票夹 ticketId（缺省取最近一张机票/火车票）" },
      ],
      outputSchema: { ok: "boolean", summary: "动态描述", snapshot: "结构化快照" },
      permissions: ["storage:read"],
      timeoutMs: 15_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ticket = resolveTicket(input, actorId);
      if (!ticket.ok) return { ok: false, error: ticket.error, actorId };
      const result = await arrivalMonitor.getSnapshot(ticket.ticketId, actorId);
      return { ok: result.ok, actorId, ticketId: ticket.ticketId, summary: result.summary, snapshot: result.snapshot };
    },
  };

  const pickup_set: SkillDefinition = {
    metadata: {
      name: "travel.pickup-set",
      version: "1.0.0",
      displayName: "设置接站人",
      description:
        "为某张票设置接站人：姓名 + 手机号（短信通知）或微信/QQ/飞书会话 id。autoSend=true 表示到站时直接发送通知" +
        "（免确认）；缺省 false，到站时先给用户过目草稿、确认后再发。",
      kind: "builtin",
      tags: ["travel", "pickup", "接站", "接机", "联系人"],
      icon: "🤝",
      parameters: [
        { name: "name", type: "string", required: true, description: "接站人姓名" },
        { name: "phone", type: "string", required: false, description: "手机号（短信通道）" },
        { name: "channel", type: "string", required: false, description: "sms / wechat / qq / feishu（缺省自动推断）" },
        { name: "channelTarget", type: "string", required: false, description: "平台桥会话/接收 id（wechat/qq/feishu 时必填）" },
        { name: "autoSend", type: "boolean", required: false, description: "到站时免确认直接发送（缺省 false）" },
        { name: "ticketId", type: "string", required: false, description: "票夹 ticketId（缺省取最近一张）" },
      ],
      outputSchema: { ok: "boolean", summary: "结果说明" },
      permissions: ["storage:write", "contacts:read"],
      timeoutMs: 15_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ticket = resolveTicket(input, actorId);
      if (!ticket.ok) return { ok: false, error: ticket.error, actorId };
      const result = arrivalMonitor.setPickupContact(ticket.ticketId, actorId, {
        name: typeof input.name === "string" ? input.name : "",
        phone: typeof input.phone === "string" ? input.phone.trim() || undefined : undefined,
        channel: input.channel === "sms" || input.channel === "wechat" || input.channel === "qq" || input.channel === "feishu"
          ? input.channel
          : undefined,
        channelTarget: typeof input.channelTarget === "string" ? input.channelTarget : undefined,
        autoSend: input.autoSend === true,
      });
      return { ok: result.ok, actorId, ticketId: ticket.ticketId, summary: result.summary };
    },
  };

  const pickup_send: SkillDefinition = {
    metadata: {
      name: "travel.pickup-send",
      version: "1.0.0",
      displayName: "发送接站通知",
      description:
        "把接站通知真实发给接站人（短信/微信桥）。两种入口：1) 到站时 agent 给出的草稿（带 draftId），用户确认后调用；" +
        "2) 直接指定 ticketId 立即发送。发送结果如实转告用户（通道失败时说明原因）。",
      kind: "builtin",
      tags: ["travel", "pickup", "接站", "发送", "短信", "微信"],
      icon: "📤",
      parameters: [
        { name: "draftId", type: "string", required: false, description: "待确认草稿 id（到站提案里给出）" },
        { name: "ticketId", type: "string", required: false, description: "票夹 ticketId（无 draftId 时直接发送）" },
      ],
      outputSchema: { ok: "boolean", summary: "发送结果" },
      permissions: ["notifications:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const draftId = typeof input.draftId === "string" ? input.draftId.trim() : "";
      if (draftId) {
        const draft = arrivalMonitor.consumePickupDraft(draftId, actorId);
        if (!draft) return { ok: false, error: `草稿 ${draftId} 不存在或已处理`, actorId };
        const result = await arrivalMonitor.sendPickupNow(draft.ticketId, actorId);
        return { ok: result.ok, actorId, ticketId: draft.ticketId, summary: result.summary };
      }
      const ticket = resolveTicket(input, actorId);
      if (!ticket.ok) return { ok: false, error: ticket.error, actorId };
      const result = await arrivalMonitor.sendPickupNow(ticket.ticketId, actorId);
      return { ok: result.ok, actorId, ticketId: ticket.ticketId, summary: result.summary };
    },
  };

  const arrival_ride: SkillDefinition = {
    metadata: {
      name: "travel.arrival-ride",
      version: "1.0.0",
      displayName: "到站约车",
      description:
        "用户落地/到站后叫车：从票夹自动取到达站/机场作为上车点，走统一预订层 ride 域两阶段确认真实下单" +
        "（阶段一返回报价与 confirmationToken，向用户复述价格后带 confirm=true+confirmationToken 完成预订）。" +
        "dropoff 缺省时可建议「回家」（结合常去地点）或直接询问；tier 可选 economy/comfort/business。",
      kind: "builtin",
      tags: ["travel", "ride", "打车", "网约车", "到站"],
      icon: "🚕",
      parameters: [
        { name: "dropoff", type: "string", required: true, description: "目的地（如「家」「xx小区」；不确定时先询问用户）" },
        { name: "ticketId", type: "string", required: false, description: "票夹 ticketId（缺省取最近一张机票/火车票）" },
        { name: "tier", type: "string", required: false, description: "车型偏好：economy / comfort / business（缺省取首个可用）" },
        { name: "confirm", type: "boolean", required: false, description: "阶段二：true 时必须带 confirmationToken" },
        { name: "confirmationToken", type: "string", required: false, description: "阶段一返回的确认 token" },
      ],
      outputSchema: { ok: "boolean", summary: "结果说明", orderId: "订单号", paymentUrl: "支付链接（如有）" },
      permissions: ["location:read"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ticket = resolveTicket(input, actorId);
      if (!ticket.ok) return { ok: false, error: ticket.error, actorId };
      const t = arrivalMonitor.getTicket(ticket.ticketId, actorId);
      if (!t) return { ok: false, error: `票 ${ticket.ticketId} 不存在`, actorId };
      const dropoff = typeof input.dropoff === "string" ? input.dropoff.trim() : "";
      if (!dropoff) return { ok: false, error: "缺少 dropoff（目的地）；可结合常去地点建议「回家」或直接询问", actorId };

      const pickup = t.toStation ? `${t.toStation}到达层` : "";
      const confirm = input.confirm === true;

      // 阶段二：直接用 token 完成下单（草稿已在阶段一 mint）
      if (confirm) {
        const result = await bookingService.book(context, "ride", {
          optionId: "",
          params: { pickup, dropoff },
          confirm: true,
          confirmationToken: typeof input.confirmationToken === "string" ? input.confirmationToken : undefined,
        });
        if (!result.ok) return { ok: false, error: result.error, actorId, ticketId: ticket.ticketId };
        return { actorId, ticketId: ticket.ticketId, ...result };
      }

      // 阶段一：先报价拿到当前可用的 optionId，再 mint 确认 token
      const search = await bookingService.search(context, "ride", {
        params: { pickup, dropoff },
      });
      if (!search.ok) return { ok: false, error: search.error, actorId, ticketId: ticket.ticketId };
      const options = (search as { options?: Array<{ id: string; title: string }> }).options ?? [];
      const tierRaw = typeof input.tier === "string" ? input.tier.trim().toLowerCase() : "";
      const tierWant = tierRaw.startsWith("econ") ? "eco" : tierRaw.startsWith("busi") ? "business" : tierRaw ? "comfort" : null;
      const option =
        (tierWant ? options.find((o) => o.id === tierWant || o.id.endsWith(`:${tierWant}`) || o.title.includes(tierWant)) : undefined) ??
        options[0];
      if (!option) {
        return { ok: false, error: `未拿到可用车型：${search.note ?? "无选项"}`, actorId, ticketId: ticket.ticketId };
      }
      const result = await bookingService.book(context, "ride", {
        optionId: option.id,
        params: { pickup, dropoff, note: `到站约车（${t.carrier}${t.code ? " " + t.code : ""}）` },
        confirm: false,
      });
      if (!result.ok) return { ok: false, error: result.error, actorId, ticketId: ticket.ticketId };
      return {
        actorId,
        ticketId: ticket.ticketId,
        ...result,
        hint:
          result.needsConfirmation
            ? "请向用户复述报价摘要，得到明确同意后带 confirm=true + confirmationToken 再调用完成真实下单"
            : undefined,
      };
    },
  };

  return [arrival_monitor, arrival_status, pickup_set, pickup_send, arrival_ride];
}

export function registerArrivalConciergeBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createArrivalConciergeBuiltinSkills(deps)) {
    register(s);
  }
}
