import fs from "node:fs";
function edit(path: string, fn: (s: string) => string): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  fs.writeFileSync(path, fn(raw.split("\r\n").join("\n")).split("\n").join(eol));
}

const client = "server/src/services/openai-embedding-client.ts";
edit(client, (s) => {
  let t = s;
  // 1) key 链删 OPENAI_API_KEY 兜底
  t = t.replace("    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||\n    process.env.OPENAI_API_KEY?.trim() ||\n", "    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||\n");
  // 2) 两处 api.openai.com 默认端点 → 报错（显式配置是唯一远端来源）
  t = t.replace(
    `  const base =
    opts.baseUrl?.replace(/\\/\$/, "") ??
    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\\/\$/, "") ??
    "https://api.openai.com/v1/embeddings";`,
    `  const base =
    opts.baseUrl?.replace(/\\/\$/, "") ??
    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\\/\$/, "");
  if (!base) {
    throw new Error(
      "embeddings: 未配置远端端点（OpenAI 官方兜底已于 2026-11-20 删除）；" +
        "请配置 AGENT_EMBEDDING_BASE_URL（如 https://api.siliconflow.cn/v1）+ AGENT_EMBEDDING_API_KEY，" +
        "或启用本地内置向量引擎",
    );
  }`,
  );
  // 另一处单输入版本（202-206 行附近同款三元）
  t = t.replace(
    `    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\\/\$/, "") ??
    "https://api.openai.com/v1/embeddings";`,
    `    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\\/\$/, "");`,
  );
  // 模型默认值也去掉 OpenAI 残留（远端必配 bge-m3 等）
  return t;
});

const tools = "server/src/tools/tool-search/tool-embedding.ts";
edit(tools, (s) => {
  // getApiKey 删 OPENAI_API_KEY 兜底
  let t = s.replace(
    "    process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||\n    process.env.OPENAI_API_KEY?.trim() ||\n    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||\n",
    "    process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||\n    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||\n",
  );
  // provider2 注释改名：OpenAI API → 远端兼容端点
  t = t.replace("    // ── provider 2：OpenAI 兼容 API（批量 8 并发）──", "    // ── provider 2：远端 OpenAI 兼容端点（SiliconFlow 等，须显式配 base；api.openai.com 兜底已删除）──");
  return t;
});
console.log("openai fallback stripped");
