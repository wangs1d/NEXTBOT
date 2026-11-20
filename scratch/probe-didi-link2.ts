import "../server/src/config/load-server-env.js";
import { McpClientService } from "../server/src/services/mcp-client-service.js";
function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}
async function main() {
  const svc = new McpClientService();
  await svc.discoverTools();
  for (const args of [{ order_id: "test123" }, { orderId: "test123" }, { type: "home" }]) {
    const res = await svc.callTool("didi", "taxi_generate_ride_app_link", args, 20_000);
    console.log(`\n>>> ${JSON.stringify(args)} ok=${res.ok}`);
    console.log(textOf(res.result).slice(0, 400));
  }
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
