import { getMeituanConfig, type MeituanConfig } from "../config/meituan-config.js";

export interface MeituanPricingRequest {
  pickupAddress: string;
  pickupDetail?: string;
  deliveryAddress: string;
  deliveryDetail?: string;
  itemDescription?: string;
  itemWeight?: number;
  expressType?: number;
}

export interface MeituanPricingResult {
  ok: boolean;
  deliveryFee?: number;
  totalFee?: number;
  distance?: number;
  estimatedTime?: string;
  expressType?: number;
  error?: string;
  rawResponse?: unknown;
}

export interface MeituanCreateOrderRequest {
  pickupAddress: string;
  pickupDetail?: string;
  pickupPhone?: string;
  pickupName?: string;
  deliveryAddress: string;
  deliveryDetail?: string;
  deliveryPhone?: string;
  deliveryName?: string;
  itemDescription: string;
  itemWeight?: number;
  expressType?: number;
  tipAmount?: number;
  remark?: string;
  orderSource?: string;
}

export interface MeituanCreateOrderResult {
  ok: boolean;
  orderId?: string;
  deliveryId?: string;
  status?: string;
  deliveryFee?: number;
  totalFee?: number;
  estimatedTime?: string;
  error?: string;
  rawResponse?: unknown;
}

export interface MeituanQueryOrderResult {
  ok: boolean;
  orderId: string;
  status?: string;
  statusDesc?: string;
  riderName?: string;
  riderPhone?: string;
  riderLat?: number;
  riderLng?: number;
  estimatedTime?: string;
  error?: string;
  rawResponse?: unknown;
}

export class MeituanService {
  private config: MeituanConfig;

  constructor(configOverride?: Partial<MeituanConfig>) {
    this.config = { ...getMeituanConfig(), ...configOverride };
  }

  private get token(): string {
    return this.config.accessToken;
  }

  private get skillId(): string {
    return this.config.skillId;
  }

  private get baseUrl(): string {
    return this.config.apiBaseUrl;
  }

  private async apiCall<T>(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}/skills/${this.skillId}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Access-Token": this.token,
    };

    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        if (contentType.includes("json")) {
          const errBody = (await response.json()) as Record<string, unknown>;
          errMsg = (errBody.msg || errBody.message || errBody.error || errMsg) as string;
        } else {
          const text = await response.text();
          if (text.length < 500) errMsg = text;
        }
      } catch {
        const text = await response.text();
        if (text.length < 500) errMsg = text;
      }
      throw new Error(errMsg);
    }

    if (!contentType.includes("json")) {
      const text = await response.text();
      if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
        throw new Error("API 返回了 HTML 页面，请检查 MEITUAN_AI_HUB_API_BASE 配置是否正确");
      }
      return JSON.parse(text) as T;
    }

    return (await response.json()) as T;
  }

  async pricing(req: MeituanPricingRequest): Promise<MeituanPricingResult> {
    try {
      const result = await this.apiCall<Record<string, unknown>>(
        "/pricing",
        "POST",
        {
          pickup_address: req.pickupAddress,
          pickup_detail: req.pickupDetail || "",
          delivery_address: req.deliveryAddress,
          delivery_detail: req.deliveryDetail || "",
          item_description: req.itemDescription || "",
          item_weight: req.itemWeight || 1.0,
          express_type: req.expressType || 1,
        }
      );

      return {
        ok: true,
        deliveryFee: (result.data as Record<string, unknown>)?.delivery_fee as number
          || result.delivery_fee as number,
        totalFee: (result.data as Record<string, unknown>)?.total_fee as number
          || result.total_fee as number,
        distance: (result.data as Record<string, unknown>)?.distance as number
          || result.distance as number,
        estimatedTime: ((result.data as Record<string, unknown>)?.estimated_time
          || result.estimated_time) as string,
        expressType: ((result.data as Record<string, unknown>)?.express_type
          || result.express_type) as number,
        rawResponse: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `询价失败：${message}` };
    }
  }

  async createOrder(req: MeituanCreateOrderRequest): Promise<MeituanCreateOrderResult> {
    try {
      const result = await this.apiCall<Record<string, unknown>>(
        "/create",
        "POST",
        {
          pickup_address: req.pickupAddress,
          pickup_detail: req.pickupDetail || "",
          pickup_phone: req.pickupPhone || "",
          pickup_name: req.pickupName || "",
          delivery_address: req.deliveryAddress,
          delivery_detail: req.deliveryDetail || "",
          delivery_phone: req.deliveryPhone || "",
          delivery_name: req.deliveryName || "",
          item_description: req.itemDescription,
          item_weight: req.itemWeight || 1.0,
          express_type: req.expressType || 1,
          tip_amount: req.tipAmount || 0,
          remark: req.remark || "",
          order_source: req.orderSource || "nextbot",
        }
      );

      return {
        ok: true,
        orderId: ((result.data as Record<string, unknown>)?.order_id
          || result.order_id) as string,
        deliveryId: ((result.data as Record<string, unknown>)?.delivery_id
          || result.delivery_id) as string,
        status: ((result.data as Record<string, unknown>)?.status
          || result.status) as string,
        deliveryFee: ((result.data as Record<string, unknown>)?.delivery_fee
          || result.delivery_fee) as number,
        totalFee: ((result.data as Record<string, unknown>)?.total_fee
          || result.total_fee) as number,
        estimatedTime: ((result.data as Record<string, unknown>)?.estimated_time
          || result.estimated_time) as string,
        rawResponse: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `创建订单失败：${message}` };
    }
  }

  async queryOrder(orderId: string): Promise<MeituanQueryOrderResult> {
    try {
      const result = await this.apiCall<Record<string, unknown>>(
        `/query?order_id=${encodeURIComponent(orderId)}`,
        "GET"
      );

      return {
        ok: true,
        orderId,
        status: ((result.data as Record<string, unknown>)?.status
          || result.status) as string,
        statusDesc: ((result.data as Record<string, unknown>)?.status_desc
          || result.status_desc) as string,
        riderName: ((result.data as Record<string, unknown>)?.rider_name
          || result.rider_name) as string,
        riderPhone: ((result.data as Record<string, unknown>)?.rider_phone
          || result.rider_phone) as string,
        riderLat: ((result.data as Record<string, unknown>)?.rider_lat
          || result.rider_lat) as number,
        riderLng: ((result.data as Record<string, unknown>)?.rider_lng
          || result.rider_lng) as number,
        estimatedTime: ((result.data as Record<string, unknown>)?.estimated_time
          || result.estimated_time) as string,
        rawResponse: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, orderId, error: `查询订单失败：${message}` };
    }
  }

  async cancelOrder(orderId: string, reason?: string): Promise<{ ok: boolean; orderId: string; error?: string }> {
    try {
      const result = await this.apiCall<Record<string, unknown>>(
        "/cancel",
        "POST",
        {
          order_id: orderId,
          cancel_reason: reason || "用户取消",
        }
      );

      const ok = (result.code === 0 || result.code === 200 || result.success === true);
      return {
        ok,
        orderId,
        error: ok ? undefined : ((result.msg || result.message) as string),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, orderId, error: `取消订单失败：${message}` };
    }
  }

  estimatePrice(description: string): { low: number; high: number } {
    const chars = description.length;
    if (chars < 10) return { low: 8, high: 18 };
    if (chars < 30) return { low: 12, high: 25 };
    return { low: 18, high: 40 };
  }
}
