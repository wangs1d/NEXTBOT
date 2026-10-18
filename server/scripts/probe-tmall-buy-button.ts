/**
 * 探测：无登录打开天猫商品详情页，dump 全量可交互元素，找购买按钮真实 selector。
 * 不需要扫码，不消耗登录态。
 * 运行：npx tsx scripts/probe-tmall-buy-button.ts
 */
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolContext } from "../src/tools/tool-registry.js";
import { registerAgentBrowserTools } from "../src/tools/capability-modules/agent-browser/handlers.js";
import { AgentBrowserService } from "../src/services/agent-browser-service.js";

const ITEM_URL = "https://detail.tmall.com/item.htm?abbucket=5&id=910321976057&skuId=6109439730334";

async function main(): Promise<void> {
  const agentBrowserService = new AgentBrowserService({
    browserSessionService: { getCookiesForAgent: async () => [] } as never,
  });
  const registry = new ToolRegistry();
  registerAgentBrowserTools(registry, { agentBrowserService });
  const ctx: ToolContext = { sessionId: "probe-buy-btn", userId: "e2e-taobao-user" };

  const exec = async (name: string, input: Record<string, unknown>) => {
    const { result } = await registry.execute(name, input, ctx);
    return result;
  };

  const opened = await exec("agent_browser.open", {
    url: ITEM_URL,
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (opened.ok === false) {
    console.error(`open 失败: ${opened.error}`);
    process.exit(1);
  }
  const sessionId = String(opened.sessionId);
  await new Promise((r) => setTimeout(r, 6_000));

  const detail = await exec("agent_browser.extract_text", { sessionId });
  console.log("=== 可交互元素（全部） ===");
  for (const el of (detail.interactive as Array<{ tag: string; text: string; selector: string }>) ?? []) {
    const t = el.text.replace(/\s+/g, " ").slice(0, 50);
    console.log(`<${el.tag}> "${t}" → ${el.selector}`);
  }
  console.log("\n=== 文本中含 购/买/车/结算/下单 的行 ===");
  const text = String(detail.text ?? "");
  for (const line of text.split(/\s+(?=[^\s]*(?:购|买|车|结算|下单))/).slice(0, 60)) {
    if (/(立即|加入购物车|结算|下单|购买|抢|马上去)/.test(line)) {
      console.log(`  "${line.slice(0, 60)}"`);
    }
  }

  await exec("agent_browser.close", { sessionId });
  await agentBrowserService.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error("探测失败:", e);
  process.exit(1);
});
