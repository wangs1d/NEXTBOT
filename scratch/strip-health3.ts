import fs from "node:fs";
const p = "server/src/tools/capability-modules/index.ts";
let s = fs.readFileSync(p, "utf8");

/** 删除一个模块条目：从 domain 行回溯到条目开括号，按括号平衡找到闭合。 */
function dropEntry(src: string, domain: string): string {
  const marker = `domain: "${domain}"`;
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("marker missing: " + domain);
  const start = src.lastIndexOf("\n    {\n", at);
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
  // 吃掉行尾的逗号与换行
  let end = i + 1;
  while (end < src.length && (src[end] === "," || src[end] === "\r" || src[end] === "\n")) end += 1;
  return src.slice(0, start) + src.slice(end);
}

s = dropEntry(s, "health_fitness");
s = dropEntry(s, "period_care");

// 删除 import 块
function dropImport(src: string, marker: string, fromSuffix: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("import marker missing: " + marker);
  const start = src.lastIndexOf("import {\n", at);
  const endAt = src.indexOf(fromSuffix, at);
  if (start < 0 || endAt < 0) throw new Error("import block missing: " + marker);
  let end = src.indexOf("\n", endAt) + 1;
  return src.slice(0, start) + src.slice(end);
}
s = dropImport(s, "HEALTH_FITNESS_CHAT_TOOLS", "./health-fitness/index.js");
s = dropImport(s, "PERIOD_CARE_CHAT_TOOLS", "./period-care/index.js");

// 删除 deps 字段
s = s.replace(/^\s*healthFitnessService: HealthFitnessService;\r?\n/m, "");
s = s.replace(/^\s*periodCareService: PeriodCareService;\r?\n/m, "");

// 恢复两处此前被 git 回滚掉的 ride MCP 接线
if (!s.includes("mcpClientService?:")) {
  s = s.replace(
    /(\n  \/\*\* 统一预订编排服务（方案 A：网约车\/家政\/餐厅共用） \*\/\n  bookingService: BookingService;)/,
    "$1\n  /** 滴滴 MCP client（ride_pickup 选点卡的周边候选走滴图 maps_place_around） */\n  mcpClientService?: import(\"../../services/mcp-client-service.js\").McpClientService;",
  );
}
s = s.replace(
  "registerRideHailingTools(registry, { bookingService: deps.bookingService })",
  "registerRideHailingTools(registry, { bookingService: deps.bookingService, mcp: deps.mcpClientService })",
);

fs.writeFileSync(p, s);
console.log("domains left:", (s.match(/domain: "/g) ?? []).length, "mcp wired:", s.includes("mcpClientService?:"), "ride mcp:", s.includes("mcp: deps.mcpClientService"));
