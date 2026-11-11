/**
 * 周界鉴权覆盖单测（ACCESS_AUTH_REQUIRED=1）：
 *  - 默认拦截对「不在 /api/ 下」的裸路径同样生效（图库/墙/笔记/聊天资产）；
 *  - 公开面只剩「取凭证本身要走的入口」与「不含用户数据的静态/探针」；
 *  - token 双通道（Bearer 头 / ?token=）与身份钉死（query + body）；
 *  - 未开启鉴权时零行为变更。
 * 凭证落盘钉到临时目录，绝不碰真实数据根。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "access-perim-"));
process.env.NEXTBOT_DATA_DIR = TMP;
process.env.ACCESS_TOKENS_FILE = join(TMP, "access-tokens.json");

import Fastify, { type FastifyInstance, type Request } from "fastify";

import { AccessAuthService } from "../src/services/access-auth-service.js";
import { EmailOtpService } from "../src/services/email-otp-service.js";
import { isPublicAccessPath, registerAccessAuthHook, registerAuthRoutes } from "../src/routes/http/auth.js";

const OWNER = "me@example.com";
const VICTIM = "victim@other.com";

function makeApp(): { app: FastifyInstance; accessAuthService: AccessAuthService } {
  const accessAuthService = new AccessAuthService();
  const app = Fastify();
  registerAccessAuthHook(app, accessAuthService);
  const echo = async (request: Request) => ({
    ok: true,
    query: request.query,
    body: (request.body ?? null) as unknown,
  });
  // 裸路径（历史上周界只盖 /api/*，这些一律漏网）
  app.get("/picture/assets", echo);
  app.get("/gallery-wall/layout", echo);
  app.get("/notes", echo);
  app.get("/schedule/tasks", echo);
  app.get("/api/some/thing", echo);
  // 公开面
  app.get("/health", echo);
  app.get("/downloads/installer.exe", echo);
  app.get("/chat/assets/embed.html", echo);
  app.get("/gallery-wall/vendor/three.module.js", echo);
  app.get("/api/auth/status", echo);
  app.get("/ws", echo);
  app.post("/api/echo", echo);
  return { app, accessAuthService };
}

async function bindFirstDevice(accessAuthService: AccessAuthService): Promise<string> {
  const code = accessAuthService.issueBindingCode(OWNER);
  const { token } = await accessAuthService.consumeBindingCode(code, "device-1");
  return token;
}

test("开启鉴权：裸路径与 /api/* 同等拦截，无身份一律 401", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  try {
    for (const url of ["/picture/assets", "/gallery-wall/layout", "/notes", "/schedule/tasks", "/api/some/thing"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 401, `${url} 必须要求凭证`);
      assert.equal(res.json().ok, false);
      assert.equal(res.json().code, "IDENTITY_REQUIRED");
    }
  } finally {
    await app.close();
  }
});

test("开启鉴权：未登录设备（inst_）按 guest 放行，但仍拿不到账号数据", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/notes?userId=inst_9f8e7d6c5b4a3210" });
    assert.equal(res.statusCode, 200, "未登录设备是合法身份，不该被 401");
  } finally {
    await app.close();
  }
});

test("未登录设备用请求头表明身份（图片/音频/WebView 发不出 query）", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  try {
    const ok = await app.inject({
      method: "GET",
      url: "/picture/assets",
      headers: { "x-nb-actor": "inst_9f8e7d6c5b4a3210" },
    });
    assert.equal(ok.statusCode, 200, "设备标识头是未登录设备的合法身份来源");
    assert.equal((ok.json().query as Record<string, string>).userId, "inst_9f8e7d6c5b4a3210");

    // 头里塞邮箱不能当成账号：没有 token 就是没有账号身份。
    const forged = await app.inject({
      method: "GET",
      url: "/picture/assets",
      headers: { "x-nb-actor": VICTIM },
    });
    assert.equal(forged.statusCode, 403, "邮箱走请求头同样必须带 token 才认");
  } finally {
    await app.close();
  }
});

test("无 token 自报邮箱：一律 403，与鉴权开关无关", async () => {
  for (const strict of ["1", undefined]) {
    if (strict) process.env.ACCESS_AUTH_REQUIRED = strict;
    else delete process.env.ACCESS_AUTH_REQUIRED;
    const { app } = makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/gallery-wall/layout?userId=victim@example.com",
      });
      assert.equal(res.statusCode, 403, `strict=${strict} 时自报账号必须被拒`);
      assert.equal(res.json().code, "IDENTITY_REQUIRED");
    } finally {
      await app.close();
    }
  }
});

test("无 token 把邮箱塞进 sessionId 或 actorId：同样 403", async () => {
  delete process.env.ACCESS_AUTH_REQUIRED;
  const { app } = makeApp();
  try {
    for (const q of ["sessionId=victim@example.com", "actorId=victim@example.com"]) {
      const res = await app.inject({ method: "GET", url: `/gallery-wall/layout?${q}` });
      assert.equal(res.statusCode, 403, `${q} 不能被当成身份`);
    }
  } finally {
    await app.close();
  }
});

test("公开面免凭证可达（注册页/安装包直链/静态库/健康探针/WS）", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  try {
    for (const url of [
      "/health",
      "/downloads/installer.exe",
      "/chat/assets/embed.html",
      "/gallery-wall/vendor/three.module.js",
      "/api/auth/status",
      "/ws",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, `${url} 属于公开面`);
    }
  } finally {
    await app.close();
  }
});

test("Bearer token 通过后把 query 身份钉到 token 归属（伪造 userId 失效）", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app, accessAuthService } = makeApp();
  try {
    const token = await bindFirstDevice(accessAuthService);
    const res = await app.inject({
      method: "GET",
      url: `/picture/assets?userId=${encodeURIComponent(VICTIM)}&sessionId=${encodeURIComponent(VICTIM)}&actorId=${encodeURIComponent(VICTIM)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    const query = res.json().query as Record<string, string>;
    assert.equal(query.userId, OWNER);
    assert.equal(query.sessionId, OWNER);
    assert.equal(query.actorId, OWNER);
  } finally {
    await app.close();
  }
});

test("?token= 通道同样有效（<img>/WebView 发不出请求头）", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app, accessAuthService } = makeApp();
  try {
    const token = await bindFirstDevice(accessAuthService);
    const ok = await app.inject({ method: "GET", url: `/picture/assets?token=${token}` });
    assert.equal(ok.statusCode, 200);
    const bad = await app.inject({ method: "GET", url: "/picture/assets?token=deadbeef" });
    assert.equal(bad.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("HTML 页用 query token 换同站 Cookie，页面内部请求继承凭证", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app, accessAuthService } = makeApp();
  try {
    const token = await bindFirstDevice(accessAuthService);
    const page = await app.inject({ method: "GET", url: `/gallery-wall/layout?token=${token}` });
    assert.equal(page.statusCode, 200);
    const cookie = page.headers["set-cookie"];
    const raw = Array.isArray(cookie) ? cookie.join(";") : String(cookie ?? "");
    assert.match(raw, new RegExp(`nb_access=${token}`), "同站 HttpOnly Cookie 落给 WebView");
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);

    const inPage = await app.inject({
      method: "GET",
      url: `/notes?userId=${encodeURIComponent(VICTIM)}`,
      headers: { cookie: `nb_access=${token}` },
    });
    assert.equal(inPage.statusCode, 200, "只有 Cookie 也认");
    assert.equal((inPage.json().query as Record<string, string>).userId, OWNER, "Cookie 身份同样钉死");

    const forged = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: "nb_access=not-a-real-token" },
    });
    assert.equal(forged.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("对象型 body 的身份字段一并钉死", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app, accessAuthService } = makeApp();
  try {
    const token = await bindFirstDevice(accessAuthService);
    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: { authorization: `Bearer ${token}` },
      payload: { userId: VICTIM, sessionId: VICTIM, note: "hello" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json().body as Record<string, string>;
    assert.equal(body.userId, OWNER);
    assert.equal(body.sessionId, OWNER);
    assert.equal(body.note, "hello", "非身份字段原样透传");
  } finally {
    await app.close();
  }
});

test("未开启鉴权：完全无身份的请求按匿名放行（宽松模式兼容旧客户端）", async () => {
  delete process.env.ACCESS_AUTH_REQUIRED;
  const { app } = makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/picture/assets" });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("isPublicAccessPath 口径：凭证链与静态/探针之外一律不公开", () => {
  assert.equal(isPublicAccessPath("/"), true);
  assert.equal(isPublicAccessPath("/assets/app.js"), true);
  assert.equal(isPublicAccessPath("/accounts/register"), true);
  assert.equal(isPublicAccessPath("/api/auth/bind"), true);
  assert.equal(isPublicAccessPath("/api/auth/devices"), false, "设备列表是用户数据，不在公开面");
  assert.equal(isPublicAccessPath("/metrics"), true);
  assert.equal(isPublicAccessPath("/picture/assets"), false);
  assert.equal(isPublicAccessPath("/gallery-wall/layout"), false);
  assert.equal(isPublicAccessPath("/notes"), false);
  assert.equal(isPublicAccessPath("/accounts/register/email/pending"), false, "自报 actorId 就能拿验证码，不进公开面");
});

test("开机链路免凭证（未配对设备也要能更新自检与注册探活）", () => {
  for (const path of [
    "/api/client/manifest",
    "/api/telemetry/client-boot",
    "/accounts/me",
    "/accounts/email/otp/start",
    "/downloads/Nextbot-Setup.exe",
  ]) {
    assert.equal(isPublicAccessPath(path), true, path);
  }
});

test("自带机器密钥的通道不被周界接管（它们的 ?token= 是另一套秘密）", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  const machineChannels = [
    "/phone-bridge/captures/me/screenshot.jpg", // PHONE_BRIDGE_TOKEN
    "/api/internal/manifest-events", // MANIFEST_EVENT_TOKEN
    "/v1/search", // 搜索代理自带访问令牌
    "/admin", // 后台会话 Cookie
    "/api/admin/clients",
    "/travel/share/abcd1234/page", // 不可猜的分享码
    "/travel-basemap/fetch.png",
    "/chat/assets/embed.html",
    "/world/register/challenge",
  ];
  for (const path of machineChannels) {
    assert.equal(isPublicAccessPath(path), true, path);
  }
  for (const dataPath of [
    "/agent/voice/messages/me/clip.mp3",
    "/api/user/avatar",
    "/travel-map/desktop",
    "/shopping/decision-page",
    "/integrations/wechat-claw/status",
    "/api/schedule/tasks",
  ]) {
    assert.equal(isPublicAccessPath(dataPath), false, dataPath);
  }
  // 真跑一遍：桥接通道的私有 token 不会被当成无效设备 token 拒掉
  app.get("/phone-bridge/captures/:actorId/:file", async () => ({ ok: true }));
  app.get("/api/internal/manifest-events", async () => ({ ok: true }));
  try {
    for (const url of [
      "/phone-bridge/captures/me/screenshot.jpg?token=bridge-secret",
      "/api/internal/manifest-events?token=manifest-secret",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, `${url} 的 token 参数归路由自己判`);
    }
  } finally {
    await app.close();
  }
});

test("第二台设备：无 token 时凭邮箱验证码签绑定码；码一次性、猜码被拒", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const accessAuthService = new AccessAuthService();
  await bindFirstDevice(accessAuthService);
  const emailOtpService = new EmailOtpService();
  let sent = "";
  await emailOtpService.issue(OWNER, { deliver: async (_email, code) => (sent = code) });

  const app = Fastify();
  registerAuthRoutes(app, { accessAuthService, emailOtpService });
  try {
    const issued = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      payload: { userId: OWNER, emailCode: sent },
    });
    assert.equal(issued.statusCode, 200);
    assert.match(issued.json().code, /^[A-Z2-9]{6}$/);
    assert.equal(issued.json().userId, OWNER);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      payload: { userId: OWNER, emailCode: sent },
    });
    assert.equal(replay.statusCode, 401, "验证码一次性，重放作废");

    const guessed = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      payload: { userId: VICTIM, emailCode: "000000" },
    });
    assert.equal(guessed.statusCode, 401, "别人邮箱的码猜不出来");

    const bare = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      payload: { userId: VICTIM },
    });
    assert.equal(bare.statusCode, 401, "既无 token 又无邮箱证明 → 拒签");

    const nonEmail = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      payload: { userId: "session-mvp-001", emailCode: sent },
    });
    assert.equal(nonEmail.statusCode, 400, "非邮箱主体不走 OTP 通道");
  } finally {
    await app.close();
    delete process.env.ACCESS_AUTH_REQUIRED;
  }
});

test("已绑定设备凭 token 签码：body 里的 userId 被 token 归属覆盖", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const accessAuthService = new AccessAuthService();
  const token = await bindFirstDevice(accessAuthService);
  const app = Fastify();
  registerAuthRoutes(app, { accessAuthService });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/pairing-code",
      headers: { authorization: `Bearer ${token}` },
      payload: { userId: VICTIM },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().userId, OWNER);
  } finally {
    await app.close();
    delete process.env.ACCESS_AUTH_REQUIRED;
  }
});

test("设备列表：只回本人名下设备，且不泄露任何凭据字段", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const accessAuthService = new AccessAuthService();
  const token = await bindFirstDevice(accessAuthService);
  const otherCode = accessAuthService.issueBindingCode(OWNER);
  await accessAuthService.consumeBindingCode(otherCode, "device-2", "手机");
  await accessAuthService.consumeBindingCode(accessAuthService.issueBindingCode(VICTIM), "device-x");

  const app = Fastify();
  registerAuthRoutes(app, { accessAuthService });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json() as { userId: string; currentTokenId: string; devices: Array<Record<string, unknown>> };
    assert.equal(data.userId, OWNER);
    assert.equal(data.devices.length, 2, "只看得到自己名下两台，别人的设备不进列表");
    assert.ok(data.currentTokenId, "回本机编号供 UI 标注");
    for (const d of data.devices) {
      assert.ok(!("token" in d) && !("tokenHash" in d), "列表不得带出凭据");
    }

    const anonymous = await app.inject({ method: "GET", url: "/api/auth/devices" });
    assert.equal(anonymous.statusCode, 401, "没凭证列不出设备");
  } finally {
    await app.close();
    delete process.env.ACCESS_AUTH_REQUIRED;
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
