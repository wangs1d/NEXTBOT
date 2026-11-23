import { resolveActorId } from "../agent/actor-id.js";
import type { WorldService } from "@nextbot/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { ToolRegistry } from "./tool-registry.js";

// 好友联络工具族（world.link.* / registerAgentLinkTools）已整体下线（2026-11-23）。
// 本文件只保留 world.status.*（Agent World 状态查询），与好友无关。

/**
 * world.status（2026-10-22）：Agent World 状态专属查询工具。
 *
 * 历史注记：世界状态原先只能经 agent.query_capabilities(domain=world/all) 间接
 * 拿到（且默认被注入 prompt 词表路由段）——域归属错位。世界的事归 world.* 自己
 * 说明；query_capabilities 回归"宿主侧能力清单"单一职责。
 */
export function registerWorldStatusTools(
  registry: ToolRegistry,
  worldService: WorldService,
  skillManager: SkillManager,
): void {
  registry.register("world.status", async (_input, context) => {
    const actorId = resolveActorId(context);
    const state = worldService.getOrCreateRoom(actorId, actorId);
    // 有效注册：世界挑战注册 或 宿主已注册账号（另一处登录不重走注册）
    const registered = worldService.isAgentWorldRegistered(actorId);
    const owned = new Set(state.ownedSkillIds);
    const communityListed = skillManager
      .list(false)
      .filter((m) => m.kind === "community")
      .map((m) => `${m.name}（${m.displayName}）`);

    const skillLines: string[] = [];
    for (const id of state.ownedSkillIds) {
      const m = skillManager.get(id);
      skillLines.push(m ? `- ${m.name}（${m.displayName}）` : `- ${id}（元数据未加载）`);
    }

    const lines: string[] = [
      `注册状态：${registered ? "已注册" : "未注册（须先 world.open_registry.* 注册，否则 free_market/social 等不可用）"}`,
      `世界点数：${state.agentWorldCredits}（独立货币，与用户真实钱包 wallet.* 无关）`,
      `已解锁技能：${state.ownedSkillIds.length ? state.ownedSkillIds.join("、") : "（无）"}`,
    ];
    if (skillLines.length) lines.push("已购技能说明：", ...skillLines);
    if (communityListed.length) lines.push(`上架社区技能：${communityListed.join("、")}`);
    if (!owned.size && !state.agentWorldCredits && registered) {
      lines.push("提示：注册后可在世界内挣点、购买技能。");
    }
    lines.push(
      "",
      "world.* 工具族：open_registry=世界注册；room=共享房间；free_market=技能商店/世界点数/A2A契约；social=发帖/评论/点赞。操作前用对应 get_snapshot；扣点/购技能/发帖/发契约前须用户同意。",
    );

    return {
      ok: true,
      registered,
      credits: state.agentWorldCredits,
      ownedSkillIds: [...state.ownedSkillIds],
      summary: lines.join("\n"),
    };
  });
}
