/**
 * 记忆回声守卫（防召回循环）。
 *
 * 问题：prompt 注入的记忆块会被模型复述进回复，随后 turn-lifecycle 的记忆提取
 * （AGENT_COMMITMENT_RE / 显式记住信号）把同一段内容当"新发现"再写回长期记忆——
 * 同一条记忆被反复再发现、再入库，记忆库静默膨胀（OpenClaw 2.0 用结构性标记
 * 解决同类问题：注入回上下文的内容永不再被提取为新记忆）。
 *
 * 方案：prompt-context-builder 每次装配记忆块时，把注入的记忆条目登记到本模块；
 * 对话衍生的记忆写入候选在落库前经 isMemoryEcho 比对——与最近注入条目词法重叠
 * 超阈值即判为回声，拒绝入库。用户显式改写偏好（语义不同）不受影响，由
 * supersession/overwrite 决策正常处理。
 */
import { contentTokenSet, tokenOverlapRatio } from "./memory-record-utils.js";
import { RetentionMap, retentionMaxEntries } from "./resource-pool.js";

const ECHO_OVERLAP_THRESHOLD = 0.75;
const ECHO_TTL_MS = 30 * 60_000;
const ECHO_MAX_ENTRIES_PER_ACTOR = 80;

type EchoEntry = {
  tokens: Set<string>;
  at: number;
};

/** 按 actor 登记并挂进资源池：空闲超过 ECHO_TTL_MS 由闸口心跳清扫，actor 数超上限按最近未用淘汰。 */
const entriesByActor = new RetentionMap<EchoEntry[]>("memory-echo-guard", {
  maxEntries: retentionMaxEntries(1000),
  idleMs: ECHO_TTL_MS,
});

function prune(entries: EchoEntry[], now: number): EchoEntry[] {
  const kept = entries.filter((e) => now - e.at < ECHO_TTL_MS);
  if (kept.length > ECHO_MAX_ENTRIES_PER_ACTOR) {
    kept.splice(0, kept.length - ECHO_MAX_ENTRIES_PER_ACTOR);
  }
  return kept;
}

/** 按行拆分登记一段注入的记忆块（多行块逐行登记，保证长块不稀释重叠比）。 */
export function markInjectedMemory(actorId: string, block: string | undefined): void {
  if (!actorId || !block?.trim()) return;
  const now = Date.now();
  let entries = entriesByActor.get(actorId);
  if (!entries) {
    entries = [];
    entriesByActor.set(actorId, entries);
  } else {
    const fresh = prune(entries, now);
    entries.length = 0;
    entries.push(...fresh);
  }
  for (const line of block.split(/\n+/)) {
    const t = line.trim();
    if (t.length < 4) continue;
    entries.push({ tokens: contentTokenSet(t), at: now });
  }
}

/**
 * 判定一段候选文本是否为最近注入记忆的回声。
 * 逐条比对词法重叠，任一条 ≥ 阈值即判回声；空指纹（纯标点等）不算。
 */
export function isMemoryEcho(actorId: string, text: string): boolean {
  if (!actorId || !text.trim()) return false;
  const entries = entriesByActor.get(actorId);
  if (!entries || entries.length === 0) return false;
  const now = Date.now();
  if (entries.some((e) => now - e.at >= ECHO_TTL_MS)) {
    const fresh = prune(entries, now);
    entries.length = 0;
    entries.push(...fresh);
  }
  const candidate = contentTokenSet(text);
  if (candidate.size === 0) return false;
  for (const entry of entries) {
    if (entry.tokens.size === 0) continue;
    if (tokenOverlapRatio(candidate, entry.tokens) >= ECHO_OVERLAP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** 测试与进程内重置用。 */
export function resetMemoryEchoGuard(): void {
  entriesByActor.clear();
}
