import { getDataDir } from "../../config/data-dir.js";
import { mkdir, readFile, stat, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import net from "node:net";
import os from "node:os";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { renderAdminConsolePage } from "./admin-console-page.js";
import { adminAudit, readAdminAudit, requireAdmin } from "./admin-auth.js";
import { feedbackStatusCounts } from "./feedback.js";
import { renderInboxTemplate } from "../../services/inbox-templates.js";
import { resolvePrimaryExternalModelBinding } from "../../external-model/resolve-provider.js";
import { readClientManifest } from "./client-manifest.js";
import { BetaWhitelistService } from "../../services/beta-whitelist-service.js";
import type { HttpRouteDeps } from "./types.js";

const DAY_MS = 86_400_000;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 管理控制台：页面 + 管理数据 API。
 *
 * - GET  /admin                            控制台页面（概览/用户/白名单/站内信(发送+统计)/支付/反馈/下载分发/系统）
 * - GET  /admin/feedback                   兼容旧链接，重定向到控制台反馈标签
 * - GET  /api/admin/overview               业务聚合概览（注册 / 支付 / 站内信 / 反馈）
 * - GET  /api/admin/users                  用户注册数据（列表 + 新增趋势）
 * - POST /api/admin/users/:id/disabled     禁用/恢复用户（审计落 admin-audit.jsonl）
 * - GET  /api/admin/beta-whitelist         内测注册白名单快照（名单空 = 未设闸）
 * - POST /api/admin/beta-whitelist         添加名单邮箱（{ email }，幂等）
 * - DELETE /api/admin/beta-whitelist/:email 移除名单邮箱（只挡新注册，不踢已注册账号）
 * - GET  /api/admin/orders                 真实支付订单（持久台账，只记 live 交易）
 * - GET  /api/admin/messages               站内信统计（平台分布 + 最近消息）
 * - GET  /api/admin/system                 系统状态（进程/OS/存储占用/依赖探活/定时任务）
 * - GET  /api/admin/config                 服务配置状态（支付渠道/模型/邮件，不回传密钥）
 * - GET  /api/admin/audit?limit=50         最近管理操作审计
 *
 * 全部接口经共享 requireAdmin 鉴权（x-admin-token == ADMIN_UPLOAD_TOKEN，
 * 无默认值：未配置该环境变量时管理接口一律 503）。
 */

/** 目录体积：递归求和，限制扫描文件数防止失控。 */
async function dirSize(dir: string): Promise<{ bytes: number; files: number; truncated: boolean }> {
  const FILE_CAP = 20_000;
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files > FILE_CAP) {
        truncated = true;
        return { bytes, files, truncated };
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files++;
        try {
          const s = await stat(full);
          bytes += s.size;
        } catch {
          // 竞态删除：忽略
        }
      }
    }
  }
  return { bytes, files, truncated };
}

/** data 目录顶层条目体积明细（管理页存储表用）。 */
async function dataDirBreakdown(): Promise<{
  path: string;
  totalBytes: number;
  entries: Array<{ name: string; bytes: number; files: number; isDir: boolean }>;
}> {
  const dataDir = resolve(getDataDir());
  let entries: Array<{ name: string; bytes: number; files: number; isDir: boolean }> = [];
  let totalBytes = 0;
  try {
    const items = await readdir(dataDir, { withFileTypes: true });
    entries = await Promise.all(items.map(async (item) => {
      const full = join(dataDir, item.name);
      if (item.isDirectory()) {
        const s = await dirSize(full);
        return { name: item.name, bytes: s.bytes, files: s.files, isDir: true };
      }
      try {
        const st = await stat(full);
        return { name: item.name, bytes: st.size, files: 1, isDir: false };
      } catch {
        return { name: item.name, bytes: 0, files: 0, isDir: false };
      }
    }));
    entries.sort((a, b) => b.bytes - a.bytes);
    totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  } catch {
    // data 目录不存在
  }
  return { path: dataDir, totalBytes, entries };
}

/** 下载目录路径（与 downloads.ts 的解析规则保持一致）。 */
function downloadsDirPath(): string {
  if (process.env.DOWNLOADS_DIR) return resolve(process.env.DOWNLOADS_DIR);
  if (process.env.NODE_ENV === "production") return resolve("/app/downloads");
  return resolve(import.meta.dirname ?? __dirname, "../../../downloads");
}

/** Redis TCP 探活：连通即认为健康（不发 PING，避免协议兼容问题）。 */
function probeRedis(url: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      res({ ok, detail });
    };
    let host = "127.0.0.1";
    let port = 6379;
    try {
      const parsed = new URL(url);
      host = parsed.hostname || host;
      port = Number(parsed.port) || port;
    } catch {
      // 非 URL 形式：按 host:port 解析
      const [h, p] = url.replace(/^redis:\/\//, "").split(":");
      if (h) host = h;
      if (p && Number.isFinite(Number(p))) port = Number(p);
    }
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, `tcp ${host}:${port} 连通`));
    socket.once("timeout", () => done(false, `tcp ${host}:${port} 超时`));
    socket.once("error", (err) => done(false, `tcp ${host}:${port} 失败：${err.message}`));
  });
}

/** Qdrant HTTP 探活（GET /readyz，2s 超时）。 */
async function probeQdrant(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/readyz`, { signal: AbortSignal.timeout(2000) });
    return { ok: resp.ok, detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function registerAdminConsoleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderAdminConsolePage();
  });

  app.get("/admin/feedback", async (_request, reply) => {
    return reply.redirect("/admin#feedback");
  });

  // ── 客户端版本清单（manifest）管理：后台"下载分发"页直接改 latest/url 发版 ──
  // 与 routes/http/client-manifest.ts 的读取路径保持一致（cwd/config/client-manifest.json，
  // 每次请求实时读取，写完即生效，无需重启）。
  const manifestFilePath = (): string => join(process.cwd(), "config", "client-manifest.json");
  const MANIFEST_FIELDS = ["latest", "minVersion", "url", "notes", "channel"] as const;

  app.get("/api/admin/client-manifest", { preHandler: requireAdmin }, async () => {
    try {
      const manifest = JSON.parse(await readFile(manifestFilePath(), "utf8")) as Record<
        string,
        unknown
      >;
      return { ok: true, manifest };
    } catch {
      // 文件缺失/损坏：返回 null，前端按服务端内置默认展示
      return { ok: true, manifest: null };
    }
  });

  app.post("/api/admin/client-manifest", { preHandler: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let next: Record<string, unknown> = {};
    try {
      next = JSON.parse(await readFile(manifestFilePath(), "utf8")) as Record<string, unknown>;
    } catch {
      // 从空对象起步（首次保存会创建文件）
    }
    for (const field of MANIFEST_FIELDS) {
      const value = body[field];
      if (typeof value === "string") next[field] = value.trim();
    }
    for (const field of ["latest", "minVersion"] as const) {
      const value = next[field];
      if (typeof value !== "string" || !/^\d+(\.\d+){1,3}$/.test(value)) {
        return reply
          .code(400)
          .send({ ok: false, message: `${field} 版本号格式须为 x.y.z（如 0.2.1）` });
      }
    }
    const url = next.url;
    if (typeof url !== "string" || (url !== "" && !/^https?:\/\//.test(url))) {
      return reply.code(400).send({ ok: false, message: "url 须以 http(s):// 开头（留空表示暂不推送）" });
    }
    await mkdir(dirname(manifestFilePath()), { recursive: true });
    await writeFile(manifestFilePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await adminAudit(
      "client_manifest.update",
      { latest: next.latest, minVersion: next.minVersion, url: next.url, channel: next.channel },
      request,
    );
    return { ok: true, manifest: next };
  });

  // ── 内测注册白名单：名单落 data/beta-whitelist.json（BETA_WHITELIST_FILE 可覆盖），
  // 注册闸（routes/http/accounts.ts /accounts/register）每次实时读盘，这里改完即
  // 生效无需重启。名单空 = 未设闸（任何人可注册）；名单非空 = 仅名单内邮箱可注册。
  const whitelistBodySchema = z.object({ email: z.string().max(254) });

  app.get("/api/admin/beta-whitelist", { preHandler: requireAdmin }, async () => {
    if (!deps.betaWhitelistService) {
      return { ok: false, message: "白名单服务未装配", enabled: false, emails: [], updatedAt: null };
    }
    return { ok: true, ...(await deps.betaWhitelistService.snapshot()) };
  });

  app.post("/api/admin/beta-whitelist", { preHandler: requireAdmin }, async (request, reply) => {
    if (!deps.betaWhitelistService) {
      return reply.code(503).send({ ok: false, message: "白名单服务未装配" });
    }
    const parsed = whitelistBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "缺少 email" });
    }
    try {
      const snap = await deps.betaWhitelistService.add(parsed.data.email);
      await adminAudit("beta_whitelist.add", { email: BetaWhitelistService.normalize(parsed.data.email) }, request);
      return { ok: true, ...snap };
    } catch (e) {
      return reply.code(400).send({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete<{ Params: { email: string } }>(
    "/api/admin/beta-whitelist/:email",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!deps.betaWhitelistService) {
        return reply.code(503).send({ ok: false, message: "白名单服务未装配" });
      }
      const email = String(request.params.email ?? "").trim();
      if (!email) {
        return reply.code(400).send({ ok: false, message: "缺少 email" });
      }
      const snap = await deps.betaWhitelistService.remove(email);
      await adminAudit("beta_whitelist.remove", { email: email.toLowerCase() }, request);
      return { ok: true, ...snap };
    },
  );

  // ── 内测候补申请队列：登录页自助排队 → 后台批量「通过/拒绝」 ──
  // 通过 = 逐个加入注册白名单 + 邮件通知（申请人多半还没装客户端，邮件是唯一可达通道）。
  const waitlistDecideSchema = z.object({ emails: z.array(z.string()).min(1).max(200) });

  app.get("/api/admin/beta-waitlist", { preHandler: requireAdmin }, async () => {
    if (!deps.betaWaitlistService) {
      return { ok: true, requests: [] };
    }
    const requests = await deps.betaWaitlistService.list();
    return { ok: true, requests: requests.slice().reverse() };
  });

  app.post("/api/admin/beta-waitlist/approve", { preHandler: requireAdmin }, async (request, reply) => {
    if (!deps.betaWaitlistService || !deps.betaWhitelistService) {
      return reply.code(503).send({ ok: false, message: "候补通道未装配" });
    }
    const parsed = waitlistDecideSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "缺少 emails" });
    }
    const approved: string[] = [];
    const invalid: string[] = [];
    for (const raw of parsed.data.emails) {
      try {
        await deps.betaWhitelistService.add(raw);
        approved.push(BetaWhitelistService.normalize(raw));
      } catch {
        invalid.push(raw);
      }
    }
    const decided = await deps.betaWaitlistService.decide(approved, "approved");
    // 邮件通知（申请人多半还没装客户端，站内信收不到；这是唯一通知通道）。
    // 未配置 OUTBOUND_SMTP_* 时静默跳过，审批本身不受影响。
    let emailSent = 0;
    const emailFailed: Array<{ email: string; error: string }> = [];
    if (deps.emailSmsService?.isEmailEnabled() && decided.length > 0) {
      const installerUrl = await readClientManifest().then((m) => m.url).catch(() => "");
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      for (const email of decided) {
        const link = installerUrl
          ? `<p style="margin:18px 0;"><a href="${esc(installerUrl)}" style="display:inline-block;background:#111111;color:#ffffff;padding:12px 28px;border-radius:24px;text-decoration:none;font-size:14px;font-weight:600;">下载安装包（Windows）</a></p>`
          : `<p style="margin:18px 0;font-size:14px;color:#555555;">安装包整理中，请稍后回到申请页下载。</p>`;
        try {
          const result = await deps.emailSmsService.sendEmail({
            to: email,
            subject: "NEXTBOT 内测申请已通过",
            body: [
              "您的 NEXTBOT 内测申请已通过，三步开始使用：",
              installerUrl ? `1. 下载安装包：${installerUrl}` : "1. 安装包整理中，请稍后回到申请页下载",
              "2. 安装后打开应用，点「立即登录」",
              `3. 用本邮箱（${email}）登录即可开始使用`,
              "",
              "NEXTBOT · 越用越懂您的私人管家",
              "如非本人申请请忽略本邮件。",
            ].join("\n"),
            // 邮箱客户端安全：纯内联样式 + 表格骨架，无外部资源/脚本
            html: `<div style="margin:0;padding:24px 12px;background:#f4f4f5;">` +
              `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center">` +
              `<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e4e7;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">` +
              `<tr><td style="background:#0a0a0a;padding:30px 34px 26px;">` +
              `<div style="font-size:16px;font-weight:700;letter-spacing:6px;color:#ffffff;">NEXTBOT</div>` +
              `<div style="margin-top:10px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#a1a1aa;">At your service.</div>` +
              `</td></tr>` +
              `<tr><td style="padding:28px 34px 10px;">` +
              `<h2 style="margin:0 0 10px;font-size:20px;color:#111111;">您的内测申请已通过</h2>` +
              `<p style="margin:0;font-size:14px;line-height:1.8;color:#555555;">三步开始使用：</p>` +
              link +
              `<p style="margin:6px 0 0;font-size:14px;line-height:1.9;color:#555555;">` +
              `<b>1</b>. 下载并安装，桌面出现 NEXTBOT 图标<br>` +
              `<b>2</b>. 打开应用，点「立即登录」<br>` +
              `<b>3</b>. 用本邮箱（${esc(email)}）登录即可开始使用</p>` +
              `</td></tr>` +
              `<tr><td style="padding:14px 34px 24px;border-top:1px solid #eeeeee;">` +
              `<p style="margin:0;font-size:12px;line-height:1.8;color:#999999;">NEXTBOT · 越用越懂您的私人管家<br>内测名额有限，完全免费 · 如非本人申请请忽略本邮件</p>` +
              `</td></tr>` +
              `</table></td></tr></table></div>`,
          });
          if (result.ok) emailSent++;
          else emailFailed.push({ email, error: result.error });
        } catch (err) {
          emailFailed.push({ email, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (emailFailed.length > 0) {
        console.warn("[admin-console] 候补通过邮件通知失败:", emailFailed);
      }
    }
    await adminAudit(
      "beta_waitlist.approve",
      { emails: decided, invalid, emailSent, emailFailed, emailNotConfigured: !deps.emailSmsService?.isEmailEnabled() },
      request,
    );
    return { ok: true, approved: decided, invalid, notified: { emailSent, emailFailed } };
  });

  app.post("/api/admin/beta-waitlist/reject", { preHandler: requireAdmin }, async (request, reply) => {
    if (!deps.betaWaitlistService) {
      return reply.code(503).send({ ok: false, message: "候补通道未装配" });
    }
    const parsed = waitlistDecideSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "缺少 emails" });
    }
    const decided = await deps.betaWaitlistService.decide(parsed.data.emails, "rejected");
    await adminAudit("beta_waitlist.reject", { emails: decided }, request);
    return { ok: true, rejected: decided };
  });

  // ── 内测邀请码：群里发码，用户登录页填码自助过闸；支持限次/停用 ──
  const inviteCreateSchema = z.object({
    code: z.string().max(32).optional(),
    maxUses: z.number().int().min(0).max(100000).optional(),
    note: z.string().max(100).optional(),
  });
  const inviteToggleSchema = z.object({ disabled: z.boolean() });

  app.get("/api/admin/beta-invite-codes", { preHandler: requireAdmin }, async () => {
    if (!deps.betaInviteService) {
      return { ok: true, codes: [] };
    }
    const codes = await deps.betaInviteService.list();
    return { ok: true, codes: codes.slice().reverse() };
  });

  app.post("/api/admin/beta-invite-codes", { preHandler: requireAdmin }, async (request, reply) => {
    if (!deps.betaInviteService) {
      return reply.code(503).send({ ok: false, message: "邀请码服务未装配" });
    }
    const parsed = inviteCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "参数无效" });
    }
    try {
      const row = await deps.betaInviteService.create(parsed.data);
      await adminAudit("beta_invite.create", { code: row.code, maxUses: row.maxUses }, request);
      return { ok: true, code: row };
    } catch (e) {
      return reply.code(400).send({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Params: { code: string } }>(
    "/api/admin/beta-invite-codes/:code/toggle",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!deps.betaInviteService) {
        return reply.code(503).send({ ok: false, message: "邀请码服务未装配" });
      }
      const parsed = inviteToggleSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, message: "缺少 disabled" });
      }
      const row = await deps.betaInviteService.setDisabled(String(request.params.code ?? ""), parsed.data.disabled);
      if (!row) {
        return reply.code(404).send({ ok: false, message: "邀请码不存在" });
      }
      await adminAudit("beta_invite.toggle", { code: row.code, disabled: parsed.data.disabled }, request);
      return { ok: true, code: row };
    },
  );

  app.delete<{ Params: { code: string } }>(
    "/api/admin/beta-invite-codes/:code",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!deps.betaInviteService) {
        return reply.code(503).send({ ok: false, message: "邀请码服务未装配" });
      }
      const removed = await deps.betaInviteService.remove(String(request.params.code ?? ""));
      if (!removed) {
        return reply.code(404).send({ ok: false, message: "邀请码不存在" });
      }
      await adminAudit("beta_invite.remove", { code: String(request.params.code ?? "").toUpperCase() }, request);
      return { ok: true };
    },
  );

  app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
    const mem = process.memoryUsage();
    const feedback = await feedbackStatusCounts();

    // —— 用户注册：总量、今日/近7日新增、活跃（最近活跃落在窗口内）、近14日逐日趋势 ——
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const now = Date.now();
    let newToday = 0;
    let new7d = 0;
    let activeToday = 0;
    let active7d = 0;
    const regByDay = new Map<string, number>();
    for (let i = 13; i >= 0; i--) regByDay.set(localDay(now - i * DAY_MS), 0);
    for (const account of accounts) {
      const t = Date.parse(account.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t >= now - DAY_MS) newToday++;
      if (t >= now - 7 * DAY_MS) new7d++;
      const key = localDay(t);
      if (regByDay.has(key)) regByDay.set(key, (regByDay.get(key) ?? 0) + 1);
      const la = account.lastActiveAt ? Date.parse(account.lastActiveAt) : NaN;
      if (!Number.isFinite(la)) continue;
      if (la >= now - DAY_MS) activeToday++;
      if (la >= now - 7 * DAY_MS) active7d++;
    }
    const users = {
      total: accounts.length,
      disabled: accounts.filter((a) => a.disabled).length,
      newToday,
      new7d,
      activeToday,
      active7d,
      series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
    };

    // —— 支付：真实订单台账统计（模拟订单不落库），已支付金额=收入 + 近14日收入趋势 ——
    const orders = deps.paymentService ? deps.paymentService.orderStats() : null;
    if (deps.paymentService) {
      const paidByDay = new Map<string, number>();
      for (let i = 13; i >= 0; i--) paidByDay.set(localDay(now - i * DAY_MS), 0);
      for (const o of deps.paymentService.listOrders(300)) {
        if (o.status !== "paid") continue;
        const t = Date.parse(o.paidAt ?? o.createdAt);
        const key = Number.isFinite(t) ? localDay(t) : "";
        if (paidByDay.has(key)) paidByDay.set(key, (paidByDay.get(key) ?? 0) + o.amount);
      }
      (orders as Record<string, unknown>).series = [...paidByDay.entries()].map(([day, amount]) => ({
        day,
        count: amount,
      }));
    }

    // —— 站内信：总量、收/发、今日、近14日趋势 ——
    const messages = deps.messageHubService?.globalStats(14) ?? null;

    return {
      ok: true,
      server: {
        uptimeMs: Math.round(process.uptime() * 1000),
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        rssBytes: mem.rss,
      },
      users,
      orders,
      messages,
      feedback,
    };
  });

  // —— 待办计数（导航徽标轮询用）：比 overview 轻得多，专供常驻刷新 ——
  app.get("/api/admin/pending-counts", { preHandler: requireAdmin }, async () => {
    const feedback = await feedbackStatusCounts();
    const waitlistRows = deps.betaWaitlistService ? await deps.betaWaitlistService.list() : [];
    return {
      ok: true,
      feedbackOpen: feedback.open,
      feedbackProcessing: feedback.processing,
      waitlistPending: waitlistRows.filter((r) => r.status === "pending").length,
    };
  });

  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const now = Date.now();
    let newToday = 0;
    let new7d = 0;
    let activeToday = 0;
    let active7d = 0;
    let active30d = 0;
    const regByDay = new Map<string, number>();
    for (let i = 29; i >= 0; i--) regByDay.set(localDay(now - i * DAY_MS), 0);
    for (const account of accounts) {
      const t = Date.parse(account.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t >= now - DAY_MS) newToday++;
      if (t >= now - 7 * DAY_MS) new7d++;
      const key = localDay(t);
      if (regByDay.has(key)) regByDay.set(key, (regByDay.get(key) ?? 0) + 1);
      const la = account.lastActiveAt ? Date.parse(account.lastActiveAt) : NaN;
      if (!Number.isFinite(la)) continue;
      if (la >= now - DAY_MS) activeToday++;
      if (la >= now - 7 * DAY_MS) active7d++;
      if (la >= now - 30 * DAY_MS) active30d++;
    }
    const users = accounts
      .map((a) => ({
        userId: a.userId,
        displayName: a.displayName,
        email: a.email ?? null,
        setupComplete: a.setupComplete,
        disabled: Boolean(a.disabled),
        createdAt: a.createdAt,
        lastActiveAt: a.lastActiveAt ?? null,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      ok: true,
      stats: {
        total: users.length,
        disabled: users.filter((u) => u.disabled).length,
        newToday,
        new7d,
        activeToday,
        active7d,
        active30d,
        series: [...regByDay.entries()].map(([day, count]) => ({ day, count })),
      },
      users,
    };
  });

  const disableBodySchema = z.object({ disabled: z.boolean() });

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/disabled",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = disableBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const userId = String(request.params.userId ?? "").trim();
      const record = await deps.agentAccountService?.setDisabled(userId, parsed.data.disabled);
      if (!record) {
        return reply.code(404).send({ ok: false, message: "user not found" });
      }
      await adminAudit(
        parsed.data.disabled ? "user.disable" : "user.enable",
        { userId, displayName: record.displayName },
        request,
      );
      // 状态变更事件自动通知：模板渲染站内信落盘（必达），失败不影响管理操作本身
      if (deps.inboxService) {
        const notice = renderInboxTemplate(
          parsed.data.disabled ? "account.disabled" : "account.restored",
          { displayName: record.displayName },
        );
        try {
          await deps.inboxService.send({ actorId: userId, ...notice });
        } catch (err) {
          console.warn("[admin-console] account state inbox notify failed:", err);
        }
      }
      return { ok: true, account: record };
    },
  );

  app.get("/api/admin/orders", { preHandler: requireAdmin }, async () => {
    if (!deps.paymentService) {
      return { ok: true, enabled: false, stats: null, orders: [] };
    }
    const stats = deps.paymentService.orderStats();
    const orders = deps.paymentService.listOrders(300).map((o) => ({
      outTradeNo: o.outTradeNo,
      provider: o.provider,
      method: o.method,
      amount: o.amount,
      description: o.description,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
    }));
    return { ok: true, enabled: true, stats, orders };
  });

  app.get("/api/admin/messages", { preHandler: requireAdmin }, async () => {
    const hub = deps.messageHubService;
    if (!hub) return { ok: true, enabled: false, stats: null, byPlatform: [], recent: [] };
    return {
      ok: true,
      enabled: true,
      stats: hub.globalStats(14),
      byPlatform: hub.platformStats(),
      recent: hub.recentMessages(30),
    };
  });

  app.get("/api/admin/system", { preHandler: requireAdmin }, async () => {
    const mem = process.memoryUsage();
    const [storage, downloads] = await Promise.all([
      dataDirBreakdown(),
      dirSize(downloadsDirPath()),
    ]);

    // —— 依赖探活：只在配置了对应服务时探测（变量名与实际使用方一致） ——
    const qdrantUrl = process.env.AGENT_QDRANT_URL?.trim() || "";
    const qdrant = qdrantUrl
      ? { configured: true, ...(await probeQdrant(qdrantUrl)) }
      : { configured: false, ok: false, detail: "AGENT_QDRANT_URL 未配置" };
    const redisUrl =
      process.env.AGENT_REDIS_URL?.trim() || process.env.HTTP_RATE_LIMIT_REDIS_URL?.trim() || "";
    const redis = redisUrl
      ? { configured: true, ...(await probeRedis(redisUrl)) }
      : { configured: false, ok: false, detail: "AGENT_REDIS_URL / HTTP_RATE_LIMIT_REDIS_URL 未配置" };
    const modelBinding = resolvePrimaryExternalModelBinding();
    const model = modelBinding
      ? {
          configured: true,
          ok: true,
          detail: `${modelBinding.providerId} · ${modelBinding.model || "(默认模型)"} · ${modelBinding.baseUrl}`,
        }
      : {
          configured: false,
          ok: false,
          detail: "未配置任何模型密钥（MOONSHOT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY）",
        };

    // —— 定时任务（用户日程）统计 ——
    const tasks = deps.scheduleTaskService?.listAllTasks() ?? [];
    const now = Date.now();
    const jobs = {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "active" || t.status === "paused").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
      nextRunAt:
        tasks
          .map((t) => t.nextRunAt ?? t.runAt)
          .filter((t) => {
            const ms = Date.parse(t);
            return Number.isFinite(ms) && ms >= now;
          })
          .sort()[0] ?? null,
    };

    const accounts = deps.agentAccountService?.listAll() ?? [];
    const feedback = await feedbackStatusCounts();

    return {
      ok: true,
      server: {
        uptimeMs: Math.round(process.uptime() * 1000),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        cwd: process.cwd(),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        externalMemoryBytes: mem.external,
      },
      os: {
        hostname: os.hostname(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      },
      storage: {
        dataDir: storage,
        downloadsDir: { path: downloadsDirPath(), bytes: downloads.bytes, files: downloads.files },
      },
      deps: { qdrant, redis, model },
      jobs,
      accounts: { total: accounts.length, disabled: accounts.filter((a) => a.disabled).length },
      feedback,
    };
  });

  app.get("/api/admin/config", { preHandler: requireAdmin }, async () => {
    const env = process.env;
    const modelBinding = resolvePrimaryExternalModelBinding();
    return {
      ok: true,
      payment: {
        wechat: {
          mode: env.WECHAT_PAY_MODE?.trim() || "mock(默认)",
          appId: env.WECHAT_PAY_APP_ID?.trim() || null,
          mchId: env.WECHAT_PAY_MCH_ID?.trim() || null,
          apiKeySet: Boolean(env.WECHAT_PAY_API_KEY?.trim()),
          privateKeySet: Boolean(env.WECHAT_PAY_PRIVATE_KEY?.trim()),
          certSerialNo: env.WECHAT_PAY_CERT_SERIAL_NO?.trim() || null,
        },
        alipay: {
          mode: env.ALIPAY_MODE?.trim() || "mock(默认)",
          appId: env.ALIPAY_APP_ID?.trim() || null,
          gatewayUrl: env.ALIPAY_GATEWAY_URL?.trim() || "https://openapi.alipay.com/gateway.do",
          privateKeySet: Boolean(env.ALIPAY_PRIVATE_KEY?.trim()),
          publicKeySet: Boolean(env.ALIPAY_PUBLIC_KEY?.trim()),
        },
        notifyBaseUrl: env.PAYMENT_NOTIFY_BASE_URL?.trim() || null,
      },
      model: modelBinding
        ? {
            configured: true,
            providerId: modelBinding.providerId,
            model: modelBinding.model,
            baseUrl: modelBinding.baseUrl,
          }
        : { configured: false },
      mail: {
        agentMailDomain: env.AGENT_MAIL_DOMAIN?.trim() || "agents.privateai.local(默认)",
        inboundSecretSet: Boolean(env.AGENT_MAIL_INBOUND_SECRET?.trim()),
        outboundSmtpConfigured: Boolean(
          env.OUTBOUND_SMTP_HOST?.trim() && env.OUTBOUND_SMTP_USER?.trim() && env.OUTBOUND_SMTP_PASS?.trim(),
        ),
        outboundSmtpHost: env.OUTBOUND_SMTP_HOST?.trim() || null,
        outboundFrom: env.OUTBOUND_SMTP_FROM?.trim() || env.OUTBOUND_SMTP_USER?.trim() || null,
      },
      paths: {
        downloadsDir: downloadsDirPath(),
      },
    };
  });

  app.get("/api/admin/audit", { preHandler: requireAdmin }, async (request) => {
    const q = request.query as { limit?: string } | undefined;
    const parsed = q?.limit ? Number.parseInt(q.limit, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return { ok: true, entries: await readAdminAudit(limit) };
  });
}
