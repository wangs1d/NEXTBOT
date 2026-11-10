/**
 * 真数据验证脚本：flyai CLI 已安装后跑真实搜索（只查价，不下单、不出票）。
 *
 * 用法：cd server && npx tsx scripts/verify-flyai-live.ts
 * 装配：buildQuoteAggregator({}) 默认源集（local + flyai 真实 CLI；浏览器代查未注入不挂）。
 *
 * 判定（诚实边界）：
 *   - flyai 源出真实价（priceSource=api，带 bookingUrl）→ 通
 *   - flyai 源报「体验模式价格脱敏」（未配 FLYAI_API_KEY，官方限制）→ 也算通
 *     （源必须如实报错而不是拿脱敏价/空价编造，这正是要验的行为）
 *   - local 保底源必须始终在位
 */

import type { ToolContext } from "../src/tools/tool-registry.js";
import { buildQuoteAggregator } from "../src/services/booking/quote/index.js";

const ctx: ToolContext = { sessionId: "verify-flyai-live", userId: "u-verify" };

async function main() {
  const aggregator = buildQuoteAggregator({});
  // 日期动态生成：此前硬编码 2026-09-25，日期一过飞猪就返回
  // 「入离时间校验失败/出发日期非法」，脚本永远 FAIL 且误判为链路问题。
  // 验证脚本只关心链路可达，与具体日期无关——统一取未来 7/8/10 天。
  const ymd = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const inDays = (n: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return ymd(d);
  };
  const checkIn = inDays(7);
  const checkOut = inDays(8);
  const flightDep = inDays(7);
  const flightIntl = inDays(10);
  const cases: Array<{ label: string; req: Parameters<typeof aggregator.aggregate>[0] }> = [
    { label: "酒店·杭州（国内）", req: { type: "hotel", city: "杭州", checkInDate: checkIn, checkOutDate: checkOut } },
    { label: "酒店·东京（国外）", req: { type: "hotel", city: "东京", checkInDate: checkIn, checkOutDate: checkOut } },
    { label: "机票·北京→上海", req: { type: "flight", from: "北京", to: "上海", departTime: flightDep } },
    { label: "机票·上海→东京（国际）", req: { type: "flight", from: "上海", to: "东京", departTime: flightIntl } },
  ];

  let reachable = 0;
  for (const c of cases) {
    console.log(`\n═══ ${c.label} ═══`);
    const agg = await aggregator.aggregate(c.req, ctx);
    for (const s of agg.sources) {
      const mark = s.ok ? (s.quotes.length > 0 ? `出价 ${s.quotes.length} 条` : "空") : `报错`;
      console.log(`  [${s.source}] ${mark}${s.error ? `：${s.error.slice(0, 110)}` : ""}`);
    }
    const flyai = agg.sources.filter((s) => s.source.startsWith("flyai."));
    const localOk = agg.sources.some((s) => s.source === "local" && s.ok);
    if (flyai.length > 0 && localOk && flyai.some((s) => s.ok || /体验模式/.test(s.error ?? ""))) reachable++;
    console.log(`  聚合报价（升序前 5）：`);
    if (agg.quotes.length === 0) console.log("    （无——本查询未取到实时报价，如实不出价）");
    for (const q of agg.quotes.slice(0, 5)) {
      console.log(
        `    - ${q.name ?? q.code} ¥${q.amountCny}${q.nights && q.nights > 1 ? "/晚×" + q.nights : ""} [${q.priceSource}/${q.source}]${q.bookingUrl ? " 🔗" + q.bookingUrl.slice(0, 50) : ""}`,
      );
    }
  }

  const pass = reachable === cases.length;
  console.log(`\n${pass ? "PASS" : "FAIL"}：flyai 真实链路可达 ${reachable}/${cases.length}${pass ? "" : "（体验模式=未配 FLYAI_API_KEY 或 CLI 不可达，见各源明细）"}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
