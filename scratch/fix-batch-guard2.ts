import fs from "node:fs";
const p = "server/src/services/openai-embedding-client.ts";
let s = fs.readFileSync(p, "utf8");
// 定位批量版函数内的 apiKey 守卫（在 fetchOpenAiCompatibleEmbeddings 定义之后）
const fnAt = s.indexOf("export async function fetchOpenAiCompatibleEmbeddings(");
if (fnAt < 0) throw new Error("batch fn missing");
const at = s.indexOf('  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";', fnAt);
if (at < 0) throw new Error("guard missing");
const rep = [
  '  if (!base) {',
  '    throw new Error(',
  '      "embeddings: 未配置远端端点（OpenAI 官方兜底已于 2026-11-20 删除）；" +',
  '        "请配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY，或启用本地内置向量引擎",',
  '    );',
  '  }',
  '  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";',
].join("\n");
s = s.slice(0, at) + rep + s.slice(at + '  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";'.length);
fs.writeFileSync(p, s);
console.log("batch guard added");
