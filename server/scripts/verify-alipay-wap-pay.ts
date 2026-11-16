/**
 * 支付宝手机网站支付 · 真付款闭环验收（仅沙箱，best-effort）。
 *
 * 做什么（全程真实网关 + 真实沙箱收银台，不 mock）：
 *   1. 统一支付模块创建意图 → 手机网站支付渠道出签名收银台地址；
 *   2. 用手机 UA 打开收银台，自动走「继续浏览器付款 → 支付密码登录 → 确认付款」，
 *      买家账号取自项目根 .alipay-sandbox.json（本机文件，不入库）；
 *   3. 服务端主动查单，断言 TRADE_SUCCESS 且意图变 paid；
 *   4. 再发起一次全额退款，断言资金退回。
 *
 * 边界：这套自动化依赖支付宝沙箱收银台的页面结构，属于**验收工具**，不进业务链路；
 * 沙箱改版可能失效，失效时脚本会明确报在哪一步，不会假报成功。
 *
 * 用法：node --import tsx server/scripts/verify-alipay-wap-pay.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "nextbot-wap-pay-"));
process.env.PAYMENT_UNIFIED_DB = join(workDir, "verify.db");
process.env.PAYMENT_MOCK_ENABLED = "0";
process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
process.env.PAYMENT_ALLOWED_CATEGORIES = "*";
process.env.PAYMENT_PUBLIC_BASE_URL = "http://127.0.0.1:3992";

const { loadAlipayAccount } = await import("../src/payments/alipay-account.js");
const { PaymentAuthorizationService } = await import("../src/payments/authorization-service.js");
const { ChannelRegistry } = await import("../src/payments/channels/index.js");
const { UnifiedPaymentStore } = await import("../src/payments/store.js");
const { UnifiedPaymentService } = await import("../src/payments/unified-payment-service.js");
const { AlipayBotService } = await import("../src/services/alipay-bot-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");
const { chromium } = await import("playwright");

const account = loadAlipayAccount();
if (!account || account.env !== "sandbox") {
  console.error("需要沙箱账户（项目根 .alipay-sandbox.json）才能跑真实付款验收");
  process.exit(1);
}

// 沙箱买家账号（支付宝官方沙箱控制台发放，仅存本机）
const sandboxPath = resolve(process.env.WEBPAY_SANDBOX_CONFIG?.trim() || ".alipay-sandbox.json");
const raw = JSON.parse(readFileSync(sandboxPath, "utf8")) as {
  sandboxAccounts?: { user?: { email?: string; logonPassword?: string; payPassword?: string } };
};
const buyer = raw.sandboxAccounts?.user;
if (!buyer?.email || !buyer?.payPassword) {
  console.error("`.alipay-sandbox.json` 里缺少 sandboxAccounts.user（email / payPassword）");
  process.exit(1);
}

const store = new UnifiedPaymentStore(process.env.PAYMENT_UNIFIED_DB);
const channels = ChannelRegistry.createDefault({
  alipayBotService: new AlipayBotService(),
  paymentService: new PaymentService(),
});
const service = new UnifiedPaymentService({
  store,
  authorizations: new PaymentAuthorizationService(store),
  channels,
});

const actorId = `verify_wap_${Date.now().toString(36)}`;
const actorAuth = service.createAuthorization({
  actorId,
  channel: "alipay_wap",
  accepted: true,
  limits: { perTxCny: 1, dailyCny: 5, monthlyCny: 20, autoApproveCny: 1 },
  categories: ["*"],
  source: "verify-wap-pay",
});
if (!actorAuth.ok) {
  console.error("授权失败:", actorAuth.error);
  process.exit(1);
}

const created = await service.createIntent({
  actorId,
  amount: 0.01,
  subject: "手机网站支付闭环验收",
  bizDomain: "other",
  channel: "alipay_wap",
});
console.log(`意图 ${created.intent?.id} nextAction=${created.nextAction} status=${created.intent?.status}`);
if (!created.intent || created.nextAction !== "pay" || !created.intent.payUrl) {
  console.error("未拿到收银台地址：", created.message);
  store.close();
  process.exit(1);
}
const intentId = created.intent.id;
const payUrl = created.intent.payUrl;
console.log(`收银台 ${payUrl.slice(0, 90)}…`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  await page.goto(payUrl, { waitUntil: "commit", timeout: 30_000 });
  await page.waitForTimeout(6000);

  if (!/cashier/i.test(page.url())) {
    throw new Error(`没有落到支付宝收银台：${page.url()}`);
  }

  // 「继续浏览器付款」（沙箱里可以不起 App）
  const cont = page.getByText("继续浏览器付款", { exact: true }).first();
  if (await cont.isVisible().catch(() => false)) {
    await cont.click();
    await page.waitForTimeout(5000);
  }

  // 切「支付密码登录」→ 邮箱 + 支付密码
  const tab = page.getByText("支付密码登录", { exact: true }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
    await page.waitForTimeout(3000);
  }
  await page.waitForSelector("#logon_id", { timeout: 15_000 });
  await page.click("#logon_id");
  await page.keyboard.type(String(buyer.email), { delay: 25 });
  await page.click("#spwd");
  await page.keyboard.type(String(buyer.payPassword), { delay: 120 });
  await page.waitForTimeout(300);
  await page.getByText("下一步", { exact: true }).first().click();
  await page.waitForTimeout(6000);

  // 收银台确认
  const confirm = page.getByText("确认付款", { exact: true }).first();
  if (!(await confirm.isVisible().catch(() => false))) {
    throw new Error("登录后没有出现「确认付款」");
  }
  await confirm.click();
  await page.waitForTimeout(5000);

  // 最终支付密码
  const pwd = page.locator('input[type="password"], input[type="tel"], #spwd').last();
  if (await pwd.isVisible().catch(() => false)) {
    await pwd.click();
    await page.keyboard.type(String(buyer.payPassword), { delay: 120 });
    await page.waitForTimeout(400);
    const done = page.getByText("确定", { exact: true }).first();
    if (await done.isVisible().catch(() => false)) await done.click();
    await page.waitForTimeout(8000);
  }

  const resultText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  console.log(`收银台结果：${resultText.slice(0, 120)}`);
  if (!/支付成功/.test(resultText)) throw new Error("收银台没有显示「支付成功」");

  const paid = await service.queryIntent(intentId, actorId);
  console.log(`查单：status=${paid.intent?.status} amount=¥${paid.intent?.amount} paidAt=${paid.intent?.paidAt}`);
  if (paid.intent?.status !== "paid") throw new Error("主动查单未确认到账");

  const refund = await service.refundIntent({ intentId, actorId, reason: "验收退款" });
  console.log(`退款：ok=${refund.ok} status=${refund.status} refunded=¥${refund.refundedAmount} ${refund.message}`);
  if (!refund.ok) throw new Error("退款失败");

  console.log("\n✅ 支付宝手机网站支付闭环通过：出码 → 收银台付款 → 查单到账 → 原路退款");
} finally {
  await browser.close();
  store.close();
}
