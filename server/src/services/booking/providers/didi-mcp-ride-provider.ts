/**
 * 滴滴出行 Provider（官方 MCP 桥接，travel-upgrade-plan P2 接驳下单链）。
 *
 * 用户已接入滴滴官方 MCP（http 端点，别名 didi，经 McpClientService）：
 *   maps_textsearch（POI 搜索拿坐标）→ taxi_estimate（估价，沙箱返回自由文本）
 *   → taxi_create_order（下单）→ taxi_query_order / taxi_get_driver_location（查单）
 *   → taxi_cancel_order（取消）。
 *
 * 桥接意义：ride_hailing.* 工具族此前只有 simulated/amap 两个 provider，
 * 接驳提醒确认后的「真实下单」没有走滴滴。本 provider 把滴滴 MCP 并入
 * BookingService 的 ride 域（数组首位、availability 优先），让接驳确认后
 * ride_hailing.quote → book 两阶段确认真实走到滴滴（开发/沙箱环境为滴滴
 * 官方沙箱 Mock 端点，生产配真实 Key 后同链路真实下单）。
 *
 * 诚实边界：
 *   - 估价文本解析不出车型/流程ID 时不造假 option（返回明确错误）；
 *   - 沙箱估价金额多为非承诺预估，解析不出 amount 时按 null 处理（以平台为准）；
 *   - 下单未返回订单号视为失败，不虚构「已下单」。
 */
import type {
  BookingProvider,
  BookingProviderBookPayload,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderStatusPayload,
  BookingDraft,
  BookingOption,
  BookingSearchQuery,
  BookingOrderStatus,
} from "../booking-provider.js";
import type { McpClientService } from "../../mcp-client-service.js";

/** 从 MCP 工具结果提取文本（content[].text 或原始 JSON） */
function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}

/** 深度查找对象中第一个命中 key 的值 */
function deepFind(obj: unknown, keyPattern: RegExp): unknown {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFind(item, keyPattern);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (keyPattern.test(k) && v !== undefined && v !== null && v !== "") return v;
      const hit = deepFind(v, keyPattern);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 从工具结果文本中解析 JSON（尽力而为） */
function parseResultJson(result: Record<string, unknown>): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return text;
}

/** optionId 形态：didi:{estimate_trace_id}:{product_category} */
const OPTION_ID_RE = /^didi:([A-Za-z0-9_-]+):(\d+)$/;

export class DidiMcpRideProvider implements BookingProvider {
  readonly key = "didi";
  readonly domain = "ride" as const;
  readonly label = "滴滴出行（官方 MCP）";

  constructor(private readonly mcp: McpClientService) {}

  private serverReady(): boolean {
    return this.mcp.listServers().some((s) => s.alias === "didi");
  }

  /** 不可用原因（null = 可用）。未配 key 时回落模拟 provider，配上即自动接管首选。 */
  private availabilityIssue(): string | null {
    const server = this.mcp.listServers().find((s) => s.alias === "didi");
    if (!server) return "滴滴 MCP server 未注册（检查 MCP 配置 data/mcp-servers.json 中的 didi 端点）";
    if (server.url?.includes("${DIDI_MCP_KEY}") && !process.env.DIDI_MCP_KEY?.trim()) {
      return "未配置 DIDI_MCP_KEY（滴滴端点无法鉴权），暂由模拟 provider 兜底";
    }
    return null;
  }

  availability(): { ok: boolean; reason?: string } {
    const issue = this.availabilityIssue();
    return issue ? { ok: false, reason: issue } : { ok: true };
  }

  /** maps_textsearch：地址 → {lng,lat,name}（滴滴要求坐标来自本工具，不能假设） */
  private async textsearch(
    keywords: string,
    city?: string,
  ): Promise<{ lng: string; lat: string; name: string } | null> {
    const res = await this.mcp.callTool(
      "didi",
      "maps_textsearch",
      { keywords, ...(city ? { city } : {}) },
      20_000,
    );
    if (!res.ok) return null;
    const parsed = parseResultJson(res.result);
    const loc = deepFind(parsed, /^(location|lng_lat|coord)$/i);
    let lng: unknown;
    let lat: unknown;
    if (loc && typeof loc === "object") {
      lng = (loc as { lng?: unknown }).lng;
      lat = (loc as { lat?: unknown }).lat;
    }
    if (lng === undefined || lat === undefined) return null;
    const name = String(deepFind(parsed, /^(name|title)$/i) || keywords);
    return { lng: String(lng), lat: String(lat), name };
  }

  async search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const dropoffText = typeof query.params.dropoff === "string" ? query.params.dropoff.trim() : "";
    if (!dropoffText) return { ok: false, error: "缺少 dropoff（目的地）", retryable: true };
    const pickupText = typeof query.params.pickup === "string" ? query.params.pickup.trim() : "";
    const city = query.city?.trim() || undefined;

    // 起点：显式地址 → textsearch；缺省 → 客户端 GPS（坐标在手，name 取 label）
    let from: { lng: string; lat: string; name: string };
    if (pickupText) {
      const r = await this.textsearch(pickupText, city);
      if (!r) return { ok: false, error: `无法定位起点「${pickupText}」，请换更具体的地址`, retryable: true };
      from = r;
    } else {
      const loc = ctx.location ?? query.location;
      if (loc) {
        from = {
          lng: loc.longitude.toFixed(6),
          lat: loc.latitude.toFixed(6),
          name: loc.label?.trim() || "当前位置",
        };
      } else {
        return { ok: false, error: "缺少起点：请提供 pickup，或确保客户端已上报定位", retryable: true };
      }
    }

    const dest = await this.textsearch(dropoffText, city);
    if (!dest) return { ok: false, error: `无法定位目的地「${dropoffText}」，请换更具体的地址`, retryable: true };

    // 数字/坐标参数一律传字符串（滴滴 MCP 契约）
    const est = await this.mcp.callTool(
      "didi",
      "taxi_estimate",
      {
        from_lng: from.lng,
        from_lat: from.lat,
        from_name: from.name,
        to_lng: dest.lng,
        to_lat: dest.lat,
        to_name: dest.name,
      },
      30_000,
    );
    if (!est.ok) return { ok: false, error: "滴滴估价请求失败（MCP 调用未成功）", retryable: true };

    // 沙箱估价是自由文本：解析「车型 (product_category: N)」行 + 预估流程ID + 预估价
    const text = textOf(est.result);
    const categories = [
      ...text.matchAll(/([\u4e00-\u9fa5A-Za-z]{2,6})\s*[（(]\s*product_category[:：=]\s*(\d+)\s*[）)]/g),
    ];
    const traceId = text.match(/预估流程ID[:：]\s*([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const amount = Number(text.match(/(?:预估|约)[^0-9]{0,6}[¥￥]?\s*(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
    const eta = Number(text.match(/(\d+)\s*分钟内?[接驾|到达]/)?.[1] ?? NaN);
    if (categories.length === 0 || !traceId) {
      return {
        ok: false,
        error: `滴滴估价返回无法解析（片段：${text.slice(0, 80)}），请稍后重试`,
        retryable: true,
      };
    }

    const options: BookingOption[] = categories.slice(0, 4).map((m) => ({
      // 报价上下文（流程ID/车型）编码进 optionId，下单阶段原样带回
      id: `didi:${traceId}:${m[2]}`,
      provider: this.key,
      title: `${m[1]}${Number.isFinite(amount) ? `（预估 ¥${amount}）` : ""}`,
      description: `${from.name} → ${dest.name}${Number.isFinite(amount) ? ` · 预估 ¥${amount}` : " · 价格以平台为准"}`,
      amountCny: Number.isFinite(amount) ? amount : null,
      currency: "CNY" as const,
      etaMinutes: Number.isFinite(eta) ? eta : null,
      extra: { carType: m[1], estimateTraceId: traceId, productCategory: m[2] },
    }));
    return {
      ok: true,
      options,
      note: "滴滴官方 MCP 报价；下单需两阶段确认（confirm + confirmationToken）",
    };
  }

  async book(
    draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    const m = OPTION_ID_RE.exec(draft.optionId);
    if (!m) {
      return {
        ok: false,
        error: `optionId 非滴滴报价形态（${draft.optionId.slice(0, 40)}），请先 ride_hailing.quote 重新报价`,
        retryable: true,
      };
    }
    const [, traceId, category] = m;
    const res = await this.mcp.callTool(
      "didi",
      "taxi_create_order",
      { product_category: category, estimate_trace_id: traceId },
      45_000,
    );
    if (!res.ok) return { ok: false, error: "滴滴下单请求失败（MCP 调用未成功）", retryable: true };
    const text = textOf(res.result);
    const orderId =
      String(deepFind(parseResultJson(res.result), /order_id|orderId/i) ?? "") ||
      text.match(/订单号[:：]\s*([A-Za-z0-9]+)/)?.[1] ||
      "";
    if (!orderId) return { ok: false, error: `滴滴下单未返回订单号（${text.slice(0, 80)}）`, retryable: true };
    return {
      ok: true,
      providerOrderId: orderId,
      status: "confirmed",
      message: `滴滴已下单，订单号 ${orderId}`,
    };
  }

  async getStatus(
    ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    const res = await this.mcp.callTool("didi", "taxi_query_order", { order_id: ref.providerOrderId }, 30_000);
    if (!res.ok) return { ok: false, error: "滴滴查单失败（MCP 调用未成功）", retryable: true };
    const text = textOf(res.result);
    // 沙箱状态推进：0 匹配中 → 1 已接单 → 2 已到达 → 4 行程中 → 5 完成
    const code = Number(
      String(deepFind(parseResultJson(res.result), /^status(_code)?$/i) ?? text.match(/状态码?[:：]\s*(\d)/)?.[1] ?? NaN),
    );
    const map: Record<number, BookingOrderStatus> = { 0: "confirmed", 1: "confirmed", 2: "confirmed", 4: "in_progress", 5: "completed" };
    // 司机位置尽力补一条动态信息（失败不影响查单结果）
    let tracking: Record<string, unknown> | undefined;
    const drv = await this.mcp
      .callTool("didi", "taxi_get_driver_location", { order_id: ref.providerOrderId }, 20_000)
      .catch(() => null);
    if (drv?.ok) {
      const parsed = parseResultJson(drv.result) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") tracking = parsed;
    }
    return {
      ok: true,
      status: map[code] ?? "confirmed",
      message: text.slice(0, 200) || undefined,
      tracking,
    };
  }

  async cancel(
    ref: BookingProviderRef,
    reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    const res = await this.mcp.callTool(
      "didi",
      "taxi_cancel_order",
      { order_id: ref.providerOrderId, ...(reason ? { reason } : {}) },
      30_000,
    );
    if (!res.ok) return { ok: false, error: "滴滴取消请求失败（MCP 调用未成功）", retryable: true };
    return { ok: true, message: textOf(res.result).slice(0, 120) || "滴滴订单已取消" };
  }
}
