/**
 * `session.init` 身份裁决（唯一权威源）。
 *
 * 历史故障（2026-11-11 真机「卡在思考中」）根因：客户端建连时本地账号还没
 * 读出来，`session.init` 报了编译期默认值 `session-mvp-001`，服务端照单全收
 * 并把连接绑在这个兜底身份上；随后 `chat.user_message` 带的是恢复后的登录
 * 邮箱，两边不一致 → `FORBIDDEN` 丢弃，且不落审计 → 界面永远停在「我看看」。
 *
 * 修法不是「再补一层兜底」，而是把身份的合法来源收窄成两类：
 *   1. 服务端签发的 token（账号身份的唯一证明，认证即发证）；
 *   2. 本机安装标识 `inst_…`（未登录 = 一种真实状态，按设备隔离，不是假账号）。
 * 其余一律判定为 guest/compat 或直接拒连，服务端**不再**把客户端自报的账号
 * 身份当作可信事实。
 *
 * 本模块保持纯函数：不碰 socket、不读 env，开关由调用方传入，便于单测覆盖
 * 「旧包 / 换号 / token 失效 / 探针脚本」等各种入口组合。
 */

/** 身份来源分类，写进审计（`session.init.identitySource`）。 */
export type SessionIdentitySource = "token" | "bridge" | "guest" | "compat";

export type SessionIdentityResult =
  | {
      ok: true;
      actorId: string;
      source: SessionIdentitySource;
      /** 客户端自报但未被采纳的账号身份（审计留痕）。 */
      claimedActorId?: string;
      /** 命中占位身份（旧包/脚本默认值），需要告警。 */
      placeholder?: boolean;
    }
  | {
      ok: false;
      code: "IDENTITY_REQUIRED" | "BAD_SESSION_INIT";
      message: string;
      claimedActorId?: string;
    };

export type SessionIdentityInput = {
  /** 服务端校验通过的 token 归属（query 预验或 payload.token 验签）。 */
  verifiedTokenUserId?: string | null;
  /** 客户端在 payload 里自报的 userId。 */
  claimedUserId?: string | null;
  /** 客户端在 payload 里自报的 sessionId（旧包只报这个）。 */
  claimedSessionId?: string | null;
  /** desktopBridge / phoneBridge 通道：身份由桥接注册流程负责。 */
  isBridgeChannel?: boolean;
  /**
   * 逃生开关（`WS_TRUST_PAYLOAD_ACCOUNT_IDENTITY=1`，默认关）：
   * 允许无 token 时信任自报的账号身份。只为一次性迁移期保留，正常不放。
   */
  trustPayloadAccountIdentity?: boolean;
};

/**
 * 占位/默认值身份：不是任何人的账号，只是「还没读到身份」的临时字符串。
 * 命中后按 guest 处理并告警——绝不把它当账号去挂记忆/世界/配额。
 */
export const PLACEHOLDER_ACTOR_IDS = new Set([
  "session-mvp-001",
  "session-mvp",
  "local-device",
  "default",
  "anonymous",
  // 离线旁路（邮件盯梢 / 消息桥）在未显式配置归属时的历史兜底名。
  // 它不是任何人的账号，写进长期记忆只会形成跨用户共享桶。
  "default_user",
]);

/** 本机安装标识：`inst_…`（客户端 InstallIdentity），兼容 `guest_…`。 */
export const GUEST_ACTOR_RE = /^(?:inst|guest)[._-][A-Za-z0-9._-]{3,}$/;

const RESERVED_CHARS_RE = /[\s\u0000-\u001f]/;

function clean(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 账号身份形态：本服务的账号 actorId 是归一化邮箱（accounts 路由同规则）。 */
export function looksLikeAccountId(actorId: string): boolean {
  return actorId.includes("@");
}

/** 结构性会话键前缀：键内部带账号邮箱，但键本身不是「自报账号」。 */
export const SESSION_KEY_PREFIXES = [
  "side:",
  "notes:",
  "incognito:",
  "master:",
  "master-delegate:",
] as const;

/**
 * 是否为结构性会话键（旁聊 / 笔记 / 隐身 / master 委派 / 渠道隔离）。
 *
 * HTTP 与 WS 两侧共用这一判据：旁聊键是 `side:<邮箱>:<id>`，含 `@` 但它
 * 不是身份声明。只看 `@` 就把会话键当成自报账号，会把周界改写、403 拒连、
 * 历史串线程等一整串误判带出来（2026-11-11）。
 */
export function isStructuredSessionId(sid: string): boolean {
  if (!sid) return false;
  if (SESSION_KEY_PREFIXES.some((prefix) => sid.startsWith(prefix))) return true;
  // 渠道隔离键 `<actorId>@<channel>`，末段是无点的渠道名。
  // 两种形态都要认：
  //   - 登录态：`user@x.com@wechat`（3 段）
  //   - 未登录：`inst_xxx@wechat`（2 段，actorId 本身不含 @）
  // 旧判据只认「>2 段」，guest 的渠道键会被周界当成自报邮箱改写成裸
  // actorId，微信/入站线程的历史串回主线程（2026-11-11 旁聊事故的同型第二例）。
  // 两段形态只认 guest/机器身份开头——`user@localhost` 这类仍按自报账号处理。
  const parts = sid.split("@");
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1] ?? "";
  if (!/^[\w-]+$/.test(last)) return false;
  if (parts.length > 2) return true;
  return /^(?:inst|guest|session)[._-][A-Za-z0-9._-]+$/i.test(parts[0] ?? "");
}

/** 该值是否是「未登录设备」的合法身份（安装标识或旧占位值）。 */
export function isGuestActorId(raw: string | null | undefined): boolean {
  const v = clean(raw);
  if (!v) return false;
  return GUEST_ACTOR_RE.test(v) || PLACEHOLDER_ACTOR_IDS.has(v.toLowerCase());
}

/**
 * 裁决一条 `session.init` 的身份。
 *
 * 优先级：token > bridge > guest/compat > 拒连。任何分支都不会「猜」一个
 * 账号出来——猜错账号是比拒连严重得多的故障（串记忆、串钱包、串世界）。
 */
export function resolveSessionIdentity(
  input: SessionIdentityInput,
): SessionIdentityResult {
  const verified = clean(input.verifiedTokenUserId);
  const claimedUserId = clean(input.claimedUserId);
  const claimedSessionId = clean(input.claimedSessionId);
  const claimed = claimedUserId || claimedSessionId;
  const claimedDiffers = claimed !== "" && claimed !== verified;

  if (verified) {
    return {
      ok: true,
      actorId: verified,
      source: "token",
      ...(claimedDiffers ? { claimedActorId: claimed } : {}),
    };
  }

  if (input.isBridgeChannel) {
    if (!claimed) {
      return {
        ok: false,
        code: "BAD_SESSION_INIT",
        message: "桥接通道需要 userId 或 sessionId",
      };
    }
    return { ok: true, actorId: claimed, source: "bridge" };
  }

  if (!claimed) {
    return {
      ok: false,
      code: "BAD_SESSION_INIT",
      message: "需要 userId 或 sessionId",
    };
  }

  if (RESERVED_CHARS_RE.test(claimed)) {
    return {
      ok: false,
      code: "BAD_SESSION_INIT",
      message: "身份标识含非法字符",
      claimedActorId: claimed,
    };
  }

  const lowered = claimed.toLowerCase();
  if (PLACEHOLDER_ACTOR_IDS.has(lowered)) {
    // 旧包/探针脚本的默认值：可以连、可以聊天，但只是「这台设备还没登录」，
    // 审计里明确标成 guest，不再出现「账号身份其实是默认值」的假象。
    return {
      ok: true,
      actorId: claimed,
      source: "guest",
      placeholder: true,
      ...(claimedDiffers ? { claimedActorId: claimed } : {}),
    };
  }

  if (GUEST_ACTOR_RE.test(claimed)) {
    return { ok: true, actorId: claimed, source: "guest" };
  }

  // 走到这里说明客户端在无凭据情况下自报了非 guest 身份。
  // 账号形态（邮箱）必须由 token 证明，否则任何人都能冒充别人读记忆。
  if (looksLikeAccountId(claimed) && !input.trustPayloadAccountIdentity) {
    return {
      ok: false,
      code: "IDENTITY_REQUIRED",
      message: "登录状态已过期，请重新登录以确认账号身份",
      claimedActorId: claimed,
    };
  }

  // 非账号形态的自定义 id（探针/联调/桥接工具）：保留兼容，但标 compat，
  // 审计能看出「这条连接的身份没有凭据背书」。
  return { ok: true, actorId: claimed, source: "compat" };
}

/** 该身份来源是否代表「真实登录账号」（可挂账号级数据）。 */
export function isAccountIdentitySource(source: SessionIdentitySource): boolean {
  return source === "token";
}

/** 日志/审计用的一句话描述。 */
export function describeSessionIdentity(
  result: Extract<SessionIdentityResult, { ok: true }>,
): string {
  if (result.source === "token") {
    return result.claimedActorId
      ? `token 权威（自报 ${result.claimedActorId} 被忽略）`
      : "token 权威";
  }
  if (result.source === "bridge") return "桥接通道自报";
  if (result.placeholder) return "占位身份（未登录设备）";
  return result.source === "guest" ? "设备匿名身份" : "无凭据兼容身份";
}
