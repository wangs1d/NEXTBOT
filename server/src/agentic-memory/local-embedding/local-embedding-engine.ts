/**
 * 本地内置向量引擎（零配置记忆底座）。
 *
 * 打包随附 bge-small-zh-v1.5（int8 量化 ONNX，~24MB，512 维），经 onnxruntime-node
 * 纯 CPU 推理——无 Python、离线可用、记忆数据不出本机。用户未配置任何远端
 * Embedding 端点时自动点亮（见 local-embedding-endpoint.ts），远端显式配置时
 * 仍可覆盖（AGENT_EMBEDDING_BASE_URL / OPENAI_EMBEDDINGS_URL）。
 *
 * 池化：BGE 官方口径——取 [CLS] 位置末层隐状态，L2 归一化。
 * 模型资产：models/bge-small-zh-v1.5/{model_quantized.onnx, vocab.txt}，
 * dev 位于 server/models，打包后位于 runtime/models（安装器 staging 负责拷贝）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serverRoot } from "../../config/paths.js";

import type { InferenceSession, Tensor } from "onnxruntime-node";

export const LOCAL_EMBEDDING_MODEL_ID = "bge-small-zh-v1.5";
export const LOCAL_EMBEDDING_DIMS = 512;

/** 编码上限：BERT 位置表 512，[CLS]/[SEP] 占两头 */
const MAX_SEQ_LEN = 512;

const CLS_ID = 101;
const SEP_ID = 102;
const UNK_ID = 100;
const MAX_WORD_CHARS = 100;

export type LocalEmbeddingEngine = {
  model: string;
  dims: number;
  /** 批量嵌入；返回顺序与输入一致，向量已 L2 归一化 */
  embed(texts: string[]): Promise<number[][]>;
};

export function isLocalEmbeddingDisabled(): boolean {
  return process.env.AGENT_LOCAL_EMBEDDING_DISABLED?.trim() === "1";
}

/** 模型资产目录：显式 env → 模块相对（dev src / 打包 dist 同构）→ cwd 兜底 */
export function resolveLocalEmbeddingModelDir(): string | null {
  const explicit = process.env.AGENT_LOCAL_EMBEDDING_DIR?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(serverRoot(), "models", LOCAL_EMBEDDING_MODEL_ID),
    join(process.cwd(), "models", LOCAL_EMBEDDING_MODEL_ID),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "model_quantized.onnx")) && existsSync(join(dir, "vocab.txt"))) {
      return dir;
    }
  }
  return null;
}

// ── BERT WordPiece 分词（中文 BERT 口径：NFKC + 小写 + 去重音 + CJK/标点切分） ──

function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
}

function isPunct(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  // ASCII 标点 + 全角/CDATA 标点区（，。！？等）
  return (
    (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) ||
    (c >= 0x7b && c <= 0x7e) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
  );
}

function basicTokenize(text: string): string[] {
  let t = text.normalize("NFKC").toLowerCase();
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // 去重音
  let spaced = "";
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (isCJK(ch) || isPunct(ch)) spaced += " " + ch + " ";
    else if (c < 0x20 || c === 0x7f) spaced += " "; // 控制字符当空白
    else spaced += ch;
  }
  return spaced.split(/\s+/).filter(Boolean);
}

function wordpiece(word: string, vocab: Map<string, number>): number[] {
  if (word.length > MAX_WORD_CHARS) return [UNK_ID];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found: number | null = null;
    while (end > start) {
      const slice = word.slice(start, end);
      const cand = start === 0 ? slice : "##" + slice;
      const id = vocab.get(cand);
      if (id !== undefined) { found = id; break; }
      end--;
    }
    if (found === null) return [UNK_ID];
    ids.push(found);
    start = end;
  }
  return ids;
}

class BertTokenizer {
  private readonly vocab: Map<string, number>;

  constructor(vocabPath: string) {
    const lines = readFileSync(vocabPath, "utf8").split("\n").map((l) => l.replace(/\r$/, "").trim());
    this.vocab = new Map();
    lines.forEach((tok, i) => {
      if (tok && !this.vocab.has(tok)) this.vocab.set(tok, i);
    });
    if (this.vocab.get("[CLS]") !== CLS_ID || this.vocab.get("[SEP]") !== SEP_ID) {
      throw new Error("vocab.txt 特殊 token 布局与预期不符（非标准 BERT 词表）");
    }
  }

  encode(text: string): number[] {
    const ids = [CLS_ID];
    for (const w of basicTokenize(text)) ids.push(...wordpiece(w, this.vocab));
    if (ids.length > MAX_SEQ_LEN - 1) ids.length = MAX_SEQ_LEN - 1;
    ids.push(SEP_ID);
    return ids;
  }
}

// ── 引擎装配 ──

let enginePromise: Promise<LocalEmbeddingEngine | null> | null = null;

/** 幂等初始化；模型缺失/被关闭/加载失败返回 null（调用方维持旧禁用行为） */
export function initLocalEmbeddingEngine(): Promise<LocalEmbeddingEngine | null> {
  if (!enginePromise) enginePromise = doInit();
  return enginePromise;
}

async function doInit(): Promise<LocalEmbeddingEngine | null> {
  if (isLocalEmbeddingDisabled()) return null;
  const dir = resolveLocalEmbeddingModelDir();
  if (!dir) return null;

  const t0 = Date.now();
  const ort = await import("onnxruntime-node");
  let session: InferenceSession;
  const tokenizer = new BertTokenizer(join(dir, "vocab.txt"));
  try {
    session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  } catch (err) {
    console.warn(
      "[local-embedding] ONNX 会话创建失败:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  console.info(
    `[local-embedding] 内置向量引擎就绪 model=${LOCAL_EMBEDDING_MODEL_ID} dims=${LOCAL_EMBEDDING_DIMS} load=${Date.now() - t0}ms`,
  );

  // 串行化推理：CPU 单会话并发 run 会放大峰值内存，且单条仅 15~40ms，无并发收益
  let chain: Promise<unknown> = Promise.resolve();

  const embedOne = async (text: string): Promise<number[]> => {
    const ids = tokenizer.encode(text);
    const len = ids.length;
    const toI64 = (arr: number[]) => BigInt64Array.from(arr.map(BigInt));
    const feeds: Record<string, Tensor> = {
      input_ids: new ort.Tensor("int64", toI64(ids), [1, len]),
      attention_mask: new ort.Tensor("int64", toI64(Array(len).fill(1)), [1, len]),
      token_type_ids: new ort.Tensor("int64", toI64(Array(len).fill(0)), [1, len]),
    };
    const output = await session.run(feeds);
    const hidden = output["last_hidden_state"]
      ?? output[Object.keys(output)[0]!];
    const dims = hidden.dims[2]!;
    const data = hidden.data as Float32Array;
    const cls = Array.from(data.subarray(0, dims));
    const norm = Math.sqrt(cls.reduce((s, v) => s + v * v, 0)) || 1;
    return cls.map((v) => v / norm);
  };

  return {
    model: LOCAL_EMBEDDING_MODEL_ID,
    dims: LOCAL_EMBEDDING_DIMS,
    async embed(texts: string[]): Promise<number[][]> {
      const run = chain.then(async () => {
        const out: number[][] = [];
        for (const raw of texts) {
          const text = raw.trim();
          if (!text) {
            out.push(new Array(LOCAL_EMBEDDING_DIMS).fill(0));
            continue;
          }
          out.push(await embedOne(text));
        }
        return out;
      });
      chain = run.catch(() => undefined); // 链上吞错，避免一次失败卡死后续
      return run;
    },
  };
}
