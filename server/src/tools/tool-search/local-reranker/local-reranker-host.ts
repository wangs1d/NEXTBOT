import type { LocalRerankerEngine } from "./local-reranker-engine.js";
import {
  initLocalRerankerEngine,
  isLocalRerankerDisabled,
  LOCAL_RERANKER_MODEL_ID,
  resolveLocalRerankerModelDir,
} from "./local-reranker-engine.js";
import { startLocalRerankerServer } from "./local-reranker-server.js";

async function main(): Promise<void> {
  if (isLocalRerankerDisabled()) {
    process.send?.({ ok: false, reason: "AGENT_LOCAL_RERANKER_DISABLED=1" });
    return;
  }
  if (!resolveLocalRerankerModelDir()) {
    process.send?.({ ok: false, reason: `模型资产缺失（models/${LOCAL_RERANKER_MODEL_ID}）` });
    return;
  }

  let engine: LocalRerankerEngine | null = null;
  const endpoint = await startLocalRerankerServer(() => engine);
  process.send?.({ ok: true, endpoint });
  process.on("disconnect", () => process.exit(0));

  engine = await initLocalRerankerEngine();
  process.send?.({
    type: "engine",
    ok: engine !== null,
    reason: "引擎不可用（模型缺失或 ONNX 会话创建失败）",
  });
}

void main().catch((error: unknown) => {
  try {
    process.send?.({ ok: false, reason: error instanceof Error ? error.message : String(error) });
  } finally {
    process.exit(1);
  }
});
