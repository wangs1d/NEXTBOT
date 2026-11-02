/**
 * 微信消息桥的入站归属判定：按扫码时记录的微信账号反查绑定，
 * 绝不按「绑定表里排在第几个」猜主人；多条绑定又认不出来源时宁可拒答。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "wx-claw-attr-"));
// 被导入模块在加载期就会解析数据根：钉到临时目录，绝不让测试碰真实数据
process.env.NEXTBOT_DATA_DIR = TMP;

const OWNER = "2378709729@qq.com";
const OTHER = "b@other.com";

const { resolveActorFromBindings } = await import("../src/services/wechat-claw-bridge-service.js");

const TWO = {
  [OWNER]: { actorId: OWNER, accountId: "wx-open-a" },
  [OTHER]: { actorId: OTHER, accountId: "wx-open-b" },
};

test("带微信账号身份 → 命中该账号所属 actor", () => {
  assert.equal(resolveActorFromBindings(TWO, "wx-open-b"), OTHER);
  assert.equal(resolveActorFromBindings(TWO, "  WX-OPEN-B  "), OTHER, "大小写/空白不敏感");
});

test("账号对不上且有多条绑定 → 不回落第一个", () => {
  assert.equal(resolveActorFromBindings(TWO, "wx-unknown"), null);
});

test("没带账号身份且有多条绑定 → null（宁可拒答，不替用户选主人）", () => {
  assert.equal(resolveActorFromBindings(TWO), null);
});

test("全机唯一绑定 → 免身份也认（没有第二个候选人，不算猜）", () => {
  const single = { [OWNER]: { actorId: OWNER, accountId: "wx-solo" } };
  assert.equal(resolveActorFromBindings(single), OWNER);
  assert.equal(resolveActorFromBindings(single, "wx-solo"), OWNER);
  assert.equal(resolveActorFromBindings(single, "wx-other"), OWNER);
});

test("按绑定键也能反查；老数据没写 actorId 字段时退回键本身", () => {
  assert.equal(resolveActorFromBindings(TWO, OWNER), OWNER);
  assert.equal(resolveActorFromBindings({ [OWNER]: { accountId: "wx-a" } }), OWNER);
});

test("空表 / 缺字段 → null", () => {
  assert.equal(resolveActorFromBindings({}), null);
  assert.equal(resolveActorFromBindings(undefined), null);
  assert.equal(resolveActorFromBindings({ "": {} }), null);
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
