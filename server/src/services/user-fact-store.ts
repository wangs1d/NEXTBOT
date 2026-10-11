/**
 * 用户事实主库（User Fact Store）—— 事实级唯一存储（canonical semantic facts）
 *
 * 解决的问题：此前"用户住在杭州"这类稳定事实同时落在 Mem0 / humanLike 记忆图 /
 * KV 结构化槽位 / USER_PROFILE.md 四个库，更新时机和覆盖逻辑各不相同——
 * 更新类事实（搬家、换工作）需要各库分别覆盖，任何一库漏更就自相矛盾。
 *
 * 架构定位（收敛后的数据流）：
 *   每轮对话 → KV 槽位快速捕获（regex 粗分， latest-wins）
 *   夜间巩固 → 本库 upsertFact（subject 归一 + provenance + 置信度，冲突即替换）
 *            → syncDerivedSlots 把本库视图归并回 KV 槽位（事实为主、槽位为视图）
 *   prompt 注入 → 继续读 KV 槽位（零渲染层改动）
 *
 * 设计要点：
 * - 主键 = kind + 归一化 subject（"喜欢X"取宾语、"我住在X"取地点、"我是X"取身份），
 *   同主键新值替换旧值而不是累积——跨会话"越来越了解你"且不自相矛盾；
 * - 每条事实带 sources（来源链路）与 confidence，可审计可回溯；
 * - 持久化 per-actor JSON 文件（data/user-facts/<actorId>.json），写路径串行队列；
 * - 派生同步只做归并：与事实冲突的旧槽位行被替换，未提升的近期捕获行保留。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  dedupeMemoryLines,
  limitLinesByChars,
  semanticFingerprint,
} from "./memory-record-utils.js";
import { formatMemoryTopicTag } from "../agent/memory-topic.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export type UserFactKind = "preference" | "identity" | "constraint" | "fact";

export interface UserFact {
  /** `${kind}:${subject}` 的 sha1 前 16 位 */
  id: string;
  kind: UserFactKind;
  /** 归一化主语/槽位（如 "居住地"、"项目"、"简洁回答"） */
  subject: string;
  /** 事实陈述（第一人称短句） */
  value: string;
  /** 0-1，多次观察取最大值 */
  confidence: number;
  /** 被观察到的次数（同 subject 重复出现说明稳定） */
  seenCount: number;
  /** 来源链路（最多保留 3 条） */
  sources: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserFactUpsertInput {
  kind: UserFactKind;
  value: string;
  source?: string;
  confidence?: number;
}

interface FactFileShape {
  version: 1;
  updatedAt: string;
  facts: UserFact[];
}

export interface DerivedSlotSyncResult {
  /** 写入 memory_facts 的事实行数 */
  facts: number;
  /** 写入 memory_preferences 的事实行数 */
  preferences: number;
  /** 保留的近期未提升槽位行数 */
  keptRecent: number;
}

const MAX_FACTS = 200;
const SLOT_MAX_CHARS = 6000;
const SLOT_MAX_LINES = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSubject(text: string): string {
  return text
    .trim()
    .replace(/[\s，。；！？、,.;:!?'""''「」『』（）()\[\]【】~～]/g, "")
    .slice(0, 12);
}

/**
 * 从事实文本提取归一化 subject（冲突归并的 key）。
 * - preference：取"喜欢/讨厌/习惯"后的宾语（"喜欢简洁的回答" → "简洁的回答"）；
 * - identity："我是X" → "身份"（身份变化应互相替换）；
 * - constraint：取"不要/不能/忌"后的宾语；
 * - fact：居住地/项目/职业归类，其余取归一化文本前 12 字。
 */
export function extractFactSubject(kind: UserFactKind, text: string): string {
  const t = text.trim();
  if (kind === "preference") {
    const m = t.match(/(?:喜欢|偏好|不喜欢|讨厌|习惯)(?:上|)?([^，。；！？,.;!?\s]{1,12})/);
    if (m?.[1]) return normalizeSubject(m[1]);
    return normalizeSubject(t) || "通用偏好";
  }
  if (kind === "identity") {
    return "身份";
  }
  if (kind === "constraint") {
    const m = t.match(/(?:不要|不能|别|避免|忌|过敏)(?:吃|喝)?([^，。；！？,.;!?\s]{1,12})/);
    if (m?.[1]) return normalizeSubject(m[1]);
    return normalizeSubject(t) || "通用约束";
  }
  // fact
  if (/^我是/.test(t)) return "身份";
  const loc = t.match(/(?:我住在|住在|定居在?)([\u4e00-\u9fa5a-zA-Z]{2,12})/);
  if (loc?.[1]) return "居住地";
  if (/(?:我的项目|我在做|我在开发|项目是)/.test(t)) return "项目";
  if (/(?:我的职业|我的工作是|我在).{0,6}(?:工作|上班)/.test(t)) return "职业";
  // 亲密关系单值主题（root fix）：「我的老婆是X」「我的未来老婆是X」「X才是正主」
  // 等表述归一到同一 subject，值变化时 latest-wins 替换，不再按字面各存一条
  if (
    /(?:我的|未来的?|自家的)(?:老婆|媳妇|妻子|夫人|爱人|未婚妻|未婚夫|对象|正主|女朋友|女友|男朋友|男友)|(?:老婆|媳妇|妻子|未婚妻|对象|正主)(?:是|叫|才是)/.test(
      t,
    )
  ) {
    return "配偶/伴侣";
  }
  return normalizeSubject(t) || "其他";
}

function factId(kind: UserFactKind, subject: string): string {
  return createHash("sha1").update(`${kind}:${subject}`).digest("hex").slice(0, 16);
}

function sanitizeSegment(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "anonymous";
}

/** 把事实渲染为 KV 槽位行（与 appendMemorySummaryLine 的行格式一致） */
function renderFactLine(fact: UserFact): string {
  return `[${fact.updatedAt}] ${formatMemoryTopicTag("profile")} ${fact.value}`;
}

export class UserFactStore {
  private readonly cache = new Map<string, FactFileShape>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly dir: string = join(process.cwd(), "data", "user-facts")) {}

  private filePath(actorId: string): string {
    return join(this.dir, `${sanitizeSegment(actorId)}.json`);
  }

  private async load(actorId: string): Promise<FactFileShape> {
    const cached = this.cache.get(actorId);
    if (cached) return cached;
    let shape: FactFileShape = { version: 1, updatedAt: nowIso(), facts: [] };
    try {
      const raw = await readFile(this.filePath(actorId), "utf-8");
      const parsed = JSON.parse(raw) as Partial<FactFileShape>;
      if (Array.isArray(parsed.facts)) {
        shape = {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
          facts: parsed.facts.filter(
            (f): f is UserFact =>
              !!f &&
              typeof f.id === "string" &&
              typeof f.kind === "string" &&
              typeof f.value === "string" &&
              f.value.trim().length > 0,
          ),
        };
      }
    } catch {
      /* 文件不存在或损坏 → 空库起步 */
    }
    this.cache.set(actorId, shape);
    return shape;
  }

  private persist(actorId: string, shape: FactFileShape): void {
    const prev = this.writeChains.get(actorId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const path = this.filePath(actorId);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(shape, null, 2), "utf-8");
        await rename(tmp, path);
      })
      .catch((err) => {
        console.log(`[UserFactStore] persist failed for ${actorId}: ${err}`);
      });
    this.writeChains.set(actorId, next);
  }

  /** 等待所有待写盘完成（测试与关停用）。 */
  async flush(actorId?: string): Promise<void> {
    if (actorId) {
      await this.writeChains.get(actorId);
      return;
    }
    await Promise.all([...this.writeChains.values()]);
  }

  /**
   * 写入/更新一条事实：同 kind+subject 的新值替换旧值（latest-wins），
   * seenCount 递增、confidence 取最大、sources 追加去重（cap 3）。
   */
  async upsertFact(actorId: string, input: UserFactUpsertInput): Promise<UserFact | null> {
    const value = input.value?.trim();
    if (!value) return null;
    const kind = input.kind;
    const subject = extractFactSubject(kind, value);
    const id = factId(kind, subject);
    const shape = await this.load(actorId);

    const now = nowIso();
    const existing = shape.facts.find((f) => f.id === id);
    if (existing) {
      existing.value = value;
      existing.confidence = Math.max(existing.confidence, input.confidence ?? 0.7);
      existing.seenCount += 1;
      existing.updatedAt = now;
      if (input.source && !existing.sources.includes(input.source)) {
        existing.sources.push(input.source);
        if (existing.sources.length > 3) existing.sources = existing.sources.slice(-3);
      }
      this.persist(actorId, shape);
      return existing;
    }

    const fact: UserFact = {
      id,
      kind,
      subject,
      value,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
      seenCount: 1,
      sources: input.source ? [input.source] : [],
      createdAt: now,
      updatedAt: now,
    };
    shape.facts.push(fact);
    // 容量上限：按 updatedAt 淘汰最旧
    if (shape.facts.length > MAX_FACTS) {
      shape.facts.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      shape.facts = shape.facts.slice(-MAX_FACTS);
    }
    shape.updatedAt = now;
    this.persist(actorId, shape);
    return fact;
  }

  async getFacts(
    actorId: string,
    opts?: { kind?: UserFactKind; limit?: number },
  ): Promise<UserFact[]> {
    const shape = await this.load(actorId);
    let facts = [...shape.facts];
    if (opts?.kind) facts = facts.filter((f) => f.kind === opts.kind);
    facts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return typeof opts?.limit === "number" ? facts.slice(0, opts.limit) : facts;
  }

  async stats(actorId: string): Promise<{ total: number; byKind: Record<string, number> }> {
    const facts = await this.getFacts(actorId);
    const byKind: Record<string, number> = {};
    for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return { total: facts.length, byKind };
  }

  /**
   * 派生视图同步：把事实库归并回 KV 结构化槽位（事实为主、槽位为视图）。
   *
   * - 事实行按槽位归类：preference → memory_preferences，其余 → memory_facts；
   * - 槽位中与事实同 (subject) 冲突的旧行被替换（事实胜出）；
   * - 未被事实覆盖的近期捕获行保留（当天 per-turn 写入不丢）；
   * - 行数/字数上限与 AgentMemorySyncService 的槽位约束一致（8 行 / 6000 字）。
   */
  async syncDerivedSlots(
    actorId: string,
    memorySync: Pick<AgentMemorySyncService, "getSnapshot" | "setEntry">,
  ): Promise<DerivedSlotSyncResult> {
    const facts = await this.getFacts(actorId);
    const prefFacts = facts.filter((f) => f.kind === "preference");
    const otherFacts = facts.filter((f) => f.kind !== "preference");

    let keptRecent = 0;
    const plan: Array<{ key: string; factLines: string[]; factSubjects: Set<string> }> = [
      {
        key: "memory_preferences",
        factLines: prefFacts.map(renderFactLine),
        factSubjects: new Set(prefFacts.map((f) => f.subject)),
      },
      {
        key: "memory_facts",
        factLines: otherFacts.map(renderFactLine),
        factSubjects: new Set(
          otherFacts.map((f) => extractFactSubject(f.kind, f.value)),
        ),
      },
    ];

    const result: DerivedSlotSyncResult = {
      facts: otherFacts.length,
      preferences: prefFacts.length,
      keptRecent: 0,
    };

    for (const { key, factLines, factSubjects } of plan) {
      const { entries } = memorySync.getSnapshot(actorId, [key]);
      const existingLines = (typeof entries[key] === "string" ? entries[key] : "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      // 保留"与事实库无冲突"的近期捕获行（同 subject 的旧行由事实行替换）
      const factFingerprints = new Set(factLines.map((l) => semanticFingerprint(l) || l));
      const kept = existingLines.filter((line) => {
        if (factFingerprints.has(semanticFingerprint(line) || line)) return false;
        // 行格式 [ts] [topic:x] text → 取 text 部分提取 subject 对比
        const text = line.replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*/, "");
        for (const kind of ["preference", "identity", "constraint", "fact"] as const) {
          if (factSubjects.has(extractFactSubject(kind, text))) return false;
        }
        return true;
      });
      keptRecent += kept.length;

      const merged = dedupeMemoryLines([...factLines, ...kept], { preferLatest: true });
      const bounded = limitLinesByChars(merged, SLOT_MAX_CHARS, { preserveTail: true })
        .kept.slice(-SLOT_MAX_LINES);
      const value = bounded.join("\n");

      const prevValue = typeof entries[key] === "string" ? entries[key] : "";
      if (value !== prevValue) {
        memorySync.setEntry(actorId, key, value);
      }
    }

    return { ...result, keptRecent };
  }
}
