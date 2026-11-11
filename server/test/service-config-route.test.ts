/**
 * 服务接入路由单测。锁四件事：
 * ① 任何分支都不外抄完整密钥——GET 只回脱敏尾号，字段里根本没有 keyValue
 *   （曾经全文回显供输入框回填，等于把数据根里的凭据摊给每个调这个接口的人）；
 * ② 邮箱授权码不再进 data/service-config.json，而是按请求者自己那个账号交给注册表
 *   （加密落盘 + 当场起盯），保存响应也只回状态不回授权码；
 * ③ 邮箱状态按人取：别人的邮箱地址、配没配、轮询成败都不在这个人的响应里；
 * ④ 多租户云端拒绝全站密钥写入，模型只报本会话的按 actor 绑定。
 *
 * 数据目录钉到临时目录（加密仓按 getDataDir() 落文件），绝不碰真实数据。
 */
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "svc-route-"));
process.env.NEXTBOT_DATA_DIR = SCRATCH;
process.env.MODEL_KEY_SECRET = "unit-master-secret-for-service-config-route";
delete process.env.MAIL_WATCH_PASS;
delete process.env.MINIMAX_API_KEY;

import Fastify from "fastify";

const { registerServiceConfigRoutes } = await import("../src/routes/http/service-config.js");
const { getDataDir } = await import("../src/config/data-dir.js");
const { serviceConfigFilePath, serviceSecretsEncryptedAtRest } = await import(
  "../src/config/service-config-store.js"
);
// 双保险：加密仓按 getDataDir() 落文件，钉不住就说明测试会写真实数据根
if (resolve(getDataDir()) !== resolve(SCRATCH)) throw new Error(`数据根未钉住：${getDataDir()}`);

import type { TtsService } from "../src/services/tts-service.js";
import type { MailboxAccountInput } from "../src/services/mail-watch-registry.js";

type SavedAccount = { actorId: string; pass: string };

function makeApp() {
  const saved: SavedAccount[] = [];
  const app = Fastify();
  registerServiceConfigRoutes(app, {
    ttsService: {
      synthesizeMp3Base64: async () => ({ ok: false, reason: "stub" }),
    } as unknown as TtsService,
    mailWatchApplyPass: (input: MailboxAccountInput) => {
      saved.push({ actorId: String(input.actorId ?? ""), pass: String(input.pass ?? "") });
      return {
        ok: true,
        persisted: true,
        status: { configured: true, running: true, user: input.actorId },
      };
    },
    // a 自己配过邮箱，b 没配：状态逐个给
    mailWatchStatus: (actorId: string) =>
      actorId === "a@qq.com"
        ? { configured: true, running: true, user: "a@qq.com", reason: null }
        : { configured: false, running: false, user: "", reason: "这个账号还没绑定邮箱" },
    actorByokStatus: (actorId: string) =>
      actorId === "u1@example.com"
        ? { configured: true, model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }
        : null,
  });
  return { app, saved };
}

function fileText(): string {
  try {
    return readFileSync(serviceConfigFilePath(SCRATCH), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  rmSync(serviceConfigFilePath(SCRATCH), { force: true });
  rmSync(join(SCRATCH, "service-secrets", "machine.enc"), { force: true });
  delete process.env.ACCESS_AUTH_REQUIRED;
});

test("GET 不外抄密钥：model/tts/mail 都只回尾号，没有 keyValue 字段", async () => {
  const { app } = makeApp();
  try {
    const put = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: {
        model: {
          providerId: "custom",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "sk-visible-never",
        },
        tts: { provider: "minimax", apiKey: "mk-tts-9f3k" },
      },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().applied.model.keyTail, "****ever", "保存响应只给尾号");

    const res = await app.inject({ method: "GET", url: "/api/service-config?userId=a@qq.com" });
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, "global");
    assert.equal(body.encryptedAtRest, true, "配了主密钥：密钥确实加密落盘");
    assert.equal(body.encryptedAtRest, serviceSecretsEncryptedAtRest(), "状态口报的就是加密仓的真实状态");
    assert.equal(body.model.configured, true);
    assert.equal(body.model.keyTail, "****ever");
    assert.equal(body.model.keyValue, undefined, "完整密钥不再下发");
    assert.equal(body.tts.keyTail, "****9f3k");
    assert.equal("keyValue" in body.tts, false);
    assert.equal("keyValue" in body.mail, false);
    const dumped = JSON.stringify(body);
    assert.ok(!dumped.includes("sk-visible-never"), "响应里没有模型明文密钥");
    assert.ok(!dumped.includes("mk-tts-9f3k"), "响应里没有 TTS 明文密钥");
    assert.ok(!fileText().includes("sk-visible-never"), "文件里也不躺明文密钥");
    assert.ok(!fileText().includes("mk-tts-9f3k"), "文件里也不躺 TTS 明文");
  } finally {
    await app.close();
  }
});

test("邮箱授权码：PUT 走注册表并绑给请求者，不再写进 service-config.json", async () => {
  const { app, saved } = makeApp();
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: { mail: { pass: "imap-authcode" }, userId: "a@qq.com" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved, [{ actorId: "a@qq.com", pass: "imap-authcode" }], "授权码只交给这一个账号");
    const applied = res.json().applied;
    assert.equal(applied.mail.persisted, true, "服务端确实加密落盘了");
    assert.equal(applied.mail.running, true, "当场起盯的真实状态如实回出");
    assert.equal("keyTail" in applied.mail, false, "连尾号都不必回：授权码不是拿来核对的");
    assert.ok(!JSON.stringify(res.json()).includes("imap-authcode"), "响应不回显授权码");
    assert.ok(!fileText().includes("imap-authcode"), "服务接入文件不再是授权码的家");
  } finally {
    await app.close();
  }
});

test("邮箱状态按人取：他人邮箱的地址与配置情况不外泄", async () => {
  const { app } = makeApp();
  try {
    const mine = await app.inject({ method: "GET", url: "/api/service-config?userId=a@qq.com" });
    assert.equal(mine.json().mail.configured, true);
    assert.equal(mine.json().mail.account, "a@qq.com");
    assert.equal(mine.json().mail.running, true);

    const other = await app.inject({ method: "GET", url: "/api/service-config?userId=b@qq.com" });
    const mail = other.json().mail;
    assert.equal(mail.configured, false, "b 看不到 a 那只邮箱");
    assert.equal(mail.account, "");
    assert.equal(mail.keyTail, null);
    assert.match(String(mail.reason), /还没绑定邮箱/);
  } finally {
    await app.close();
  }
});

test("请求体全空 → 400；provider 只认 minimax/openai", async () => {
  const { app } = makeApp();
  try {
    const empty = await app.inject({ method: "PUT", url: "/api/service-config", payload: {} });
    assert.equal(empty.statusCode, 400);
    const bad = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: { tts: { provider: "elevenlabs", apiKey: "x" } },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /minimax/);
  } finally {
    await app.close();
  }
});

test("多租户云端：拒绝全站密钥写入，外出字段不含密钥，只报本会话绑定", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  const { app } = makeApp();
  try {
    const put = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: {
        model: {
          providerId: "custom",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "sk-cloud-should-not-persist",
        },
      },
    });
    assert.equal(put.statusCode, 409, "云端不接受把单个用户 key 变成全站 provider");

    const res = await app.inject({ method: "GET", url: "/api/service-config?userId=u1@example.com" });
    const body = res.json();
    assert.equal(body.mode, "session-byok");
    assert.equal(body.model.source, "session-byok");
    assert.equal(body.model.configured, true);
    assert.equal(body.model.model, "deepseek-chat");
    assert.equal(body.model.keyValue, undefined);
    assert.ok(!JSON.stringify(body).includes("sk-cloud-should-not-persist"));

    const other = await app.inject({ method: "GET", url: "/api/service-config?userId=u2@example.com" });
    assert.equal(other.json().model.source !== "session-byok", true, "他人会话看不到本机绑定");
  } finally {
    delete process.env.ACCESS_AUTH_REQUIRED;
    await app.close();
  }
});

test("多租户云端：存量全站 key 不再冒充「已配置」，只认按 actor 的 BYOK", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  // 11-09 那种存量装机：data/service-config.json 里还留着一份全站模型 key。
  // 云端写入链已关、这份文件不再属于任何人的会话绑定，状态口必须如实报未配置。
  writeFileSync(
    serviceConfigFilePath(SCRATCH),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-11-09T18:11:28.145Z",
      model: {
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        apiKey: "sk-legacy-global",
        updatedAt: "2026-11-09T18:11:28.145Z",
      },
    }),
  );
  const { app } = makeApp();
  try {
    const unbound = await app.inject({
      method: "GET",
      url: "/api/service-config?userId=u2@example.com",
    });
    const model = unbound.json().model;
    assert.equal(model.configured, false, "存量全站 key 已停用，不能报已配置");
    assert.equal(model.source, null, "云端不把停用配置报成生效来源");
    assert.equal(model.keyTail, null, "云端不回显存量/运营方密钥尾号");
    assert.equal(model.baseUrl, "https://api.deepseek.com", "网关/模型仍可作表单预填建议");
    assert.ok(!JSON.stringify(unbound.json()).includes("sk-legacy-global"));

    const bound = await app.inject({
      method: "GET",
      url: "/api/service-config?userId=u1@example.com",
    });
    assert.equal(bound.json().model.configured, true, "有 BYOK 绑定才算已配置");
    assert.equal(bound.json().model.source, "session-byok");
  } finally {
    delete process.env.ACCESS_AUTH_REQUIRED;
    await app.close();
  }
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
