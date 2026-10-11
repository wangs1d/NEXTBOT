/**
 * 一次性收敛：档案字段单一权威源（手动 / 运维）。
 *
 * 把 USER_PROFILE.md 与 KV 槽位里的档案字段副本（称呼/职业/居住地…）收敛到
 * 结构化事实库的当前值，并归并行式事实库（data/user-facts/*.json）里的重复项。
 *
 * 用法（务必在 server/ 目录下运行，data 路径以 cwd 解析）：
 *   node --import tsx scripts/reconcile-profile-facts.ts                # 全部非临时 actor
 *   node --import tsx scripts/reconcile-profile-facts.ts <actorId> ...  # 指定 actor
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isEphemeralActorId } from "../src/agent/actor-id.js";
import { createStructuredFactStoreIfEnabled } from "../src/agentic-memory/structured-fact-store.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import {
  canonicalFieldMap,
  filterUserFactLikeEntries,
} from "../src/services/user-personalization/profile-fact-authority.js";
import { reconcileProfileFactsFromStores } from "../src/services/user-personalization/profile-fact-authority.js";
import { UserProfileStore } from "../src/services/user-personalization/user-profile-store.js";

function sanitize(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "anonymous";
}

/** 行式事实库（JSON）去重 + 剔除档案字段副本 */
async function cleanUserFactFile(
  actorId: string,
  fields: ReadonlySet<string>,
  knownValues: ReadonlyMap<string, readonly string[]>,
): Promise<number> {
  if (fields.size === 0) return 0;
  const path = join(process.cwd(), "data", "user-facts", `${sanitize(actorId)}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let parsed: { facts?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return 0;
  }
  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  const { kept, removed } = filterUserFactLikeEntries(
    facts as Array<{ kind?: string; subject?: string; value: string }>,
    fields,
    knownValues,
  );
  if (removed === 0) return 0;
  const next = JSON.stringify({ ...parsed, facts: kept }, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path);
  return removed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const memorySync = new AgentMemorySyncService();
  await memorySync.load();
  const factStore = createStructuredFactStoreIfEnabled();
  if (!factStore) {
    console.error("[reconcile] 结构化事实库未启用（AGENT_STRUCTURED_FACTS_ENABLED=0），无可收敛的权威源");
    process.exit(1);
  }
  const store = new UserProfileStore();

  const actors =
    args.length > 0
      ? args
      : memorySync.listSessionIds().filter((a) => a && !isEphemeralActorId(a));

  if (actors.length === 0) {
    console.log("[reconcile] 没有需要收敛的 actor");
    return;
  }

  let touched = 0;
  for (const actorId of actors) {
    const facts = factStore.getActiveFacts(actorId);
    const fields = new Set(canonicalFieldMap(facts).keys());
    if (facts.length === 0) {
      console.log(`- ${actorId}: 权威库无档案字段，跳过`);
      continue;
    }
    const report = await reconcileProfileFactsFromStores(actorId, {
      profileStore: store,
      factStore,
      memorySync,
    });
    const knownValues = new Map<string, readonly string[]>(
      [...fields].map((f) => [f, factStore.getAllValuesForField(actorId, f)]),
    );
    const walletRemoved = await cleanUserFactFile(actorId, fields, knownValues);
    if (report.profileChanged || report.profileKvSynced || report.kvRemoved > 0 || walletRemoved > 0) {
      touched += 1;
    }
    console.log(
      `- ${actorId}: 权威字段=${JSON.stringify(report.fields)} ` +
        `画像${report.profileChanged ? "已投影" : "不变"} ` +
        `KV画像副本${report.profileKvSynced ? "已同步" : "不变"} ` +
        `KV 清副本=${report.kvRemoved} 行式库清=${walletRemoved} 条`,
    );
  }

  await memorySync.flush();
  console.log(`[reconcile] 完成：${touched}/${actors.length} 个 actor 有变更`);
}

void main().catch((err) => {
  console.error("[reconcile] 失败:", err);
  process.exit(1);
});
