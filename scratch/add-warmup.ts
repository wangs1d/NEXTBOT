import fs from "node:fs";
const p = "server/src/bootstrap/create-app-services.ts";
const raw = fs.readFileSync(p, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let t = raw.split("\r\n").join("\n");

t = t.replace(
  'import { setMcpChatTools, setBrainChatTools, setBodyChatTools, setMemoryChatTools } from "../external-model/openai-compatible-tool-loop.js";',
  'import { setMcpChatTools, setBrainChatTools, setBodyChatTools, setMemoryChatTools, getBuiltinAgentChatTools } from "../external-model/openai-compatible-tool-loop.js";\nimport { ensureToolEmbeddings } from "../tools/tool-search/tool-embedding.js";',
);

const anchor = `  registerMcpTools(toolRegistry, mcpClientService);
  setMcpChatTools(buildMcpChatTools(mcpClientService));`;
const warm = `${anchor}
  // 工具向量预热（2026-11-20）：本地 bge 侧车就绪后，后台把可检索工具的向量算进
  // 缓存——否则首个 tool_discover(query) 要现算 200+ 条，混合召回首轮不可用。
  void (async () => {
    try {
      const seen = new Set<string>();
      const items = getBuiltinAgentChatTools()
        .filter((t) => t.type === "function" && Boolean(t.function?.name) && !seen.has(t.function!.name) && seen.add(t.function!.name))
        .map((t) => ({
          registryName: (t as { function: { name: string } }).function.name,
          searchText: ((t as { function: { description?: string; name: string } }).function.description ?? "") +
            " " + (t as { function: { name: string } }).function.name,
        }));
      const stats = await ensureToolEmbeddings(items);
      log("[tool-embedding] 预热完成 computed=" + stats.computed + " reused=" + stats.reused + " failed=" + stats.failed);
    } catch (e) {
      log("[tool-embedding] 预热失败（不影响主链路）: " + (e instanceof Error ? e.message : String(e)));
    }
  })();`;
if (!t.includes(anchor)) throw new Error("anchor missing");
t = t.replace(anchor, warm);
fs.writeFileSync(p, t.split("\n").join(eol));
console.log("warmup added:", t.includes("工具向量预热"));
