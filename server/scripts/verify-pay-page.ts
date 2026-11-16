/**
 * 付款页 UI 冒烟：真起一个临时服务 → 用 Chrome 打开付款页 → 点「确认付款」→
 * 断言进入 pending 并拿到真实二维码。
 *
 * 覆盖的是「用户确认 + 选择付款方式 + 点按钮」这条交互链，不替用户付款：
 * 断言停在 pending（已出码），真实扣款仍需扫那张码。
 *
 * 前置：本机有 Chrome（playwright 用 channel=chrome），且支付宝凭证可用于出码。
 * 用法：node --import tsx server/scripts/verify-pay-page.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 3996;
process.env.PAYMENT_UNIFIED_DB = join(mkdtempSync(join(tmpdir(), "nextbot-paypage-")), "verify.db");
process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
process.env.PAYMENT_ALLOWED_CATEGORIES = "*";
process.env.PORT = String(PORT);
process.env.PAYMENT_PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;

const Fastify = (await import("fastify")).default;
const { chromium } = await import("playwright");
const { PaymentAuthorizationService } = await import("../src/payments/authorization-service.js");
const { ChannelRegistry } = await import("../src/payments/channels/index.js");
const { UnifiedPaymentStore } = await import("../src/payments/store.js");
const { UnifiedPaymentService, setUnifiedPaymentService } = await import(
  "../src/payments/unified-payment-service.js"
);
const { registerUnifiedPaymentRoutes } = await import("../src/routes/http/payment-unified.js");
const { AlipayBotService } = await import("../src/services/alipay-bot-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");

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
setUnifiedPaymentService(service);

const app = Fastify();
registerUnifiedPaymentRoutes(app);
await app.listen({ port: PORT, host: "127.0.0.1" });

const actor = `verify_ui_${Date.now().toString(36)}`;
const target = service.listChannels().find((c) => c.available && c.direction === "collect");
if (!target) {
  console.error("没有可用的收款渠道，无法验收付款页");
  await app.close();
  store.close();
  process.exit(1);
}
console.log(`渠道：${target.channel}（${target.label} / ${target.mode}）`);

const auth = service.createAuthorization({
  actorId: actor,
  channel: target.channel,
  accepted: true,
  limits: { perTxCny: 10, dailyCny: 20, monthlyCny: 50, autoApproveCny: 0 },
  categories: ["*"],
  source: "verify-pay-page",
});
if (!auth.ok) {
  console.error("授权失败:", auth.error);
  await app.close();
  store.close();
  process.exit(1);
}

const created = await service.createIntent({
  actorId: actor,
  amount: 0.02,
  subject: "付款页验收",
  bizDomain: "other",
});
console.log(`意图 ${created.intent?.id} nextAction=${created.nextAction}`);
console.log(`付款页 ${created.payPageUrl}`);
if (!created.payPageUrl) {
  console.error("未返回 payPageUrl");
  await app.close();
  store.close();
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
try {
  // ── 场景一：电脑端 → 扫码页 ──
  const desk = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  await desk.goto(created.payPageUrl, { waitUntil: "networkidle" });
  await desk.waitForTimeout(1200);

  const methods = await desk.locator(".method .name").allTextContents();
  console.log("付款方式：", methods.join(" / "));
  if (methods.some((m) => m.includes("模拟支付"))) {
    throw new Error("有真实渠道时不应把模拟支付摆给用户选");
  }
  if (!methods.some((m) => m.includes("支付宝"))) throw new Error("付款方式里没有支付宝");

  await desk.click("#payBtn");
  await desk.waitForTimeout(3500);
  if (!(await desk.locator("#qrbox img").isVisible())) throw new Error("电脑端应展示扫码页二维码");
  if (await desk.locator("#mobilePane").isVisible().catch(() => false)) {
    throw new Error("电脑端不应展示手机确认页");
  }

  const state = await service.queryIntent(String(created.intent?.id), actor);
  console.log(`意图状态：${state.intent?.status}，二维码链接：${state.intent?.payUrl}`);
  if (state.intent?.status !== "pending") throw new Error("点击确认付款后未进入 pending");
  if (!state.intent?.qrCodeDataUrl) throw new Error("未生成二维码");
  console.log("✅ 场景一通过（电脑）：金额 → 选支付宝 → 确认付款 → 扫码页出码");

  // ── 场景二：手机端 → 确认页（不显示二维码，直接拉起支付宝）──
  const mobileActor = `verify_ui_m_${Date.now().toString(36)}`;
  await service.createAuthorization({
    actorId: mobileActor,
    channel: target.channel,
    accepted: true,
    limits: { perTxCny: 10, dailyCny: 20, monthlyCny: 50, autoApproveCny: 0 },
    categories: ["*"],
    source: "verify-pay-page",
  });
  const mIntent = await service.createIntent({
    actorId: mobileActor,
    amount: 0.04,
    subject: "手机端确认页验收",
    bizDomain: "other",
  });
  const mCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: MOBILE_UA,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const mob = await mCtx.newPage();
  await mob.goto(String(mIntent.payPageUrl), { waitUntil: "networkidle" });
  await mob.waitForTimeout(900);
  await mob.click("#payBtn");
  await mob.waitForTimeout(3500);

  const mMethods = await mob.locator(".method .name").allTextContents();
  console.log("手机端付款方式：", mMethods.join(" / "));
  if (mMethods.some((m) => m.includes("网页收银台"))) {
    throw new Error("手机端不应出现「支付宝（网页收银台）」");
  }
  if (mMethods.some((m) => m.includes("模拟支付"))) {
    throw new Error("有真实渠道时手机端不应出现模拟支付");
  }

  if (!(await mob.locator("#mOpen").isVisible())) throw new Error("手机端应展示「打开支付宝付款」确认页");
  if (await mob.locator("#qrbox img").isVisible()) throw new Error("手机端默认不应展示二维码");

  const openHref = await mob.locator("#mOpen").getAttribute("href");
  const mState = await service.queryIntent(String(mIntent.intent?.id), mobileActor);
  console.log(`手机端：nextAction=${mState.nextAction} 状态=${mState.intent?.status}`);
  console.log(`打开链接：${String(openHref).slice(0, 120)}…`);
  if (mState.intent?.status !== "pending") throw new Error("手机端确认后未进入 pending");
  if (!openHref || !/^https:\/\/openapi-sandbox[^/]*\/gateway\.do\?method=alipay\.trade\.wap\.pay/.test(openHref)) {
    throw new Error("手机端应拿到 alipay.trade.wap.pay 签名的收银台地址");
  }

  // 真的打开这个地址：必须落到支付宝手机收银台（而不是一个空白/报错页）
  const cashier = await mCtx.newPage();
  await cashier.goto(openHref, { waitUntil: "commit", timeout: 30_000 });
  await cashier.waitForTimeout(6000);
  const cashierUrl = cashier.url();
  const cashierText = (await cashier.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  console.log(`收银台落地：${cashierUrl.slice(0, 90)}…`);
  console.log(`收银台文案：${cashierText.slice(0, 160)}`);
  if (!/mobileclientgw|cashier/i.test(cashierUrl)) {
    throw new Error("点「打开支付宝付款」没有落到支付宝收银台");
  }
  if (!/支付宝付款|打开支付宝/.test(cashierText)) {
    throw new Error("收银台页面没有出现支付宝付款信息");
  }
  await cashier.screenshot({ path: resolve(".scratch/pay-mobile-cashier.png"), fullPage: false });
  await cashier.close();

  // 主动点「用另一台设备扫码」才展开二维码
  await mob.click("#mShowQr");
  console.log("✅ 场景二通过（手机）：确认页 → 打开支付宝 → 真实落到支付宝手机收银台");

  // ── 场景三：手机端首次使用（没有授权）→ 授权页 → 回付款页 ──
  const freshActor = `verify_ui_new_${Date.now().toString(36)}`;
  const unauthed = await service.createIntent({
    actorId: freshActor,
    amount: 0.05,
    subject: "首次付款验收",
    bizDomain: "other",
  });
  if (!unauthed.payPageUrl) throw new Error("未授权场景未返回 payPageUrl");
  console.log(`\n场景三：新用户 ${freshActor}，nextAction=${unauthed.nextAction}`);

  await mob.goto(unauthed.payPageUrl, { waitUntil: "networkidle" });
  await mob.waitForTimeout(900);
  if (!(await mob.locator("#auth").isVisible())) throw new Error("未授权时付款页应展示授权引导");
  await mob.click("#authLink");
  await mob.waitForLoadState("networkidle");
  console.log("授权页：", await mob.title());
  await mob.check("#accepted");
  await mob.click("#submit");
  await mob.waitForTimeout(1200);
  if (!(await mob.locator("#returnBtn").isVisible())) throw new Error("授权成功后应出现「去付款」回跳按钮");
  await mob.click("#returnBtn");
  await mob.waitForLoadState("networkidle");
  await mob.waitForTimeout(900);
  await mob.click("#payBtn");
  await mob.waitForTimeout(3500);

  const freshState = await service.queryIntent(String(unauthed.intent?.id), freshActor);
  console.log(`意图状态：${freshState.intent?.status}`);
  if (freshState.intent?.status !== "pending") throw new Error("授权后付款未进入 pending");
  console.log("✅ 场景三通过：未授权 → 授权页同意 → 回付款页 → 确认付款 → 待支付");
} finally {
  await browser.close();
  await app.close();
  store.close();
}
