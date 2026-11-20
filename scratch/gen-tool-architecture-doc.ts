import fs from "node:fs";
import { SKILL_BUNDLES } from "../server/src/tools/exposure/skill-bundles.js";
import { RESIDENT_TOOLS } from "../server/src/tools/exposure/residency.js";

const inv = JSON.parse(fs.readFileSync("design/tool-inventory.json", "utf8")) as {
  resident: { chat: string[]; task: string[] };
  domains: Array<{ domain: string; label: string; tools: string[] }>;
};
const mcp = JSON.parse(fs.readFileSync("server/data/mcp-servers.json", "utf8")) as {
  servers: Array<{ alias: string; name: string; description: string; enabled: boolean }>;
};

const domainTools = new Map(inv.domains.map((d) => [d.domain, d]));

// 每个 skill 展开后的工具清单
const skillSections = SKILL_BUNDLES.map((s) => {
  const rows: string[] = [];
  let total = 0;
  for (const d of s.domains) {
    const dd = domainTools.get(d);
    if (!dd) continue;
    total += dd.tools.length;
    rows.push(`| \`${d}\` | ${dd.label} | ${dd.tools.map((t) => `\`${t}\``).join(" ")} |`);
  }
  return { skill: s, rows, total };
});

const assigned = new Set(SKILL_BUNDLES.flatMap((s) => s.domains));
const orphan = inv.domains.filter((d) => !assigned.has(d.domain));

const lines: string[] = [];
lines.push("# NEXTBOT 工具架构与全量清单");
lines.push("");
lines.push(`> 自动生成（${new Date().toISOString().slice(0, 16).replace("T", " ")}）——数据源：capability-modules 代码枚举 + mcp-servers.json + residency.ts + skill-bundles.ts。`);
lines.push("");
lines.push("## 一、架构总览");
lines.push("");
lines.push("```");
lines.push("模型每轮看到的 tools = ①常驻可视面（residency.ts，单一声明源）");
lines.push("                    + ②延迟目录桥（tool_discover / tool_search / tool_call）");
lines.push("");
lines.push("① 常驻可视面  = 基础设施(6) + 对话高频(4) + 时点性刚需(2) + 任务车道(11)");
lines.push("② 延迟目录    = 22 个能力域 / 118 个工具 + 13 个 Skill 包（意图粒度索引）");
lines.push("                   └ 发现方式：skill 名 → 整族 / 域名 → 单域 / query → 语义检索");
lines.push("```");
lines.push("");
lines.push("**四条不变量**：①每个工具要么可见要么在目录；②目录 = 不可见全集（无需额外分层）；③新增常驻只改 residency.ts；④首轮冻结可视面，动态扩展走 grow 名单。");
lines.push("");
lines.push("## 二、常驻可视面（residency.ts）");
lines.push("");
lines.push("| 工具 | 车道 | 为什么常驻 |");
lines.push("|---|---|---|");
for (const t of RESIDENT_TOOLS) {
  lines.push(`| \`${t.name}\` | ${t.lanes.join("+")} | ${t.note || "—"} |`);
}
lines.push("");
lines.push("## 三、Skill 包 → 域 → 工具（13 包 / 22 域 / 118 工具）");
lines.push("");
for (const { skill, rows, total } of skillSections) {
  lines.push(`### \`${skill.id}\`（${skill.label}）· ${total} 个工具`);
  lines.push("");
  lines.push(`> ${skill.oneLiner}`);
  lines.push("");
  lines.push("| 域 | 说明 | 工具 |");
  lines.push("|---|---|---|");
  lines.push(...rows);
  lines.push("");
}
if (orphan.length > 0) {
  lines.push("### 未归入 skill 的域");
  lines.push("");
  lines.push("| 域 | 说明 | 工具 |");
  lines.push("|---|---|---|");
  for (const d of orphan) {
    lines.push(`| \`${d.domain}\` | ${d.label} | ${d.tools.map((t) => `\`${t}\``).join(" ")} |`);
  }
  lines.push("");
}
lines.push("## 四、复合工具（一个 schema 多 action，省 token 的主力）");
lines.push("");
lines.push("| 工具 | 覆盖的 action / 子能力 | 说明 |");
lines.push("|---|---|---|");
lines.push("| `web_search` | web / weather / quote(行情) / images / images_batch / videos / find_video / parse_video / hot / deep | 检索+天气+行情+媒体五族合一的常驻入口 |");
lines.push("| `phone` | number（号码查询/拨号意图） | 手机号与语音入口 |");
lines.push("| `calendar` | create / update_task / delete_task / list_tasks | 日程/提醒唯一入口 |");
lines.push("| `profile.update` | 画像字段结构化写入 | 自编辑，缺失即谎称已记 |");
lines.push("| `brain.recall` / `obs_recall` | 记忆回溯 / 压缩原文分页读回 | 感知类只读 |");
lines.push("| `tool_discover` | domain(skill/域) / query / name / include_schema | 延迟目录唯一发现桥（domain 可直接传 skill 名） |");
lines.push("");
lines.push("## 五、MCP 外部工具（独立于能力域，按 server 分组）");
lines.push("");
lines.push("| server | 状态 | 工具族 | 说明 |");
lines.push("|---|---|---|---|");
for (const s of mcp.servers) {
  lines.push(`| \`${s.alias}\` | ${s.enabled ? "启用" : "停用"} | ${s.description.length > 120 ? s.description.slice(0, 120) + "…" : s.description} | ${s.name} |`);
}
lines.push("");
lines.push("> 滴滴 13 个工具中 10 个已接（封装在 `ride` skill 的 ride_hailing.* 之下，裸 `mcp.didi.*` 对模型不可见，避免绕过选点卡抽象层）。");
lines.push("");
lines.push("## 六、分类维度速查");
lines.push("");
lines.push("| 分类 | 判定 | 数量 | 举例 |");
lines.push("|---|---|---|---|");
lines.push("| 常驻工具（每轮可见） | residency.ts 声明 | " + RESIDENT_TOOLS.length + " | calendar、ride_hailing.quote、web_search |");
lines.push("| 域（延迟目录内部切分） | capability-modules 的 domain 字段 | " + inv.domains.length + " | ride_hailing、finance_deep、code_sandbox |");
lines.push("| Skill 包（意图粒度） | skill-bundles.ts 声明 | " + SKILL_BUNDLES.length + " | ride、travel、local_life、web_ops |");
lines.push("| 复合工具 | 一个 schema 多 action | 6 | web_search、phone、calendar |");
lines.push("| MCP 外部工具 | mcp-servers.json 注册 | " + mcp.servers.length + " servers | didi(13)、luckin(8) |");
lines.push("| 技能族工具（运行时注册） | self-programming skills | 动态 | travel.pickup-* 等，自动进目录 |");

fs.writeFileSync("design/tool-architecture.md", lines.join("\n"));
console.log("written design/tool-architecture.md, lines:", lines.length, "orphanDomains:", orphan.length);
