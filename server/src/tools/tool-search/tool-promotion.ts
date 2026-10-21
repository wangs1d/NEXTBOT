/**
 * 高频工具晋升（2026-10-09 五层根修 L4，chat / task 车道共用）。
 *
 * 机理：模型真实成功调用过 N 次（默认 3）的延迟工具，说明该 actor 的工作流
 * 真用得上它——晋升为该 actor 的常驻可见工具，不再依赖每轮的域预载/top-K
 * 兜底/两波 discover 召回。这是「调用即发现」（L3 转正）的下游闭环：转正
 * 执行成功 → 记晋升计数 → 凑满阈值常驻。
 *
 * 为什么不用 sharedHistoryStore：那是检索排序的反馈信号（RRS 加权/衰减），
 * 语义是「分数」；晋升需要的是「近窗真实成功次数 ≥ 阈值」的确定性计数，
 * 两者混用会让晋升被检索调参牵连。按 actor 隔离。
 *
 * 持久化（2026-10-10 冷启动修复）：计数落盘 data/tool-promotion-state.json
 * （AGENT_TOOL_PROMOTION_STATE_PATH 可覆盖）——此前纯进程内计数，重启归零，
 * 高频用户每次重启都要重新 discover 一轮才凑满晋升阈值（冷启动退化）。写侧
 * 防抖（10s dirty 合并）+ 进程退出 flush；测试 reset 不触发落盘，零测试污染。
 *
 * 观测对齐：入口在 ToolContextFactory.execute（全车道工具执行唯一咽喉），
 * 写操作与失败调用不计数；桥工具/元工具/obs_recall 永不晋升。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 晋升阈值：近窗成功调用次数（lane-tool-sets 注释里的 PROMOTE_THRESHOLD=3 落地） */
export const TOOL_PROMOTE_THRESHOLD = 3;
/** 滑动窗口：近 48h 的成功调用才计数 */
const TOOL_PROMOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** 每 actor 晋升上限（防常驻集膨胀；超过后按最近使用时间 LRU 淘汰） */
const TOOL_PROMOTE_CAP = 6;
/** 记录桶内最大保留条目（防无限增长） */
const PER_ACTOR_MAX_TOOLS = 64;

/** 元工具/桥/上下文管线支撑工具：永不晋升（它们本身是召回通道，不是业务能力） */
const NON_PROMOTABLE_NAMES: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "obs_recall",
  "agent.query_capabilities",
  "task.dispatch",
  "task.status",
  "task.cancel",
]);

type ActorPromotionState = Map<string, number[]>; // toolName → 成功调用时间戳数组

const promotionState = new Map<string, ActorPromotionState>();
const ACTOR_STATE_MAX = 512;

// ── 持久化（2026-10-10 冷启动修复） ──

const STATE_PATH_ENV = "AGENT_TOOL_PROMOTION_STATE_PATH";
const SAVE_DEBOUNCE_MS = 10_000;

/** off/0/false = 关闭持久化（单测/基准进程防把假 actor 计数写进生产状态文件）。 */
function isPersistenceDisabled(): boolean {
  const override = process.env[STATE_PATH_ENV]?.trim().toLowerCase();
  return override === "off" || override === "0" || override === "false";
}

function resolveStatePath(): string {
  const override = process.env[STATE_PATH_ENV]?.trim();
  return override ? resolve(override) : resolve(process.cwd(), "data", "tool-promotion-state.json");
}

let loadAttempted = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/** 首次访问时从磁盘恢复（迟到 actor 也能凑满阈值跨重启累计）。失败静默重计。 */
function loadFromDiskOnce(): void {
  if (loadAttempted || isPersistenceDisabled()) return;
  loadAttempted = true;
  try {
    const path = resolveStatePath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [actorId, tools] of Object.entries(parsed)) {
      if (!tools || typeof tools !== "object") continue;
      const state: ActorPromotionState = new Map();
      for (const [name, timestamps] of Object.entries(tools as Record<string, unknown>)) {
        if (Array.isArray(timestamps)) {
          state.set(
            name,
            timestamps.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts)),
          );
        }
      }
      if (state.size > 0) promotionState.set(actorId, state);
    }
  } catch (error) {
    console.warn("[tool-promotion] 晋升状态加载失败（忽略，重新累计）:", error);
  }
}

/** 原子写：tmp + rename，半截文件不会覆盖旧状态。 */
function flushToDisk(): void {
  if (isPersistenceDisabled()) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  try {
    const path = resolveStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: Record<string, Record<string, number[]>> = {};
    for (const [actorId, state] of promotionState) {
      const tools: Record<string, number[]> = {};
      for (const [name, timestamps] of state) tools[name] = timestamps;
      payload[actorId] = tools;
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    console.warn("[tool-promotion] 晋升状态落盘失败（忽略）:", error);
  }
}

/** 防抖合并写：10s 窗口内的连续计数只落一次盘；unref 不阻碍进程退出。 */
function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) flushToDisk();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

if (typeof process?.on === "function") {
  process.on("exit", () => {
    if (dirty) flushToDisk();
  });
}

function pruneTimestamps(timestamps: number[], now: number): number[] {
  const minTs = now - TOOL_PROMOTE_WINDOW_MS;
  return timestamps.filter((ts) => ts >= minTs);
}

/** 记一次真实工具执行（仅成功调用计数；失败不计）。 */
export function recordToolUsageForPromotion(actorId: string, toolName: string, ok: boolean): void {
  if (!ok || !actorId || !toolName || NON_PROMOTABLE_NAMES.has(toolName)) return;
  loadFromDiskOnce();
  const now = Date.now();
  let state = promotionState.get(actorId);
  if (!state) {
    if (promotionState.size >= ACTOR_STATE_MAX) {
      // LRU 近似：清最旧一半（观测数据，不值得精确 LRU 的复杂度）
      const keys = [...promotionState.keys()].slice(0, Math.floor(ACTOR_STATE_MAX / 2));
      for (const k of keys) promotionState.delete(k);
    }
    state = new Map();
    promotionState.set(actorId, state);
  }
  const timestamps = pruneTimestamps(state.get(toolName) ?? [], now);
  timestamps.push(now);
  if (state.size > PER_ACTOR_MAX_TOOLS) {
    // 按最近使用时间淘汰最旧的 1/4
    const entries = [...state.entries()].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]));
    for (const [name] of entries.slice(PER_ACTOR_MAX_TOOLS)) state.delete(name);
  }
  state.set(toolName, timestamps);
  scheduleSave();
}

/** 该 actor 的晋升工具名（近窗成功 ≥ 阈值；超过 cap 按最近使用取前 cap）。确定性输出。 */
export function getPromotedToolNames(actorId: string): string[] {
  loadFromDiskOnce();
  const state = promotionState.get(actorId);
  if (!state || state.size === 0) return [];
  const now = Date.now();
  const qualified: Array<{ name: string; count: number; latest: number }> = [];
  for (const [name, timestamps] of state) {
    const recent = pruneTimestamps(timestamps, now);
    if (recent.length >= TOOL_PROMOTE_THRESHOLD) {
      qualified.push({ name, count: recent.length, latest: Math.max(...recent) });
    }
  }
  qualified.sort((a, b) => b.count - a.count || b.latest - a.latest || a.name.localeCompare(b.name));
  return qualified.slice(0, TOOL_PROMOTE_CAP).map((q) => q.name);
}

/** 测试用：清空全部晋升状态（不落盘、不触发 reload，测试零污染）。 */
export function resetToolPromotionState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  promotionState.clear();
}

/** 测试专用：模拟重启——清空内存态并允许下次访问重新从磁盘加载。 */
export function resetToolPromotionStateForRestartTest(): void {
  resetToolPromotionState();
  loadAttempted = false;
}

/** 优雅停机/运维用：立即把未落盘的计数刷盘。 */
export function flushToolPromotionState(): void {
  if (dirty) flushToDisk();
}

/** 测试用：清空内存并强制下次访问重新从磁盘恢复（模拟进程重启）。 */
export function reloadToolPromotionStateFromDiskForTests(): void {
  promotionState.clear();
  loadAttempted = false;
}
