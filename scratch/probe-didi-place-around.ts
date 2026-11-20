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
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["A keywords+location+radius", { keywords: "停车场", location: "104.901700,25.088100", radius: "800" }],
    ["B 仅location", { location: "104.901700,25.088100" }],
    ["C lng/lat", { lng: "104.901700", lat: "25.088100", radius: "800" }],
    ["D regeocode 参考约定", { location: "104.901700,25.088100" }],
  ];
  for (const [label, args] of attempts) {
    const tool = label.startsWith("D") ? "maps_regeocode" : "maps_place_around";
    const res = await svc.callTool("didi", tool, args, 30_000);
    console.log(`\n>>> [${label}] ${tool} ok=${res.ok}`);
    console.log(textOf(res.result).slice(0, 700));
  }
  svc.closeAll();
}
main().catch((e) => { console.error(e); process.exit(1); });
