/**
 * e2e：Agent 内置虚拟浏览器（agent_browser.*）沙箱实测。
 *
 * 验证目标：agent 需要浏览器时是否直接走内置 Playwright 无头浏览器，
 * 并真实地在服务端沙箱里完成多步网页任务。
 *
 * 路径：ToolRegistry.execute（生产执行入口，含权限门禁）
 *   → registerAgentBrowserTools 注册的真实 handler
 *   → AgentBrowserService（会话池/URL 策略/actor 隔离）
 *   → Playwright 无头 Chromium。
 *
 * 用例：
 *   A. 本地沙箱页多步任务：open → extract_text → type → click → wait_for →
 *      extract_text 校验交互结果 → 点链接跳转校验导航 → screenshot → scroll → close
 *   B. 外网 https 真实站点：open example.com → extract_text 校验标题
 *   C. 沙箱护栏：外部 http 被拒；跨 actor 会话隔离
 *   D. 路由证据：agent_browser.* 工具 schema / 意图规则 / 关键词分类已挂载
 *
 * 运行：npx tsx scripts/e2e-agent-browser-sandbox.ts
 */
import { createServer, type Server } from "node:http";

import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext } from "../src/tools/tool-registry.js";
import { registerAgentBrowserTools } from "../src/tools/capability-modules/agent-browser/handlers.js";
import { AgentBrowserService } from "../src/services/agent-browser-service.js";
import {
  AGENT_BROWSER_CHAT_TOOLS,
  AGENT_BROWSER_INTENT_RULES,
} from "../src/tools/capability-modules/agent-browser/index.js";

// ─── 本地沙箱站点 ─────────────────────────────────────────────────────────────

function startSandboxSite(port: number): Promise<Server> {
  const page = (title: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

  const home = page(
    "沙箱首页",
    `<h1>Agent 浏览器沙箱测试页</h1>
     <input id="name" placeholder="输入名字" />
     <button id="go">提交</button>
     <div id="result"></div>
     <a id="to-page2" href="/page2">前往第二页</a>
     <script>
       document.getElementById('go').addEventListener('click', () => {
         const v = document.getElementById('name').value;
         document.getElementById('result').textContent = '你好，' + v + '！';
       });
     </script>`,
  );
  const page2 = page("沙箱第二页", "<h1>这是第二页</h1><p>导航成功标记 NAV_OK</p>");

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(path === "/page2" ? page2 : home);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ─── 断言工具 ─────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount++;
    console.log(`  [PASS] ${label}`);
  } else {
    failCount++;
    console.log(`  [FAIL] ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

async function runTool(
  registry: ToolRegistry,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ok, result } = await registry.execute(name, input, ctx);
  return { __ok: ok, ...result };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const PORT = 18742;
  const site = await startSandboxSite(PORT);
  const base = `http://127.0.0.1:${PORT}`;

  // 与生产装配（create-app-services.ts:887）一致的构造，audit/qrAssist 可选省略；
  // browserSessionService 仅白名单站点 Cookie 注入用，测试 URL 不触发，给最小 stub。
  const agentBrowserService = new AgentBrowserService({
    browserSessionService: {
      getCookiesForAgent: async () => [],
    } as never,
  });
  const registry = new ToolRegistry();
  registerAgentBrowserTools(registry, { agentBrowserService });

  const ctx: ToolContext = { sessionId: "e2e-sandbox-session", userId: "e2e-actor-A" };

  // ── D. 路由证据：schema / 意图规则 / 关键词分类是否挂载 ──
  console.log("\n== D. 工具路由证据 ==");
  const toolNames = AGENT_BROWSER_CHAT_TOOLS.map(
    (t) => (t.type === "function" ? t.function?.name : null) ?? "?",
  );
  console.log(`  LLM 工具 schema: ${toolNames.join(", ")}`);
  console.log(`  意图规则条数: ${AGENT_BROWSER_INTENT_RULES.length}`);
  check("8 个 agent_browser.* 工具 schema 已挂载", toolNames.length === 8, `实际 ${toolNames.length}`);
  check(
    "registry 中可执行器齐全",
    toolNames.every((n) => registry.list().includes(n)),
  );

  // ── A. 本地沙箱页多步任务 ──
  console.log("\n== A. 沙箱内多步任务（本地页面） ==");
  const opened = await runTool(registry, ctx, "agent_browser.open", { url: `${base}/` });
  check("open 打开页面", opened.ok === true, String(opened.error));
  const sessionId = String(opened.sessionId ?? "");
  check("返回 sessionId（有状态会话）", sessionId.length > 0);
  console.log(`  title=${opened.title} sessionId=${sessionId.slice(0, 8)}...`);

  const extract1 = await runTool(registry, ctx, "agent_browser.extract_text", { sessionId });
  const hasButton = JSON.stringify(extract1.interactive ?? "").includes("提交");
  check("extract_text 拿到页面文本与可交互元素", extract1.ok === true && hasButton);

  const typed = await runTool(registry, ctx, "agent_browser.type", {
    sessionId,
    selector: "#name",
    text: "旅行青蛙",
  });
  check("type 输入文本", typed.ok === true, String(typed.error));

  const clicked = await runTool(registry, ctx, "agent_browser.click", {
    sessionId,
    selector: "#go",
  });
  check("click 点击按钮", clicked.ok === true, String(clicked.error));

  await runTool(registry, ctx, "agent_browser.wait_for", { sessionId, selector: "#result:not(:empty)" });

  const extract2 = await runTool(registry, ctx, "agent_browser.extract_text", {
    sessionId,
    selector: "#result",
  });
  // 页面按钮的 onclick：把输入值写进 #result，校验真实 DOM 状态被浏览器改写
  const resultText = String(extract2.text ?? "");
  console.log(`  #result 文本 = "${resultText}"`);
  check("交互结果落盘（浏览器真实执行了脚本）", resultText.includes("旅行青蛙"), resultText || "(空)");

  const nav = await runTool(registry, ctx, "agent_browser.click", {
    sessionId,
    selector: "#to-page2",
  });
  check("click 链接触发导航", nav.ok === true && String(nav.url ?? "").includes("/page2"), String(nav.url ?? nav.error));

  const shot = await runTool(registry, ctx, "agent_browser.screenshot", { sessionId });
  const b64 = String(shot.imageBase64 ?? "");
  check("screenshot 返回图像 base64", shot.ok === true && b64.length > 100, `len=${b64.length}`);

  const scrolled = await runTool(registry, ctx, "agent_browser.scroll", { sessionId, deltaY: 300 });
  check("scroll 滚动", scrolled.ok === true, String(scrolled.error));

  const closed = await runTool(registry, ctx, "agent_browser.close", { sessionId });
  check("close 关闭会话", closed.ok === true);

  // ── B. 外网真实站点 ──
  console.log("\n== B. 外网 https 真实站点 ==");
  const ext = await runTool(registry, ctx, "agent_browser.open", {
    url: "https://example.com",
    waitUntil: "load",
    timeout: 20_000,
  });
  check("open https://example.com", ext.ok === true, String(ext.error));
  const extText = await runTool(registry, ctx, "agent_browser.extract_text", {
    sessionId: String(ext.sessionId ?? ""),
  });
  console.log(`  外网页面文本 = "${String(extText.text ?? "").slice(0, 60)}"`);
  check("外网页面内容真实抓取", /This domain is for|文档示例/.test(String(extText.text ?? "")));
  await runTool(registry, ctx, "agent_browser.close", { sessionId: String(ext.sessionId ?? "") });

  // ── C. 沙箱护栏 ──
  console.log("\n== C. 沙箱护栏 ==");
  const blockedHttp = await runTool(registry, ctx, "agent_browser.open", { url: "http://example.com" });
  check("外部 http 被策略拒绝", blockedHttp.ok === false, String(blockedHttp.error));
  console.log(`  拒绝理由: ${blockedHttp.error}`);

  const sessionB = await runTool(registry, ctx, "agent_browser.open", { url: `${base}/` });
  const sidB = String(sessionB.sessionId ?? "");
  const ctxB: ToolContext = { sessionId: "e2e-sandbox-session-b", userId: "e2e-actor-B" };
  const hijack = await runTool(registry, ctxB, "agent_browser.click", { sessionId: sidB, selector: "#go" });
  check("跨 actor 操作他人会话被拒", hijack.ok === false, String(hijack.error));
  await runTool(registry, ctx, "agent_browser.close", { sessionId: sidB });

  // ── 清理 ──
  await agentBrowserService.dispose();
  site.close();

  console.log(`\n========== 结果: ${passCount} PASS / ${failCount} FAIL ==========`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("e2e 异常:", e);
  process.exit(1);
});
