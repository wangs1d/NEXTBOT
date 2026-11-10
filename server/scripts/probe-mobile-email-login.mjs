// 手机端邮箱登录/注册真链探针（一次性，放 server/scripts/ 下；改完账号链跑它验真。
// 走的接口与手机端 EmailLoginApi 完全一致（2026-11 登录/注册分家后）：
//   1. GET  /accounts/me?userId=              账号是否已存在 → 决定走登录还是注册
//   2. POST /accounts/email/otp/start         真实 SMTP 发码
//   3. IMAP 收验证码                          证明邮件真落地
//   4. 已注册 → POST /accounts/login（错码 400 → 真码 200）
//      未注册 → POST /accounts/register（mode:"register"，真码 200）
//   5. 已注册再走一次 register(mode:"register") → 409 ACCOUNT_EXISTS（证明注册界面
//      不会把老用户悄悄当登录）
// 用法：node server/scripts/probe-mobile-email-login.mjs <目标邮箱>
import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";

const target = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
  console.error("用法：node server/scripts/probe-mobile-email-login.mjs <目标邮箱>");
  process.exit(1);
}

const env = readFileSync("server/.env", "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
const smtpUser = pick("OUTBOUND_SMTP_USER");
const smtpPass = pick("OUTBOUND_SMTP_PASS");
const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3000";

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

const getName = async (email) => {
  const res = await fetch(`${BASE}/accounts/me?userId=${encodeURIComponent(email)}`);
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, registered: data.registered === true, data };
};

console.log("=== 0) 账号是否已注册 ===");
const who = await getName(target);
console.log(who.status, "registered=", who.registered);

console.log("=== 1) otp/start ===");
const start = await post("/accounts/email/otp/start", { email: target });
console.log(start.status, JSON.stringify(start.data));
if (start.status !== 200) process.exit(1);
await new Promise((r) => setTimeout(r, 3000));

console.log("=== 2) IMAP 收验证码 ===");
const client = new ImapFlow({
  host: "imap.qq.com", port: 993, secure: true,
  auth: { user: smtpUser, pass: smtpPass },
  logger: false,
});
await client.connect();
const lock = await client.getMailboxLock("INBOX");
let code = "";
try {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const uids = await client.search({ since });
  console.log("近10分钟邮件数:", uids.length);
  for (let i = uids.length - 1; i >= 0; i--) {
    const msg = await client.fetchOne(uids[i], { envelope: true, source: true });
    const subject = msg.envelope?.subject ?? "";
    console.log("  mail:", subject.slice(0, 60));
    if (!code && subject.includes("NEXTBOT")) {
      const m = subject.match(/(\d{6})/);
      code = m?.[1] ?? "";
    }
  }
  console.log("code:", code ? "***" + code.slice(-2) : "(未提取到)");
} finally {
  lock.release();
  await client.logout();
}
if (!code) process.exit(1);

const wrongCode = code === "000000" ? "111111" : "000000";
let pass = false;

if (who.registered) {
  console.log("=== 3) login 错码（预期 400 OTP_INVALID）===");
  const wrong = await post("/accounts/login", { userId: target, email: target, otpCode: wrongCode });
  console.log(wrong.status, JSON.stringify(wrong.data));

  console.log("=== 4) login 真码（预期 200 ok）===");
  const ok = await post("/accounts/login", { userId: target, email: target, otpCode: code });
  console.log(ok.status, JSON.stringify(ok.data));
  pass = ok.status === 200 && ok.data.ok === true;

  console.log("=== 5) register(mode=register) 老号（预期 409 ACCOUNT_EXISTS）===");
  const dupe = await post("/accounts/register", {
    userId: target, displayName: "probe", email: target, mode: "register",
  });
  console.log(dupe.status, JSON.stringify(dupe.data));
  pass = pass && dupe.status === 409;
} else {
  console.log("=== 3) register(mode=register) 错码（预期 400 验证码不正确）===");
  const wrong = await post("/accounts/register", {
    userId: target, displayName: "probe", email: target, otpCode: wrongCode, mode: "register",
  });
  console.log(wrong.status, JSON.stringify(wrong.data));

  console.log("=== 4) register(mode=register) 真码（预期 200 ok）===");
  const ok = await post("/accounts/register", {
    userId: target, displayName: "probe", email: target, otpCode: code, mode: "register",
  });
  console.log(ok.status, JSON.stringify(ok.data));
  pass = ok.status === 200 && ok.data.ok === true;
}

console.log(pass ? "\n[PASS] 账号链全通（发码→收码→验证→登录/注册）" : "\n[FAIL] 账号链未通过");
process.exit(pass ? 0 : 1);
