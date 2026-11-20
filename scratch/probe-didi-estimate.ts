import "../server/src/config/load-server-env.js";
import { McpClientService } from "../server/src/services/mcp-client-service.js";
function textOf(result) {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}
async function main() {
  const svc = new McpClientService();
  await svc.discoverTools();
  // 梦乐城（州政府北侧 regeo 点 104.9017,25.0881）→ 街心花园（104.89829,25.08985）
  const res = await svc.callTool("didi", "taxi_estimate", {
    from_lng: "104.906400", from_lat: "25.088200",
    to_lng: "104.898290", to_lat: "25.089850",
    from_name: "州人民政府北侧", to_name: "街心花园",
  }, 30_000);
  console.log(textOf(res.result).slice(0, 500));
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
