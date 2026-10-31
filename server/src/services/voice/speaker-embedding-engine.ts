/**
 * 本地说话人向量引擎（声纹底座）。
 *
 * 打包随附 3D-Speaker CAM++ 中文版 ONNX（~28MB，192 维，CN-Celeb+CN-Common
 * ~20 万说话人训练，官方 checkpoint 导出），onnxruntime-node 纯 CPU 推理。
 * 输入 16k 单声道 PCM16（>0.25s），输出 L2 归一化 192 维说话人 embedding——
 * 同一人不同语句余弦相近、不同人相远，注册/验证共用同一实现保证系统内一致
 * （不与 pyannote 等外部实现互认）。
 *
 * 前端见 speaker-fbank.ts（kaldi fbank80 + 逐句减均值）。归一口径经官方样本
 * 实证标定（scripts/probe-campplus-frontend.ts）：mean margin 0.78 ≫ cmvn 0.30，
 * 与 3D-Speaker 官方 CAM++ 推理一致；模型图内不含 CMVN。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { serverRoot } from "../../config/paths.js";

import type { InferenceSession, Tensor } from "onnxruntime-node";

import { computeFbank, pcm16ToFloat, resampleTo16k } from "./speaker-fbank.js";

export const SPEAKER_MODEL_ID = "speaker-campplus-zh";
export const SPEAKER_EMBEDDING_DIMS = 192;
export const SPEAKER_MODEL_FILE = "campplus_zh_cn_common_200k.onnx";

export type SpeakerEmbeddingEngine = {
  model: string;
  dims: number;
  /** PCM16 单声道 → L2 归一化说话人向量；过短/静音抛错（调用方跳过该样本） */
  embedPcm16(pcm: Int16Array, sampleRate?: number): Promise<Float32Array>;
};

export function isSpeakerEmbeddingDisabled(): boolean {
  return process.env.AGENT_SPEAKER_EMBEDDING_DISABLED?.trim() === "1";
}

/** 模型资产目录：显式 env → 模块相对（dev src / 打包 dist 同构）→ cwd 兜底 */
export function resolveSpeakerModelDir(): string | null {
  const explicit = process.env.AGENT_SPEAKER_MODEL_DIR?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(serverRoot(), "models", SPEAKER_MODEL_ID),
    join(process.cwd(), "models", SPEAKER_MODEL_ID),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, SPEAKER_MODEL_FILE))) return dir;
  }
  return null;
}

let enginePromise: Promise<SpeakerEmbeddingEngine | null> | null = null;

/** 幂等初始化；模型缺失/被关闭/加载失败返回 null（声纹能力降级为不可用） */
export function initSpeakerEmbeddingEngine(): Promise<SpeakerEmbeddingEngine | null> {
  if (!enginePromise) enginePromise = doInit();
  return enginePromise;
}

async function doInit(): Promise<SpeakerEmbeddingEngine | null> {
  if (isSpeakerEmbeddingDisabled()) return null;
  const dir = resolveSpeakerModelDir();
  if (!dir) {
    console.warn("[voiceprint] 说话人模型缺失（models/speaker-campplus-zh），声纹能力不可用");
    return null;
  }

  const t0 = Date.now();
  const ort = await import("onnxruntime-node");
  let session: InferenceSession;
  try {
    session = await ort.InferenceSession.create(join(dir, SPEAKER_MODEL_FILE), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  } catch (err) {
    console.warn("[voiceprint] 说话人 ONNX 会话创建失败:", err instanceof Error ? err.message : err);
    return null;
  }
  console.info(
    `[voiceprint] 说话人向量引擎就绪 model=${SPEAKER_MODEL_ID} dims=${SPEAKER_EMBEDDING_DIMS} load=${Date.now() - t0}ms`,
  );

  // 串行化推理：与 local-embedding 同款，防 CPU 并发峰值
  let chain: Promise<unknown> = Promise.resolve();

  return {
    model: SPEAKER_MODEL_ID,
    dims: SPEAKER_EMBEDDING_DIMS,
    async embedPcm16(pcm: Int16Array, sampleRate = 16000): Promise<Float32Array> {
      const run = chain.then(async () => {
        const wave = resampleTo16k(pcm16ToFloat(pcm), sampleRate);
        // CAM++ 推理口径：逐句减均值（标定 margin 0.78，见文件头）
        const fbank = computeFbank(wave, "mean");
        const feeds: Record<string, Tensor> = {
          feats: new ort.Tensor("float32", fbank.data, [1, fbank.frames, fbank.dims]),
        };
        const output = await session.run(feeds);
        const emb = output["embs"] ?? output[Object.keys(output)[0]!];
        const data = emb.data as Float32Array;
        const norm = Math.sqrt(Array.from(data).reduce((s, v) => s + v * v, 0)) || 1;
        const out = new Float32Array(SPEAKER_EMBEDDING_DIMS);
        for (let i = 0; i < Math.min(out.length, data.length); i++) out[i] = data[i]! / norm;
        return out;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
