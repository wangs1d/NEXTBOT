/**
 * 邮箱盯梢多租户契约（MailWatchRegistry）单元测试，全程假 IMAP、不发网络请求。
 *
 * 锁定这些边界：
 *   A. 一个用户一个邮箱：各自轮询、各自回调、各自归属；两个邮箱里的同一个 UID 不是同一封信
 *   B. 已处理 UID 按账号落盘，accounts.json 里不落任何授权码
 *   C. 授权码必须绑到具体用户：无身份/匿名一律拒；单机形态才允许认给本机唯一账号
 *   D. 未收录的邮箱域不猜 host，如实要求一并填 IMAP 地址
 *   E. 主密钥缺失 → 拒写盘并如实报 persisted:false；有主密钥 → 密文落盘、重启读回，明文不进文件
 *   F. MAIL_WATCH_ENABLED=0 是部署级硬闸，接入的账号也不点亮轮询
 *   G. statusFor 只回本人那份：别人的邮箱地址不出现在我的状态里
 *   H. env 里孤悬的授权码只在"整机唯一自动接入账号"时收编，多账号时不分给任何人；
 *      多账号机器要部署方用 MAIL_WATCH_PASS_OWNER 点名，认领后按 actor 加密落盘（撤掉 env 仍生效）
 *   I. 单机存量 processed-uids.json 只在整机唯一账号时收编；env 自用邮箱不许用户侧删
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const SCRATCH = join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  `nextbot-mailwatch-test-${process.pid}`,
);
rmSync(SCRATCH, { recursive: true, force: true });
// 必须在导入任何会解析数据根的模块之前设置：加密凭据仓的目录就挂在数据根下面，
// 一旦抢先解析到真实数据根，测试会把密文写进用户自己的 mail-watch/pass 目录
process.env.NEXTBOT_DATA_DIR = SCRATCH;
delete process.env.MODEL_KEY_SECRET;
delete process.env.WELLNESS_DATA_SECRET;
delete process.env.BROWSER_SESSION_SECRET;
delete process.env.SESSION_SECRET;

const { MailWatchRegistry } = await import("../src/services/mail-watch-registry.js");
const { getDataDir } = await import("../src/config/data-dir.js");
const typeMod = await import("../src/services/mail-watch-service.js");
type MailWatchClient = typeMod.MailWatchClient;
type MailWatchFetchedMail = typeMod.MailWatchFetchedMail;

if (resolve(getDataDir()) !== resolve(SCRATCH)) {
  throw new Error(`测试数据根不是临时目录（实际 ${getDataDir()}），拒绝落盘`);
}

/** 凭据密文目录（相对数据根，不受 stateDir 注入影响） */
const VAULT_DIR = join(SCRATCH, "mail-watch", "pass");
const SECRET = "unit-test-master-secret";

// ---------------------------------------------------------------------- //
// 假邮箱：每个地址一只，clientFactory 按登录名分发
// ---------------------------------------------------------------------- //

class FakeMailbox {
  mails: MailWatchFetchedMail[] = [];
  connects = 0;
  constructor(readonly user: string) {}

  add(uid: number, from: string, subject: string): void {
    this.mails.push({ uid, from, to: this.user, subject, textSnippet: `${subject}（正文摘要）` });
  }

  client(): MailWatchClient {
    return {
      connect: async () => {
        this.connects += 1;
      },
      logout: async () => {},
      mailboxOpen: async () => ({ uidValidity: 42n, exists: this.mails.length }),
      fetchRecentMessages: async (limit: number) => this.mails.slice(-limit),
      markSeen: async () => {},
    };
  }
}

interface Received {
  actorId: string;
  subject: string;
  to: string;
}

let seq = 0;
function stateDirOf(name: string): string {
  const dir = join(SCRATCH, `t${(seq += 1)}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function acct(actorId: string, email = actorId, imapHost = "imap.qq.com") {
  return { actorId, email, imapHost, imapPort: 993 };
}

function makeRegistry(opts: {
  stateDir: string;
  boxes?: Record<string, FakeMailbox>;
  env?: Record<string, string | undefined>;
  received?: Received[];
  allowAnonymousFallback?: boolean;
}): MailWatchRegistry {
  const boxes = opts.boxes ?? {};
  return new MailWatchRegistry({
    env: { MAIL_WATCH_ENABLED: "1", ...opts.env },
    stateDir: opts.stateDir,
    allowAnonymousFallback: opts.allowAnonymousFallback,
    logger: () => {},
    clientFactory: (cfg) => {
      const box = boxes[cfg.user];
      if (!box) throw new Error(`假邮箱未注册：${cfg.user}`);
      return box.client();
    },
    onNewMessage: async (mail) => {
      opts.received?.push({ actorId: mail.actorId, subject: mail.subject, to: mail.to });
    },
  });
}

// ---------------------------------------------------------------------- //
// A / B：账号隔离
// ---------------------------------------------------------------------- //

test("A 两个用户各盯各的邮箱：同一个 UID 不互相顶掉，新邮件只落自己名下", async () => {
  const boxA = new FakeMailbox("a@qq.com");
  const boxB = new FakeMailbox("b@qq.com");
  // UID 是"一个邮箱里"的编号：两只邮箱各自的第 101 封不是同一封信
  boxA.add(101, "bank@ex.com", "A 的历史账单");
  boxB.add(101, "shop@ex.com", "B 的历史订单");
  const received: Received[] = [];
  const dir = stateDirOf("isolation");
  const reg = makeRegistry({ stateDir: dir, boxes: { "a@qq.com": boxA, "b@qq.com": boxB }, received });
  reg.attachAutoAccounts([acct("a@qq.com"), acct("b@qq.com")]);
  reg.engineOf("a@qq.com");
  reg.engineOf("b@qq.com");

  await reg.pollAll(); // 首启基线：历史邮件只记账，不轰炸
  assert.deepEqual(received, [], "第一轮不该把历史邮件当新消息");

  boxA.add(102, "code@ex.com", "A 的验证码 1234");
  boxB.add(102, "code@ex.com", "B 的验证码 5678");
  await reg.pollAll();

  assert.deepEqual(received, [
    { actorId: "a@qq.com", subject: "A 的验证码 1234", to: "a@qq.com" },
    { actorId: "b@qq.com", subject: "B 的验证码 5678", to: "b@qq.com" },
  ], "两人都收到自己那封：归属与收件地址都不得顶包");

  const merged = reg.fetchNewSince(0);
  assert.equal(merged.length, 2, "内核读口合并各账号，且各自带归属");
  assert.deepEqual(merged.map((m) => m.mail.actorId).sort(), ["a@qq.com", "b@qq.com"]);

  // B：UID 基线按账号各一份文件
  const uidFiles = readdirSync(dir).filter((f) => f.startsWith("uids-"));
  assert.deepEqual(uidFiles.sort(), ["uids-a@qq.com.json", "uids-b@qq.com.json"], `实际 ${uidFiles.join(",")}`);
  const aState = JSON.parse(readFileSync(join(dir, "uids-a@qq.com.json"), "utf8")) as { uids: number[] };
  assert.deepEqual(aState.uids, [101, 102]);

  await reg.pollAll();
  assert.equal(received.length, 2, "重复轮询按各自 UID 幂等，不重推");
  reg.stop();
});

test("B accounts.json 只落非机密字段，授权码明文不进任何明文文件", () => {
  const dir = stateDirOf("accounts-plain");
  const reg = makeRegistry({ stateDir: dir, env: { MODEL_KEY_SECRET: SECRET } });
  const r = reg.saveAccount({ actorId: "plain@qq.com", pass: "PLAIN-AUTH-CODE" });
  assert.equal(r.ok, true);
  const raw = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!raw.includes("PLAIN-AUTH-CODE"), "授权码不得写明文");
  assert.ok(raw.includes("plain@qq.com"), "账号本身（地址/host）要能持久化");
  assert.ok(!raw.includes("source\":\"env"));
});

// ---------------------------------------------------------------------- //
// C / D：身份与 host 判定
// ---------------------------------------------------------------------- //

test("C 云端形态：没带账号身份的授权码一律拒，不替任何人收凭据", () => {
  const dir = stateDirOf("identity");
  const reg = makeRegistry({ stateDir: dir, env: { MODEL_KEY_SECRET: SECRET } });
  for (const actorId of ["", "   ", "anonymous"]) {
    const r = reg.saveAccount({ actorId, pass: "someone-code" });
    assert.equal(r.ok, false, `actorId="${actorId}" 必须拒收`);
    if (!r.ok) assert.match(r.error, /没带账号身份/);
  }
  assert.equal(reg.list().length, 0, "被拒的凭据不留账号壳");
});

test("C 单机装机形态：允许把无身份的提交认给本机唯一账号", () => {
  const box = new FakeMailbox("solo@qq.com");
  const dir = stateDirOf("desktop-fallback");
  const reg = makeRegistry({
    stateDir: dir,
    boxes: { "solo@qq.com": box },
    allowAnonymousFallback: true,
    env: { MODEL_KEY_SECRET: SECRET },
  });
  reg.attachAutoAccounts([acct("solo@qq.com")]);
  const r = reg.saveAccount({ actorId: "", pass: "solo-code" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.account.actorId, "solo@qq.com", "认给本机唯一账号");
});

test("C 会话号身份可用但推不出邮箱地址：如实要 email，不乱猜", () => {
  const dir = stateDirOf("session-actor");
  const reg = makeRegistry({ stateDir: dir });
  const r = reg.saveAccount({ actorId: "sess-abc123", pass: "p" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /缺邮箱地址/);
});

test("D 未收录邮箱域不猜 host；显式填了 host 才接", () => {
  const dir = stateDirOf("unknown-domain");
  const box = new FakeMailbox("me@some-corp.cn");
  const reg = makeRegistry({ stateDir: dir, boxes: { "me@some-corp.cn": box } });
  const r1 = reg.saveAccount({ actorId: "me@some-corp.cn", pass: "corp-code" });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /未收录 some-corp\.cn/);

  const r2 = reg.saveAccount({ actorId: "me@some-corp.cn", pass: "corp-code", host: "imap.some-corp.cn" });
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.account.host, "imap.some-corp.cn");
    assert.equal(r2.status.configured, true);
  }
});

// ---------------------------------------------------------------------- //
// E：加密留存与重启读回
// ---------------------------------------------------------------------- //

test("E 主密钥缺失：拒写盘，只在本次运行内生效，并在返回里如实说明", () => {
  const box = new FakeMailbox("novault@qq.com");
  const dir = stateDirOf("no-vault");
  const reg = makeRegistry({ stateDir: dir, boxes: { "novault@qq.com": box } });
  const r = reg.saveAccount({ actorId: "novault@qq.com", pass: "TEMP-CODE" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.persisted, false, "没主密钥就不能说已保存");
    assert.equal(r.account.passStored, false);
    assert.equal(r.status.configured, true, "内存里这份凭据本次运行可用");
  }
  assert.equal(existsSync(join(VAULT_DIR, "novault@qq.com.enc")), false, "没主密钥就不产出解不开的密文文件");
  reg.start();
  assert.equal(reg.runningCount(), 1, "本次运行内照盯（只是重启后要重填）");
  reg.stop();

  // 重启：本次运行内的凭据没了，状态如实回到"等待授权码"
  const revived = makeRegistry({ stateDir: dir, boxes: { "novault@qq.com": box } });
  revived.start();
  const st = revived.statusFor("novault@qq.com");
  assert.equal(st.user, "novault@qq.com", "账号（地址/host）仍从 accounts.json 读回");
  assert.equal(st.configured, false, "授权码没落盘就是没落盘");
  assert.equal(st.running, false, "不假装在盯");
  assert.match(st.reason ?? "", /授权码/);
  revived.stop();
});

test("E 主密钥齐备：密文落盘、明文不在文件里，新实例（重启）读回并起盯", () => {
  const box = new FakeMailbox("vault@qq.com");
  const dir = stateDirOf("with-vault");
  const reg = makeRegistry({ stateDir: dir, boxes: { "vault@qq.com": box }, env: { MODEL_KEY_SECRET: SECRET } });
  const r = reg.saveAccount({ actorId: "vault@qq.com", pass: "STORED-AUTH-CODE" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.persisted, true);
  const enc = join(VAULT_DIR, "vault@qq.com.enc");
  assert.ok(existsSync(enc), `应有密文文件，实际 ${existsSync(VAULT_DIR) ? readdirSync(VAULT_DIR).join(",") : "目录不存在"}`);
  assert.ok(!readFileSync(enc, "utf8").includes("STORED-AUTH-CODE"), "密文里不得出现明文授权码");

  const revived = makeRegistry({ stateDir: dir, boxes: { "vault@qq.com": box }, env: { MODEL_KEY_SECRET: SECRET } });
  const st = revived.statusFor("vault@qq.com");
  assert.equal(st.configured, true, "重启后凭据读得回来，离线期间的邮件盯梢照跑");
  assert.equal(JSON.stringify(st).includes("STORED-AUTH-CODE"), false, "状态口不回显授权码");
  revived.start();
  assert.equal(revived.runningCount(), 1);
  revived.stop();
});

test("I 删账号连密文一起清；env 自用邮箱不许用户侧删", () => {
  const dir = stateDirOf("remove");
  const reg = makeRegistry({ stateDir: dir, env: { MODEL_KEY_SECRET: SECRET } });
  reg.saveAccount({ actorId: "drop@qq.com", pass: "DROP-CODE" });
  const enc = join(VAULT_DIR, "drop@qq.com.enc");
  assert.ok(existsSync(enc));
  assert.equal(reg.removeAccount("drop@qq.com").ok, true);
  assert.equal(existsSync(enc), false, "密文必须跟着账号一起消失");
  assert.equal(reg.list().length, 0);
  assert.equal(reg.statusFor("drop@qq.com").configured, false);

  const envDir = stateDirOf("env-account");
  const envReg = makeRegistry({
    stateDir: envDir,
    env: {
      MAIL_WATCH_HOST: "imap.qq.com",
      MAIL_WATCH_USER: "deploy@qq.com",
      MAIL_WATCH_PASS: "env-code",
      MAIL_WATCH_ACTOR_ID: "deploy@qq.com",
    },
  });
  assert.equal(envReg.list()[0]?.source, "env");
  assert.equal(envReg.removeAccount("deploy@qq.com").ok, false, "部署方在 env 里配的邮箱不由用户删");
  const accountsRaw = existsSync(join(envDir, "accounts.json")) ? readFileSync(join(envDir, "accounts.json"), "utf8") : "";
  assert.ok(!accountsRaw.includes("env-code"), "env 里那份授权码不写进任何明文文件");
});

// ---------------------------------------------------------------------- //
// F / G / H：开关层级、状态可见性、孤悬授权码
// ---------------------------------------------------------------------- //

test("F MAIL_WATCH_ENABLED=0 是部署级硬闸：接入的账号也不点亮轮询", () => {
  const dir = stateDirOf("hard-stop");
  const reg = makeRegistry({ stateDir: dir, env: { MAIL_WATCH_ENABLED: "0", MAIL_WATCH_PASS: "code" } });
  reg.attachAutoAccounts([acct("gate@qq.com")]);
  reg.start();
  assert.equal(reg.runningCount(), 0, "硬闸下没有任何账号在拉邮件");
  const st = reg.statusFor("gate@qq.com");
  assert.equal(st.hardStop, true);
  assert.match(st.reason ?? "", /硬闸/);
  reg.stop();
});

test("G 没绑邮箱的账号查状态：只看得到自己那份，别人的地址不泄漏", () => {
  const box = new FakeMailbox("other@qq.com");
  const dir = stateDirOf("status-scope");
  const reg = makeRegistry({
    stateDir: dir,
    boxes: { "other@qq.com": box },
    env: { MAIL_WATCH_HOST: "imap.qq.com", MAIL_WATCH_USER: "deploy@qq.com", MAIL_WATCH_PASS: "deploy-code" },
  });
  reg.attachAutoAccounts([acct("other@qq.com")]);
  const st = reg.statusFor("stranger@qq.com");
  assert.equal(st.user, "", "未绑定就是未绑定，不能把部署方/别人的地址当我的显示");
  assert.equal(st.host, "");
  assert.equal(JSON.stringify(st).includes("other@qq.com"), false);
  assert.equal(JSON.stringify(st).includes("deploy@qq.com"), false);
  assert.match(st.reason ?? "", /还没绑定邮箱/);
  assert.equal(st.running, false);
});

test("H env 里孤悬的授权码：整机唯一自动接入账号才收编，多账号时谁都不给", () => {
  const single = makeRegistry({ stateDir: stateDirOf("orphan-single"), env: { MAIL_WATCH_PASS: "orphan-code" } });
  single.attachAutoAccounts([acct("solo2@qq.com")]);
  const singleView = single.list()[0]!;
  assert.equal(singleView.hasPass, true, "家用装机：唯一账号认下这份没有归属的授权码");
  assert.equal(singleView.source, "auto");
  single.start();
  assert.equal(single.statusFor("solo2@qq.com").configured, true);
  assert.equal(single.runningCount(), 1, "收编成功即起盯");
  single.stop();

  const multi = makeRegistry({ stateDir: stateDirOf("orphan-multi"), env: { MAIL_WATCH_PASS: "orphan-code" } });
  multi.attachAutoAccounts([acct("x1@qq.com"), acct("x2@qq.com")]);
  assert.deepEqual(
    multi.list().map((a) => a.hasPass),
    [false, false],
    "两个候选账号时不猜归属：谁的都不是",
  );
  multi.start();
  assert.equal(multi.statusFor("x1@qq.com").configured, false);
  assert.equal(multi.runningCount(), 0, "没有归属的凭据不拿去连任何人的邮箱");
  multi.stop();
});

test("H 多账号机器点名 MAIL_WATCH_PASS_OWNER：机器级授权码只认给他，并即刻按 actor 加密落盘", () => {
  const dir = stateDirOf("orphan-owner");
  const boxes = { "claimed-owner@qq.com": new FakeMailbox("claimed-owner@qq.com") };
  const env = {
    MAIL_WATCH_PASS: "machine-code",
    MAIL_WATCH_PASS_OWNER: "claimed-owner@qq.com",
    MODEL_KEY_SECRET: SECRET,
  };
  const reg = makeRegistry({ stateDir: dir, boxes, env });
  reg.attachAutoAccounts([acct("claimed-owner@qq.com"), acct("other-tenant@qq.com")]);
  const by = Object.fromEntries(reg.list().map((a) => [a.actorId, a]));
  assert.equal(by["claimed-owner@qq.com"]?.hasPass, true, "部署方点名归谁就认给谁，不再因多账号而谁都不给");
  assert.equal(by["other-tenant@qq.com"]?.hasPass, false, "没被点名的租户拿不到别人那份码");
  reg.start();
  assert.equal(reg.statusFor("claimed-owner@qq.com").running, true, "认领即起盯");
  assert.equal(reg.statusFor("other-tenant@qq.com").configured, false);
  assert.ok(existsSync(VAULT_DIR), "认领后授权码按 actor 落进加密仓");
  reg.stop();

  // 机器级那两行 env 撤掉后重启：凭据从 actor 密文里读回，不靠 env 续命
  const reopened = makeRegistry({ stateDir: dir, boxes, env: { MODEL_KEY_SECRET: SECRET } });
  assert.equal(reopened.statusFor("claimed-owner@qq.com").configured, true, "env 撤了仍在（已按 actor 持久化）");
  assert.equal(reopened.statusFor("other-tenant@qq.com").configured, false);
  reopened.stop();

  const plain = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!plain.includes("machine-code"), "明文授权码不进 accounts.json");

  // 点名点到一个没接入的账号：谁都不给
  const stray = makeRegistry({
    stateDir: stateDirOf("orphan-owner-stray"),
    env: { MAIL_WATCH_PASS: "machine-code", MAIL_WATCH_PASS_OWNER: "ghost@qq.com" },
  });
  stray.attachAutoAccounts([acct("a1@qq.com"), acct("a2@qq.com")]);
  assert.deepEqual(
    stray.list().map((a) => a.hasPass),
    [false, false],
    "点名的账号不在场就不分给任何人",
  );
  stray.stop();
});

test("H 自动接入不覆盖用户已自助改过的邮箱；同一只邮箱不挂第二份引擎", () => {
  const dir = stateDirOf("attach-non-destructive");
  const reg = makeRegistry({
    stateDir: dir,
    boxes: {},
    env: { MAIL_WATCH_HOST: "imap.qq.com", MAIL_WATCH_USER: "deploy@qq.com", MAIL_WATCH_PASS: "deploy-code" },
  });
  reg.saveAccount({ actorId: "me@qq.com", email: "me@qq.com", pass: "mine", host: "imap.qq.com" });
  reg.attachAutoAccounts([
    acct("deploy@qq.com"),
    acct("me@qq.com", "changed@qq.com", "imap.163.com"),
    acct("new@qq.com"),
  ]);
  const by = Object.fromEntries(reg.list().map((a) => [a.actorId, a]));
  assert.equal(by["deploy@qq.com"]?.source, "env", "env 自用邮箱保持 env 来源");
  assert.equal(by["deploy@qq.com"]?.hasPass, true, "env 里那份授权码跟着邮箱走");
  assert.equal(
    reg.list().filter((a) => a.user === "deploy@qq.com").length,
    1,
    "同一只邮箱只挂一份：否则重复轮询 + 邮件落到两个 actor 名下",
  );
  assert.equal(by["me@qq.com"]?.source, "user", "自助配号优先于自动接入");
  assert.equal(by["me@qq.com"]?.user, "me@qq.com", "注册地址变了也不覆盖用户自己填的地址");
  assert.equal(by["new@qq.com"]?.source, "auto");
  assert.equal(by["new@qq.com"]?.hasPass, false, "自动接入只接线，授权码无从得知");
  assert.equal(reg.defaultActorId(), "deploy@qq.com", "多账号时缺省归属只认 env 那份");
});

test("I 单机存量 processed-uids.json：整机唯一账号才收编，多账号时留着不动", () => {
  const legacy = JSON.stringify({ version: 1, initialized: true, uidValidity: "42", uids: [7, 8] });
  const singleDir = stateDirOf("legacy-single");
  writeFileSync(join(singleDir, "processed-uids.json"), legacy);
  const single = makeRegistry({ stateDir: singleDir, boxes: { "only@qq.com": new FakeMailbox("only@qq.com") } });
  single.attachAutoAccounts([acct("only@qq.com")]);
  single.start();
  single.stop();
  assert.equal(existsSync(join(singleDir, "processed-uids.json")), false, "存量基线归到唯一账号名下");
  assert.ok(existsSync(join(singleDir, "uids-only@qq.com.json")));

  const multiDir = stateDirOf("legacy-multi");
  writeFileSync(join(multiDir, "processed-uids.json"), legacy);
  const multi = makeRegistry({ stateDir: multiDir });
  multi.attachAutoAccounts([acct("m1@qq.com"), acct("m2@qq.com")]);
  multi.start();
  multi.stop();
  assert.ok(existsSync(join(multiDir, "processed-uids.json")), "不知道该给谁就不挪用，也不冒充某个用户的历史基线");
});
