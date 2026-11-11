/**
 * HTTP 侧身份裁决单测。
 *
 * 锁定的是 2026-11-11 那条真实漏洞：`GET /api/...?userId=别人的邮箱` 能读到
 * 别人的数据。WS 侧早已堵死，HTTP 侧 53 处 resolveActorId 仍在采信自报值。
 *
 * 这里穷举入口组合，重点是「账号形态必须由 token 证明」这条与开关无关。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decideHttpIdentity } from "../src/http/http-identity.js";

test("有效 token：身份取 token 归属，自报账号被忽略并留痕", () => {
  const d = decideHttpIdentity({
    tokenPresent: true,
    verifiedUserId: "me@example.com",
    claimedUserId: "victim@example.com",
    strict: true,
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.actorId, "me@example.com");
  assert.equal(d.source, "token");
  assert.equal(d.claimedActorId, "victim@example.com");
});

test("无效 token：拒绝，不降级成自报身份", () => {
  const d = decideHttpIdentity({
    tokenPresent: true,
    verifiedUserId: null,
    claimedUserId: "victim@example.com",
    strict: false,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "TOKEN_INVALID");
});

test("过期 token：拒绝，文案提示重新登录", () => {
  const d = decideHttpIdentity({
    tokenPresent: true,
    verifiedUserId: null,
    tokenExpired: true,
    strict: true,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "TOKEN_INVALID");
  assert.match(d.message, /过期/);
});

test("无 token 自报邮箱：即使不开强制鉴权也拒绝（核心修复）", () => {
  for (const strict of [true, false]) {
    const d = decideHttpIdentity({
      tokenPresent: false,
      claimedUserId: "victim@example.com",
      strict,
    });
    assert.equal(d.ok, false, `strict=${strict} 时必须拒绝自报账号`);
    if (d.ok) continue;
    assert.equal(d.code, "IDENTITY_REQUIRED");
  }
});

test("无 token 自报 sessionId 里的邮箱同样拒绝（换通道绕不过）", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedSessionId: "victim@example.com",
    strict: false,
  });
  assert.equal(d.ok, false);
});

test("无 token 自报 actorId 里的邮箱同样拒绝", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedActorId: "victim@example.com",
    strict: false,
  });
  assert.equal(d.ok, false);
});

test("安装标识：按 guest 放行（未登录设备是合法身份）", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedUserId: "inst_9f8e7d6c5b4a3210",
    strict: true,
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.source, "guest");
  assert.equal(d.actorId, "inst_9f8e7d6c5b4a3210");
});

test("占位身份：按 guest 放行并标记 placeholder", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedSessionId: "session-mvp-001",
    strict: true,
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.source, "guest");
  assert.equal(d.placeholder, true);
});

test("强制模式下完全无身份：拒绝", () => {
  const d = decideHttpIdentity({ tokenPresent: false, strict: true });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "IDENTITY_REQUIRED");
});

test("宽松模式下完全无身份：按匿名放行（旧行为兼容）", () => {
  const d = decideHttpIdentity({ tokenPresent: false, strict: false });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.source, "anonymous");
});

test("迁移开关打开时允许自报账号（仅排障用）", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedUserId: "dev@example.com",
    strict: false,
    trustPayloadAccountIdentity: true,
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.actorId, "dev@example.com");
});

test("探针自定义 id：标 compat，不当账号", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedUserId: "probe-runner-7",
    strict: true,
  });
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.equal(d.source, "compat");
});
