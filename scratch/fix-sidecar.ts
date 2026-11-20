import fs from "node:fs";
const p = "server/src/tools/tool-search/neural-sidecar.ts";
const raw = fs.readFileSync(p, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let s = raw.split("\r\n").join("\n");

// 1) 导入本地 bge 端点
if (!s.includes('local-embedding-endpoint.js')) {
  s = s.replace(
    'import { getToolSearchConfig } from "./env.js";',
    'import { getToolSearchConfig } from "./env.js";\nimport { getLocalEmbeddingEndpoint } from "../../agentic-memory/local-embedding/local-embedding-endpoint.js";',
  );
}

// 2) embed 统一入口：本地 bge 侧车（OpenAI 兼容）优先，缺失才回退旧 FastAPI 侧车
const helper = [
  "/**",
  " * 2026-11-20 根修：此前的 embed 一律打 `cfg.neuralSidecarUrl`（默认 8790 的",
  " * FastAPI 侧车），但本部署根本没有那个服务——所有神经召回静默降级成纯 BM25",
  " * （实证：tool-embeddings.json 从未生成、日志只有「embed 调用失败」）。",
  " * 现改为：进程内 bge 侧车（getLocalEmbeddingEndpoint，OpenAI 兼容 /v1）优先，",
  " * 它有 512 维中文小模型、云端离线可用；没有才回退旧 URL。",
  " */",
  "async function embedTextsOnce(texts: string[], timeoutMs: number): Promise<NeuralEmbedResult | null> {",
  "  const local = getLocalEmbeddingEndpoint();",
  "  if (local) {",
  "    try {",
  "      const res = await fetch(`${local.baseUrl.replace(/\\/+$/, \"\")}/embeddings`, {",
  "        method: \"POST\",",
  "        headers: {",
  "          \"Content-Type\": \"application/json\",",
  "          ...(local.apiKey ? { Authorization: `Bearer ${local.apiKey}` } : {}),",
  "        },",
  "        body: JSON.stringify({ model: local.model, input: texts }),",
  "        signal: AbortSignal.timeout(timeoutMs),",
  "      });",
  "      if (!res.ok) throw new Error(`local embedding HTTP ${res.status}`);",
  "      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };",
  "      const vectors = (json.data ?? []).map((d) => d.embedding ?? []).filter((v) => v.length > 0);",
  "      if (vectors.length !== texts.length) throw new Error(`local embedding 数量不匹配 ${vectors.length}/${texts.length}`);",
  "      return { model: local.model, dim: vectors[0]?.length ?? 0, vectors };",
  "    } catch (e) {",
  "      console.info(`[tool-search:neural] 本地 bge 侧车失败，回退旧 sidecar：${e instanceof Error ? e.message : String(e)}`);",
  "    }",
  "  }",
  "  return null;",
  "}",
  "",
].join("\n");
s = s.replace("async function postJson<T>(", helper + "async function postJson<T>(");

// 3) 两个 embed 函数先走统一入口，失败再回退旧路径
s = s.replace(
  `  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    const part = await guardedCall("embed", () =>
      postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
    );`,
  `  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    const part =
      (await guardedCall("embed", () => embedTextsOnce(chunk, timeoutMs))) ??
      (await guardedCall("embed", () =>
        postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
      ));`,
);
s = s.replace(
  `  for (let i = 0; i < texts.length; i += SIDECAR_MAX_BATCH) {
    const chunk = texts.slice(i, i + SIDECAR_MAX_BATCH);
    const part = await guardedCall("embed", () =>
      postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
    );`,
  `  for (let i = 0; i < texts.length; i += SIDECAR_MAX_BATCH) {
    const chunk = texts.slice(i, i + SIDECAR_MAX_BATCH);
    const part =
      (await guardedCall("embed", () => embedTextsOnce(chunk, timeoutMs))) ??
      (await guardedCall("embed", () =>
        postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
      ));`,
);
fs.writeFileSync(p, s.split("\n").join(eol));
console.log("sidecar fixed:", s.includes("embedTextsOnce"));
