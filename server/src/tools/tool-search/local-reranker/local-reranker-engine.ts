import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { InferenceSession, Tensor } from "onnxruntime-node";

import { serverRoot } from "../../../config/paths.js";

export const LOCAL_RERANKER_MODEL_ID = "bge-reranker-base";
const BOS_ID = 0;
const EOS_ID = 2;
const PAD_ID = 1;

export type LocalRerankerEngine = {
  model: string;
  maxSequenceLength: number;
  rerank(query: string, documents: string[]): Promise<number[]>;
};

export function isLocalRerankerDisabled(): boolean {
  return process.env.AGENT_LOCAL_RERANKER_DISABLED?.trim() === "1";
}

export function resolveLocalRerankerModelDir(): string | null {
  const explicit = process.env.AGENT_LOCAL_RERANKER_DIR?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(serverRoot(), "models", LOCAL_RERANKER_MODEL_ID),
    join(process.cwd(), "models", LOCAL_RERANKER_MODEL_ID),
  ];
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "model_quantized.onnx")) &&
      existsSync(join(dir, "tokenizer.json")) &&
      existsSync(join(dir, "tokenizer_config.json"))
    ) {
      return dir;
    }
  }
  return null;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

let enginePromise: Promise<LocalRerankerEngine | null> | null = null;

export function initLocalRerankerEngine(): Promise<LocalRerankerEngine | null> {
  if (!enginePromise) enginePromise = doInit();
  return enginePromise;
}

async function doInit(): Promise<LocalRerankerEngine | null> {
  if (isLocalRerankerDisabled()) return null;
  const dir = resolveLocalRerankerModelDir();
  if (!dir) return null;

  const started = Date.now();
  try {
    const [{ Tokenizer }, ort, tokenizerConfig] = await Promise.all([
      import("@huggingface/tokenizers"),
      import("onnxruntime-node"),
      Promise.resolve(JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")) as {
        model_max_length?: number;
        pad_token_id?: number;
      }),
    ]);
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")),
      tokenizerConfig,
    );
    if (tokenizerConfig.pad_token_id !== undefined && tokenizerConfig.pad_token_id !== PAD_ID) {
      throw new Error(`unexpected pad token id: ${tokenizerConfig.pad_token_id}`);
    }
    const configuredMax = tokenizerConfig.model_max_length ?? 512;
    const maxSequenceLength = envInt("AGENT_LOCAL_RERANKER_MAX_SEQ_LEN", Math.min(224, configuredMax), 64, 512);
    const maxQueryTokens = envInt("AGENT_LOCAL_RERANKER_MAX_QUERY_TOKENS", 96, 16, 256);
    const session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    console.info(
      `[local-reranker] 交叉编码引擎就绪 model=${LOCAL_RERANKER_MODEL_ID} ` +
        `maxSeq=${maxSequenceLength} load=${Date.now() - started}ms`,
    );

    let chain: Promise<unknown> = Promise.resolve();
    return {
      model: LOCAL_RERANKER_MODEL_ID,
      maxSequenceLength,
      async rerank(query: string, documents: string[]): Promise<number[]> {
        const run = chain.then(async () => {
          const encoded = documents.map((document) => encodePair(tokenizer, query, document, maxSequenceLength, maxQueryTokens));
          const batch = encoded.length;
          const sequenceLength = Math.max(...encoded.map((item) => item.ids.length));
          const ids = new BigInt64Array(batch * sequenceLength);
          const mask = new BigInt64Array(batch * sequenceLength);
          encoded.forEach((item, row) => {
            ids.set(item.ids, row * sequenceLength);
            mask.set(item.mask, row * sequenceLength);
          });
          const feeds: Record<string, Tensor> = {
            input_ids: new ort.Tensor("int64", ids, [batch, sequenceLength]),
            attention_mask: new ort.Tensor("int64", mask, [batch, sequenceLength]),
          };
          const output = await session.run(feeds);
          const logits = output.logits ?? output[Object.keys(output)[0]!];
          if (!logits || logits.dims[0] !== batch || logits.dims[1] < 1) {
            throw new Error(`unexpected reranker logits shape: ${logits?.dims.join("x") ?? "missing"}`);
          }
          const values = logits.data as Float32Array;
          return Array.from({ length: batch }, (_, index) =>
            Math.max(-60, Math.min(60, values[index * logits.dims[1]!] ?? 0)),
          );
        });
        chain = run.catch(() => undefined);
        return run;
      },
    };
  } catch (error) {
    console.warn(
      "[local-reranker] 交叉编码引擎装载失败:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function encodePair(
  tokenizer: InstanceType<typeof import("@huggingface/tokenizers").Tokenizer>,
  query: string,
  document: string,
  maxSequenceLength: number,
  maxQueryTokens: number,
): { ids: bigint[]; mask: bigint[] } {
  const queryIds = tokenizer.encode(query, { add_special_tokens: false }).ids.slice(0, maxQueryTokens);
  const documentBudget = Math.max(1, maxSequenceLength - queryIds.length - 4);
  const documentIds = tokenizer.encode(document, { add_special_tokens: false }).ids.slice(0, documentBudget);
  const ids = [BOS_ID, ...queryIds, EOS_ID, EOS_ID, ...documentIds, EOS_ID];
  return { ids: ids.map(BigInt), mask: ids.map(() => 1n) };
}
