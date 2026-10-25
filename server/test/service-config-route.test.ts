/**
 * 服务接入路由回显单测（2026-10-24）：「服务接入」页语义「已接入就把授权码填入、
 * 默认隐蔽」——已存密钥/授权码经 GET /api/service-config 回显 keyValue（供客户端
 * 回填进输入框、默认打码显示），keyTail 仍只回脱敏尾号供状态角标。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";

// 数据目录钉到临时目录：PUT 落盘不碰真实数据（getDataDir 懒解析 + 进程内缓存，
// 测试进程内首次调用发生在下面的请求期，env 已就位）
process.env.NEXTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "svc-route-"));

import { registerServiceConfigRoutes } from "../src/routes/http/service-config.js";
import type { TtsService } from "../src/services/tts-service.js";

function makeApp() {
  const app = Fastify();
  registerServiceConfigRoutes(app, {
    ttsService: {
      synthesizeMp3Base64: async () => ({ ok: false, reason: "stub" }),
    } as unknown as TtsService,
  });
  return app;
}

test("mail 块：PUT 落盘后 GET 回显 keyValue 全文，keyTail 只回尾号", async () => {
  const app = makeApp();
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: { mail: { pass: "authcode-1234" } },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().applied.mail.keyTail, "****1234");

    const res = await app.inject({ method: "GET", url: "/api/service-config" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mail.configured, true);
    assert.equal(body.mail.keyValue, "authcode-1234", "已接入 → 全文回显供输入框回填");
    assert.equal(body.mail.keyTail, "****1234", "角标仍只回尾号");
  } finally {
    await app.close();
    rmSync(process.env.NEXTBOT_DATA_DIR!, { recursive: true, force: true });
  }
});

test("model 块：已存 API Key 同样经 keyValue 回显", async () => {
  const app = makeApp();
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/service-config",
      payload: {
        model: {
          providerId: "custom",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "sk-test-ab12",
        },
      },
    });
    assert.equal(saved.statusCode, 200);

    const res = await app.inject({ method: "GET", url: "/api/service-config" });
    const body = res.json();
    assert.equal(body.model.configured, true);
    assert.equal(body.model.keyValue, "sk-test-ab12");
    assert.equal(body.model.keyTail, "****ab12");
  } finally {
    await app.close();
    rmSync(process.env.NEXTBOT_DATA_DIR!, { recursive: true, force: true });
  }
});
