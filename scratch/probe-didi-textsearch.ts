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
    ["街心花园+兴义市", { keywords: "街心花园", city: "兴义市" }],
    ["街心花园+黔西南州", { keywords: "街心花园", city: "黔西南布依族苗族自治州" }],
    ["兴义街心花园", { keywords: "兴义 街心花园", city: "兴义市" }],
    ["梦乐城+兴义市", { keywords: "梦乐城", city: "兴义市" }],
  ];
  for (const [label, args] of attempts) {
    const res = await svc.callTool("didi", "maps_textsearch", args, 20_000);
    console.log(`\n>>> [${label}] ok=${res.ok}`);
    console.log(textOf(res.result).slice(0, 350));
  }
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
