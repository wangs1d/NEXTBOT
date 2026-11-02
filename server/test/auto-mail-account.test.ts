/**
 * 邮箱自动接入单测：注册邮箱 → IMAP host 推断 + 逐账号 actorId 归属。
 * 诚实边界：授权码永远不猜，缺了如实报等待授权码。
 * （多租户的挂账号/凭据留存/硬闸契约在 test/mail-watch-registry.test.ts 里锁）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";

const SCRATCH = join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  `nextbot-automail-test-${process.pid}`,
);
rmSync(SCRATCH, { recursive: true, force: true });
// 服务构造时按数据根解析 processed-uids.json：直接跑本文件时 npm_lifecycle_event 为空，
// 不设这个就会指向真实数据目录（getDataDir 懒解析，模块体顶部赋值即赶在构造之前）
process.env.NEXTBOT_DATA_DIR = SCRATCH;

import { resolveAutoMailAccount, resolveAutoMailAccounts } from "../src/proactivity/auto-mail-account.js";
import { MailWatchService } from "../src/services/mail-watch-service.js";
import { AgentAccountService } from "../src/services/agent-account-service.js";
import { getDataDir } from "../src/config/data-dir.js";

if (resolve(getDataDir()) !== resolve(SCRATCH)) {
  throw new Error(`测试数据根不是临时目录（实际 ${getDataDir()}），拒绝落盘`);
}

function makeAccountService(rows: Array<Partial<{ userId: string; email: string; setupComplete: boolean; lastActiveAt: string; createdAt: string }>>): AgentAccountService {
  const svc = new AgentAccountService();
  const anySvc = svc as unknown as { byActorId: Map<string, Record<string, unknown>> };
  anySvc.byActorId.clear();
  rows.forEach((r, i) => {
    anySvc.byActorId.set(r.userId ?? `u${i}`, {
      accountId: `id-${i}`,
      userId: r.userId ?? `u${i}`,
      displayName: r.userId ?? `u${i}`,
      email: r.email,
      setupComplete: r.setupComplete ?? true,
      lastActiveAt: r.lastActiveAt,
      createdAt: r.createdAt ?? "2026-09-28T00:00:00Z",
    });
  });
  return svc;
}

test("resolveAutoMailAccount：QQ 邮箱映射 imap.qq.com，取最近活跃账号", () => {
  const svc = makeAccountService([
    { userId: "old@qq.com", email: "old@qq.com", lastActiveAt: "2026-09-28T00:00:00Z" },
    { userId: "new@qq.com", email: "new@qq.com", lastActiveAt: "2026-09-30T12:00:00Z" },
  ]);
  const acct = resolveAutoMailAccount(svc);
  assert.ok(acct);
  assert.equal(acct!.actorId, "new@qq.com", "取最近活跃的账号");
  assert.equal(acct!.imapHost, "imap.qq.com");
  assert.equal(acct!.imapPort, 993);
});

test("resolveAutoMailAccount：未收录域/无邮箱返回 null（不猜）", () => {
  assert.equal(
    resolveAutoMailAccount(makeAccountService([{ userId: "x@some-corp.cn", email: "x@some-corp.cn" }])),
    null,
    "企业邮箱域不猜 host",
  );
  assert.equal(resolveAutoMailAccount(makeAccountService([{ userId: "noemail" }])), null);
});

test("resolveAutoMailAccounts：一台机器服务多人时逐个给，各自 actorId 归属", () => {
  const list = resolveAutoMailAccounts(
    makeAccountService([
      { userId: "u1@qq.com", email: "u1@qq.com", lastActiveAt: "2026-10-01T00:00:00Z" },
      { userId: "u2@163.com", email: "u2@163.com", lastActiveAt: "2026-10-03T00:00:00Z" },
      { userId: "u3@some-corp.cn", email: "u3@some-corp.cn", lastActiveAt: "2026-10-04T00:00:00Z" },
      { userId: "u4@qq.com", email: "u4@qq.com", setupComplete: false },
    ]),
  );
  assert.deepEqual(
    list.map((a) => [a.actorId, a.imapHost]),
    [
      ["u2@163.com", "imap.163.com"],
      ["u1@qq.com", "imap.qq.com"],
    ],
    "可映射的都进来（按最近活跃排序）；未收录域与未完成注册的账号不进",
  );
  assert.equal(resolveAutoMailAccount(makeAccountService([{ userId: "u1@qq.com", email: "u1@qq.com" }]))?.actorId, "u1@qq.com");
});

test("applyAccount：账号注入即定 host/user/归属，缺授权码如实报等待授权码", () => {
  const svc = new MailWatchService({ env: { MAIL_WATCH_ENABLED: "0" } });
  svc.applyAccount({ actorId: "u@qq.com", host: "imap.qq.com", port: 993, user: "u@qq.com" });
  svc.start();
  const st = svc.status();
  assert.equal(st.enabled, false, "部署级硬闸（MAIL_WATCH_ENABLED=0）优先于接入账号");
  assert.equal(st.hardStop, true);
  assert.equal(st.running, false, "硬闸下不假装运行");
  assert.match(st.reason ?? "", /硬闸/);
  assert.equal(st.actorId, "u@qq.com", "新邮件归属跟着账号走");
});

test("applyAccount：账号自带授权码才 configured；没带不得回落到 env 里那份", () => {
  const withPass = new MailWatchService({
    env: { MAIL_WATCH_ENABLED: "1", MAIL_WATCH_PASS: "deploy-own-auth-code" },
  });
  withPass.applyAccount({ actorId: "u@qq.com", host: "imap.qq.com", port: 993, user: "u@qq.com", pass: "my-code" });
  assert.equal(withPass.isConfigured(), true);
  withPass.start();
  assert.equal(withPass.status().running, true);
  withPass.stop();

  // 拿部署方的码去连别人的邮箱 = 用别人的凭据冒名登录，绝对不允许
  const noPass = new MailWatchService({
    env: { MAIL_WATCH_ENABLED: "1", MAIL_WATCH_PASS: "deploy-own-auth-code" },
  });
  noPass.applyAccount({ actorId: "v@qq.com", host: "imap.qq.com", port: 993, user: "v@qq.com" });
  assert.equal(noPass.isConfigured(), false, "账号没带授权码就是没带");
  noPass.start();
  assert.equal(noPass.status().running, false);
  assert.match(noPass.status().reason ?? "", /授权码/);
});
