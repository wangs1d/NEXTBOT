import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSessionIdentity,
  isAccountIdentitySource,
  resolveSessionIdentity,
} from "../src/ws/session-identity.js";

/**
 * 身份裁决回归（2026-11-11 真机「卡在思考中」根因）。
 *
 * 关键不变式：**账号身份只能由服务端 token 证明**。没有 token 时，服务端
 * 只接受本机安装标识（guest）或明确的无凭据兼容 id（探针/联调），绝不把
 * 自报的邮箱当成账号，也不再回落任何内置默认身份。
 */

test("token 权威：自报不同身份被忽略，仍以 token 为 actor", () => {
  const r = resolveSessionIdentity({
    verifiedTokenUserId: "owner@example.com",
    claimedUserId: "session-mvp-001",
    claimedSessionId: "session-mvp-001",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "owner@example.com");
  assert.equal(r.source, "token");
  assert.equal(r.claimedActorId, "session-mvp-001");
});

test("token 与自报一致时不留 claimedActorId（不产生噪音告警）", () => {
  const r = resolveSessionIdentity({
    verifiedTokenUserId: "owner@example.com",
    claimedUserId: "owner@example.com",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "owner@example.com");
  assert.equal(r.claimedActorId, undefined);
});

test("无 token 自报邮箱 → IDENTITY_REQUIRED（不再兜底信任账号身份）", () => {
  const r = resolveSessionIdentity({ claimedUserId: "someone@example.com" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "IDENTITY_REQUIRED");
  assert.equal(r.claimedActorId, "someone@example.com");
});

test("迁移开关打开时才允许无 token 的账号身份（明确标 compat）", () => {
  const r = resolveSessionIdentity({
    claimedUserId: "someone@example.com",
    trustPayloadAccountIdentity: true,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "someone@example.com");
  assert.equal(r.source, "compat");
  assert.equal(isAccountIdentitySource(r.source), false);
});

test("无 token 的设备安装标识 → guest，可正常建连", () => {
  const r = resolveSessionIdentity({ claimedUserId: "inst_abc12345" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "inst_abc12345");
  assert.equal(r.source, "guest");
  assert.equal(r.placeholder, undefined);
});

test("旧包默认 session-mvp-001 → guest 并标记 placeholder（可连、不挂账号数据）", () => {
  const r = resolveSessionIdentity({ claimedSessionId: "session-mvp-001" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "session-mvp-001");
  assert.equal(r.source, "guest");
  assert.equal(r.placeholder, true);
  assert.equal(isAccountIdentitySource(r.source), false);
});

test("探针脚本的自定义 id → compat（不拒连，也不当账号）", () => {
  const r = resolveSessionIdentity({ claimedSessionId: "probe-bubble-m3k9" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.source, "compat");
  assert.equal(isAccountIdentitySource(r.source), false);
});

test("完全没有身份 → BAD_SESSION_INIT", () => {
  const r = resolveSessionIdentity({ claimedUserId: "   ", claimedSessionId: "" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "BAD_SESSION_INIT");
});

test("桥接通道保留自报身份（由各自桥接 token 负责）", () => {
  const r = resolveSessionIdentity({
    isBridgeChannel: true,
    claimedUserId: "owner@example.com",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.actorId, "owner@example.com");
  assert.equal(r.source, "bridge");
});

test("桥接通道缺身份 → BAD_SESSION_INIT", () => {
  const r = resolveSessionIdentity({ isBridgeChannel: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "BAD_SESSION_INIT");
});

test("身份含控制字符 → BAD_SESSION_INIT（防注入审计日志）", () => {
  const r = resolveSessionIdentity({ claimedUserId: "inst_ok\u0000evil" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "BAD_SESSION_INIT");
});

test("只有 token 来源算账号身份", () => {
  assert.equal(isAccountIdentitySource("token"), true);
  for (const s of ["bridge", "guest", "compat"] as const) {
    assert.equal(isAccountIdentitySource(s), false);
  }
});

test("描述文案能直接看出身份来源（排查用）", () => {
  const token = resolveSessionIdentity({
    verifiedTokenUserId: "owner@example.com",
    claimedUserId: "session-mvp-001",
  });
  const guest = resolveSessionIdentity({ claimedSessionId: "session-mvp-001" });
  assert.equal(token.ok, true);
  assert.equal(guest.ok, true);
  if (!token.ok || !guest.ok) return;
  assert.match(describeSessionIdentity(token), /token 权威/);
  assert.match(describeSessionIdentity(guest), /占位身份/);
});
