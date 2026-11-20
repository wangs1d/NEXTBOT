/**
 * 记忆权威源注册表（Memory Authority Registry）
 *
 * 规则（2026-11-12 收敛，2026-11-13 重切）：
 *   1. 每个**物理存储**只有一个 owner（唯一直接写它的模块）；其余位置只能是
 *      「只读投影」或「索引」。
 *   2. 写入必须经 owner；owner 之外任何模块写同一存储都视为 bug。
 *   3. 读取侧只从 authority 拉取，不从投影/索引反查（避免拿到过期副本）。
 *
 * 为什么需要它：此前同一份用户画像最多存在 7 处、memory_summary 有两个写者，
 * 改动一处必然漏其它几处。注册表把「谁写谁」从口头约定变成可断言、可测试的契约。
 *
 * ── 2026-11-13 重切：从「13 个语义概念」改成「6 域 / 10 个存储槽」 ──
 *
 * 上一版按语义命名了 13 个概念（profile.field / memory.summary / memory.event…）。
 * 问题不是数量本身，而是：
 *   - **概念名是发明出来的**：EventStore、ProvenanceStore、CommitmentService、
 *     ProfileBatchHook 这几个名字在代码里并不存在（真实名字是 EventMemoryStore、
 *     ProvenanceService、commitment-store 的模块函数、以及一个没有独立文件
 *     的夜间批钩子）——登记的是幻觉，审计也查不出来。
 *   - **粒度与断言单位不一致**：断言发生在具体存储上（谁写了
 *     structured_facts），契约却按语义分组，一个概念跨多个存储时，
 *     「允许谁写」就说不清了。
 *
 * 现在的口径：**槽位（slot）= 一个物理存储 = 一行契约**。每个生产者同时登记
 * 两个身份：
 *   - id：运行时标识（写入口传给 assertMemoryWriter 的名字，回答「谁决定写」）；
 *   - file：真正落库的文件（回答「谁动了物理存储」，供静态审计逐文件核对）。
 * 语义分组退化为 domain 标签，只是给人看的，不再参与断言。
 *
 * 只登记「**存在竞争写点**」的存储：单写者、无历史多副本的存储（如声明账本
 * ledger_records、会话原文 chat-threads.json）不可能违反「唯一 owner」契约，
 * 登记进去只增加维护面。
 */

export type MemoryDomain =
  | "profile" // 画像域：档案字段 + 画像正文
  | "narrative" // 叙事域：发生过什么
  | "model" // 模型域：对用户的理解与人物关系
  | "ledger" // 账本域：事件与待办
  | "longterm" // 长期域：非结构化长期记忆
  | "identity"; // 身份域：Agent 自我身份

export type MemorySlotId =
  | "structured_facts"
  | "user_profile"
  | "memory_summary"
  | "user_understanding"
  | "life_models"
  | "memory_events"
  | "commitments"
  | "mem0"
  | "cognition_graph"
  | "agent_name";

/** 生产者：运行时标识 + 真正落库的文件（相对 src 的 posix 路径）。 */
export type MemoryProducer = {
  /** 运行时标识：写入口传给 assertMemoryWriter 的名字（谁决定写什么） */
  id: string;
  /** 真正落库的文件（相对 src）。静态审计按这个集合核对写点。 */
  file: string;
};

export type MemorySlotSpec = {
  /** 语义域（仅分组展示，不参与断言） */
  domain: MemoryDomain;
  /** 物理位置（唯一权威） */
  authority: string;
  /** 唯一允许直接写物理存储的文件 */
  owner: string;
  /** 允许经 owner 写入该槽位的生产者 */
  producers: readonly MemoryProducer[];
  /** 允许的只读消费方 */
  readers: readonly string[];
  /** 明确禁止写入的位置（历史冗余，已删除或降级） */
  forbiddenWrites?: readonly string[];
  /**
   * 已知例外：契约与现实不符、但暂时保留的位置。
   * 显式登记而不是隐形——「知道有例外」和「不知道有例外」差别很大。
   */
  knownViolations?: readonly string[];
};

export const MEMORY_AUTHORITY: Record<MemorySlotId, MemorySlotSpec> = {
  // ───────────────────────── 画像域 ─────────────────────────
  structured_facts: {
    domain: "profile",
    authority: "sqlite:agentic-memory.db#structured_facts",
    owner: "agentic-memory/structured-fact-store.ts",
    producers: [
      { id: "StructuredFactStore", file: "agentic-memory/structured-fact-store.ts" },
      // 统一抽取写钩子（对话内实时）：判断与落库都在装配层。
      { id: "UnifiedExtractionHook", file: "bootstrap/create-app-services.ts" },
      // 夜间画像批抽取：决策在 profile-write-scheduler，落库同样走统一钩子。
      { id: "ProfileBatchHook", file: "bootstrap/create-app-services.ts" },
      { id: "UserProfileAggregator", file: "brain/user-profile-aggregator.ts" },
      { id: "ProfileManageRoute", file: "routes/http/profile-manage.ts" },
      { id: "OnboardingIntroService", file: "services/onboarding-intro-service.ts" },
      // 夜间巩固抽到档案字段时也落这里（2026-11-13 词表统一）：
      // 此前夜间把同样的事实另存一份到行式 JSON 库，两边字段名还不一样。
      { id: "NightlyMemoryTaskService", file: "services/nightly-memory-task-service.ts" },
    ],
    readers: ["PromptContextBuilder", "ProfileFactAuthority", "NightlyMemoryTaskService"],
    forbiddenWrites: [
      "kv:agent-memory-sync.json#memory_facts",
      "kv:agent-memory-sync.json#memory_preferences",
      "json:user-facts/*.json",
    ],
    // 2026-11-13：knownViolations 清空。夜间巩固已改走权威库（词表统一），
    // 行式 JSON 库里的档案字段副本在 UserFactStore.load 时自动清扫退场，
    // 契约与现实不再有已知出入。
  },
  user_profile: {
    domain: "profile",
    authority: "file:user_profiles/<actor>/USER_PROFILE.md",
    owner: "services/user-personalization/user-profile-store.ts",
    producers: [
      { id: "UserProfileStore", file: "services/user-personalization/user-profile-store.ts" },
      { id: "UserProfileAggregator", file: "brain/user-profile-aggregator.ts" },
      { id: "ProfileFactAuthority", file: "services/user-personalization/profile-fact-authority.ts" },
    ],
    readers: ["PromptContextBuilder", "UserPersonalizationService"],
    // KV 全文副本已删除：画像以文件为唯一权威，读取时实时投影。
    forbiddenWrites: ["kv:agent-memory-sync.json#user_profile"],
  },

  // ───────────────────────── 叙事域 ─────────────────────────
  memory_summary: {
    domain: "narrative",
    authority: "kv:agent-memory-sync.json#memory_summary",
    owner: "services/agent-memory-sync-service.ts",
    // 摘要槽已退役：白天只追加 L0，当前状态由 ContextCompiler 从权威库编译。
    // 保留 owner 作为历史数据清理的唯一入口（healPollutedMemoryLines）。
    producers: [
      { id: "AgentMemorySyncService", file: "services/agent-memory-sync-service.ts" },
    ],
    readers: ["MemoryInventory"],
    forbiddenWrites: [
      "file:long-term-memory/*.json",
      "kv:agent-memory-sync.json#memory_preferences",
      "kv:agent-memory-sync.json#memory_facts",
    ],
  },

  // ───────────────────────── 模型域 ─────────────────────────
  user_understanding: {
    domain: "model",
    authority: "sqlite:agentic-memory.db#user_understanding",
    owner: "agentic-memory/user-understanding-store.ts",
    producers: [
      { id: "UserUnderstandingStore", file: "agentic-memory/user-understanding-store.ts" },
      { id: "UnifiedExtractionHook", file: "bootstrap/create-app-services.ts" },
      { id: "ProfileBatchHook", file: "bootstrap/create-app-services.ts" },
    ],
    readers: ["PromptContextBuilder", "RecallGate"],
  },
  life_models: {
    domain: "model",
    authority: "sqlite:agentic-memory.db#life_*",
    owner: "agentic-memory/life-model-store.ts",
    producers: [
      { id: "LifeModelStore", file: "agentic-memory/life-model-store.ts" },
      // 事实写时顺带物化实体（同一 LLM 产物，零新增调用）
      { id: "StructuredFactStore", file: "agentic-memory/structured-fact-store.ts" },
      { id: "AppServices", file: "bootstrap/create-app-services.ts" },
      { id: "LifeManageTools", file: "tools/life-manage-tools.ts" },
      { id: "ExperienceLearningLoop", file: "brain/memory-cognitive/memory-experience-learning-loop.ts" },
    ],
    readers: ["PromptContextBuilder", "MemoryCortex"],
  },

  // ───────────────────────── 账本域 ─────────────────────────
  memory_events: {
    domain: "ledger",
    authority: "sqlite:agentic-memory.db#memory_events",
    owner: "agentic-memory/event-store.ts",
    producers: [
      { id: "EventMemoryStore", file: "agentic-memory/event-store.ts" },
      // 轮次收尾写事件 / 出口定稿回写摘要
      { id: "TurnLifecycle", file: "agent/turn-lifecycle.ts" },
      { id: "ChatUserMessage", file: "ws/handlers/chat-user-message.ts" },
    ],
    readers: ["NarrativeHybridRetrievalService", "PromptContextBuilder"],
  },
  commitments: {
    domain: "ledger",
    authority: "sqlite:agentic-memory.db#commitments",
    owner: "services/commitment-store.ts",
    producers: [
      { id: "CommitmentStore", file: "services/commitment-store.ts" },
      { id: "AppServices", file: "bootstrap/create-app-services.ts" },
    ],
    readers: ["PromptContextBuilder", "ProactivityGoalBoard"],
    forbiddenWrites: [
      "kv:agent-memory-sync.json#memory_open_loops",
      "kv:agent-memory-sync.json#memory_commitments",
    ],
  },

  // ───────────────────────── 长期域 ─────────────────────────
  mem0: {
    domain: "longterm",
    authority: "mem0:default",
    owner: "agentic-memory/ingest.ts",
    producers: [
      { id: "AgenticMemoryIngestService", file: "agentic-memory/ingest.ts" },
      // 统一写入者 → 认知图 + Mem0 一次完成
      { id: "MemoryBridgeService", file: "agentic-memory/memory-bridge-service.ts" },
      // 叙事门面的直写入口（无 bridge 时的降级路径）
      { id: "NarrativeMemoryFacade", file: "services/narrative-memory-port.ts" },
      // 生命周期遗忘 / 溯源失效的删除
      { id: "MemoryLifecycleService", file: "agentic-memory/memory-lifecycle.ts" },
      { id: "ProvenanceService", file: "agentic-memory/provenance.ts" },
    ],
    readers: ["MemoryCortex", "MemoryBridgeService", "MemoryLifecycleService"],
    forbiddenWrites: ["json:user-facts/*.json"],
  },
  cognition_graph: {
    domain: "longterm",
    authority: "sqlite:human-memory.sqlite#hm_*",
    owner: "services/human-like-memory-service.ts",
    producers: [
      { id: "HumanLikeMemoryService", file: "services/human-like-memory-service.ts" },
      // 桥接：统一抽取产物落认知图
      { id: "MemoryBridgeService", file: "agentic-memory/memory-bridge-service.ts" },
      // 叙事门面的直写入口（无 bridge 时的降级路径）
      { id: "NarrativeMemoryFacade", file: "services/narrative-memory-port.ts" },
      // 联想记忆回灌：以「联想推测」身份写回认知图
      { id: "MemoryCortex", file: "brain/memory-cortex.ts" },
    ],
    readers: ["MemoryCortex", "PromptContextBuilder"],
  },

  // ───────────────────────── 身份域 ─────────────────────────
  agent_name: {
    domain: "identity",
    authority: "kv:agent-memory-sync.json#agent.name",
    owner: "services/agent-memory-sync-service.ts",
    producers: [
      { id: "AgentMemorySyncService", file: "services/agent-memory-sync-service.ts" },
      { id: "AgentIdentityTools", file: "tools/agent-identity-tools.ts" },
    ],
    readers: ["PromptContextBuilder", "AgentIdentityTools"],
  },
};

function forbiddenMatches(forbidden: readonly string[] | undefined, target: string): boolean {
  if (!forbidden) return false;
  return forbidden.some((entry) => {
    if (entry === target) return true;
    if (!entry.includes("*")) return false;
    const pattern = entry
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/\\\\]*");
    return new RegExp(`^${pattern}$`).test(target);
  });
}

/**
 * 断言某模块有权写入某存储槽位。越权一律抛错（2026-11-13 起恒为严格模式，
 * 原 MEMORY_AUTHORITY_STRICT 灰度开关已删除——契约经过非 strict 观察期验证，
 * 不再提供「warn 后继续」的越权通道）。
 *
 * @param slot 存储槽位
 * @param writer **调用方**模块名（谁决定写什么）。必须是该槽位的合法 producer。
 * @param target 物理位置（可选）：给出时额外校验它是否在禁止清单里（支持 `*` 通配）。
 */
export function assertMemoryWriter(
  slot: MemorySlotId,
  writer: string,
  target?: string,
): void {
  const spec = MEMORY_AUTHORITY[slot];
  if (!spec) return;
  const forbidden = target ? forbiddenMatches(spec.forbiddenWrites, target) : false;
  const unauthorized = !spec.producers.some((p) => p.id === writer);
  if (!forbidden && !unauthorized) return;

  throw new Error(
    `[memory-authority] ${writer} 越权写入 ${slot}` +
      (target ? ` → ${target}` : "") +
      `（权威源 ${spec.authority}，owner=${spec.owner}，合法生产者=${spec.producers
        .map((p) => p.id)
        .join("/")}）`,
  );
}

/** 诊断用：人类可读的权威矩阵。 */
export function describeMemoryAuthority(): string {
  return Object.entries(MEMORY_AUTHORITY)
    .map(
      ([slot, s]) =>
        `${slot}（${s.domain}）\n  权威: ${s.authority}\n  写者: ${s.owner}\n  生产者: ${s.producers
          .map((p) => `${p.id}@${p.file}`)
          .join(", ")}\n  读方: ${s.readers.join(", ")}` +
        (s.knownViolations?.length ? `\n  已知例外: ${s.knownViolations.join(", ")}` : ""),
    )
    .join("\n");
}
