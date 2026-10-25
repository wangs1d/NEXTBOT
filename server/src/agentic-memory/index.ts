import { Memory } from "mem0ai/oss";

import { buildAgenticMemoryConfig } from "./config.js";
import { isAgenticMemoryEnabled } from "./env.js";
import { AgenticMemoryIngestService } from "./ingest.js";
import { AgenticMemoryRetrievalService } from "./retrieval.js";
import { AgenticMemoryLifecycleService } from "./memory-lifecycle.js";
import { AgenticMemoryRecallCompressor } from "./recall-compressor.js";
import {
  MemoryReinforcementStore,
  configureMemoryReinforcement,
} from "./memory-reinforcement.js";
import { isMemoryReinforcementEnabled } from "./env.js";

export type AgenticMemoryRuntime = {
  memory: Memory;
  ingest: AgenticMemoryIngestService;
  retrieval: AgenticMemoryRetrievalService;
  lifecycle: AgenticMemoryLifecycleService;
  compressor: AgenticMemoryRecallCompressor;
};

let singleton: AgenticMemoryRuntime | null | undefined;

export function getAgenticMemoryRuntime(): AgenticMemoryRuntime | null {
  if (singleton !== undefined) return singleton;
  if (!isAgenticMemoryEnabled()) {
    singleton = null;
    return null;
  }

  const config = buildAgenticMemoryConfig();
  if (!config) {
    console.warn("[agentic-memory] disabled: OPENAI_API_KEY required for Mem0 OSS");
    singleton = null;
    return null;
  }

  try {
    const memory = new Memory(config);

    // 召回强化侧表（SQLite）：初始化失败仅降级（TTL 回退纯时间判据），不阻塞 runtime
    let reinforcement: MemoryReinforcementStore | null = null;
    if (isMemoryReinforcementEnabled()) {
      try {
        reinforcement = new MemoryReinforcementStore();
      } catch (err) {
        console.warn(
          "[agentic-memory] reinforcement store init failed（降级）:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    configureMemoryReinforcement(reinforcement);

    const lifecycle = new AgenticMemoryLifecycleService(memory, reinforcement);
    lifecycle.start();

    singleton = {
      memory,
      ingest: new AgenticMemoryIngestService(memory),
      retrieval: new AgenticMemoryRetrievalService(memory),
      lifecycle,
      compressor: new AgenticMemoryRecallCompressor(),
    };
    console.info("[agentic-memory] Mem0 OSS runtime ready (entity linking + multi-signal retrieval + lifecycle + compressor)");
    return singleton;
  } catch (e) {
    console.warn(
      "[agentic-memory] init failed:",
      e instanceof Error ? e.message : e,
    );
    singleton = null;
    return null;
  }
}

export { AgenticMemoryIngestService } from "./ingest.js";
export { AgenticMemoryRetrievalService } from "./retrieval.js";
export { AgenticMemoryLifecycleService } from "./memory-lifecycle.js";
export { AgenticMemoryRecallCompressor } from "./recall-compressor.js";
export {
  AgenticMemoryFtsStore,
  createMemoryFtsStoreIfEnabled,
} from "./fts-store.js";
export { LifeModelStore } from "./life-model-store.js";
export {
  getAgenticMemoryCollection,
  getAgenticMemoryDir,
  getAgenticMemoryTopK,
  isAgenticMemoryEnabled,
} from "./env.js";

// ============================================================
// 组件注册表：create-app-services 装配后登记四件套实例，
// 供 memory-clear-service（级联清理）/ prompt-context /
// health 快照等无装配上下文的消费方获取。测试环境默认全 null。
// ============================================================

export interface AgenticMemoryComponents {
  ledger: import("./ledger.js").AgenticLedger | null;
  provenance: import("./provenance.js").ProvenanceService | null;
  bridge: import("./memory-bridge-service.js").MemoryBridgeService | null;
  understandingStore: import("./user-understanding-store.js").UserUnderstandingStore | null;
  factStore: import("./structured-fact-store.js").StructuredFactStore | null;
  /** FTS 关键词第三路（混合检索 P0）；bridge 融合召回的 BM25 rank 来源 */
  fts: import("./fts-store.js").AgenticMemoryFtsStore | null;
  /** 用户生活模型（实体/关系/图式/信念）——第 ④ 层建模，purge 级联与 prompt 注入消费 */
  lifeModel: import("./life-model-store.js").LifeModelStore | null;
}

const components: AgenticMemoryComponents = {
  ledger: null,
  provenance: null,
  bridge: null,
  understandingStore: null,
  factStore: null,
  fts: null,
  lifeModel: null,
};

export function registerMemoryComponents(part: Partial<AgenticMemoryComponents>): void {
  Object.assign(components, part);
}

export function getMemoryComponents(): AgenticMemoryComponents {
  return components;
}
