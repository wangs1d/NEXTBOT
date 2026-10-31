/**
 * 本地向量引擎宿主进程：ONNX 引擎与回环 /v1/embeddings 端点都跑在这里。
 *
 * 为什么必须独立进程：onnxruntime-node 是原生二进制，部分 CPU/系统组合上
 * InferenceSession.create 直接 0xC0000005（进程级崩溃，try/catch 拦不住，
 * 实证机型 Xeon Gold 6530 + Server 2022）。放进子进程后最坏结果是语义记忆
 * 降级，后端照常监听。
 */

import type { LocalEmbeddingEngine } from "./local-embedding-engine.js";
import {
  initLocalEmbeddingEngine,
  isLocalEmbeddingDisabled,
  LOCAL_EMBEDDING_MODEL_ID,
  resolveLocalEmbeddingModelDir,
} from "./local-embedding-engine.js";
import { startLocalEmbeddingServer } from "./local-embedding-server.js";

async function main(): Promise<void> {
  // 资产前置检查是同步的：模型缺失时不要先对外宣称端点可用
  if (isLocalEmbeddingDisabled()) {
    process.send?.({ ok: false, reason: "AGENT_LOCAL_EMBEDDING_DISABLED=1" });
    return;
  }
  if (!resolveLocalEmbeddingModelDir()) {
    process.send?.({ ok: false, reason: `模型资产缺失（models/${LOCAL_EMBEDDING_MODEL_ID}）` });
    return;
  }
  // 先绑回环端口把端点交给父进程，再后台加载 ONNX：模型装载是几秒级冷启动，
  // 放在端点就绪之前会把整个后端启动拖住；装载完成前的嵌入请求回 503，消费方降级。
  let engine: LocalEmbeddingEngine | null = null;
  const endpoint = await startLocalEmbeddingServer(() => engine);
  process.send?.({ ok: true, endpoint });
  // 父进程消失（正常退出 / 被杀）时跟着退出，不留守回环端口
  process.on("disconnect", () => process.exit(0));

  engine = await initLocalEmbeddingEngine();
  process.send?.({ type: "engine", ok: engine !== null, reason: "引擎不可用（模型缺失或 ONNX 会话创建失败）" });
}

void main().catch((err: unknown) => {
  try {
    process.send?.({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    process.exit(1);
  }
});
