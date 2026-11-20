import fs from "node:fs";
const p = "server/src/bootstrap/create-app-services.ts";
const raw = fs.readFileSync(p, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let t = raw.split("\r\n").join("\n");

const anchor = "  void (async () => {\n    try {\n      const seen = new Set<string>();";
if (!t.includes(anchor)) throw new Error("warmup anchor missing");
t = t.replace(anchor, [
  "  void (async () => {",
  "    try {",
  "      // 端口绑定 ≠ 模型就绪：bge 引擎懒加载期间 /embeddings 会 503，连续失败会把",
  "      // 熔断器打开（之后所有 embed 调用静默跳过）。先等到一次成功推理再开算。",
  "      const { ensureLocalEmbeddingEndpoint } = await import(\"../agentic-memory/local-embedding/local-embedding-endpoint.js\");",
  "      const { neuralEmbedTexts } = await import(\"../tools/tool-search/neural-sidecar.js\");",
  "      await ensureLocalEmbeddingEndpoint();",
  "      let warm = false;",
  "      for (let i = 0; i < 8; i++) {",
  "        const probe = await neuralEmbedTexts([\"warmup\"]);" +
    " if (probe) { warm = true; break; }",
  "        await new Promise((r2) => setTimeout(r2, 1500));",
  "      }",
  "      if (!warm) throw new Error(\"bge 侧车 12s 内未就绪\");",
  "      const seen = new Set<string>();",
].join("\n"));

fs.writeFileSync(p, t.split("\n").join(eol));
console.log("wait-for-ready added");
