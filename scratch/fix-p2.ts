import fs from "node:fs";

function edit(path: string, fn: (s: string) => string): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const out = fn(raw.split("\r\n").join("\n"));
  fs.writeFileSync(path, out.split("\n").join(eol));
}

// 1) resolve-chat-tools：彻底移除 selectRelevantTools 导入
edit("server/src/external-model/resolve-chat-tools.ts", (s) =>
  s.replace("import {\n  getBuiltinAgentChatTools,\n  selectRelevantTools,\n} from \"./openai-compatible-tool-loop.js\";", "import { getBuiltinAgentChatTools } from \"./openai-compatible-tool-loop.js\";"),
);

// 2) agent-core：删除关键词白名单注入块（2026-11-20 归一：可视面 + 延迟目录，
//    不再用关键词把能力域塞进前台白名单；未常驻的工具走 skill/域/query 发现）
edit("server/src/services/agent-core.ts", (s) => {
  const start = s.indexOf("  // 能力域关键词确定性注入（2026-09-19）");
  const end = s.indexOf("}\n\n/**\n * fast 对话模式的单次输出 token 上限。");
  if (start < 0 || end < 0) throw new Error("agent-core anchors missing");
  return s.slice(0, start) + "  return base;\n" + s.slice(end);
});
console.log("fixed");
