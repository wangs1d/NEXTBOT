/**
 * 事实变更 → 向量层即时退役（2026-10-19 收尾）。
 *
 * 遗留问题：结构化事实库是字段级 latest-wins（旧值瞬间下线），但 Mem0 向量层
 * 走 infer:false 写入即存，"住在杭州"那条旧记忆不会因为档案改成"兴义"而消失。
 * 此后靠 lifecycle 去重 / LLM 24h 审查兜底，最长有约一天的新旧并存窗口——
 * 这段窗口里模型可能同时看到两个居住地，拿哪条全看排序。
 *
 * 本模块把窗口压到零：事实字段发生变更时，立即把**同一个字段**的旧记忆归档
 * （archiveIds：召回侧过滤、可恢复，不是物理删除）。
 *
 * 判定宁可漏不可错（与全项目「宁保留不误删」一致）：
 *   ① 优先认 metadata.factFields（写入时按事实值打的标签，精确）；
 *   ② 无标签的存量条目退回 `isProfileFieldCopyLine`——要求「短句 + 该字段的
 *      显式线索词」或「我是X式自称命中已知旧值」，长段落一律不碰；
 *   ③ 文本里已包含新值的条目不归档（新旧混写的条目交给 LLM 审查）；
 *   ④ 没有归档能力（reinforcement 未装配）时**不删**，交给 lifecycle。
 */

import type { Memory } from "mem0ai/oss";

import { isProfileFieldCopyLine } from "../services/user-personalization/profile-fact-authority.js";
import type { MemoryReinforcementStore } from "./memory-reinforcement.js";

export interface FactSupersedeDeps {
  /** 只用到 search（测试可注入 fake） */
  memory: Pick<Memory, "search"> | null;
  /** 归档能力；缺失时整体跳过（不删任何东西） */
  reinforcement: Pick<MemoryReinforcementStore, "archiveIds"> | null;
  actorId: string;
  /** 标准字段名（居住地/职业/称呼…） */
  field: string;
  /** 生效的新值 */
  newValue: string;
  /** 被替代的旧值（通常一条） */
  previousValues: string[];
  /** 单次最多处理的候选数（防一次变更扫爆） */
  maxCandidates?: number;
}

export interface FactSupersedeResult {
  /** 检索到的候选条数 */
  scanned: number;
  /** 实际归档的 id */
  archived: string[];
  /** 未执行的原因（memory/reinforcement 缺失、无旧值可判） */
  skipped: "no_memory" | "no_reinforcement" | "no_previous" | null;
}

const DEFAULT_MAX_CANDIDATES = 12;

/**
 * 无标签存量条目的严格长度闸：只把「短断言」当字段副本。
 * `isProfileFieldCopyLine` 的 60 字阈值是给 KV 槽位清理用的（宁可多清一行），
 * 放到记忆归档上太松——一段 58 字的叙事里提一句「住在杭州」并不是档案副本，
 * 归档它等于丢信息。这里收到 40 字：够容下「我住在杭州，做后端开发」这类
 * 多字段短句，又挡得住叙事段落。
 */
const UNTAGGED_COPY_MAX_CHARS = 40;

/**
 * 归档与已失效事实同字段的旧记忆。失败静默（返回空），不阻塞写入主链路。
 */
export async function retireMemoriesForFactChange(
  deps: FactSupersedeDeps,
): Promise<FactSupersedeResult> {
  const previous = [...new Set(deps.previousValues.map((v) => v?.trim()).filter(Boolean))]
    .filter((v) => v.length >= 2 && v !== deps.newValue)
    .slice(0, 3);
  if (previous.length === 0) return { scanned: 0, archived: [], skipped: "no_previous" };
  if (!deps.memory) return { scanned: 0, archived: [], skipped: "no_memory" };
  if (!deps.reinforcement) return { scanned: 0, archived: [], skipped: "no_reinforcement" };

  const field = deps.field.trim();
  if (!field) return { scanned: 0, archived: [], skipped: "no_previous" };

  try {
    const result = (await deps.memory.search(`${field} ${previous.join(" ")}`, {
      filters: { user_id: deps.actorId },
      topK: 24,
    })) as unknown as {
      results?: Array<{ id?: string; memory?: string; metadata?: Record<string, unknown> }>;
    };
    const hits = result.results ?? [];
    const knownValues = new Map<string, readonly string[]>([[field, previous]]);
    const fieldSet = new Set([field]);
    const ids: string[] = [];

    for (const hit of hits) {
      if (!hit?.id) continue;
      const text = typeof hit.memory === "string" ? hit.memory.trim() : "";
      // 新旧混写 / 已含新值：不归档（可能还带着别的有效信息，交给 LLM 审查）
      if (text && text.includes(deps.newValue)) continue;
      const tagged = String(hit.metadata?.factFields ?? "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .includes(field);
      const looksCopy =
        text.length > 0 && text.length <= UNTAGGED_COPY_MAX_CHARS
          ? isProfileFieldCopyLine(text, fieldSet, knownValues)
          : false;
      if (!tagged && !looksCopy) continue;
      ids.push(hit.id);
      if (ids.length >= (deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES)) break;
    }

    if (ids.length === 0) return { scanned: hits.length, archived: [], skipped: null };
    const n = deps.reinforcement.archiveIds(ids, deps.actorId);
    console.info(
      `[fact-supersede] 归档 ${n}/${ids.length} 条与 ${field}=${deps.newValue} 冲突的旧记忆 ` +
        `actor=${deps.actorId}（可恢复，非物理删除）`,
    );
    return { scanned: hits.length, archived: ids.slice(0, n), skipped: null };
  } catch (err) {
    console.warn(
      "[fact-supersede] 旧记忆归档失败（忽略，交给 lifecycle）:",
      err instanceof Error ? err.message : err,
    );
    return { scanned: 0, archived: [], skipped: null };
  }
}
