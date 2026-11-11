/**
 * HTTP 侧身份裁决（与 WS 侧 `ws/session-identity.ts` 同一套规则）。
 *
 * 历史问题：WS 通道已经做成「账号身份必须由 token 证明」，但 HTTP 路由仍在
 * 53 处各自 `resolveActorId({ userId: query.userId, ... })`——任何人只要把
 * `?userId=` 换成别人的邮箱，就能读到别人的记忆、日程、钱包。HTTP 比 WS 更
 * 危险，因为它的入口多、参数多、没人盯着。
 *
 * 本模块不碰 Fastify 对象，只做纯判定，便于单测穷举各种入口组合；真正的
 * 取 token / 改写 query & body 在 `routes/http/auth.ts` 的周界 hook 里做。
 *
 * 合法身份只有三种：
 *   1. token（服务端签发）——唯一的账号身份证明；
 *   2. 本机安装标识 `inst_…` / `guest_…`——未登录设备，数据与账号天然隔离；
 *   3. 无凭据的兼容 id（探针/联调）——审计标 compat，不是账号。
 * 其余（自报邮箱）在强制模式下直接拒，宽松模式下也拒：自报账号从来不该被信任。
 */
import {
  PLACEHOLDER_ACTOR_IDS,
  GUEST_ACTOR_RE,
  looksLikeAccountId,
} from "../ws/session-identity.js";

export type HttpIdentitySource = "token" | "guest" | "compat" | "anonymous";

export type HttpIdentityDecision =
  | {
      ok: true;
      actorId: string;
      source: HttpIdentitySource;
      /** 客户端自报但未被采纳的身份（审计留痕）。 */
      claimedActorId?: string;
      /** 命中占位身份（旧包/脚本默认值），需要告警。 */
      placeholder?: boolean;
    }
  | {
      ok: false;
      code: "TOKEN_INVALID" | "IDENTITY_REQUIRED";
      /**
       * 细分原因，决定 HTTP 状态码：
       *  - `no_identity`   → 401（未认证，客户端该去登录）
       *  - `claimed_account` → 403（自称了账号却没凭证，属于冒充，登录也未必是他）
       *  - `token_invalid` → 401（凭据废了，续期或重登）
       */
      reason: "no_identity" | "claimed_account" | "token_invalid";
      message: string;
      claimedActorId?: string;
    };

export type HttpIdentityInput = {
  /** 请求里是否出现了 token（Bearer / ?token= / Cookie）。 */
  tokenPresent: boolean;
  /** token 校验通过后的归属用户；null = 无效或已过期。 */
  verifiedUserId?: string | null;
  /** token 是否存在但已过期（用于给出「请重新登录」而不是「token 无效」）。 */
  tokenExpired?: boolean;
  /** 客户端自报的 userId（query / body / header）。 */
  claimedUserId?: string | null;
  /** 客户端自报的 sessionId（旧客户端只报这个）。 */
  claimedSessionId?: string | null;
  /** 部分路由读 ?actorId=，一并纳管。 */
  claimedActorId?: string | null;
  /** ACCESS_AUTH_REQUIRED：开启后无身份的请求直接拒。 */
  strict: boolean;
  /** 迁移逃生开关（默认关）。 */
  trustPayloadAccountIdentity?: boolean;
};

function clean(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 裁决一个 HTTP 请求的身份。 */
export function decideHttpIdentity(
  input: HttpIdentityInput,
): HttpIdentityDecision {
  const verified = clean(input.verifiedUserId);
  const claimedUserId = clean(input.claimedUserId);
  const claimedActorId = clean(input.claimedActorId);
  const claimedSessionId = clean(input.claimedSessionId);
  const claimed = claimedUserId || claimedActorId || claimedSessionId;
  const claimedDiffers = claimed !== "" && claimed !== verified;

  // ① 有可用 token：token 归属即身份，自报值只做留痕。
  if (input.tokenPresent && verified) {
    return {
      ok: true,
      actorId: verified,
      source: "token",
      ...(claimedDiffers ? { claimedActorId: claimed } : {}),
    };
  }

  // ② 带了 token 但无效/过期：不能「降级成自报身份」继续用——那等于把
  //    最该拦下的场景放过去。让客户端清凭据重新登录。
  if (input.tokenPresent && !verified) {
    return {
      ok: false,
      code: "TOKEN_INVALID",
      reason: "token_invalid",
      message: input.tokenExpired
        ? "登录状态已过期，请重新登录"
        : "本机访问凭据已失效，请重新登录",
      ...(claimed ? { claimedActorId: claimed } : {}),
    };
  }

  // ③ 无 token 且什么都没报：宽松模式下按匿名处理（旧行为），强制模式下拒。
  if (!claimed) {
    if (input.strict) {
      return {
        ok: false,
        code: "IDENTITY_REQUIRED",
        reason: "no_identity",
        message: "需要访问凭证：请登录后重试",
      };
    }
    return { ok: true, actorId: "anonymous", source: "anonymous" };
  }

  // ④ 账号形态（邮箱）必须由 token 证明。这一条与开关无关——自报账号从来
  //    都不该被信任，宽松模式下也不放行，否则「关闭鉴权」就是「随便读别人」。
  if (looksLikeAccountId(claimed) && !input.trustPayloadAccountIdentity) {
    return {
      ok: false,
      code: "IDENTITY_REQUIRED",
      reason: "claimed_account",
      message: "登录状态已过期，请重新登录以确认账号身份",
      claimedActorId: claimed,
    };
  }

  // ⑤ 占位值：可以当 guest 用，但审计明确标出来，不挂账号数据。
  if (PLACEHOLDER_ACTOR_IDS.has(claimed.toLowerCase())) {
    return {
      ok: true,
      actorId: claimed,
      source: "guest",
      placeholder: true,
      ...(claimedDiffers ? { claimedActorId: claimed } : {}),
    };
  }

  // ⑥ 安装标识：未登录设备的真实身份（与账号数据隔离）。
  if (GUEST_ACTOR_RE.test(claimed)) {
    return {
      ok: true,
      actorId: claimed,
      source: "guest",
      ...(claimedDiffers ? { claimedActorId: claimed } : {}),
    };
  }

  // ⑦ 其余非账号形态 id（探针/联调）：保留兼容，审计看得出没有凭据背书。
  return {
    ok: true,
    actorId: claimed,
    source: "compat",
    ...(claimedDiffers ? { claimedActorId: claimed } : {}),
  };
}

/** 该身份来源是否代表真实登录账号（可挂账号级数据）。 */
export function isAccountIdentitySource(source: HttpIdentitySource): boolean {
  return source === "token";
}
