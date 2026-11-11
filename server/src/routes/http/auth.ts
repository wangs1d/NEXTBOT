/**
 * 设备自绑定鉴权 HTTP 路由（ACCESS_AUTH_REQUIRED 开启后的凭证发放入口）。
 *
 *   GET  /api/auth/status       鉴权状态（authRequired + 是否已有绑定设备；免鉴权）
 *   POST /api/auth/pairing-code 签发 6 位绑定码（10 分钟有效，一次性）
 *   POST /api/auth/bind         设备提交绑定码 → 签发设备 token（明文只返回这一次；免鉴权）
 *   GET  /api/auth/devices      列出本人名下设备（须 Bearer token）
 *   POST /api/auth/revoke       吊销自己的设备 token（须 Bearer token）
 *
 * 鉴权规则（pairing-code）：
 *  - ACCESS_AUTH_REQUIRED 关闭 → 允许，用 body.userId（与现状一致）
 *  - 开启且已存在绑定设备：带有效 Bearer token → userId 以 token 为准；
 *    没 token 的新设备须带 emailCode（先发 /accounts/email/otp/start），
 *    证明「这个邮箱是我的」才签得出码——否则任何人都能凭陌生邮箱自签
 *  - 开启但尚无任何绑定设备（bootstrap 首台）→ 允许，用 body.userId
 *
 * 注意：/api/auth/status 与 /api/auth/bind 永远免鉴权（前者是探测，后者是获取凭证
 * 的唯一入口）；/api/auth/pairing-code 与 /api/auth/revoke 在周界 hook 开启时由
 * hook 统一拦截（无效 token 到不了这里），路由内只做 userId 归属与 bootstrap 放行。
 */
import type { FastifyInstance } from "fastify";

import { isAccessAuthRequired, trustsPayloadAccountIdentity } from "../../config/env.js";
import { decideHttpIdentity, type HttpIdentitySource } from "../../http/http-identity.js";
import { AccessAuthService } from "../../services/access-auth-service.js";
import type { EmailOtpService } from "../../services/email-otp-service.js";
import { resolveAdminSession } from "./admin-session-auth.js";
import { isStructuredSessionId } from "../../ws/session-identity.js";

// HTTP/WS 共用同一份结构性会话键判据，这里保留导出供既有调用/测试使用。
export { isStructuredSessionId };

export interface AuthRouteDeps {
  accessAuthService: AccessAuthService;
  /** 邮箱所有权验证码：第二台设备没有 token 时唯一的自证途径 */
  emailOtpService?: EmailOtpService;
}

declare module "fastify" {
  interface FastifyRequest {
    /** 周界鉴权解出的 token 归属（仅 token 来源时写入） */
    accessUserId?: string;
    /**
     * 本次请求的身份裁决结果（token / guest / compat / anonymous）。
     * 路由需要区分「登录用户」与「未登录设备」时读这里，不要自己再解析 query。
     */
    accessIdentity?: {
      actorId: string;
      source: HttpIdentitySource;
      placeholder: boolean;
    };
  }
}

/**
 * 周界公开面（fail-closed 的唯一例外来源）。只有四类：
 *  ① 取凭证本身要走的入口（配对链 + 注册/登录，路由内各自把关）
 *  ② 不含任何用户数据的静态产物与运维探针
 *  ③ 配对成功前客户端必须可达的开机入口（更新清单、启动台账、注册探活）
 *  ④ 自带机器密钥的通道——它们用 `?token=` 传自己的secret，周界若接管这个
 *    参数名会把合法回调拒掉，所以必须让位（各自 403/401 由路由自证）
 * 其余一切（/picture、/notes、/gallery-wall 数据、/travel*、/agent*、/api/*）
 * 都要设备 token；「不在 /api/ 下」不再是免检理由。
 */
const PUBLIC_EXACT_PATHS = new Set([
  // ② 页面壳与探针
  "/", // 注册/登录页
  "/beta",
  "/favicon.ico",
  "/health",
  "/brain/health",
  "/system/upstream-health", // 运维探活：只出上游模型状态，不含用户数据
  // ① 凭证获取链（绑定码一次性、注册须邮箱 OTP，均在路由内自门禁）
  "/api/auth/status",
  "/api/auth/bind",
  "/api/auth/refresh", // 用（可能已过期的）token 换新，必须能穿过周界才叫续期
  "/api/auth/pairing-code",
  "/accounts/email/otp/start",
  "/accounts/register",
  "/accounts/login", // 老用户登录入口（只登录不建档，OTP 闸在路由内把关）
  "/accounts/beta/apply",
  "/accounts/beta/status",
  // ③ 装机/开机链路：安装包自检版本与启动台账发生在「配对」之前，
  //    此刻设备还没有任何凭证；两者都不返回用户数据。
  "/api/client/manifest",
  "/api/telemetry/client-boot",
  "/accounts/me", // 注册探活（未配对时唯一能问「这个邮箱注册过吗」的入口）
  // ② 健康探针
  "/api/resource/health-check",
  "/api/memory/health",
  "/api/browser/health", // 云端无头浏览器自检（无用户数据、无副作用，部署终验用）
  "/api/payment/status", // 支付通道就绪自检（只出模式布尔值，无用户数据、无密钥）
  // 官网支付（webpay）：页面壳与支付宝同步回跳 / 异步通知都由支付网关或浏览器
  // 发起，不带设备 token。只放行这四条——订单创建/查询/退款仍需设备鉴权。
  // notify 与 return/verify 在 webpay.ts 内各自验签；页面壳不含用户数据。
  "/webpay/checkout",
  "/webpay/return",
  "/api/webpay/config-status",
  "/api/webpay/return/verify",
  "/api/webpay/notify",
]);

const PUBLIC_PATH_PREFIXES = [
  // ② 静态产物：构建出来的 JS/CSS/HTML/字体与图片库
  "/assets/",
  "/chat/assets/", // WebView 里的 3D 形象构建产物（数据走 /ws，自带握手鉴权）
  "/gallery-wall/vendor/",
  "/accounts/web",
  // 官网充值面：页面自带邮箱 OTP 会话（HttpOnly Cookie），付款前必须登录本站账号；
  // 与设备 token 无关，套上周界鉴权会让支付宝回跳与付款页都打不开
  "/recharge",
  "/api/recharge/",
  "/downloads/", // 安装包固定直链（发给用户的链接不能带设备凭证）
  // ② 运维/发现
  "/metrics",
  "/.well-known/",
  "/ws", // WebSocket 两条通道各自握手鉴权：/ws 走 session.init token，/ws/voice-duplex 验 query token
  // ② 无用户数据的公开共享面：按不可猜的 shareCode 取件
  "/travel/share/",
  // ② 底图瓦片：白名单上游的瓦片/字形代理，任何账号的数据都不在这里
  "/travel-basemap/",
  // ① agent-world 入网引导（challenge/verify 自带证明；发现清单指向的路径）
  "/world/register/",
  // ④ 自带机器密钥的通道（周界不许吃它们的 ?token= / 私有头）
  "/phone-bridge/captures/", // PHONE_BRIDGE_TOKEN
  "/api/internal/manifest-events", // MANIFEST_EVENT_TOKEN
  "/accounts/register/email/inbound", // X-Agent-Mail-Secret
  "/finance/ingest/email/inbound", // X-Agent-Mail-Secret
  "/api/webhooks/inbound/", // WEBHOOK_SECRET（body.secret）
  "/integrations/messages/inbound", // MessageBridgeService.assertAuthorized
  "/v1/", // 云端搜索代理：自带访问令牌 + IP 限流，消耗运营方上游额度
  // ④ 管理后台：HttpOnly 会话 Cookie + CSRF + 仅回环监听（admin-console-gate），
  //    浏览器里没有设备 token，交给周界等于把后台关死
  "/admin",
  "/api/admin/",
];

/**
 * 前缀必须按路径段边界匹配。
 *
 * `"/ws"`、`"/admin"`、`"/recharge"`、`"/metrics"` 等项没有尾斜杠，
 * 直接 startsWith 会把 `/ws-evil/...`、`/administrator/...` 也放进公开面
 * ——周界鉴权就出现一条可构造的绕行。以 `/` 结尾的前缀保持原语义。
 */
function matchesPublicPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 该路径是否属于公开面。 */
export function isPublicAccessPath(path: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(path)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => matchesPublicPrefix(path, p));
}

/**
 * 管理后台与 App 共用的路径：后台用 HttpOnly 会话 Cookie（不是设备 token），
 * 只在会话有效时放行，否则仍由周界按设备凭据裁决。
 *
 * 2026-11-11 回写：这段放行此前只存在于线上 `dist` 的热补丁里，源码没有，
 * 走一次完整发版就会把它抹掉，后台反馈页随即 401。产物与源码必须同字节语义。
 */
export function isAdminSharedPath(path: string): boolean {
  return path === "/api/feedback" || path.startsWith("/api/feedback/");
}

/**
 * WebView 承载的 HTML 页（墙/行迹/决策页/网页聊天）：页面自身的 fetch 与 `<img>`
 * 都发不出请求头，逐站点改页面 JS 既脆又漏。约定：宿主用 `?token=` 打开页面，
 * 周界在这次响应里把同一枚 token 落成同站 HttpOnly Cookie，页面后续请求自动带上。
 * 暴露面等同宿主本机已明文保存的 token（客户端凭据文件同口径），不新增类别。
 */
const HTML_PAGE_PATHS = [
  "/gallery-wall",
  "/travel-map",
  "/shopping/decision-page",
  "/chat/notes",
  "/chat",
];
const ACCESS_COOKIE_NAME = "nb_access";

/** 从 Cookie 头取访问 token（只认我们自己落的那一枚）。 */
function accessCookieToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== ACCESS_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * 周界鉴权 hook（**始终挂载**，不依赖 ACCESS_AUTH_REQUIRED）。
 *
 * 2026-11-11 起语义从「开关打开就全拒」变成分级裁决（`http/http-identity.ts`）：
 *
 *  | 请求携带 | 结果 |
 *  |---|---|
 *  | 有效 token | 放行，身份 = token 归属，query/body 的自报值被改写 |
 *  | 无效/过期 token | 401 TOKEN_INVALID（客户端据此清凭据并续期或重登） |
 *  | 无 token + 自报邮箱 | 403 IDENTITY_REQUIRED（**与开关无关**） |
 *  | 无 token + `inst_…`/占位值 | 放行，按 guest 身份（数据与账号隔离） |
 *  | 无 token + 无身份 | 强制模式下 401，宽松模式下按匿名（旧行为） |
 *
 * 「无 token 自报邮箱必须拒」这条不看开关：它和 WS 侧同一个漏洞——自报
 * 账号从来不是身份，只可能是冒充。ACCESS_AUTH_REQUIRED 只影响最后一行
 * （完全没身份的请求），用来逐步收紧匿名面。
 *
 * 分两个 hook 是因为 body 在 onRequest 之后才解析：单钩子里读
 * `request.body` 永远是 undefined，body 侧的伪造身份会原样漏到路由下面。
 */
export function registerAccessAuthHook(app: FastifyInstance, accessAuthService: AccessAuthService): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = (request.url || "").split("?")[0];
    if (isPublicAccessPath(path)) return;
    if (isAdminSharedPath(path) && resolveAdminSession(request)) return;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const queryToken = typeof query.token === "string" ? query.token : undefined;
    const token = AccessAuthService.extractToken({
      authorization: request.headers.authorization,
      queryToken,
    }) ?? accessCookieToken(request.headers.cookie) ?? null;

    const decision = decideFromRequest(request, query, token, accessAuthService);
    if (!decision.ok) {
      // 401 = 你还没被认出来（去登录/续期）；403 = 你自称了某个账号但没有凭证。
      // 分开的意义：客户端可以对 401 走「静默续期 → 仍失败才回登录页」，
      // 而 403 说明它手里压根没有可用凭据，续期没有意义，直接回登录门禁。
      const status = decision.reason === "claimed_account" ? 403 : 401;
      return reply.code(status).send({
        ok: false,
        code: decision.code,
        error: decision.message,
      });
    }

    if (decision.source === "token") {
      request.accessUserId = decision.actorId;
      // HTML 页：query token 落一次同站 Cookie，页面内部的 fetch/图片才拿得到凭证
      if (queryToken && HTML_PAGE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
        void reply.header(
          "set-cookie",
          `${ACCESS_COOKIE_NAME}=${queryToken}; Path=/; HttpOnly; SameSite=Strict`,
        );
      }
    }
    request.accessIdentity = {
      actorId: decision.actorId,
      source: decision.source,
      placeholder: decision.placeholder ?? false,
    };
    // 身份钉死：userId/actorId 一律取裁决结果；sessionId 只在「本身就是自报
    // 账号」时改写，结构性会话键（`side:`/`notes:`/`incognito:`/`master:` 等）
    // 必须原样保留——它们内部带账号邮箱，误改会把旁聊历史挤成主会话历史。
    // actor 解析由 resolveActorId 优先读 userId，userId 钉死后 sessionId 里的
    // 伪造值已经影响不到归属。
    pinIdentity(query, decision.actorId);
  });

  app.addHook("preValidation", async (request) => {
    if (!request.accessIdentity) return;
    if (
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body) &&
      !Buffer.isBuffer(request.body)
    ) {
      pinBodyIdentity(request.body as Record<string, unknown>, request.accessIdentity.actorId);
    }
  });
}

/**
 * query 侧身份钉死：一律注入裁决后的 userId（大量路由靠 `?userId=` 解析
 * actor），并钉掉自报的 actorId。结构性会话键原样保留——它们内部带邮箱，
 * 误改会把旁聊历史挤成主会话历史（2026-11-11）。
 */
export function pinIdentity(target: Record<string, unknown>, actorId: string): void {
  target.userId = actorId;
  if ("actorId" in target) target.actorId = actorId;
  const sid = target.sessionId;
  if (
    typeof sid === "string" &&
    sid.includes("@") &&
    !isStructuredSessionId(sid)
  ) {
    target.sessionId = actorId;
  }
}

/**
 * body 侧身份钉死：**只覆盖调用方确实传了的身份字段，绝不凭空注入**。
 *
 * 与 query 版分开的原因：body 是业务对象，无条件塞一个 `userId` 会让
 * `if (!body.userId)` 这类"必须提供身份"的校验永久通过，也会给下游
 * 透传/落库的对象掺入不属于它的字段。自报的 userId/actorId 仍必须钉死
 * （否则 POST 能冒充别人），但调试接口想指定别的 actor 请用
 * `targetActorId`——那是显式业务字段，不参与身份裁决。
 */
export function pinBodyIdentity(target: Record<string, unknown>, actorId: string): void {
  if ("userId" in target) target.userId = actorId;
  if ("actorId" in target) target.actorId = actorId;
  const sid = target.sessionId;
  if (
    typeof sid === "string" &&
    sid.includes("@") &&
    !isStructuredSessionId(sid)
  ) {
    target.sessionId = actorId;
  }
}

/** 从请求里取 token 并裁决身份（query 阶段用；body 阶段只做钉死）。 */
function decideFromRequest(
  request: { headers: Record<string, unknown>; query: unknown },
  query: Record<string, unknown>,
  token: string | null,
  accessAuthService: AccessAuthService,
): ReturnType<typeof decideHttpIdentity> {
  const verified = token ? accessAuthService.inspectToken(token) : null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const headers = request.headers ?? {};
  const headerActor = str(headers["x-nb-actor"] ?? headers["X-Nb-Actor"]);
  return decideHttpIdentity({
    tokenPresent: Boolean(token),
    verifiedUserId: verified?.status === "ok" ? verified.userId : null,
    tokenExpired: verified?.status === "expired",
    // 设备标识头只在没有 token 时才有意义：发不出请求头的消费方（图片/音频/
    // WebView）靠它表明「我是这台还没登录的设备」。有 token 时一律以 token 为准。
    claimedUserId: str(query.userId) ?? (token ? null : headerActor),
    claimedSessionId: str(query.sessionId),
    claimedActorId: str(query.actorId),
    strict: isAccessAuthRequired(),
    trustPayloadAccountIdentity: trustsPayloadAccountIdentity(),
  });
}

/** 从请求中提取明文 token（Bearer 头优先，其次 ?token= query）。 */
function tokenFromRequest(request: { headers: Record<string, unknown>; query: unknown }): string | null {
  const headers = request.headers ?? {};
  const authRaw = headers["authorization"] ?? headers["Authorization"];
  const authorization = Array.isArray(authRaw) ? String(authRaw[0] ?? "") : authRaw == null ? undefined : String(authRaw);
  const query = (request.query ?? {}) as { token?: string };
  return AccessAuthService.extractToken({ authorization, queryToken: query.token });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { accessAuthService, emailOtpService } = deps;

  /** GET /api/auth/status：探测鉴权是否开启 / 是否已有绑定设备（免鉴权） */
  app.get("/api/auth/status", async () => {
    return {
      ok: true,
      authRequired: isAccessAuthRequired(),
      bound: accessAuthService.hasAnyTokens(),
      userId: null,
    };
  });

  /** POST /api/auth/pairing-code：签发 6 位绑定码 */
  app.post("/api/auth/pairing-code", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const authRequired = isAccessAuthRequired();
    const bootstrap = !accessAuthService.hasAnyTokens();

    let userId = asString(body.userId);
    if (authRequired && !bootstrap) {
      // 已有绑定设备：凭有效 token 签发，userId 以 token 归属为准；
      // 新设备还没 token 时须先用邮箱验证码证明「这个邮箱是我的」，
      // 否则任何人都能凭一个陌生邮箱给自己签码。
      const token = tokenFromRequest(request);
      const verified = token ? accessAuthService.verifyToken(token) : null;
      if (verified) {
        userId = verified.userId;
      } else {
        const emailCode = asString(body.emailCode);
        if (!emailCode) {
          return reply
            .code(401)
            .send({ ok: false, error: "需要有效的设备 token（Authorization: Bearer），或提交 emailCode 证明邮箱归属" });
        }
        if (!userId.includes("@")) {
          return reply.code(400).send({ ok: false, error: "邮箱验证码通道要求 userId 是邮箱地址" });
        }
        if (!emailOtpService) {
          return reply.code(400).send({ ok: false, error: "邮箱验证码通道未开启，请用已绑定设备的 token 签发" });
        }
        if (!emailOtpService.verify(userId, emailCode, { consume: true })) {
          return reply.code(401).send({ ok: false, error: "邮箱验证码无效或已过期" });
        }
      }
    }
    if (!userId) {
      return reply.code(400).send({ ok: false, error: "缺少 userId" });
    }
    try {
      const code = accessAuthService.issueBindingCode(userId);
      return {
        ok: true,
        code,
        userId,
        expiresInMs: 10 * 60 * 1000,
        message: "请在 10 分钟内于新设备提交此绑定码（一次性）",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  /** POST /api/auth/bind：设备提交绑定码换取 token（免鉴权——这是获取凭证的唯一入口） */
  app.post("/api/auth/bind", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = asString(body.code);
    const deviceId = asString(body.deviceId);
    const deviceLabel = asString(body.deviceLabel);
    if (!code) return reply.code(400).send({ ok: false, error: "缺少 code" });
    if (!deviceId) return reply.code(400).send({ ok: false, error: "缺少 deviceId" });
    try {
      const { token, userId, record } = await accessAuthService.consumeBindingCode(code, deviceId, deviceLabel);
      return {
        ok: true,
        token,
        userId,
        tokenId: record.tokenId,
        expiresAt: record.expiresAt ?? 0,
        message: "绑定成功：token 请妥善保存，仅本次返回（服务端只存哈希）",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  /**
   * POST /api/auth/refresh：用现有 token 换新 token（滑动续期，免周界）。
   *
   * 为什么免周界：过期的 token 过不了周界，如果这个端点也被拦，客户端就陷入
   * 「过期 → 401 → 想续期 → 还是 401」的死循环，只能让用户重登。这里允许它
   * 穿过周界，由本路由自己按「有效 / 过期但未超宽限期 / 彻底失效」判定。
   *
   * token 从三处取：Authorization: Bearer、body.token、?token=。客户端在
   * 建连/请求前发现临期会主动调一次，用户无感。
   */
  app.post("/api/auth/refresh", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const token =
      AccessAuthService.extractToken({
        authorization: request.headers.authorization,
        queryToken: asString(body.token) || asString(query.token) || undefined,
      }) ?? accessCookieToken(request.headers.cookie);
    if (!token) {
      return reply.code(400).send({ ok: false, code: "TOKEN_MISSING", error: "缺少 token" });
    }
    const result = await accessAuthService.refreshToken(token);
    if ("error" in result) {
      return reply.code(401).send({
        ok: false,
        code: result.error === "EXPIRED" ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
        error:
          result.error === "EXPIRED"
            ? "登录状态已超过续期宽限期，请重新登录"
            : "本机访问凭据已失效，请重新登录",
      });
    }
    return {
      ok: true,
      token: result.token,
      tokenId: result.tokenId,
      userId: result.userId,
      deviceId: result.deviceId,
      expiresAt: result.expiresAt,
    };
  });

  /**
   * GET /api/auth/devices：列出本机 token 归属名下的设备（不含 token/哈希）。
   * 没有这个入口，用户只能吊销「正在用的这台」，丢掉的第二台设备凭据永远
   * 收不回来——凭证生命周期缺最后一环。
   */
  app.get("/api/auth/devices", async (request, reply) => {
    const token = tokenFromRequest(request);
    const verified = token ? accessAuthService.verifyToken(token) : null;
    if (!verified) {
      return reply.code(401).send({ ok: false, error: "需要有效的设备 token（Authorization: Bearer）" });
    }
    return {
      ok: true,
      userId: verified.userId,
      currentTokenId: verified.tokenId,
      devices: accessAuthService.listTokens(verified.userId),
    };
  });

  /** POST /api/auth/revoke：吊销自己的设备 token（须有效 token，且只能吊自己的） */
  app.post("/api/auth/revoke", async (request, reply) => {
    const token = tokenFromRequest(request);
    const verified = token ? accessAuthService.verifyToken(token) : null;
    if (!verified) {
      return reply.code(401).send({ ok: false, error: "需要有效的设备 token（Authorization: Bearer）" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tokenId = asString(body.tokenId);
    if (!tokenId) return reply.code(400).send({ ok: false, error: "缺少 tokenId" });
    const revoked = await accessAuthService.revokeToken(tokenId, verified.userId);
    if (!revoked) {
      return reply.code(404).send({ ok: false, error: "token 不存在或不属于当前用户" });
    }
    return { ok: true, tokenId, message: "已吊销" };
  });
}
