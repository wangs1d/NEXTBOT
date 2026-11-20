import fs from "node:fs";
function edit(path: string, fn: (s: string) => string): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  fs.writeFileSync(path, fn(raw.split("\r\n").join("\n")).split("\n").join(eol));
}

// resolve-chat-tools：轻量档分支改走可视面
edit("server/src/external-model/resolve-chat-tools.ts", (s) => {
  const start = s.indexOf("  if (explicitSmallToolset) {");
  const end = s.indexOf("  const key = resolvedToolsCacheKey(");
  if (start < 0 || end < 0) throw new Error("small-toolset anchors missing");
  const block = [
    "  if (explicitSmallToolset) {",
    "    // 2026-11-20 归一（P2）：轻量档不再按关键词挑选，统一走可视面装配；",
    "    // 未在可视面的工具仍经 prepareTools 进延迟目录（skill/域/query 可达）。",
    "    const face = residencyFaceForTools(merged);",
    "    const hasRankingHint =",
    "      (streamOpts?.toolRankingHint?.preferredNamespaces?.filter(Boolean).length ?? 0) > 0 ||",
    "      (streamOpts?.toolRankingHint?.cautiousNamespaces?.filter(Boolean).length ?? 0) > 0;",
    "    return {",
    "      visibleTools: hasRankingHint ? applyToolRankingHint(face, streamOpts) : face,",
    "      searchableTools: merged,",
    "    };",
    "  }",
    "",
  ].join("\n");
  return s.slice(0, start) + block + s.slice(end);
});

// agent-core：移除已删函数的导入
edit("server/src/services/agent-core.ts", (s) =>
  s.replace("import {\n  getBuiltinAgentChatTools,\n  selectForegroundCapabilityToolAdditions,\n} from \"../external-model/openai-compatible-tool-loop.js\";", "import { getBuiltinAgentChatTools } from \"../external-model/openai-compatible-tool-loop.js\";"),
);
console.log("patched2");
