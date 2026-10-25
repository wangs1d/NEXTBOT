import type { ExternalChatProvider } from "../external-model/types.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getHumanLikeMemoryService } from "./human-like-memory-service.js";
import { getAgenticMemoryRuntime, getMemoryComponents } from "../agentic-memory/index.js";
import { actorIdVariants } from "../agentic-memory/actor-key.js";
import { getMemoryReinforcementStore } from "../agentic-memory/memory-reinforcement.js";
import { getDailyDigestService } from "./daily-digest-service.js";
import { getShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { getConversationTimelineService } from "./conversation-timeline.js";
import { getGlobalMemoryInventory } from "../brain/memory-inventory.js";
import { clearActorTranscript } from "./wal-transcript.js";

export type ClearAllMemoryResult = {
  chat: boolean;
  primarySessionId: string;
  humanMemoryNodes: number;
  structuredMemory: boolean;
  agenticMemory: number;
  dailyDigest: number;
  shortTermSessions: number;
};

/**
 * 清空某 actor 的全部聊天记录与 Agent 记忆（所有记忆来源，含内存态）。
 * HTTP 路由与 WS chat.clear_history 共用，保证两条清理路径行为一致。
 */
export async function clearAllMemoryForActor(
  actorId: string,
  deps: { externalChat?: ExternalChatProvider | null; agentMemorySyncService: AgentMemorySyncService },
): Promise<ClearAllMemoryResult> {
  const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
  const primarySessionId = resolvePrimaryChatSessionId(actorId, masterOn);

  // 1. 清空 Agent 主会话聊天线程（内存 + 持久层）
  let chatCleared = false;
  if (deps.externalChat?.clearSession) {
    for (const variant of actorIdVariants(actorId)) {
      deps.externalChat.clearSession(resolvePrimaryChatSessionId(variant, masterOn));
      deps.externalChat.clearSession(`notes:${variant}`);
    }
    chatCleared = true;
  }

  // 1b. 聊天记录可见性：turn WAL 是聊天记录的权威源（append-only），清空通过
  // 记 per-actor cleared-at 读取过滤实现——任何设备拉转史（?full=1）都不会
  // 复活已清轮次（2026-10-16，桌面端跨端回填接入的前置）。
  try {
    await clearActorTranscript(actorId);
  } catch (e) {
    console.warn(
      "[memory-clear] clear transcript failed:",
      e instanceof Error ? e.message : e,
    );
  }

  // 2. 记忆图谱（HumanLikeMemoryService）
  const humanMemory = getHumanLikeMemoryService();
  const nodesCleared = humanMemory
    ? actorIdVariants(actorId).reduce((sum, v) => sum + humanMemory.clearActorMemory(v), 0)
    : 0;

  // 3. 结构化记忆（agent-memory-sync）——任一形式清成功即视为已清
  const syncCleared = actorIdVariants(actorId).reduce(
    (cleared, v) => deps.agentMemorySyncService.clearActor(v) || cleared,
    false,
  );

  // 4. Mem0 agentic 记忆（尽力而为）：mem0ai v3 的 getAll 强制要求 filters 带
  //    user_id（此前 {topK} 裸调必抛，清空对 mem0 完全失效）；按 actorIdVariants
  //    逐形式扫（userId 写入键历史上两种形式并存）再按 metadata.actorId 过滤删。
  let mem0Cleared = 0;
  const mem0 = getAgenticMemoryRuntime();
  if (mem0?.memory) {
    try {
      type Mem0Record = { id: string; metadata?: { actorId?: string } };
      for (const variant of actorIdVariants(actorId)) {
        const allResult = (await mem0.memory.getAll({
          topK: 10000,
          filters: { user_id: variant },
        })) as { results?: Mem0Record[] };
        const toDelete = (allResult.results ?? []).filter(
          (m) => (m.metadata?.actorId ?? actorId) === actorId,
        );
        for (const m of toDelete) {
          await mem0.memory.delete(m.id).catch(() => {});
        }
        mem0Cleared += toDelete.length;
      }
    } catch (e) {
      console.warn("[memory-clear] clear mem0 failed:", e instanceof Error ? e.message : e);
    }
  }

  // 5. 当日摘要（daily-digest，每轮会被 getRelevantPromptDigest 注入）
  const digestCleared = actorIdVariants(actorId).reduce(
    (sum, v) => sum + getDailyDigestService().clearActorDigests(v),
    0,
  );

  // 6. 短期任务栈 + 情景记忆（STM）
  const stmCleared = actorIdVariants(actorId).reduce((sum, v) => {
    const sessionId = resolvePrimaryChatSessionId(v, masterOn);
    return sum + (getShortTermMemoryGatewayService()?.clearSessions([sessionId, `notes:${v}`]) ?? 0);
  }, 0);

  // 7. 对话时间线内存态（首次对话/累计轮次）
  for (const variant of actorIdVariants(actorId)) {
    getConversationTimelineService()?.clearActor(variant);
  }

  // 8. 失效记忆目录缓存（MemoryInventory 60s TTL，避免旧缓存残留）
  const inventory = getGlobalMemoryInventory();
  if (inventory?.invalidate) {
    for (const variant of actorIdVariants(actorId)) {
      inventory.invalidate(variant);
    }
  }

  // 9. agentic-memory 级联清理（P0-2 隐私闭环）：语义账本 / 承诺草稿板 /
  //    溯源依赖图 / bridge_links / 用户理解档案 / 结构化事实库 / FTS 词面索引
  //    ——此前清空 actor 后这些表的数据会残留。
  //    按 actorIdVariants 逐形式 purge：ledger/provenance/bridge 等历史行两种
  //    形式并存（journal 目录名下划线形写穿），单形式 purge 会漏（2026-10-04）。
  const components = getMemoryComponents();
  let ledgerCleared = 0;
  let provenanceCleared = 0;
  let bridgeLinksCleared = 0;
  let understandingCleared = 0;
  let factsCleared = 0;
  let ftsCleared = 0;
  let reinforcementCleared = 0;
  let lifeModelCleared = 0;
  for (const variant of actorIdVariants(actorId)) {
    ledgerCleared += components.ledger?.purgeActor(variant) ?? 0;
    provenanceCleared += components.provenance?.purgeActor(variant) ?? 0;
    bridgeLinksCleared += components.bridge?.purgeActor(variant) ?? 0;
    understandingCleared += components.understandingStore?.purgeActor(variant) ?? 0;
    factsCleared += components.factStore?.purgeActor(variant) ?? 0;
    ftsCleared += components.fts?.purgeActor(variant) ?? 0;
    // 生活模型（实体/关系/轨迹/图式/信念/经历）：级联清空，隐私闭环覆盖新表
    lifeModelCleared += components.lifeModel?.purgeActor(variant) ?? 0;
    // 召回强化/归档侧表行（含两阶段遗忘的 archived 行）：Mem0 记录上面第 4 步已删，
    // 侧表行不回收会变成孤儿且归档量统计失真。
    reinforcementCleared += getMemoryReinforcementStore()?.purgeActor(variant) ?? 0;
  }
  if (ledgerCleared + provenanceCleared + bridgeLinksCleared + understandingCleared + factsCleared + ftsCleared + reinforcementCleared + lifeModelCleared > 0) {
    console.info(
      `[memory-clear] agentic-memory 级联清理：ledger=${ledgerCleared} ` +
        `provenance=${provenanceCleared} bridgeLinks=${bridgeLinksCleared} understanding=${understandingCleared} facts=${factsCleared} fts=${ftsCleared} reinforcement=${reinforcementCleared} lifeModel=${lifeModelCleared}`,
    );
  }

  // 10. 用户画像文件级联删除（2026-09-29 隐私闭环补口）：USER_PROFILE.md +
  //     pending-turns.json 此前清记忆时不删，画像里的个人信息会残留。
  let userProfileCleared = false;
  try {
    const { UserProfileStore } = await import("./user-personalization/user-profile-store.js");
    userProfileCleared = await new UserProfileStore().deleteAll(actorId);
  } catch (e) {
    console.warn("[memory-clear] 画像文件清理失败:", e instanceof Error ? e.message : e);
  }
  if (userProfileCleared) {
    console.info(`[memory-clear] 已删除用户画像文件目录: ${actorId}`);
  }

  return {
    chat: chatCleared,
    primarySessionId,
    humanMemoryNodes: nodesCleared,
    structuredMemory: syncCleared,
    agenticMemory: mem0Cleared,
    dailyDigest: digestCleared,
    shortTermSessions: stmCleared,
  };
}