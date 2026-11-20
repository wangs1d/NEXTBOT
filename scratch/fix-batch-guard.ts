import fs from "node:fs";
const p = "server/src/services/openai-embedding-client.ts";
let s = fs.readFileSync(p, "utf8");
const anchor =
  '  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";\n  if (!apiKey) {\n    throw new Error("embeddings: no API key configured");\n  }\n  const model = opts.model ?? ep?.model ?? "text-embedding-3-small";\n  const endpoint = base.endsWith("/embeddings") ? base : `${base}/embeddings`;';
if (!s.includes(anchor)) throw new Error("anchor missing");
const rep = [
  '  if (!base) {',
  '    throw new Error(',
  '      "embeddings: 未配置远端端点（OpenAI 官方兜底已于 2026-11-20 删除）；" +',
  '        "请配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY，或启用本地内置向量引擎",',
  '    );',
  '  }',
  anchor,
].join("\n");
s = s.replace(anchor, rep);
fs.writeFileSync(p, s);
console.log("batch guard added");
