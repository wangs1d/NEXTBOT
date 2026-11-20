import fs from "node:fs";
const p = "server/src/tools/tool-search/neural-sidecar.ts";
let s = fs.readFileSync(p, "utf8");
const eol = s.includes("\r\n") ? "\r\n" : "\n";

const branch = [
  "  // provider=openai（2026-11-20）：查询与工具向量必须同模型同维度——",
  "  // 本地 bge(512) 与 SiliconFlow bge-large(1024) 不能互算余弦。走远端缓存通道。",
  "  if (getToolSearchConfig().embeddingProvider === \"openai\") {",
  "    const { fetchOpenAiCompatibleEmbeddings } = await import(\"../services/openai-embedding-client.js\");",
  "    const out = await guardedCall(\"embed\", () =>",
  "      fetchOpenAiCompatibleEmbeddings({ inputs: texts, timeoutMs: Math.max(timeoutMs, 3_000) }),",
  "    );",
  "    if (!out || out.vectors.length !== texts.length) return null;",
  "    return { model: getToolSearchConfig().embeddingModel, dim: out.vectors[0]?.length ?? 0, vectors: out.vectors };",
  "  }",
  "",
].join("\n");

const anchor1 = "export async function neuralEmbedTextsBulk(texts: string[]): Promise<NeuralEmbedResult | null> {";
s = s.replace(anchor1, anchor1 + "\n" + branch);
const anchor2 = "export async function neuralEmbedTexts(texts: string[]): Promise<NeuralEmbedResult | null> {";
s = s.replace(anchor2, anchor2 + "\n" + branch);
fs.writeFileSync(p, s.split("\n").join(eol));
console.log("openai branch added:", (s.match(/provider === "openai"/g) ?? []).length);
