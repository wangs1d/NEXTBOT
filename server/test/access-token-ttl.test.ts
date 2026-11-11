/**
 * 设备 token 的有效期与滑动续期。
 *
 * 之前的 token 永不过期：泄漏一次（截图/日志/备份）就永久有效，只能靠「同设备
 * 重新登录」把它挤掉，用户永远不知道自己被冒用。这套测试锁定三件事：
 *  1. TTL 到期后 verifyToken 失效，但记录仍在（宽限期续期要靠它认设备）；
 *  2. 宽限期内 refresh 能换新，且旧 token 立刻作废（不留可用副本）；
 *  3. 超过宽限期 refresh 失败，必须重新登录。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "token-ttl-"));
process.env.NEXTBOT_DATA_DIR = TMP;
process.env.ACCESS_TOKENS_FILE = join(TMP, "access-tokens.json");

import { AccessAuthService } from "../src/services/access-auth-service.js";

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.ACCESS_TOKEN_TTL_DAYS;
  delete process.env.ACCESS_TOKEN_REFRESH_GRACE_DAYS;
});

const ACTOR = "ttl@example.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("TTL 到期：verifyToken 失效，inspectToken 报 expired 而不是 not_found", async () => {
  // 1/86400 天 ≈ 1 秒
  process.env.ACCESS_TOKEN_TTL_DAYS = String(1 / 86400);
  process.env.ACCESS_TOKEN_REFRESH_GRACE_DAYS = "30";
  const svc = new AccessAuthService();
  const issued = await svc.issueDeviceToken(ACTOR, "inst_ttl_a");
  assert.ok(issued.expiresAt > Date.now(), "签发时应带未来过期时刻");
  assert.ok(svc.verifyToken(issued.token), "有效期内必须可校验");

  await sleep(1200);

  assert.equal(svc.verifyToken(issued.token), null, "过期后不再通过校验");
  const state = svc.inspectToken(issued.token, { allowExpired: true });
  assert.equal(state.status, "expired", "记录应保留给宽限期续期");
  assert.equal(state.userId, ACTOR);
});

test("宽限期内 refresh：换到新 token，旧 token 立即作废", async () => {
  process.env.ACCESS_TOKEN_TTL_DAYS = String(1 / 86400);
  process.env.ACCESS_TOKEN_REFRESH_GRACE_DAYS = "30";
  const svc = new AccessAuthService();
  const issued = await svc.issueDeviceToken(ACTOR, "inst_ttl_b");
  await sleep(1200);

  const refreshed = await svc.refreshToken(issued.token);
  assert.ok(!("error" in refreshed), "宽限期内应该能续期");
  if ("error" in refreshed) return;

  assert.notEqual(refreshed.token, issued.token, "必须换一枚新明文");
  assert.equal(refreshed.userId, ACTOR);
  assert.equal(refreshed.deviceId, "inst_ttl_b", "沿用原设备标识");
  assert.ok(refreshed.expiresAt > Date.now());
  assert.equal(svc.verifyToken(issued.token), null, "旧 token 换新后应立即失效");
  assert.ok(svc.verifyToken(refreshed.token), "新 token 可用");
});

test("超过宽限期 refresh：拒绝，必须重新登录", async () => {
  // 过期即超过宽限期（宽限期 0 天）
  process.env.ACCESS_TOKEN_TTL_DAYS = String(1 / 86400);
  process.env.ACCESS_TOKEN_REFRESH_GRACE_DAYS = "0";
  const svc = new AccessAuthService();
  const issued = await svc.issueDeviceToken(ACTOR, "inst_ttl_c");
  await sleep(1200);

  const result = await svc.refreshToken(issued.token);
  assert.ok("error" in result, "超过宽限期不能续期");
  if (!("error" in result)) return;
  assert.equal(result.error, "EXPIRED");
});

test("未知 token 续期：报 NOT_FOUND（与过期区分）", async () => {
  const svc = new AccessAuthService();
  const result = await svc.refreshToken("deadbeef".repeat(8));
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error, "NOT_FOUND");
});

test("TTL=0：关闭过期，token 长期有效（排障逃生口）", async () => {
  process.env.ACCESS_TOKEN_TTL_DAYS = "0";
  const svc = new AccessAuthService();
  const issued = await svc.issueDeviceToken(ACTOR, "inst_ttl_d");
  assert.equal(issued.expiresAt, 0, "关闭 TTL 时 expiresAt 为 0");
  const state = svc.inspectToken(issued.token);
  assert.equal(state.status, "ok");
});

test("启动清理：只清超过宽限期的记录，宽限期内的保留", async () => {
  process.env.ACCESS_TOKEN_TTL_DAYS = String(1 / 86400);
  process.env.ACCESS_TOKEN_REFRESH_GRACE_DAYS = "30";
  const svc = new AccessAuthService();
  const fresh = await svc.issueDeviceToken(ACTOR, "inst_ttl_e");
  await sleep(1200);
  // 刚过期，仍在宽限期内 → 不该被清
  assert.equal(svc.cleanupExpiredTokens(), 0);
  assert.equal(svc.inspectToken(fresh.token, { allowExpired: true }).status, "expired");
});
