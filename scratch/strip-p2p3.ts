import fs from "node:fs";

function edit(path: string, fn: (s: string) => string): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const out = fn(raw.split("\r\n").join("\n"));
  fs.writeFileSync(path, out.split("\n").join(eol));
}

// ── P2：删除关键词分类机制（tool-loop 内 1238..selectRelevantTools 末尾）──
edit("server/src/external-model/openai-compatible-tool-loop.ts", (s) => {
  const start = s.indexOf("type ToolCategory = ");
  const end = s.indexOf("function extractUserTextFromMessages(");
  if (start < 0 || end < 0) throw new Error("tool-loop anchors missing");
  let out = s.slice(0, start) + s.slice(end);
  out = out.replace(/  getCapabilityModuleCategoryMappings,\n/, "");
  return out;
});

// ── P2：移除 create-app-services 的 selectRelevantTools 导入 ──
edit("server/src/bootstrap/create-app-services.ts", (s) =>
  s.replace(", selectRelevantTools,", ","),
);

// ── P3：删除 core 分层（core-tool-library.ts 及其引用）──
fs.rmSync("server/src/tools/tool-search/core-tool-library.ts", { force: true });

edit("server/src/tools/tool-search/catalog.ts", (s) => {
  let out = s.replace(/import \{ isCoreToolRegistryName \} from "\.\/core-tool-library\.js";\n/, "");
  const start = out.indexOf("export function splitCoreAndDeferredTools(");
  const end = out.indexOf("function extractParameterSummary(");
  if (start < 0 || end < 0) throw new Error("catalog anchors missing");
  out = out.slice(0, start) + out.slice(end);
  return out;
});

for (const p of ["server/src/tools/tool-search/index.ts", "server/src/tools/tool-search/core-tools.ts", "server/src/gateway/index.ts"]) {
  edit(p, (s) => {
    let out = s;
    // 删掉单个 re-export 名（保留其余）
    for (const name of ["CORE_TOOL_LIBRARY", "classifyToolExposureTier", "isCoreToolRegistryName", "isToolSearchCoreRegistryName", "summarizeCoreToolLibrary", "TOOL_SEARCH_CORE_REGISTRY_NAMES", "TOOL_SEARCH_CORE_REGISTRY_PREFIXES", "type ToolExposureTier"]) {
      out = out.replace(new RegExp("^\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ",\\n", "m"), "");
    }
    return out;
  });
}
console.log("P2+P3 stripped");
