import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { QdrantClient } from "@qdrant/js-client-rest";
import type { MemoryConfig } from "mem0ai/oss";

import { resolveEmbeddingEndpoint } from "../services/openai-embedding-client.js";
import {
  getAgenticMemoryCollection,
  getAgenticMemoryCustomInstructions,
  getAgenticMemoryDir,
  getAgenticMemoryEmbeddingDims,
  getAgenticMemoryLlmModel,
  resolveAgenticMemoryLlmBaseUrl,
  resolveOpenAiApiKey,
} from "./env.js";

/** 模型名 → 集合名安全段（Qdrant/SQLite 表名都不吃 `/` 等字符） */
function sanitizeModelTag(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * 向量集合按嵌入模型打标：不同模型 = 不同向量空间，混在一组集合里会静默检索
 * 出垃圾分。按模型分集合后，切换端点（本地 bge-small ↔ 远端 bge-m3 等）只会
 * 各自读写自己的集合，旧集合原样保留、互不污染。
 */
export function resolveAgenticMemoryCollectionName(embeddingModel: string): string {
  return `${getAgenticMemoryCollection()}-${sanitizeModelTag(embeddingModel)}`;
}

/** 构建 Mem0 OSS 配置；无任何可用 Embedding 端点（远端未配置且本地引擎不可用）时返回 null。 */
export function buildAgenticMemoryConfig(): Partial<MemoryConfig> | null {
  const endpoint = resolveEmbeddingEndpoint();
  if (!endpoint) {
    console.warn(
      "[agentic-memory] 无可用 Embedding 端点，agentic-memory 已禁用。正常安装内置本地向量引擎会自动启用；" +
        "若需远端可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY，" +
        "或检查 AGENT_LOCAL_EMBEDDING_DISABLED 与 models/bge-small-zh-v1.5 资产。",
    );
    return null;
  }

  const rootDir = getAgenticMemoryDir();
  mkdirSync(rootDir, { recursive: true });

  const embeddingModel = endpoint.model;
  // 向量库需要维度（本地向量库/维度校验），但 embeddingDims 不能传给 mem0ai 的
  // OpenAIEmbedder：它会作为 OpenAI 的 `dimensions` 请求参数，而 BAAI/bge-m3 等模型
  // 不支持该参数，远端会返回 400（code 20015）。
  const embeddingDims = getAgenticMemoryEmbeddingDims(embeddingModel);
  const llmModel = getAgenticMemoryLlmModel();
  const llmBaseUrl = resolveAgenticMemoryLlmBaseUrl();
  // 单 provider 可观测性（2026-10-21）：启动/初始化时打出记忆侧 LLM 实际端点，
  // 防止哪天又悄悄回落到第二个 provider。
  console.info(
    `[agentic-memory] llm model=${llmModel} baseURL=${llmBaseUrl ?? "(sdk-default)"} key=${
      resolveOpenAiApiKey() ? "set" : "none"
    }`,
  );

  const qdrantUrl = process.env.AGENT_QDRANT_URL?.trim();
  const base: Partial<MemoryConfig> = {
    embedder: {
      provider: "openai",
      config: {
        apiKey: endpoint.apiKey,
        model: embeddingModel,
        baseURL: endpoint.baseUrl,
      },
    },
    llm: {
      provider: "openai",
      config: {
        // 2026-10-21 单模型统一：记忆侧 LLM 与主聊天共用同一 provider
        //（MiniMax 优先；AGENT_AGENTIC_MEMORY_LLM_* 可单独覆盖）。
        apiKey: resolveOpenAiApiKey() ?? undefined,
        model: llmModel,
        baseURL: llmBaseUrl,
      },
    },
    disableHistory: true,
    customInstructions: getAgenticMemoryCustomInstructions(),
  };

  if (qdrantUrl) {
    const client = new QdrantClient({
      url: qdrantUrl,
      apiKey: process.env.AGENT_QDRANT_API_KEY?.trim(),
    });
    return {
      ...base,
      vectorStore: {
        provider: "qdrant",
        config: {
          client,
          collectionName: resolveAgenticMemoryCollectionName(embeddingModel),
          embeddingModelDims: embeddingDims,
        },
      },
    };
  }

  return {
    ...base,
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: resolveAgenticMemoryCollectionName(embeddingModel),
        dimension: embeddingDims,
        // mem0 的本地 SQLite 库不消费 collectionName（单 vectors 表），防串库
        // 只能落在文件名上：每模型一个库文件，切换端点互不可见、旧库原样保留
        dbPath: join(rootDir, `vectors-${sanitizeModelTag(embeddingModel)}.db`),
      },
    },
  };
}
