import type { FastifyInstance } from "fastify";

import { getAgentMailInboundSecret } from "../../config/mail.js";
import {
  accountBetaApplyBodySchema,
  accountBetaStatusQuerySchema,
  accountEmailInboundBodySchema,
  accountEmailOtpStartBodySchema,
  accountEmailRegisterPendingQuerySchema,
  accountEmailRegisterStartBodySchema,
  accountEmailRegisterVerifyBodySchema,
  accountLoginBodySchema,
  accountMeQuerySchema,
  accountRegisterBodySchema,
} from "../../schemas/api.js";
import { readClientManifest } from "./client-manifest.js";
import type { HttpRouteDeps } from "./types.js";
import { resolveActorId } from "../../agent/actor-id.js";
import type { EmailOtpService } from "../../services/email-otp-service.js";
import type { EmailSmsService } from "../../services/email-sms-service.js";
import type { OtpIssueResult } from "../../services/email-otp-service.js";

function accountActorFromBody(data: { userId?: string; sessionId?: string }): string {
  return normalizeEmailLikeActor(resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" }));
}

/**
 * 邮箱形态的 actorId 统一小写：登录邮箱就是账号主键，用户以大小写不同
 * 的写法重复登录时不得裂成两个账号（与客户端 ApiConfig.normalizeIdentity
 * 同规则）。非邮箱形态（session-* 与 inst_* 等）原样保留。
 */
function normalizeEmailLikeActor(actorId: string): string {
  const t = actorId.trim();
  return t.includes("@") ? t.toLowerCase() : t;
}

/**
 * 邮箱所有权 OTP 闸是否生效：出站 SMTP 通道已配置（OUTBOUND_SMTP_* 凭据齐备）
 * 且未显式 EMAIL_OTP_REQUIRED=0。未配置凭据时保持旧行为（不锁注册，防把
 * 自己锁在门外）；凭据一旦到位即自动收紧 —— 「邮箱即密码」升级为
 * 「邮箱+收件箱证明」。
 */
export function isEmailOtpEnforced(
  deps: Pick<HttpRouteDeps, "emailOtpService" | "emailSmsService">,
): boolean {
  return (
    Boolean(deps.emailOtpService) &&
    Boolean(deps.emailSmsService?.isEmailEnabled()) &&
    process.env.EMAIL_OTP_REQUIRED !== "0"
  );
}

/** 验证码邮件正文（黑白极简，与产品一致）。 */
function otpEmailHtml(code: string, ttlMinutes: number): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:32px;background:#000;font-family:'Noto Sans SC','Microsoft YaHei UI',sans-serif;">
  <div style="max-width:420px;margin:0 auto;background:#141414;border:1px solid #232323;border-radius:20px;padding:36px;text-align:center;">
    <div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#F2F2F2;">NEXTBOT</div>
    <div style="margin-top:24px;font-size:15px;line-height:1.6;color:#9B9B9B;">你的登录验证码</div>
    <div style="margin-top:16px;font-size:36px;font-weight:700;letter-spacing:8px;color:#F2F2F2;">${code}</div>
    <div style="margin-top:24px;font-size:13px;line-height:1.7;color:#9B9B9B;">${ttlMinutes} 分钟内有效。若非本人操作，请忽略本邮件。</div>
  </div>
</body></html>`;
}

/** 安装包下载地址（发版 manifest 现读；未配置 url 时返回 null）。 */
async function betaDownloadUrl(): Promise<string | null> {
  try {
    const url = (await readClientManifest()).url;
    return url ? url : null;
  } catch {
    return null;
  }
}

/**
 * 账号子域：Agent 账号与 **登录主体**（`userId` 优先，否则 `sessionId`）绑定。
 */
export function registerAccountRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const {
    agentAccountService,
    emailRegistrationService,
    betaWhitelistService,
    betaWaitlistService,
    emailOtpService,
    emailSmsService,
  } = deps;

  /**
   * 邮箱所有权验证码签发（POST /accounts/email/otp/start）：向用户自报的
   * 外部真实邮箱发送 6 位码，证明「这个邮箱是我的」。OTP 闸关闭（SMTP 未
   * 配置凭据或显式关闭）时 503，网页端据 rendered 开关隐藏验证码步骤。
   * 故意不区分「邮箱已注册/未注册/是否在白名单」——不泄露账号存在性。
   */
  app.post("/accounts/email/otp/start", async (request, reply) => {
    if (!isEmailOtpEnforced(deps) || !emailOtpService || !emailSmsService) {
      return reply.code(503).send({ ok: false, message: "邮件验证通道未开启" });
    }
    const parsed = accountEmailOtpStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "请输入有效的邮箱地址" });
    }
    const email = normalizeEmailLikeActor(parsed.data.email);
    let result: OtpIssueResult;
    try {
      result = await emailOtpService.issue(email, {
        ip: request.ip,
        deliver: async (to, code) => {
          const sent = await emailSmsService.sendEmail({
            to,
            subject: `NEXTBOT 登录验证码：${code}`,
            body: `你的 NEXTBOT 登录验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
            html: otpEmailHtml(code, 10),
          });
          if (!sent.ok) throw new Error(sent.error);
        },
      });
    } catch (e) {
      // 发码失败（SMTP 凭据/网络）：不锁冷却，用户改后可立即重试
      // 静默吞掉 SMTP 错误会导致「发送失败」无法归因（2026-10-08 手机端
      // 发码失败排查时发现日志完全缺失），此处必须打出底层错误。
      console.error(
        `[accounts] OTP 发码失败 email=${email} ip=${request.ip}:`,
        e instanceof Error ? e.message : e,
      );
      return reply.code(502).send({ ok: false, message: "验证码邮件发送失败，请稍后重试" });
    }
    if (!result.ok) {
      const retry = result.retryAfterSeconds
        ? { retryAfterSeconds: result.retryAfterSeconds }
        : {};
      return reply.code(result.retryAfterSeconds ? 429 : 400).send({ ok: false, message: result.error, ...retry });
    }
    return { ok: true, resendAfterSeconds: result.resendAfterSeconds, ttlMinutes: result.ttlMinutes };
  });

  app.post("/accounts/register", async (request, reply) => {
    const parsed = accountRegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { displayName } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    // email 字段同样归一：账号名单里同一邮箱只有一种写法
    const email = parsed.data.email ? normalizeEmailLikeActor(parsed.data.email) : undefined;
    const alreadyRegistered = agentAccountService.getByActorId(actorId);
    // 显式「只注册」（客户端注册界面）：已存在不再是「视为登录成功」的幂等
    // 成功，而是明确的冲突，让客户端把用户引回登录界面。不传 mode 的旧调用
    // （桌面 /accounts/web、机器身份自注册）行为原样保留。
    if (parsed.data.mode === "register" && alreadyRegistered) {
      return reply.code(409).send({
        ok: false,
        code: "ACCOUNT_EXISTS",
        message: "该邮箱已注册，请直接登录",
      });
    }
    // 内测注册闸：邮箱形态的新注册须在白名单内（名单空 = 未设闸，见
    // beta-whitelist-service）。已注册主体视为登录放行（往下走 register 报
    // 「已存在」，客户端按登录成功处理）；inst_* / session-* 等机器身份不受闸
    // 约束，保障客户端启动自注册与后台运营数据不断。
    const whitelistCandidate = actorId.includes("@") ? actorId : email;
    if (betaWhitelistService && whitelistCandidate && !alreadyRegistered) {
      const allowed = await betaWhitelistService.allows(whitelistCandidate);
      if (!allowed) {
        console.info(`[accounts] 内测白名单拦截注册：${whitelistCandidate}`);
        return reply.code(403).send({
          ok: false,
          message: "内测期间暂未开放注册：可申请加入候补名单",
        });
      }
    }
    // 邮箱所有权 OTP 闸：开启时邮箱形态主体必须携带有效验证码。验证码与
    // **账号主键（actorId）** 绑定比对——发码邮箱与注册主体不是同一个地址
    // 就验证不过（拿自己的邮箱收码、注册别人的邮箱行不通）。「随便编一个
    // 邮箱就能注册登录」到此为止。inst_* / session-* 等机器身份豁免（与
    // 白名单闸同口径，保障客户端启动自注册）。已注册主体不带码的重复注册
    // 维持原「已存在」幂等语义（客户端视作登录成功；该响应不携带任何会话/
    // 数据，无越权面）。验证码验证通过即一次性作废（防重放）。
    if (isEmailOtpEnforced(deps) && emailOtpService && actorId.includes("@")) {
      const code = parsed.data.otpCode?.trim() ?? "";
      if (!code) {
        if (agentAccountService.getByActorId(actorId)) {
          return reply.code(400).send({ ok: false, message: "该用户已存在 Agent 账号，无需重复注册" });
        }
        return reply.code(400).send({ ok: false, message: "需要邮箱验证码：请先获取验证码再登录" });
      }
      if (!emailOtpService.verify(actorId, code, { consume: true })) {
        return reply.code(400).send({ ok: false, message: "验证码不正确或已过期，请重新获取" });
      }
    }
    try {
      // 邮箱形态主体：账号邮箱一律与主键同值（防 userId 与 email 各写一个
      // 地址导致后台展示/财务收件映射错位；非邮箱形态主体 email 可空）
      const accountEmail = actorId.includes("@") ? actorId : email;
      const account = await agentAccountService.register(actorId, displayName, accountEmail);
      await agentAccountService.markSetupComplete(actorId);
      return { ok: true, account };
    } catch (e) {
      // 「已存在」报错即重复登录（客户端按登录成功处理）：顺手记一次活跃
      agentAccountService.touchLastActive(actorId);
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /**
   * 邮箱登录（POST /accounts/login）：**只登录，不建档**。
   *
   * 与 `/accounts/register` 的两点区别，正是「登录界面 / 注册界面」分开后
   * 客户端的需要：
   *  - 账号不存在 → 404 `ACCOUNT_NOT_FOUND`，客户端据此把用户切到注册；
   *  - 已存在不会走「重复注册」的幂等分支（那条分支在 OTP 闸开启时根本
   *    不验码）。这里 OTP 闸开启就必须验码并通过才放行，验证码一次性作废。
   *
   * OTP 闸关闭（无 SMTP 凭据/显式关闭，多为单机开发）时免码直登，与注册
   * 同口径，避免把自己锁在门外。
   */
  app.post("/accounts/login", async (request, reply) => {
    const parsed = accountLoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "请输入有效的邮箱地址" });
    }
    const actorId = accountActorFromBody(parsed.data);
    const account = agentAccountService.getByActorId(actorId);
    if (!account) {
      return reply.code(404).send({
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        message: "该邮箱还没有注册，请先创建账号",
      });
    }
    if (isEmailOtpEnforced(deps) && emailOtpService && actorId.includes("@")) {
      const code = parsed.data.otpCode?.trim() ?? "";
      if (!code) {
        return reply.code(400).send({
          ok: false,
          code: "OTP_REQUIRED",
          message: "请输入邮箱验证码",
        });
      }
      if (!emailOtpService.verify(actorId, code, { consume: true })) {
        return reply.code(400).send({
          ok: false,
          code: "OTP_INVALID",
          message: "验证码不正确或已过期，请重新获取",
        });
      }
    }
    agentAccountService.touchLastActive(actorId);
    return { ok: true, account };
  });

  /**
   * 内测候补申请（登录页自助排队，运营后台批量审批）。
   * 幂等：重复提交返回现状；已在白名单的邮箱直接告知无需排队。
   */
  app.post("/accounts/beta/apply", async (request, reply) => {
    if (!betaWaitlistService) {
      return reply.code(503).send({ ok: false, message: "候补通道未开启" });
    }
    const parsed = accountBetaApplyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "请填写有效邮箱" });
    }
    const email = normalizeEmailLikeActor(parsed.data.email);
    let whitelisted = false;
    if (betaWhitelistService) {
      const snap = await betaWhitelistService.snapshot();
      whitelisted = snap.emails.includes(email);
    }
    if (whitelisted) {
      return { ok: true, email, status: "approved", whitelisted: true };
    }
    const result = await betaWaitlistService.apply(email, parsed.data.note, request.ip);
    return { ok: true, ...result, whitelisted: false };
  });

  /**
   * 内测进度查询（公开 /beta 页用，只读）：unknown 一律 status:"none"，
   * 不区分"没申请过"与"邮箱不存在"。已通过时附带安装包下载地址（发版
   * manifest 现读，改版自动跟随），申请页据此亮出下载按钮。
   */
  app.get("/accounts/beta/status", async (request, reply) => {
    const parsed = accountBetaStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "请填写有效邮箱" });
    }
    const email = normalizeEmailLikeActor(parsed.data.email);
    let whitelisted = false;
    if (betaWhitelistService) {
      whitelisted = (await betaWhitelistService.snapshot()).emails.includes(email);
    }
    if (whitelisted) {
      return { ok: true, email, status: "approved", whitelisted: true, downloadUrl: await betaDownloadUrl() };
    }
    if (!betaWaitlistService) {
      return { ok: true, email, status: "none", whitelisted: false };
    }
    const row = (await betaWaitlistService.list()).find(
      (r) => r.email.trim().toLowerCase() === email,
    );
    if (!row) {
      return { ok: true, email, status: "none", whitelisted: false };
    }
    return {
      ok: true,
      email,
      status: row.status,
      whitelisted: false,
      ...(row.status === "approved" ? { downloadUrl: await betaDownloadUrl() } : {}),
    };
  });

  /**
   * 邮箱验证码注册 — 步骤 1：分配占位邮箱并生成验证码（不落真实 SMTP）。
   */
  app.post("/accounts/register/email/start", async (request, reply) => {
    const parsed = accountEmailRegisterStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { displayName } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    if (agentAccountService.getByActorId(actorId)) {
      return reply.code(400).send({ ok: false, message: "该用户已存在 Agent 账号" });
    }
    try {
      const pending = await emailRegistrationService.start(actorId, displayName);
      return {
        ok: true,
        mailDomain: emailRegistrationService.getDomain(),
        email: pending.email,
        expiresAt: pending.expiresAt,
        hint:
          "本服务生成的验证码：GET /accounts/register/email/pending 。真实邮件：将网关指向 POST /accounts/register/email/inbound 。",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /**
   * 邮箱验证码注册 — 步骤 2：Agent 拉取待验证邮件（含验证码）。
   */
  app.get("/accounts/register/email/pending", async (request, reply) => {
    const parsed = accountEmailRegisterPendingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = accountActorFromBody(parsed.data);
    const p = emailRegistrationService.getPending(actorId);
    if (!p) {
      return { ok: true, pending: null };
    }
    return {
      ok: true,
      pending: {
        displayName: p.displayName,
        email: p.email,
        code: p.code,
        inboundCodes: p.inboundCodes,
        expiresAt: p.expiresAt,
      },
    };
  });

  /**
   * 真实收信：邮件网关（Mailgun / Cloudflare Email Routing / 自建 MTA 等）将解析后的邮件 POST 到此。
   * 若设置 AGENT_MAIL_INBOUND_SECRET，则须携带请求头 X-Agent-Mail-Secret。
   */
  app.post("/accounts/register/email/inbound", async (request, reply) => {
    const secret = getAgentMailInboundSecret();
    if (secret) {
      const got = String(request.headers["x-agent-mail-secret"] ?? "");
      if (got !== secret) {
        return reply.code(401).send({ ok: false, message: "缺少或错误的 X-Agent-Mail-Secret" });
      }
    }
    const parsed = accountEmailInboundBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await emailRegistrationService.applyInbound(parsed.data);
    if (!result.matched) {
      return reply.code(404).send({ ok: false, ...result });
    }
    return { ok: true, ...result };
  });

  /**
   * 邮箱验证码注册 — 步骤 3：提交验证码并创建账号。
   */
  app.post("/accounts/register/email/verify", async (request, reply) => {
    const parsed = accountEmailRegisterVerifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { code } = parsed.data;
    const actorId = accountActorFromBody(parsed.data);
    if (agentAccountService.getByActorId(actorId)) {
      return reply.code(400).send({ ok: false, message: "该用户已存在 Agent 账号" });
    }
    try {
      const { displayName, email } = await emailRegistrationService.consume(actorId, code);
      const account = await agentAccountService.register(actorId, displayName, email);
      await agentAccountService.markSetupComplete(actorId);
      return { ok: true, account };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.get("/accounts/me", async (request, reply) => {
    const parsed = accountMeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = accountActorFromBody(parsed.data);
    const acc = agentAccountService.getByActorId(actorId);
    if (!acc) {
      return reply.code(404).send({ ok: false, registered: false });
    }
    // 客户端启动/设置页轮询的探活入口，顺带刷新最近活跃
    agentAccountService.touchLastActive(actorId);
    return { ok: true, registered: true, account: acc };
  });
}
