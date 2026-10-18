/**
 * e2e：用 agent 内置虚拟浏览器（agent_browser.*）真实走淘宝下单流程（v2 加固版）。
 *
 * v2 改进：
 *   - 二维码失效自动 close+reopen 重推新码（最多 4 次），全程只用生产 API
 *   - 详情页 interactive 全量 dump + 动态查找购买按钮（新版天猫无 #J_LinkBuy）
 *   - 「加入购物车 → 购物车结算」兜底路径
 *
 * 运行：npx tsx scripts/e2e-taobao-order-qr.ts [商品词=抽纸]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext, ToolMediaCard } from "../src/tools/tool-registry.js";
import { registerAgentBrowserTools } from "../src/tools/capability-modules/agent-browser/handlers.js";
import { AgentBrowserService } from "../src/services/agent-browser-service.js";
import { QrAssistService } from "../src/services/qr-assist-service.js";

const PRODUCT = process.argv[2] ?? "抽纸";
const QR_PNG_PATH = "data/images/e2e-taobao-qr/e2e-taobao-user/qr-login.png";
const POLL_INTERVAL_MS = 6_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(
  registry: ToolRegistry,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const { ok, result } = await registry.execute(name, input, ctx);
  const flag = ok && result.ok !== false ? "OK " : "ERR";
  const brief = JSON.stringify({ ...result, imageBase64: undefined, interactive: undefined });
  console.log(`[${flag}] ${name} (${Date.now() - t0}ms) ${brief.slice(0, 260)}`);
  return result;
}

interface InteractiveEl {
  tag: string;
  text: string;
  selector: string;
}

function dumpInteractive(label: string, interactive: unknown): void {
  if (typeof interactive === "string") {
    const lines = interactive.split("\n");
    console.log(`  [${label}] 可交互元素 ${lines.length} 行:`);
    for (const line of lines) console.log(`    ${line}`);
    return;
  }
  console.log(`  [${label}] 可交互元素 ${(interactive as InteractiveEl[])?.length ?? 0} 个:`);
  for (const el of (interactive as InteractiveEl[]) ?? []) {
    console.log(`    <${el.tag}> "${el.text.slice(0, 40)}" → ${el.selector}`);
  }
}

/** 从 extract 返回里按名称找元素引用：新格式（ref 行字符串）优先，兼容旧对象数组。 */
function findRefByText(interactive: unknown, keywords: string[]): string[] {
  const hits: string[] = [];
  if (typeof interactive === "string") {
    for (const line of interactive.split("\n")) {
      const m = line.match(/^(\S+)\s+(\w+)\s+"([^"]*)"/);
      const name = m ? m[3] : "";
      if (name && keywords.some((kw) => name.includes(kw)) && !hits.includes(m![1])) {
        hits.push(m![1]);
      }
    }
    return hits;
  }
  for (const el of (interactive as InteractiveEl[]) ?? []) {
    if (keywords.some((kw) => el.text.includes(kw))) {
      if (!hits.includes(el.selector)) hits.push(el.selector);
    }
  }
  return hits;
}

async function clickFirst(
  registry: ToolRegistry,
  ctx: ToolContext,
  sessionId: string,
  selectors: string[],
  timeout = 8_000,
): Promise<Record<string, unknown>> {
  for (const sel of selectors) {
    const input: Record<string, unknown> = { sessionId, timeout };
    // ariaSnapshot ref（如 e5 / s1e3）走 ref 引擎，其余按 Playwright selector
    if (/^(e\d+|s\d+e\d+)$/.test(sel)) input.ref = sel;
    else input.selector = sel;
    const r = await run(registry, ctx, "agent_browser.click", input);
    if (r.ok !== false) return { ...r, __selector: sel };
    console.log(`  定位未命中: ${sel}`);
  }
  return { ok: false, error: `全部定位未命中: ${selectors.join(", ")}` };
}

/** 打开登录页（撞页自动推二维码）并轮询扫码；二维码失效自动重推。 */
async function waitScanLogin(
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<{ sessionId: string; url: string }> {
  const totalDeadline = Date.now() + 8 * 60_000;
  let reopenCount = 0;
  while (Date.now() < totalDeadline) {
    console.log(`\n── 打开淘宝登录页（第 ${reopenCount + 1} 次推码）──`);
    const opened = await run(registry, ctx, "agent_browser.open", {
      url: "https://login.taobao.com/",
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (opened.ok === false) throw new Error(`打开登录页失败: ${opened.error}`);
    const sessionId = String(opened.sessionId ?? "");

    const sessionDeadline = Date.now() + 3 * 60_000; // 单码最多等 3 分钟
    while (Date.now() < sessionDeadline && Date.now() < totalDeadline) {
      await sleep(POLL_INTERVAL_MS);
      const res = await run(registry, ctx, "agent_browser.extract_text", {
        sessionId,
        includeInteractive: false,
      });
      if (res.ok === false) break;
      const url = String(res.url ?? "");
      const text = String(res.text ?? "");
      const stillLogin = /login\.taobao\.com|login\.tmall\.com/.test(url) ||
        /扫码登录|二维码登录|欢迎登录/.test(text);
      if (!stillLogin) return { sessionId, url };
      if (/已失效|请点击刷新|重新生成/.test(text)) {
        console.log("  二维码已失效，关闭会话重新推新码……");
        break;
      }
      console.log(`  ...等待扫码，url=${url.slice(0, 70)}`);
    }
    await run(registry, ctx, "agent_browser.close", { sessionId });
    reopenCount++;
    if (reopenCount > 4) throw new Error("二维码多次失效/超时，终止。");
  }
  throw new Error("登录总时长超时。");
}

async function main(): Promise<void> {
  console.log(`=== e2e 淘宝下单 v2（agent 内置浏览器沙箱）商品="${PRODUCT}" ===`);

  const agentBrowserService = new AgentBrowserService({
    browserSessionService: { getCookiesForAgent: async () => [] } as never,
    qrAssist: new QrAssistService({
      imageStore: {
        async savePng(_actorId: string, png: Buffer): Promise<string> {
          await mkdir(dirname(QR_PNG_PATH), { recursive: true });
          await writeFile(QR_PNG_PATH, png);
          console.log(`[二维码已刷新落盘] ${QR_PNG_PATH}`);
          return `/agent/images/e2e-taobao-qr/e2e-taobao-user/qr-login.png`;
        },
      },
    }),
  });
  const registry = new ToolRegistry();
  registerAgentBrowserTools(registry, { agentBrowserService });

  const ctx: ToolContext = {
    sessionId: "e2e-taobao-order",
    userId: "e2e-taobao-user",
    pushMediaCards: (cards: ToolMediaCard[]) => {
      console.log(`[推卡到聊天] ${JSON.stringify(cards).slice(0, 200)}`);
    },
  };

  // ── 1+2. 登录（自动推码 + 失效重推）──
  const login = await waitScanLogin(registry, ctx);
  const sessionId = login.sessionId;
  console.log(`扫码登录成功，url=${login.url}`);

  // ── 3. 搜索 ──
  console.log(`\n── 搜索「${PRODUCT}」──`);
  await run(registry, ctx, "agent_browser.wait_for", { sessionId, selector: "#q", timeout: 12_000 });
  await run(registry, ctx, "agent_browser.type", { sessionId, selector: "#q", text: PRODUCT });
  const searched = await clickFirst(registry, ctx, sessionId, [
    "button[type=submit]",
    ".btn-search",
    "text=搜 索",
    "text=搜索",
  ]);
  if (searched.ok === false) throw new Error(`点搜索失败: ${searched.error}`);
  await sleep(4_000);
  await run(registry, ctx, "agent_browser.extract_text", { sessionId, includeInteractive: false });

  // ── 4. 打开第一个商品（popup 跟随切新 tab）──
  console.log("\n── 打开第一个商品详情 ──");
  const itemClick = await run(registry, ctx, "agent_browser.click", {
    sessionId,
    selector: 'a[href*="item.htm"]',
    timeout: 10_000,
  });
  if (itemClick.ok === false) throw new Error(`点商品失败: ${itemClick.error}`);
  await sleep(6_000);

  let detail = await run(registry, ctx, "agent_browser.extract_text", { sessionId });
  const detailUrl = String(detail.url ?? "");
  console.log(`详情页 url=${detailUrl.slice(0, 110)}`);
  if (!/item\.htm|detail\./.test(detailUrl)) throw new Error("未进入商品详情页。");

  // ── 5. 找购买按钮：滚动触发渲染 → interactive 全量 dump → 动态找 ──
  console.log("\n── 寻找购买/加购按钮 ──");
  await run(registry, ctx, "agent_browser.scroll", { sessionId, deltaY: 6000 });
  await sleep(2_000);
  await run(registry, ctx, "agent_browser.scroll", { sessionId, deltaY: -6000 });
  await sleep(1_500);
  detail = await run(registry, ctx, "agent_browser.extract_text", { sessionId });
  dumpInteractive("详情页", detail.interactive);

  let buyRefs = findRefByText(detail.interactive, ["立即购买", "立即下单", "马上购买", "领券购买", "马上抢"]);
  buyRefs.push("#J_LinkBuy", 'button:has-text("立即购买")', "text=立即购买");
  let buy = await clickFirst(registry, ctx, sessionId, buyRefs);
  if (buy.ok === false) {
    console.log("没有「立即购买」，尝试加入购物车兜底路径……");
    const cartRefs = findRefByText(detail.interactive, ["加入购物车"]);
    cartRefs.push("#J_LinkAdd", 'button:has-text("加入购物车")', "text=加入购物车");
    buy = await clickFirst(registry, ctx, sessionId, cartRefs);
  }
  if (buy.ok === false) {
    // 人工接管：dump 已输出，等外部把真实 selector 写进 selectors.json
    console.log('\n>>> 自动查找失败。请把按钮 selector 写入 data/images/e2e-taobao-qr/selectors.json，例如 {"selectors":["..."],"kind":"buy"}');
    const SEL = "data/images/e2e-taobao-qr/selectors.json";
    const selDeadline = Date.now() + 10 * 60_000;
    let manual: { selectors?: string[]; kind?: string } | null = null;
    while (Date.now() < selDeadline) {
      await sleep(5_000);
      try {
        manual = JSON.parse(await readFile(SEL, "utf8"));
        if (manual?.selectors?.length) break;
      } catch {
        /* 尚无 */
      }
      // 保活
      const beat = await run(registry, ctx, "agent_browser.extract_text", {
        sessionId,
        includeInteractive: false,
      });
      if (beat.ok === false) throw new Error("会话已失效。");
    }
    if (!manual?.selectors?.length) throw new Error("等待人工 selector 超时。");
    console.log(`收到人工 selector: ${JSON.stringify(manual.selectors)} kind=${manual.kind ?? "buy"}`);
    buy = await clickFirst(registry, ctx, sessionId, manual.selectors);
    if (buy.ok === false) throw new Error("人工 selector 也未命中。");
    if ((manual.kind ?? "buy") === "cart") {
      await sleep(3_000);
      const cartOpen = await clickFirst(registry, ctx, sessionId, [
        'a[href*="cart.taobao"]',
        'a[href*="cart"]',
      ]);
      if (cartOpen.ok === false) throw new Error(`打开购物车失败: ${cartOpen.error}`);
      await sleep(4_000);
      const cartPage = await run(registry, ctx, "agent_browser.extract_text", { sessionId });
      console.log(`购物车 url=${cartPage.url}`);
      dumpInteractive("购物车", cartPage.interactive);
      await clickFirst(registry, ctx, sessionId, [
        'input[type="checkbox"]',
        "text=全选",
        '[class*="checkAll"]',
      ], 5_000);
      const settle = await clickFirst(registry, ctx, sessionId, [
        "text=结算",
        'button:has-text("结算")',
        '[class*="settle"]',
      ]);
      if (settle.ok === false) throw new Error(`点结算失败: ${settle.error}`);
      await sleep(6_000);
    }
  }

  // ── 6. 订单确认页 ──
  const orderPage = await run(registry, ctx, "agent_browser.extract_text", { sessionId });
  const orderUrl = String(orderPage.url ?? "");
  console.log(`\n订单页 url=${orderUrl.slice(0, 110)}`);
  console.log(`订单页文本: ${String(orderPage.text ?? "").slice(0, 1000)}`);

  if (!/buy\.taobao\.com|buy\.tmall\.com|cart\.taobao\.com|order/.test(orderUrl)) {
    throw new Error("未到达订单确认页。");
  }

  // ── 7. 等待提交指令（extract_text 保活续 TTL）──
  console.log('\n=== 已到达订单确认页（未提交）。等待 cmd.json {"action":"submit"|"abort"}，最长 10 分钟 ===');
  const CMD = "data/images/e2e-taobao-qr/cmd.json";
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    let cmd = "";
    try {
      cmd = (await readFile(CMD, "utf8")).trim();
    } catch {
      /* 尚无指令 */
    }
    if (cmd.includes("abort")) {
      await run(registry, ctx, "agent_browser.close", { sessionId });
      console.log("已中止，会话关闭。");
      process.exit(0);
    }
    if (cmd.includes("submit")) {
      console.log("收到 submit 指令，点击提交订单……");
      const after = await run(registry, ctx, "agent_browser.extract_text", { sessionId });
      dumpInteractive("订单页提交前", after.interactive);
      const submitSelectors = [
        ...findRefByText(after.interactive, ["提交订单", "同意协议", "同意以下"]),
        "#submitOrderBtn",
        "text=/同意.{0,10}(提交|协议)/",
        "text=/提交.{0,6}订单/",
        'role=button[name*="提交"]',
        "text=提交订单",
        "text=提交",
        "button[class*='submit']",
        "[class*='submitOrder']",
        "[class*='submit'] button",
      ];
      let submit = await clickFirst(registry, ctx, sessionId, submitSelectors);
      if (submit.ok === false) {
        // 人工接管：dump 已输出，等外部写入真实 selector（不浪费本次扫码登录）
        console.log('\n>>> 提交按钮自动查找失败。请写入 data/images/e2e-taobao-qr/selectors.json {"selectors":[...]}');
        const SEL = "data/images/e2e-taobao-qr/selectors.json";
        const selDeadline = Date.now() + 10 * 60_000;
        let manual: { selectors?: string[] } | null = null;
        while (Date.now() < selDeadline) {
          await sleep(5_000);
          try {
            manual = JSON.parse(await readFile(SEL, "utf8"));
            if (manual?.selectors?.length) break;
          } catch {
            /* 尚无 */
          }
          const beat = await run(registry, ctx, "agent_browser.extract_text", {
            sessionId,
            includeInteractive: false,
          });
          if (beat.ok === false) throw new Error("会话已失效。");
        }
        if (!manual?.selectors?.length) throw new Error("等待人工 selector 超时。");
        console.log(`收到人工 selector: ${JSON.stringify(manual.selectors)}`);
        submit = await clickFirst(registry, ctx, sessionId, manual.selectors);
      }
      await sleep(8_000);
      const done = await run(registry, ctx, "agent_browser.extract_text", {
        sessionId,
        includeInteractive: false,
      });
      console.log(`提交后 url=${done.url}`);
      console.log(`提交后页面文本: ${String(done.text ?? "").slice(0, 800)}`);
      console.log(`submit 结果: ${JSON.stringify(submit).slice(0, 200)}`);
      process.exit(0);
    }
    const beat = await run(registry, ctx, "agent_browser.extract_text", {
      sessionId,
      includeInteractive: false,
    });
    if (beat.ok === false) {
      console.error("会话已失效，退出。");
      process.exit(1);
    }
  }
  console.error("等待指令超时，退出。");
  process.exit(0);
}

main().catch((e) => {
  console.error("e2e 失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
