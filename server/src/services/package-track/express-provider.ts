/**
 * 运单轨迹 provider：拿到运单号后用它补官方轨迹节点。
 *
 * fail-closed：未配密钥、承运商不在白名单、接口报错一律返回明确 reason 与下一步，
 * 绝不拿空轨迹冒充"查过了没有"，也不用通知摘录拼轨迹。
 *
 * 无凭据实现、未实盘验证的两处：手机后四位字段名 `checkPhoneNo`、时间戳按官方示例
 * 取 13 位毫秒。返回参数错误就对照文档改字段名，签名错误先怀疑时间戳精度
 * ——错误响应已原样带回 msgData 前 200 字便于定位。
 */
import { createHash, randomUUID } from "node:crypto";

import { getPackageTrackConfig, type PackageTrackConfig } from "../../config/package-track-config.js";
import type { PackageTrackPoint } from "./package-store.js";

/** 丰桥路由查询服务代码 */
const SF_SERVICE_CODE = "EXP_RECE_SEARCH_ROUTES";

export type TrackFailureReason =
  | "unconfigured"
  | "unsupported"
  | "needs_phone"
  | "http"
  | "parse"
  | "rejected";

export type TrackOutcome =
  | { ok: true; provider: string; points: PackageTrackPoint[] }
  | { ok: false; provider: string; reason: TrackFailureReason; error: string };

export type TrackQueryInput = {
  trackingNo: string;
  courierCode: string | null;
  /** 收件手机后四位：顺丰/中通等散单查件的强制校验项 */
  phoneTail: string | null;
};

export interface ExpressTrackProvider {
  id: string;
  /** 密钥齐备 = 可发起真实请求 */
  configured(): boolean;
  supports(courierCode: string | null, trackingNo: string): boolean;
  queryRoutes(input: TrackQueryInput): Promise<TrackOutcome>;
}

/** 丰桥验签：sign = Base64(MD5hex(msg + timestamp + 校验码)) */
export function buildSfSign(msg: string, timestamp: string, checkWord: string): string {
  const md5Hex = createHash("md5").update(`${msg}${timestamp}${checkWord}`, "utf8").digest("hex");
  return Buffer.from(md5Hex, "utf8").toString("base64");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 把接口错误文案归成结构化 reason，方便工具侧给出下一步（缺后四位 ≠ 系统故障） */
function classifyRejection(message: string): TrackFailureReason {
  return /(手机|后四位|校验|电话号)/.test(message) ? "needs_phone" : "rejected";
}

function extractRoutes(inner: Record<string, unknown>): Array<Record<string, unknown>> {
  const msgData = inner.msgData;
  const first = Array.isArray(msgData) ? asRecord(msgData[0]) : asRecord(msgData);
  const raw = first?.routes ?? inner.routes;
  return Array.isArray(raw) ? raw.map(asRecord).filter((r): r is Record<string, unknown> => r != null) : [];
}

export class SfQiaoProvider implements ExpressTrackProvider {
  readonly id = "sf_qiao";
  private readonly cfg: PackageTrackConfig;

  constructor(env?: NodeJS.ProcessEnv) {
    this.cfg = getPackageTrackConfig(env ?? process.env);
  }

  configured(): boolean {
    return Boolean(this.cfg.sfPartnerId && this.cfg.sfCheckWord);
  }

  supports(courierCode: string | null, trackingNo: string): boolean {
    const code = (courierCode ?? "").toUpperCase();
    if (code === "SF") return true;
    if (this.cfg.sfExtraCouriers.includes(code)) return true;
    // 承运商没认出来，但单号是顺丰形态：允许试查
    return code === "" && /^SF\d/i.test(trackingNo);
  }

  async queryRoutes(input: TrackQueryInput): Promise<TrackOutcome> {
    if (!this.configured()) {
      return {
        ok: false,
        provider: this.id,
        reason: "unconfigured",
        error: "未配置顺丰丰桥密钥（SF_QIAO_PARTNER_ID / SF_QIAO_CHECK_WORD），无法补全官方轨迹",
      };
    }
    if (!this.supports(input.courierCode, input.trackingNo)) {
      return {
        ok: false,
        provider: this.id,
        reason: "unsupported",
        error: `承运商 ${input.courierCode ?? "未知"} 未在丰桥可查白名单内（确认覆盖后可加入 SF_QIAO_EXTRA_COURIERS）`,
      };
    }

    const msg = JSON.stringify({
      language: "zh-CN",
      trackingNumber: input.trackingNo,
      methodType: "1",
      ...(input.phoneTail ? { checkPhoneNo: input.phoneTail } : {}),
    });
    const timestamp = String(Date.now());
    const body = new URLSearchParams({
      partnerID: this.cfg.sfPartnerId,
      requestID: `pkg_${Date.now()}_${randomUUID().slice(0, 8)}`,
      serviceCode: SF_SERVICE_CODE,
      timestamp,
      msg,
      sign: buildSfSign(msg, timestamp, this.cfg.sfCheckWord),
      lang: "zh-CN",
    });

    let rawText = "";
    try {
      const res = await fetch(this.cfg.sfApiBaseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      rawText = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          provider: this.id,
          reason: "http",
          error: `丰桥路由查询 HTTP ${res.status}：${rawText.slice(0, 200)}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        reason: "http",
        error: `丰桥路由查询请求失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let outer: Record<string, unknown> | null;
    try {
      outer = asRecord(JSON.parse(rawText));
    } catch {
      return { ok: false, provider: this.id, reason: "parse", error: `丰桥响应非 JSON：${rawText.slice(0, 200)}` };
    }
    if (!outer) {
      return { ok: false, provider: this.id, reason: "parse", error: `丰桥响应结构异常：${rawText.slice(0, 200)}` };
    }

    // 外层 apiResultData 是字符串化 JSON（丰桥惯例）
    let inner: Record<string, unknown> | null = null;
    const dataRaw = outer.apiResultData;
    if (typeof dataRaw === "string") {
      try {
        inner = asRecord(JSON.parse(dataRaw));
      } catch {
        /* 交给下面的 errorCode 分支报错 */
      }
    } else {
      inner = asRecord(dataRaw) ?? outer;
    }

    const message = [outer.apiErrorMsg, inner?.errorMsg, inner?.message]
      .map((v) => (typeof v === "string" ? v : ""))
      .filter(Boolean)
      .join(" / ");

    if (outer.apiResultCode && outer.apiResultCode !== "S0000") {
      return { ok: false, provider: this.id, reason: classifyRejection(message), error: `丰桥拒绝：${outer.apiResultCode} ${message || rawText.slice(0, 160)}` };
    }
    if (inner?.success === false) {
      return { ok: false, provider: this.id, reason: classifyRejection(message), error: `丰桥业务失败：${message || rawText.slice(0, 160)}` };
    }
    if (!inner) {
      return { ok: false, provider: this.id, reason: "parse", error: `丰桥响应缺 apiResultData：${rawText.slice(0, 200)}` };
    }

    const points: PackageTrackPoint[] = extractRoutes(inner).map((route) => {
      const time = String(route.acceptTime ?? route.time ?? "").trim();
      const address = String(route.acceptAddress ?? route.address ?? "").trim();
      const remark = String(route.remark ?? route.status ?? route.description ?? "").trim();
      return {
        time: time || "未知时刻",
        description: [address, remark].filter(Boolean).join(" ") || "（丰桥未回传节点描述）",
      };
    });

    return { ok: true, provider: this.id, points };
  }
}

/**
 * 选 provider：v1 只有丰桥，按承运商判定能不能查。
 * 返回 null = 没有任何可用后端（调用方须如实告知"轨迹补全未接入"）。
 */
export function selectProvider(
  providers: ExpressTrackProvider[],
  courierCode: string | null,
  trackingNo: string,
): ExpressTrackProvider | null {
  const usable = providers.filter((p) => p.configured() && p.supports(courierCode, trackingNo));
  return usable[0] ?? null;
}
