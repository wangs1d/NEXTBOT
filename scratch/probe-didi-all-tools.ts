import "../server/src/config/load-server-env.js";
import { McpClientService } from "../server/src/services/mcp-client-service.js";
async function main() {
  const svc = new McpClientService();
  await svc.discoverTools();
  const tools = svc.listTools().map((t) => t.rawToolName);
  const didiTools = tools.filter((n) => n.startsWith("taxi_") || n.startsWith("maps_"));
  console.log("滴滴 MCP 全量工具:", JSON.stringify(didiTools));
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
