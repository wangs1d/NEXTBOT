/**
 * 邮箱盯梢 HTTP 面身份绑定单测（多租户云端）。
 * 锁三件事：① 状态与授权码都按请求者自己那份走，无身份的请求一律拒；
 * ② 一个人提交授权码不会动到别人的邮箱连接；
 * ③ pipeline 为 null（主动管道没装）时这两个路由照在——设置页接邮箱不该被它联动掉。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import test from "node:test";

// 数据根钉到临时目录：加密凭据仓与 accounts.json 都挂在数据根下面
process.env.NEXTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "mailwatch-routes-"));

const { MailWatchRegistry } = await import("../src/services/mail-watch-registry.js");
const { registerProactivityPipelineRoutes } = await import("../src/routes/http/proactivity.js");

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "mailwatch-routes-state-"));
}

function makeApp(registry: MailWatchRegistry) {
  const app = Fastify();
  registerProactivityPipelineRoutes(app, {
    pipeline: null,
    fabric: {
      sensorHealth: () => ({}),
      arbiterPreview: () => ({}),
      goalStats: () => ({}),
      selftest: async () => ({}),
      mailWatchStatus: (actorId) => registry.statusFor(actorId),
      mailWatchApplyPass: (input) => registry.saveAccount(input),
    },
  });
  return app;
}

test("GET /api/mail-watch/status：只回请求者自己那份", async () => {
  const registry = new MailWatchRegistry({ stateDir: tmpStateDir(), env: { MAIL_WATCH_ENABLED: "1" } });
  const app = makeApp(registry);
  try {
    const res = await app.inject({ method: "GET", url: "/api/mail-watch/status?userId=me@qq.com" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.actorId, "me@qq.com", "查询按请求主体归属");
    assert.equal(body.status.configured, false);
    assert.match(body.status.reason, /还没绑定邮箱/);
  } finally {
    await app.close();
  }
});

test("GET /api/mail-watch/status：不带身份拒答（不接受无身份查询）", async () => {
  const app = makeApp(new MailWatchRegistry({ stateDir: tmpStateDir(), env: { MAIL_WATCH_ENABLED: "1" } }));
  try {
    const res = await app.inject({ method: "GET", url: "/api/mail-watch/status" });
    assert.equal(res.json().ok, false);
    assert.match(String(res.json().error), /缺少账号身份/);
  } finally {
    await app.close();
  }
});

test("POST /api/mail-watch/pass：绑到提交者名下，即刻起盯；别人的账号不受影响", async () => {
  const registry = new MailWatchRegistry({
    stateDir: tmpStateDir(),
    env: { MAIL_WATCH_ENABLED: "1", MODEL_KEY_SECRET: "unit-test-master-secret" },
  });
  registry.attachAutoAccounts([
    { actorId: "other@qq.com", email: "other@qq.com", imapHost: "imap.qq.com", imapPort: 993 },
  ]);
  const app = makeApp(registry);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/mail-watch/pass",
      payload: { userId: "me@qq.com", pass: "my-auth-code" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.actorId, "me@qq.com");
    assert.equal(body.ok, true);
    assert.equal(body.persisted, true, "主密钥齐备 → 加密落盘");
    assert.equal(body.status.configured, true);
    assert.equal(body.status.user, "me@qq.com");
    assert.equal(JSON.stringify(body).includes("my-auth-code"), false, "响应不回显授权码");

    assert.equal(
      registry.statusFor("other@qq.com").user,
      "other@qq.com",
      "别人那份账号还在，只是地址/凭据都不动",
    );
    assert.equal(registry.statusFor("other@qq.com").configured, false, "没有因为这次提交被点亮");
    assert.deepEqual(
      registry.list().map((a) => [a.actorId, a.source, a.hasPass]).sort(),
      [
        ["me@qq.com", "user", true],
        ["other@qq.com", "auto", false],
      ],
    );
  } finally {
    await app.close();
  }
});

test("POST /api/mail-watch/pass：云端形态不带身份 → 400，不落任何账号", async () => {
  const registry = new MailWatchRegistry({ stateDir: tmpStateDir(), env: { MAIL_WATCH_ENABLED: "1" } });
  const app = makeApp(registry);
  try {
    const res = await app.inject({ method: "POST", url: "/api/mail-watch/pass", payload: { pass: "code" } });
    assert.equal(res.statusCode, 400);
    assert.match(String(res.json().error), /缺少账号身份/);
    assert.equal(registry.list().length, 0);

    const noPass = await app.inject({ method: "POST", url: "/api/mail-watch/pass", payload: { userId: "me@qq.com" } });
    assert.equal(noPass.statusCode, 400, "空授权码不接（否则会把已有账号的凭据抹掉）");
  } finally {
    await app.close();
    rmSync(process.env.NEXTBOT_DATA_DIR!, { recursive: true, force: true });
  }
});
