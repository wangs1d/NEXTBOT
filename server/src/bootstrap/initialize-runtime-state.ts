import { reconcileWorldA2aEscrows, restorePurchasedSkillsFromWorldState } from "@nextbot/agent-world";
import type { AppServices } from "./types.js";
import { seedIdentityMarkdown } from "../agent/identity-markdown-seeder.js";
import { isAgentWorldSocialEnabled } from "../config/env.js";

export async function initializeRuntimeState(services: AppServices): Promise<void> {
  // 无相互依赖的持久化加载并行执行（文件读 + JSON.parse 均为异步 IO，
  // 串行等待会把各文件加载时间累加；并行后总耗时 ≈ 最慢的一个）。
  // 注：部分服务在 createAppServices 中已 load 过一次，此处保留重复调用作为
  // 二次校验（文件损坏时抛错阻止启动，避免后续 persist 覆盖损坏文件造成数据丢失）。
  await Promise.all([
    services.agentMemorySyncService.load(),
    services.agentPairingService.load(),
    services.aipService.load(),
    services.agentAccountService.load(),
    services.emailRegistrationService.load(),
    services.infoHubService.load(),
    services.scheduleTaskService.load(),
    services.weatherPrefsService.load(),
    services.virtualPhoneService.load(),
  ]);
  services.scheduleTaskService.startScheduler();

  // 身份/记忆 Markdown 文档种子：为所有已存在 actor 幂等写入 KV。
  // SOUL/USER/MEMORY.md 只在对应 KV 键为空时写入，跨重启不覆盖运行时学习到的
  // 人格内核 / 用户画像 / 长期事实；新建 actor 在 agent-core 每轮开头懒种子。
  try {
    for (const actorId of services.agentMemorySyncService.listSessionIds()) {
      try {
        await seedIdentityMarkdown(services.agentMemorySyncService, actorId);
      } catch (e) {
        console.error(`[initialize-runtime-state] 身份/记忆种子失败(${actorId}):`, e);
      }
    }
  } catch (e) {
    console.error("[initialize-runtime-state] 身份/记忆种子遍历失败:", e);
  }

  // 重启后自动恢复未完成的自主任务（状态机任务：pending/planning/executing/verifying，
  // 跳过 paused 与 awaiting_approval），从持久化断点继续执行
  try {
    const restored = await services.runtime.resumeAutonomousTasks();
    if (restored > 0) {
      console.log(`[initialize-runtime-state] 已自动恢复 ${restored} 个未完成的自主任务`);
    }
  } catch (e) {
    console.error("[initialize-runtime-state] 自动恢复自主任务失败:", e);
  }

  // World 链路存在顺序依赖（load → 恢复技能 → 对账 → 落盘），保持串行。
  // Agent World 社交经济域开关（AGENT_WORLD_SOCIAL_ENABLED，实验性子系统默认关闭）：
  // 关闭时跳过技能商店购买恢复与 A2A escrow 对账（社交经济域不参与启动恢复），
  // 开启后行为与现状一致。
  const worldSocialEnabled = isAgentWorldSocialEnabled();
  await services.worldService.load();
  await services.socialFeedService.load();
  if (worldSocialEnabled) {
    await restorePurchasedSkillsFromWorldState(
      services.worldService,
      services.skillManager,
      services.auditService,
    );
  }
  services.skillManager.loadEnabledFromDisk();
  // 跨重启恢复"越用越强"的技能：procedural（经验文档）+ 自我进化 code（handlerCode）
  services.skillManager.loadProceduralSkillsFromDisk();
  services.skillManager.loadEvolvedSkillsFromDisk();
  await services.a2aOutsourcingService.load();
  if (worldSocialEnabled) {
    await reconcileWorldA2aEscrows(
      services.worldService,
      services.a2aOutsourcingService,
      services.auditService,
    );
  }
  await services.worldService.flushPersist();
  await services.socialFeedService.flushPersist();
}
