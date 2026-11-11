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
import { isSideChatSessionIdForActor } from "../src/agent/master-chat-session.js";
import {
  isAdminSharedPath,
  isPublicAccessPath,
  isStructuredSessionId,
  pinBodyIdentity,
  pinIdentity,
} from "../src/routes/http/auth.js";

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

// ===== 2026-11-11 回归：结构性会话键不能被身份钉死改写 =====
//
// 现象：手机端「新建旁聊」进入的界面带着主会话旧对话，不是空的新会话。
// 链路：GET /api/chat-data/history?sessionId=side:<邮箱>:<id> 经周界 hook
// 被 pinIdentity 改成裸邮箱 → chat-data.ts 的 sideThread 判定失效 →
// peekThread(主线程) → 主会话历史被客户端合并进新旁聊的消息桶。
test("旁聊键含 @ 仍是会话键：pin 后保留且归属校验通过", () => {
  const actor = "me@example.com";
  const sideId = `side:${actor}:abc123`;
  const query: Record<string, unknown> = {
    userId: actor,
    limit: "200",
    sessionId: sideId,
  };
  assert.equal(isStructuredSessionId(sideId), true);
  pinIdentity(query, actor);
  assert.equal(query.sessionId, sideId);
  assert.equal(query.userId, actor);
  assert.equal(isSideChatSessionIdForActor(String(query.sessionId), actor), true);
});

test("其它结构性会话键（含邮箱）一律保留", () => {
  const actor = "me@example.com";
  const keys = [
    `notes:${actor}`,
    `incognito:${actor}`,
    `master:${actor}`,
    `master-delegate:${actor}`,
    `${actor}@wechat`,
  ];
  for (const sid of keys) {
    assert.equal(isStructuredSessionId(sid), true, sid);
    const query: Record<string, unknown> = { sessionId: sid };
    pinIdentity(query, actor);
    assert.equal(query.sessionId, sid, sid);
  }
});

test("纯账号形态的自报 sessionId 仍钉成裁决身份", () => {
  const actor = "me@example.com";
  const query: Record<string, unknown> = {
    userId: "attacker@example.com",
    actorId: "attacker@example.com",
    sessionId: actor,
  };
  assert.equal(isStructuredSessionId(actor), false);
  pinIdentity(query, actor);
  assert.equal(query.userId, actor);
  assert.equal(query.actorId, actor);
  assert.equal(query.sessionId, actor);
});

test("无 sessionId / 占位会话键不受影响", () => {
  const query: Record<string, unknown> = { userId: "whoever" };
  pinIdentity(query, "me@example.com");
  assert.equal("sessionId" in query, false);
  assert.equal(query.userId, "me@example.com");
  const placeholder: Record<string, unknown> = { sessionId: "session-mvp-001" };
  pinIdentity(placeholder, "me@example.com");
  assert.equal(placeholder.sessionId, "session-mvp-001");
});

// 2026-11-11：线上 dist 里有一段「管理后台共享路径放行」热补丁，源码没有。
// 走完整发版会把这段抹掉，后台反馈页随即被周界 401。锁死源码/产物同源。
test("管理后台共享放行只覆盖反馈接口", () => {
  assert.equal(isAdminSharedPath("/api/feedback"), true);
  assert.equal(isAdminSharedPath("/api/feedback/list"), true);
  assert.equal(isAdminSharedPath("/api/side-chats"), false);
  assert.equal(isAdminSharedPath("/api/feedbackx"), false);
});

// ── 2026-11-11 身份裁决重构收口 ──────────────────────────────────────
// sessionId 是会话键而不是身份声明：只报一个结构性会话键属于「没带凭证」，
// 不是「自称账号」。403 claimed_account 会让 NbHttp（只对 401 续期）不重试，
// 冷启动凭据尚未就绪的请求会被直接判成该重新登录。
test("只报结构性会话键 → 401 no_identity（可静默续期）", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedSessionId: "side:me@example.com:abc123",
    strict: false,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "IDENTITY_REQUIRED");
  assert.equal(d.reason, "no_identity");
});

test("只报裸邮箱 sessionId 仍是自报账号 → 403 claimed_account", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedSessionId: "victim@example.com",
    strict: false,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "claimed_account");
});

// guest 的渠道隔离键是 `inst_xxx@wechat`（只有 1 个 @）。旧判据只认 >2 段，
// 会把它当自报邮箱返 403，客户端不续期、直接回登录门禁。
test("guest 渠道隔离键（单 @）也走 401 no_identity", () => {
  const d = decideHttpIdentity({
    tokenPresent: false,
    claimedSessionId: "inst_ab12cd@wechat",
    strict: false,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "IDENTITY_REQUIRED");
  assert.equal(d.reason, "no_identity");
});

test("body 钉死只覆盖已存在的身份字段，绝不凭空注入", () => {
  const actor = "me@example.com";
  const bare: Record<string, unknown> = { text: "hello" };
  pinBodyIdentity(bare, actor);
  assert.equal("userId" in bare, false);
  assert.equal("actorId" in bare, false);

  const withIdentity: Record<string, unknown> = {
    userId: "attacker@example.com",
    actorId: "attacker@example.com",
    sessionId: `side:${actor}:abc123`,
  };
  pinBodyIdentity(withIdentity, actor);
  assert.equal(withIdentity.userId, actor);
  assert.equal(withIdentity.actorId, actor);
  assert.equal(withIdentity.sessionId, `side:${actor}:abc123`);

  const bareAccount: Record<string, unknown> = { sessionId: "attacker@example.com" };
  pinBodyIdentity(bareAccount, actor);
  assert.equal(bareAccount.sessionId, actor);
});

test("公开前缀按路径段边界匹配，/ws-evil 不再绕过周界", () => {
  assert.equal(isPublicAccessPath("/ws"), true);
  assert.equal(isPublicAccessPath("/ws/voice-duplex"), true);
  assert.equal(isPublicAccessPath("/ws-evil/private"), false);
  assert.equal(isPublicAccessPath("/admin"), true);
  assert.equal(isPublicAccessPath("/administrator/users"), false);
  assert.equal(isPublicAccessPath("/metrics"), true);
  assert.equal(isPublicAccessPath("/metrics-evil"), false);
  assert.equal(isPublicAccessPath("/api/side-chats"), false);
});
