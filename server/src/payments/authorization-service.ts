import { randomBytes } from "node:crypto";

import { amountToCents, centsToAmount } from "./money.js";
import type { UnifiedPaymentStore } from "./store.js";
import { PROVIDER_CHANNELS, providerOf } from "./types.js";
import type {
  AuthorizationStatus,
  BizDomain,
  PaymentAuthorization,
  PaymentChannelId,
  PaymentLimits,
} from "./types.js";

/**
 * 支付授权服务 —— 「打通支付授权」的核心。
 *
 * 一句话：用户先给出**可量化、可撤销、留痕**的代付授权，agent 才可能在
 * 额度内直接付钱；没有授权就一次都付不出去。
 *
 * 四道闸（顺序固定，先严后宽）：
 *   1. 授权存在且 active（未撤销/未过期）——否则 requires_authorization
 *   2. 业务类别在授权范围内（* 或具体域）
 *   3. 单笔 / 日累计 / 月累计额度（pending 单也占用额度，防连开多单绕过）
 *   4. 免确认额度（autoApproveCny）：超出即需要用户逐笔确认
 *
 * 授权书内容（consentText）由服务端生成并随授权一起存库：变更额度必须重新
 * 同意，旧授权自动置为 revoked，形成可追溯的授权版本链。
 */

export const AUTHORIZATION_CONSENT_VERSION = "2026-11-13.1";

const KNOWN_CATEGORIES = new Set<string>([
  "travel",
  "ride",
  "delivery",
  "dining",
  "express",
  "utility",
  "shopping",
  "recharge",
  "service",
  "other",
]);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 授权默认额度（用户未自定义时）：单笔 500 / 日 1000 / 月 5000，且默认逐笔确认。 */
export function defaultLimits(): PaymentLimits {
  return {
    perTxCny: envNumber("PAYMENT_AUTH_PER_TX_CNY", 500),
    dailyCny: envNumber("PAYMENT_AUTH_DAILY_CNY", 1000),
    monthlyCny: envNumber("PAYMENT_AUTH_MONTHLY_CNY", 5000),
    autoApproveCny: envNumber("PAYMENT_AUTH_AUTO_APPROVE_CNY", 0),
  };
}

export function defaultAuthorizationDays(): number {
  return envNumber("PAYMENT_AUTH_VALID_DAYS", 30);
}

export interface CreateAuthorizationInput {
  actorId: string;
  channel: PaymentChannelId;
  limits?: Partial<PaymentLimits>;
  categories?: string[];
  /** 用户是否在授权页明确点击同意；false/缺失一律不落 active */
  accepted: boolean;
  /** 授权页来源（web / client …），仅留痕 */
  source?: string;
  validDays?: number;
}

export interface AuthorizationDecision {
  allowed: boolean;
  /** allowed=false 时的用户可读原因（Agent 直接转述） */
  reason?: string;
  /** 是否需要用户逐笔确认（仅 allowed=true 时有意义） */
  needsConfirm: boolean;
  usedTodayCny: number;
  usedThisMonthCny: number;
}

export class PaymentAuthorizationService {
  constructor(private readonly store: UnifiedPaymentStore) {}

  private normalizeLimits(input?: Partial<PaymentLimits>): PaymentLimits {
    const base = defaultLimits();
    const pick = (v: unknown, fallback: number): number => {
      if (v === undefined || v === null || v === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
    };
    return {
      perTxCny: pick(input?.perTxCny, base.perTxCny),
      dailyCny: pick(input?.dailyCny, base.dailyCny),
      monthlyCny: pick(input?.monthlyCny, base.monthlyCny),
      autoApproveCny: pick(input?.autoApproveCny, base.autoApproveCny),
    };
  }

  private normalizeCategories(input?: string[]): string[] {
    const list = (input ?? ["*"])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean);
    if (list.length === 0) return ["*"];
    if (list.includes("*")) return ["*"];
    const valid = list.filter((c) => KNOWN_CATEGORIES.has(c));
    return valid.length > 0 ? Array.from(new Set(valid)) : ["*"];
  }

  buildConsentText(auth: {
    channel: PaymentChannelId;
    limits: PaymentLimits;
    categories: string[];
    validDays: number;
  }): string {
    const auto =
      auth.limits.autoApproveCny > 0
        ? `单笔 ≤ ¥${auth.limits.autoApproveCny} 可免二次确认直接支付；超出部分每笔都需你确认`
        : "每一笔支付都需要你确认后才会扣款";
    const scope = auth.categories.includes("*") ? "全部消费类别" : auth.categories.join("、");
    return [
      `我授权 NEXTBOT 使用${auth.channel === "alipay_sandbox" ? "支付宝" : auth.channel === "wechat" ? "微信支付" : auth.channel === "alipay_bot" ? "支付宝" : "模拟支付"}渠道，`,
      `在${scope}范围内代我发起支付：单笔上限 ¥${auth.limits.perTxCny || "不限"}，`,
      `日累计上限 ¥${auth.limits.dailyCny || "不限"}，月累计上限 ¥${auth.limits.monthlyCny || "不限"}；`,
      `${auto}；授权有效期 ${auth.validDays} 天，我可随时在应用中撤销。`,
      "扣款均从已绑定账户原路支付，NEXTBOT 不保存支付密码、不可提现、不代收资金。",
    ].join("");
  }

  create(input: CreateAuthorizationInput): { ok: boolean; authorization?: PaymentAuthorization; error?: string } {
    if (!input.accepted) {
      return { ok: false, error: "授权未确认：必须由用户本人在授权页明确同意后才能创建" };
    }
    const actorId = input.actorId?.trim();
    if (!actorId) return { ok: false, error: "缺少用户标识（actorId）" };

    const limits = this.normalizeLimits(input.limits);
    const categories = this.normalizeCategories(input.categories);
    const validDays = Math.max(0, Math.floor(input.validDays ?? defaultAuthorizationDays()));

    // 免确认额度不得高于单笔上限（否则「免确认」形同虚设）
    if (limits.perTxCny > 0 && limits.autoApproveCny > limits.perTxCny) {
      return { ok: false, error: `免确认额度（¥${limits.autoApproveCny}）不能高于单笔上限（¥${limits.perTxCny}）` };
    }
    if (limits.dailyCny > 0 && limits.perTxCny > limits.dailyCny) {
      return { ok: false, error: `单笔上限（¥${limits.perTxCny}）不能高于日累计上限（¥${limits.dailyCny}）` };
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = validDays > 0 ? new Date(now.getTime() + validDays * 86_400_000).toISOString() : null;
    const consentText = this.buildConsentText({
      channel: input.channel,
      limits,
      categories,
      validDays,
    });

    const row: PaymentAuthorization = {
      id: `pa_${randomBytes(9).toString("hex")}`,
      actorId,
      channel: input.channel,
      status: "active",
      limits,
      categories,
      consentVersion: AUTHORIZATION_CONSENT_VERSION,
      consentText: [consentText, input.source ? `（来源：${input.source}）` : ""].join(""),
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    };
    if (!this.store.upsertActiveAuthorization(row)) {
      return { ok: false, error: "授权写入失败（存储不可用）" };
    }
    this.store.addEvent(`auth:${row.id}`, "authorization_created", {
      actorId: row.actorId,
      channel: row.channel,
      limits: row.limits,
      categories: row.categories,
      expiresAt: row.expiresAt,
    });
    return { ok: true, authorization: row };
  }

  /**
   * 取当前生效的授权。
   *
   * 先找同渠道的；没有再按 **provider** 找——用户授权的是「可以用支付宝付款」，
   * 不是「只能用支付宝扫码」。电脑扫码、手机网站支付属于同一个支付宝，
   * 换一种付款方式不该让用户重新授权一遍。
   */
  getActive(actorId: string, channel: PaymentChannelId): PaymentAuthorization | null {
    const exact = this.store.getActiveAuthorization(actorId, channel);
    if (exact && this.statusOf(exact) === "active") return exact;
    const provider = providerOf(channel);
    const candidates = this.store
      .listActiveAuthorizations(actorId)
      .filter((a) => providerOf(a.channel) === provider && this.statusOf(a) === "active");
    return candidates[0] ?? null;
  }

  list(actorId: string): PaymentAuthorization[] {
    return this.store.listAuthorizations(actorId);
  }

  revoke(id: string, actorId: string): boolean {
    const ok = this.store.revokeAuthorization(id, actorId, new Date().toISOString());
    if (ok) this.store.addEvent(`auth:${id}`, "authorization_revoked", { actorId });
    return ok;
  }

  /** 过期判定按需计算，不依赖定时任务改写状态（避免「过期但库里还是 active」）。 */
  statusOf(auth: PaymentAuthorization, now: Date = new Date()): AuthorizationStatus {
    if (auth.status !== "active") return auth.status;
    if (auth.expiresAt && Date.parse(auth.expiresAt) <= now.getTime()) return "expired";
    return "active";
  }

  /** 已占用额度按 provider 汇总：换通道不重置额度。 */
  usedSince(auth: PaymentAuthorization, since: Date): number {
    const channels = PROVIDER_CHANNELS[providerOf(auth.channel)];
    return centsToAmount(
      this.store.sumCommittedSinceChannels(auth.actorId, channels, since.toISOString()),
    );
  }

  private startOfDay(now: Date): Date {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private startOfMonth(now: Date): Date {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * 判定一笔支付是否被授权。
   * amountCents 传分，避免调用方先转元再转分造成精度漂移。
   */
  evaluate(
    auth: PaymentAuthorization,
    params: { amountCents: number; category: string },
    now: Date = new Date(),
  ): AuthorizationDecision {
    const usedTodayCny = this.usedSince(auth, this.startOfDay(now));
    const usedThisMonthCny = this.usedSince(auth, this.startOfMonth(now));
    const status = this.statusOf(auth, now);
    const base = { allowed: false as const, needsConfirm: true, usedTodayCny, usedThisMonthCny };

    if (status === "revoked") {
      return { ...base, reason: "支付授权已被撤销，需要用户重新授权后才能扣款" };
    }
    if (status === "expired") {
      return { ...base, reason: "支付授权已过期，需要用户重新授权（可在授权页调整额度后再次同意）" };
    }

    const category = params.category.trim().toLowerCase();
    if (!auth.categories.includes("*") && !auth.categories.includes(category)) {
      return {
        ...base,
        reason: `支付授权未覆盖「${category}」类别（已授权：${auth.categories.join("、")}）。需要用户重新授权并勾选该类别`,
      };
    }

    const amountCny = centsToAmount(params.amountCents);
    if (auth.limits.perTxCny > 0 && amountCny > auth.limits.perTxCny) {
      return {
        ...base,
        reason: `单笔 ¥${amountCny} 超出授权上限 ¥${auth.limits.perTxCny}。需要用户确认或调整授权额度`,
      };
    }
    if (auth.limits.dailyCny > 0 && usedTodayCny + amountCny > auth.limits.dailyCny) {
      return {
        ...base,
        reason: `今日已用 ¥${usedTodayCny.toFixed(2)} / 上限 ¥${auth.limits.dailyCny}，本次 ¥${amountCny} 将超额。需要用户确认或调整授权额度`,
      };
    }
    if (auth.limits.monthlyCny > 0 && usedThisMonthCny + amountCny > auth.limits.monthlyCny) {
      return {
        ...base,
        reason: `本月已用 ¥${usedThisMonthCny.toFixed(2)} / 上限 ¥${auth.limits.monthlyCny}，本次 ¥${amountCny} 将超额。需要用户确认或调整授权额度`,
      };
    }

    const needsConfirm = auth.limits.autoApproveCny <= 0 || amountCny > auth.limits.autoApproveCny;
    return { allowed: true, needsConfirm, usedTodayCny, usedThisMonthCny };
  }

  /** 供工具/HTTP 返回的摘要（不含 consentText 长文）。 */
  summarize(auth: PaymentAuthorization): Record<string, unknown> {
    const now = new Date();
    return {
      id: auth.id,
      channel: auth.channel,
      status: this.statusOf(auth, now),
      limits: auth.limits,
      categories: auth.categories,
      usedTodayCny: Math.round(this.usedSince(auth, this.startOfDay(now)) * 100) / 100,
      usedThisMonthCny: Math.round(this.usedSince(auth, this.startOfMonth(now)) * 100) / 100,
      createdAt: auth.createdAt,
      expiresAt: auth.expiresAt,
      lastUsedAt: auth.lastUsedAt,
    };
  }
}

/** 金额校验辅助：供工具层复用（元 → 分）。 */
export function toCentsOrNull(value: unknown): number | null {
  return amountToCents(value);
}

/** 类目归一：非法值落到 other，避免授权匹配被脏数据绕过。 */
export function normalizeCategory(input: unknown, fallback: BizDomain = "other"): string {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!raw) return fallback;
  return KNOWN_CATEGORIES.has(raw) ? raw : fallback;
}
