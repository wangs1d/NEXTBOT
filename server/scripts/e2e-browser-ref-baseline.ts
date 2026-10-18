/**
 * e2e：agent_browser extract 元素列表「旧版( raw querySelectorAll ) vs 新版( ariaSnapshot ref )」
 * 前后对照测试。改造前后各跑一次，输出可比对的精确度 / token 指标。
 *
 * 方案：内置 http server 模拟天猫详情页结构（130 个导航/促销/评价链接 +
 * 3000 字正文 + 底部吸底购买栏「领券购买」，订单页「同意协议并提交订单」）。
 * 目标元素排在 DOM 末尾——旧版 100 名额被导航吃光时它不可见，新版必须可见。
 *
 * 运行：npx tsx scripts/e2e-browser-ref-baseline.ts old|new
 * 结果：data/e2e-browser-ref-baseline-{tag}.json
 */
import { writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext } from "../src/tools/tool-registry.js";
import { registerAgentBrowserTools } from "../src/tools/capability-modules/agent-browser/handlers.js";
import { AgentBrowserService } from "../src/services/agent-browser-service.js";
import { estimateTokensForText } from "../src/services/llm-token-audit.js";

const TAG = process.argv[2] ?? "old";
const PORT = 18090;
const BASE = `http://127.0.0.1:${PORT}`;

// ── 测试页 ──
const NAV_LABELS = [
  "女装", "男装", "童装", "家电", "数码", "美妆", "食品", "生鲜", "家居", "运动",
  "图书", "医药", "汽车", "母婴", "宠物", "珠宝", "钟表", "酒类", "鲜花", "绿植",
];
const LOREM = "心相印经典系列抽纸，采用原生木浆材质，四层加厚设计，柔韧亲肤不易破。".repeat(46);

function navLinksHtml(count: number, prefix: string): string {
  let html = "";
  for (let i = 0; i < count; i++) {
    const label = `${NAV_LABELS[i % NAV_LABELS.length]}频道${prefix}${i}`;
    html += `<a href="/nav/${i}">${label}</a> `;
  }
  return html;
}

const DETAIL_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>心相印经典抽纸 - 详情</title></head>
<body>
<nav id="site-nav">${navLinksHtml(60, "nav")}</nav>
<div id="promo">${navLinksHtml(40, "promo")}</div>
<main><h1>心相印经典抽纸</h1><p>${LOREM}</p><div id="comments">${navLinksHtml(30, "cm")}</div></main>
<div id="buy-bar" style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:8px">
  <input id="qty" type="number" value="1" aria-label="购买数量" />
  <button id="add-cart">加入购物车</button>
  <button id="buy-btn">领券购买</button>
</div>
<script>
document.getElementById("buy-btn").onclick = () => location.href = "/order";
document.getElementById("add-cart").onclick = () => alert("已加入");
</script>
</body></html>`;

const ORDER_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>确认订单</title></head>
<body>
<nav id="site-nav">${navLinksHtml(60, "nav")}</nav>
<div id="addr">${navLinksHtml(40, "addr")}</div>
<main><h1>确认订单</h1><p>心相印经典抽纸 x1，实付款：¥9.9</p><div id="extra">${navLinksHtml(30, "ex")}</div></main>
<div id="submit-bar" style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:8px">
  <button id="submit-btn">同意协议并提交订单</button>
</div>
<script>
document.getElementById("submit-btn").onclick = () => location.href = "/success";
</script>
</body></html>`;

const SUCCESS_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>下单成功</title></head><body><h1>订单提交成功</h1><p>订单号 202610180001</p></body></html>`;

function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = path.startsWith("/order")
      ? ORDER_HTML
      : path.startsWith("/success")
        ? SUCCESS_HTML
        : DETAIL_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// ── 指标 ──
interface ExtractLike {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  interactive?: unknown;
  [k: string]: unknown;
}

/** extract_text 返回整体的 LLM 可见 token（与 tool result 注入口径一致）。 */
function resultTokens(r: ExtractLike): number {
  return estimateTokensForText(JSON.stringify(r));
}

/** Top-1 检索：从 extract 返回里找目标按钮（旧=对象数组，新=紧凑 ref 行字符串）。 */
function findTarget(r: ExtractLike, keywords: string[]): { hit: boolean; ref?: string; selector?: string } {
  const interactive = r.interactive;
  if (typeof interactive === "string") {
    for (const line of interactive.split("\n")) {
      const m = line.match(/^(\S+)\s+(\w+)\s+"([^"]*)"/);
      const name = m ? m[3] : line;
      if (keywords.some((kw) => name.includes(kw))) {
        return { hit: true, ref: m?.[1] };
      }
    }
    return { hit: false };
  }
  const list = (interactive ?? []) as Array<Record<string, unknown>>;
  for (const el of list) {
    const text = String(el.text ?? el.name ?? "");
    if (keywords.some((kw) => text.includes(kw))) {
      return { hit: true, ref: typeof el.ref === "string" ? el.ref : undefined, selector: typeof el.selector === "string" ? el.selector : undefined };
    }
  }
  return { hit: false };
}

async function main(): Promise<void> {
  console.log(`=== agent_browser 元素列表对照测试（${TAG}）===`);
  const server = await startServer();

  const agentBrowserService = new AgentBrowserService({
    browserSessionService: { getCookiesForAgent: async () => [] } as never,
  });
  const registry = new ToolRegistry();
  registerAgentBrowserTools(registry, { agentBrowserService });
  const ctx: ToolContext = { sessionId: `e2e-ref-${TAG}`, userId: "e2e-ref-user" };

  const exec = async (name: string, input: Record<string, unknown>) => {
    const t0 = Date.now();
    const { result } = await registry.execute(name, input, ctx);
    console.log(`  [${name}] ${Date.now() - t0}ms`);
    return result;
  };

  const metrics: Record<string, unknown> = { tag: TAG, steps: [] as unknown[] };
  const steps = metrics.steps as Array<Record<string, unknown>>;

  // ── 详情页 ──
  const opened = await exec("agent_browser.open", { url: `${BASE}/`, waitUntil: "domcontentloaded" });
  const sessionId = String(opened.sessionId ?? "");
  await new Promise((r) => setTimeout(r, 1_000));

  const detail = (await exec("agent_browser.extract_text", { sessionId })) as ExtractLike;
  const detailTokens = resultTokens(detail);
  const detailInteractive = detail.interactive;
  const detailInteractiveCount = typeof detailInteractive === "string"
    ? detailInteractive.split("\n").length
    : ((detailInteractive as unknown[]) ?? []).length;
  const buyHit = findTarget(detail, ["领券购买"]);
  console.log(`详情页: extract token=${detailTokens}, interactive=${detailInteractiveCount}, 领券购买可见=${buyHit.hit}`);
  steps.push({ page: "detail", extractTokens: detailTokens, interactiveCount: detailInteractiveCount, targetVisible: buyHit.hit, targetRef: buyHit.ref, targetSelector: buyHit.selector });

  // 点击目标（旧版用 selector，新版优先 ref）
  let buyClicked = false;
  if (buyHit.hit) {
    const clickInput: Record<string, unknown> = { sessionId };
    if (buyHit.ref) clickInput.ref = buyHit.ref;
    else if (buyHit.selector) clickInput.selector = buyHit.selector;
    const clicked = await exec("agent_browser.click", clickInput);
    buyClicked = clicked.ok !== false;
    await new Promise((r) => setTimeout(r, 1_500));
    const after = (await exec("agent_browser.extract_text", { sessionId, includeInteractive: false })) as ExtractLike;
    buyClicked = buyClicked && /\/order/.test(String(after.url ?? ""));
  }
  console.log(`详情页→订单页跳转: ${buyClicked}`);
  steps.push({ page: "detail", clickOk: buyClicked });

  // ── 订单页 ──
  const order = (await exec("agent_browser.extract_text", { sessionId })) as ExtractLike;
  const orderTokens = resultTokens(order);
  const orderInteractive = order.interactive;
  const orderInteractiveCount = typeof orderInteractive === "string"
    ? orderInteractive.split("\n").length
    : ((orderInteractive as unknown[]) ?? []).length;
  const submitHit = findTarget(order, ["同意协议并提交订单", "提交订单"]);
  console.log(`订单页: extract token=${orderTokens}, interactive=${orderInteractiveCount}, 提交按钮可见=${submitHit.hit}`);
  steps.push({ page: "order", extractTokens: orderTokens, interactiveCount: orderInteractiveCount, targetVisible: submitHit.hit, targetRef: submitHit.ref, targetSelector: submitHit.selector });

  let submitClicked = false;
  if (submitHit.hit) {
    const clickInput: Record<string, unknown> = { sessionId };
    if (submitHit.ref) clickInput.ref = submitHit.ref;
    else if (submitHit.selector) clickInput.selector = submitHit.selector;
    const clicked = await exec("agent_browser.click", clickInput);
    submitClicked = clicked.ok !== false;
    await new Promise((r) => setTimeout(r, 1_500));
    const after = (await exec("agent_browser.extract_text", { sessionId, includeInteractive: false })) as ExtractLike;
    submitClicked = submitClicked && /\/success/.test(String(after.url ?? ""));
  }
  console.log(`订单页→成功页跳转: ${submitClicked}`);
  steps.push({ page: "order", clickOk: submitClicked });

  // ── 汇总 ──
  const summary = {
    tag: TAG,
    detailExtractTokens: detailTokens,
    orderExtractTokens: orderTokens,
    totalExtractTokens: detailTokens + orderTokens,
    detailInteractiveCount,
    orderInteractiveCount,
    buyButtonVisible: buyHit.hit,
    submitButtonVisible: submitHit.hit,
    buyClickOk: buyClicked,
    submitClickOk: submitClicked,
    taskSuccess: buyClicked && submitClicked,
  };
  (metrics as Record<string, unknown>).summary = summary;
  console.log("\n=== 汇总 ===");
  console.log(JSON.stringify(summary, null, 2));

  await exec("agent_browser.close", { sessionId });
  agentBrowserService.dispose().catch(() => {});
  server.close();
  await mkdir("data/e2e", { recursive: true });
  await writeFile(`data/e2e/e2e-browser-ref-baseline-${TAG}.json`, JSON.stringify(metrics, null, 2));
  console.log(`结果已写入 data/e2e/e2e-browser-ref-baseline-${TAG}.json`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`对照测试(${TAG})失败:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
