/**
 * 认证即发证：账号登录/注册后直接签发设备 token（不再依赖 6 位配对码）。
 *
 * 覆盖三条语义：
 *  1. 签发的 token 能被 verifyToken 解出正确 userId（WS/HTTP 身份钉死的前提）；
 *  2. 同设备重复登录只保留最新一枚（撤销旧的），避免每次登录堆一条记录；
 *  3. 不同设备各自有效，互不影响（多端登录）。
 *
 * 凭证落盘钉到临时目录，绝不碰真实数据根。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "issue-token-"));
process.env.NEXTBOT_DATA_DIR = TMP;
process.env.ACCESS_TOKENS_FILE = join(TMP, "access-tokens.json");

import { AccessAuthService } from "../src/services/access-auth-service.js";

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ACTOR = "user@example.com";

test("签发即生效：verifyToken 解出 token 归属", async () => {
  const svc = new AccessAuthService();
  const issued = await svc.issueDeviceToken(ACTOR, "inst_phone_1", "Pixel");
  assert.ok(issued.token.length >= 48, "token 明文应为 64 hex 量级");
  assert.equal(issued.userId, ACTOR);
  assert.equal(issued.deviceId, "inst_phone_1");
  const verified = svc.verifyToken(issued.token);
  assert.ok(verified, "刚签发的 token 必须可校验");
  assert.equal(verified.userId, ACTOR);
  assert.equal(verified.tokenId, issued.tokenId);
});

test("同设备重复登录：旧 token 失效，只保留最新一枚", async () => {
  const svc = new AccessAuthService();
  const first = await svc.issueDeviceToken(ACTOR, "inst_phone_1");
  const second = await svc.issueDeviceToken(ACTOR, "inst_phone_1");
  assert.notEqual(first.token, second.token, "每次签发都应是新明文");
  assert.equal(svc.verifyToken(first.token), null, "旧 token 必须被撤销");
  const verified = svc.verifyToken(second.token);
  assert.ok(verified);
  assert.equal(verified.userId, ACTOR);
});

test("不同设备各自有效，互不影响", async () => {
  const svc = new AccessAuthService();
  const phone = await svc.issueDeviceToken(ACTOR, "inst_phone_1");
  const pad = await svc.issueDeviceToken(ACTOR, "inst_pad_1");
  assert.ok(svc.verifyToken(phone.token));
  assert.ok(svc.verifyToken(pad.token));
});

test("换账号登录同一设备：旧账号的 token 被撤销（不串号）", async () => {
  const svc = new AccessAuthService();
  const a = await svc.issueDeviceToken("a@example.com", "inst_phone_1");
  const b = await svc.issueDeviceToken("b@example.com", "inst_phone_1");
  assert.equal(svc.verifyToken(a.token), null, "同设备换号后旧凭据必须失效");
  assert.equal(svc.verifyToken(b.token)?.userId, "b@example.com");
});

test("缺参不签发（防止空身份 token 落库）", async () => {
  const svc = new AccessAuthService();
  await assert.rejects(() => svc.issueDeviceToken("", "inst_phone_1"));
  await assert.rejects(() => svc.issueDeviceToken(ACTOR, "  "));
});
