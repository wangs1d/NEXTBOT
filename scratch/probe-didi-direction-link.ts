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
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await svc.callTool("didi", tool, args, 30_000);
    console.log(`\n>>> ${tool} ok=${res.ok}`);
    console.log(textOf(res.result).slice(0, 900));
    return textOf(res.result);
  };

  // 1. 驾车路线：北京西站 → 西二旗地铁站
  await call("maps_direction_driving", {
    origin: "116.322605,39.894911",
    destination: "116.305145,40.056852",
  });
  // 2. 生成滴滴 App 链接（试无参 / 带订单号两种）
  await call("taxi_generate_ride_app_link", {});
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
