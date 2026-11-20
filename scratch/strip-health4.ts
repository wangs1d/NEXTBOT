import fs from "node:fs";
const p = "server/src/tools/capability-modules/index.ts";
let raw = fs.readFileSync(p, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let s = raw.split("\r\n").join("\n");

function dropEntry(src: string, domain: string): string {
  const at = src.indexOf(`domain: "${domain}"`);
  if (at < 0) throw new Error("marker missing: " + domain);
  const start = src.lastIndexOf("\n    {", at);
  if (start < 0) throw new Error("entry start missing: " + domain);
  let i = start + 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let end = i + 1;
  while (end < src.length && (src[end] === "," || src[end] === "\n")) end += 1;
  return src.slice(0, start) + src.slice(end);
}
s = dropEntry(s, "health_fitness");
s = dropEntry(s, "period_care");

function dropImport(src: string, marker: string, fromSuffix: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("import marker missing: " + marker);
  const start = src.lastIndexOf("import {\n", at);
  const endAt = src.indexOf(fromSuffix, at);
  if (start < 0 || endAt < 0) throw new Error("import block missing: " + marker);
  const end = src.indexOf("\n", endAt) + 1;
  return src.slice(0, start) + src.slice(end);
}
s = dropImport(s, "HEALTH_FITNESS_CHAT_TOOLS", "./health-fitness/index.js");
s = dropImport(s, "PERIOD_CARE_CHAT_TOOLS", "./period-care/index.js");

// type imports
s = s.replace(/^import type \{ HealthFitnessService \}.*\n/m, "");
s = s.replace(/^import type \{ PeriodCareService \}.*\n/m, "");
// deps 字段
s = s.replace(/^\s*healthFitnessService: HealthFitnessService;\n/m, "");
s = s.replace(/^\s*periodCareService: PeriodCareService;\n/m, "");

// 恢复被 git 回滚的 ride MCP 接线
if (!s.includes("mcpClientService?:")) {
  s = s.replace(
    /(  \/\*\* 统一预订编排服务（方案 A：网约车\/家政\/餐厅共用） \*\/\n  bookingService: BookingService;)/,
    "$1\n  /** 滴滴 MCP client（ride_pickup 选点卡的周边候选走滴图 maps_place_around；未装配时候选为空） */\n  mcpClientService?: import(\"../../services/mcp-client-service.js\").McpClientService;",
  );
}
s = s.replace(
  "registerRideHailingTools(registry, { bookingService: deps.bookingService })",
  "registerRideHailingTools(registry, { bookingService: deps.bookingService, mcp: deps.mcpClientService })",
);

fs.writeFileSync(p, s.split("\n").join(eol));
console.log("domains:", (s.match(/domain: "/g) ?? []).length, "| mcp field:", s.includes("mcpClientService?:"), "| ride mcp:", s.includes("mcp: deps.mcpClientService"));
