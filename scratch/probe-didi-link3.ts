import "../server/src/config/load-server-env.js";
import { McpClientService } from "../server/src/services/mcp-client-service.js";
async function main() {
  const svc = new McpClientService();
  await svc.discoverTools();
  const t = svc.listTools().find((x) => x.rawToolName === "taxi_generate_ride_app_link");
  console.log(JSON.stringify(t, null, 1).slice(0, 1500));
  svc.closeAll();
  process.exit(0);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
