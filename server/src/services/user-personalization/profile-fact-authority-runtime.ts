/**
 * 档案字段权威源的运行期装配（Runtime）
 *
 * 把「结构事实库（权威源）+ USER_PROFILE.md + KV 槽位」三者的收敛入口收在一处，
 * 供 bootstrap 写钩子 / 启动期批量收敛 / 夜间任务 / 手动脚本复用，避免各处
 * 自行拼装依赖导致判定口径再次分叉。
 */

import { getMemoryComponents } from "../../agentic-memory/index.js";
import {
  reconcileProfileFactsFromStores,
  type ProfileAuthorityReport,
} from "./profile-fact-authority.js";
import { UserProfileStore } from "./user-profile-store.js";

/** AgentMemorySyncService 的最小结构接口 */
export interface MemorySyncLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> };
  setEntry(actorId: string, key: string, value: unknown): void;
}

/**
 * 收敛单个 actor：画像档案字段行投影为权威值 + 清 KV 槽位里的档案字段副本。
 * 幂等；权威库为空时零写入。
 */
export async function reconcileProfileFactsRuntime(
  actorId: string,
  memorySync: MemorySyncLike | null,
): Promise<ProfileAuthorityReport> {
  return reconcileProfileFactsFromStores(actorId, {
    profileStore: new UserProfileStore(),
    factStore: getMemoryComponents().factStore,
    memorySync,
  });
}

/** 批量收敛（启动期 / 手动脚本）：逐个 actor，单个失败不影响其余。 */
export async function reconcileProfileFactsForActors(
  actorIds: Iterable<string>,
  memorySync: MemorySyncLike | null,
): Promise<{ scanned: number; changed: number; reports: ProfileAuthorityReport[] }> {
  const reports: ProfileAuthorityReport[] = [];
  let scanned = 0;
  let changed = 0;
  for (const actorId of actorIds) {
    scanned += 1;
    try {
      const report = await reconcileProfileFactsRuntime(actorId, memorySync);
      reports.push(report);
      if (report.profileChanged || report.profileKvSynced || report.kvRemoved > 0) changed += 1;
    } catch {
      /* 单 actor 失败跳过 */
    }
  }
  return { scanned, changed, reports };
}
