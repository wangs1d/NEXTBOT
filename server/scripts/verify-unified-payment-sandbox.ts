/**
 * 统一支付 · 支付宝链路自检（扫码 precreate / 网页收款 page.pay 共用凭证）。
 *
 * 做什么：
 *   1. 打印各渠道真实可用性（谁可收款、谁可代付、缺什么）；
 *   2. 用临时库+临时用户对「自动选中的支付宝收款渠道」完成授权 → 下单；
 *   3. 打印二维码链接/收银台地址与意图状态；
 *   4. 带 --query 时向支付宝沙箱网关主动查单（触网），验证验签与状态映射。
 *
 * 不做：不替用户付款。真实付款必须在支付宝里由买家完成——这正是
 * 「用户授权 + 用户确认」的边界，脚本不越界。
 *
 * 用法：
 *   node --import tsx server/scripts/verify-unified-payment-sandbox.ts
 *   node --import tsx server/scripts/verify-unified-payment-sandbox.ts --query
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "nextbot-pay-verify-"));
process.env.PAYMENT_UNIFIED_DB = join(workDir, "verify.db");
process.env.PAYMENT_MOCK_ENABLED = "0";

const { AlipayBotService } = await import("../src/services/alipay-bot-service.js");
const { PaymentService } = await import("../src/services/payment-service.js");
const { ChannelRegistry } = await import("../src/payments/channels/index.js");
const { PaymentAuthorizationService } = await import("../src/payments/authorization-service.js");
const { UnifiedPaymentStore } = await import("../src/payments/store.js");
const { UnifiedPaymentService } = await import("../src/payments/unified-payment-service.js");
const { verifyAlipayNotify } = await import("../src/payments/channels/alipay-qr.js");

const actorId = `verify_${Date.now().toString(36)}`;
const store = new UnifiedPaymentStore(process.env.PAYMENT_UNIFIED_DB);
const channels = ChannelRegistry.createDefault({
  alipayBotService: new AlipayBotService(),
  paymentService: new PaymentService(),
});
const service = new UnifiedPaymentService({
  store,
  authorizations: new PaymentAuthorizationService(store),
  channels,
  baseUrl: () => process.env.PAYMENT_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:3000",
});

console.log("=== 渠道可用性 ===");
for (const c of service.listChannels()) {
  console.log(
    `${c.available ? "✓" : "✗"} ${c.channel.padEnd(15)} ${c.mode.padEnd(8)} ${c.direction.padEnd(8)} ${c.label}` +
      (c.available ? "" : `\n    → ${c.reason}`),
  );
}

const target = service.listChannels().find((c) => c.available && c.direction === "collect");
if (!target) {
  console.error("\n没有可用的收款渠道，无法继续支付宝自检。");
  process.exit(1);
}
console.log(`\n本次使用渠道：${target.channel}（${target.label} / ${target.mode}）`);

const auth = service.createAuthorization({
  actorId,
  channel: target.channel,
  accepted: true,
  limits: { perTxCny: 10, dailyCny: 20, monthlyCny: 50, autoApproveCny: 10 },
  categories: ["*"],
  source: "verify-script",
});
if (!auth.ok) {
  console.error("授权创建失败:", auth.error);
  process.exit(1);
}
console.log(`授权已生效：${JSON.stringify(auth.authorization)}`);

const created = await service.createIntent({
  actorId,
  amount: 0.01,
  subject: "NEXTBOT 统一支付链路自检",
  bizDomain: "recharge",
  category: "recharge",
  idempotencyKey: `verify-${actorId}`,
});
console.log(`\n=== 下单 ===\nnextAction=${created.nextAction} status=${created.intent?.status} mode=${created.intent?.mode}`);
console.log(created.message);
if (created.intent) {
  console.log(`intentId   ${created.intent.id}`);
  console.log(`支付地址   ${created.intent.payUrl}`);
  console.log(`二维码      ${created.intent.qrCodeDataUrl ? "已生成（dataURL，可直接给客户端渲染）" : "未生成"}`);
}

// 通知验签自检：伪造参数必须被拒（证明验签是硬的，不是字符串比较）
console.log(
  `\n=== 通知验签（伪造参数应被拒）===\nverifyAlipayNotify(fake) = ${verifyAlipayNotify({
    app_id: "fake",
    out_trade_no: "NI_FAKE",
    trade_status: "TRADE_SUCCESS",
  })}`,
);

if (process.argv.includes("--query") && created.intent) {
  console.log("\n=== 主动查单（触网）===");
  const queried = await service.queryIntent(created.intent.id, actorId);
  console.log(`nextAction=${queried.nextAction} status=${queried.intent?.status}`);
  console.log(queried.message);
}

store.close();
