/**
 * 手机端购物链路 E2E（云端浏览器取价 → 真实价格 + 真实照片）。
 *
 * 链路：真实 BrowserSessionService（空 Cookie 库）→ 真实 ShoppingOrderService
 * （真实 Playwright 无头 chromium 开真实平台搜索页、DOM 抽价）→ 真实
 * ShoppingCompareService（同款归一 + 主图落地）→ 真实 tool handler 出卡载荷。
 *
 * 关键点：故意**不给任何 Cookie、不给可视浏览器**——完全复刻手机端
 * （canUseVisibleBrowser=false → 云端无头通道）。跑的也是**缺省平台集合**，
 * 验证「用户直接说比价」时这条链路能不能真的出价。
 *
 * 用法：cd server && node ../node_modules/tsx/dist/cli.mjs scripts/shopping-compare-cloud-e2e.ts "AirPods Pro 2"
 */
import { mkdtempSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BROWSER_SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), "pa-cloud-shop-sessions-"));
const compareDataDir = mkdtempSync(join(tmpdir(), "pa-cloud-shop-compare-"));
const imageRoot = mkdtempSync(join(tmpdir(), "pa-cloud-shop-images-"));

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { ImageGenerationService } from "../src/services/image-generation-service.js";
import { ShoppingCompareService } from "../src/services/shopping-compare-service.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import { buildToolCard } from "../src/services/tool-card-registry.js";
import { getDataDir } from "../src/config/data-dir.js";

const QUERY = process.argv[2] ?? "AirPods Pro 2";
const ACTOR = "cloud-shop-e2e";

async function main(): Promise<void> {
  const browserSessionService = new BrowserSessionService();
  const shoppingOrderService = new ShoppingOrderService({ browserSessionService });
  const imageGenerationService = new ImageGenerationService({ storageRoot: imageRoot });
  const compareService = new ShoppingCompareService({
    shoppingOrderService,
    dataDir: compareDataDir,
    imageStore: imageGenerationService,
  });

  console.log(`\n=== 手机端购物链路 E2E（云端无头浏览器） ===\n查询：「${QUERY}」 平台：缺省集合（无 Cookie / 无可视浏览器）\n`);

  const ctx = { userId: ACTOR, sessionId: "cloud-shop-e2e-session" } as never;
  const t0 = Date.now();
  const res = await compareService.comparePrices(ctx, QUERY);
  const cost = Date.now() - t0;

  if (!res.ok) {
    console.log(`❌ 比价失败（${cost}ms）：${res.error}`);
    const extra = res as unknown as { unavailablePlatforms?: unknown; handoff?: unknown };
    console.log(JSON.stringify({ unavailablePlatforms: extra.unavailablePlatforms, handoff: extra.handoff }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 比价成功（${cost}ms）`);
  console.log(`平台：requested=${res.platforms.join("/")} searched=${res.searchedPlatforms.join("/")}`);
  console.log(`摘要：${res.summary}\n`);

  let withPrice = 0;
  let withImage = 0;
  for (const [gi, g] of res.groups.slice(0, 6).entries()) {
    const best = g.offers[0];
    console.log(
      `[组${gi}] ¥${best?.priceCny ?? "?"} @${best?.platform} ${String(best?.title ?? "").slice(0, 40)}` +
        ` 图=${g.imageUrl ? "有" : "无"}`,
    );
    for (const o of g.offers) {
      if (o.priceCny != null) withPrice += 1;
      if (!o.imageUrl) continue;
      // 本地路径（/agent/images/...）→ 校验磁盘上确有这张图
      if (o.imageUrl.startsWith("/agent/images/")) {
        const rel = o.imageUrl.replace("/agent/images/", "");
        const file = join(imageRoot, rel);
        const ok = existsSync(file);
        if (ok) withImage += 1;
        console.log(
          `      ${o.platform} ¥${o.priceCny} 图=${o.imageUrl} 落盘=${ok ? `${statSync(file).size}B` : "MISSING"}`,
        );
      } else {
        console.log(`      ${o.platform} ¥${o.priceCny} 图=${o.imageUrl.slice(0, 70)}（未落地，保留原 URL）`);
      }
    }
  }

  console.log(`\n带价条目 ${withPrice} 个；本地落地主图 ${withImage} 张`);

  // 真实卡片载荷（手机端拿到的就是这份）
  const card = buildToolCard("shopping.compare.prices", res as unknown as Record<string, unknown>);
  const shopping = (card?.extra as { shopping?: { items?: Array<Record<string, unknown>> } } | undefined)?.shopping;
  console.log(`\n卡片 cardType=${card?.cardType} stage=${String(shopping?.stage)} 候选 ${shopping?.items?.length ?? 0} 张`);
  for (const it of shopping?.items ?? []) {
    console.log(`  - ${String(it.platformLabel ?? it.platform)} ¥${String(it.price ?? "-")} 图=${it.image ? "有" : "无"}`);
  }
  console.log(`footer：${String(card?.footer ?? "").slice(0, 120)}`);

  if (withPrice === 0) {
    console.log("\n❌ 一条带价报价都没有：链路仍然没打通");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("e2e 崩溃：", err);
  process.exitCode = 1;
});
