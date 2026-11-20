import fs from "node:fs";
const glob = (p) => p;

// 1) resolveEmbeddingEndpoint 尊重 provider=openai（跳过本地端点）
const client = "server/src/services/openai-embedding-client.ts";
let s = fs.readFileSync(client, "utf8");
const eol = s.includes("\r\n") ? "\r\n" : "\n";
let t = s.split("\r\n").join("\n");
if (!t.includes("tool-search/env.js")) {
  t = t.replace(
    /(^import .*local-embedding-endpoint\.js";\n)/m,
    '$1import { getToolSearchConfig } from "../tools/tool-search/env.js";\n',
  );
}
t = t.replace(
  /export function resolveEmbeddingEndpoint\(\): EmbeddingEndpoint \| null \{\n  \/\/ 本地内置引擎优先：模型\/维度\/鉴权自成一体，与远端配置解耦\n  const local = getLocalEmbeddingEndpoint\(\);\n  if \(local\) return \{ baseUrl: local\.baseUrl, apiKey: local\.apiKey, model: local\.model \};/,
  `export function resolveEmbeddingEndpoint(): EmbeddingEndpoint | null {
  // 本地内置引擎优先：模型/维度/鉴权自成一体，与远端配置解耦。
  // 2026-11-20：显式 AGENT_TOOL_EMBEDDING_PROVIDER=openai 时跳过本地——
  // ECS 2vCPU 上本地宿主启动期不稳（code=1），此类部署直接走远端。
  if (getToolSearchConfig().embeddingProvider === "openai") {
    const local = getLocalEmbeddingEndpoint();
    void local;
  } else {
    const local = getLocalEmbeddingEndpoint();
    if (local) return { baseUrl: local.baseUrl, apiKey: local.apiKey, model: local.model };
  }`,
);
fs.writeFileSync(client, t.split("\n").join(eol));

// 2) warmup 门：provider=openai 时不等本地侧车
const boot = "server/src/bootstrap/create-app-services.ts";
s = fs.readFileSync(boot, "utf8");
t = s.split("\r\n").join("\n");
t = t.replace(
  /      const \{ ensureLocalEmbeddingEndpoint \} = await import\("\.\.\/agentic-memory\/local-embedding\/local-embedding-endpoint\.js"\);\n      const \{ neuralEmbedTexts \} = await import\("\.\.\/tools\/tool-search\/neural-sidecar\.js"\);\n      await ensureLocalEmbeddingEndpoint\(\);/,
  `      const { ensureLocalEmbeddingEndpoint } = await import("../agentic-memory/local-embedding/local-embedding-endpoint.js");
      const { neuralEmbedTextsBulk } = await import("../tools/tool-search/neural-sidecar.js");
      const provider = getToolSearchConfig().embeddingProvider;
      if (provider !== "openai") {
        await ensureLocalEmbeddingEndpoint();
      }`,
);
t = t.replace(
  /        const probe = await neuralEmbedTextsBulk\(\["warmup"\]\); if \(probe && probe\.vectors\.length > 0\) \{ warm = true; break; \}/,
  `        const probe = provider === "openai"
          ? { vectors: [new Array(1024).fill(0)] } // openai 档：远端可达即视为就绪，直接预热
          : await neuralEmbedTextsBulk(["warmup"]);
        if (probe && probe.vectors.length > 0) { warm = true; break; }`,
);
t = t.replace(
  /      if \(!warm\) throw new Error\("bge 侧车 12s 内未就绪"\);/,
  `      if (!warm) throw new Error("工具向量通道 12s 内未就绪");`,
);
fs.writeFileSync(boot, t.split("\n").join(eol));
console.log("provider-aware patched");
