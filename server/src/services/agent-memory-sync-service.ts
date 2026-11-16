import { getDataDir } from "../config/data-dir.js";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { join } from "node:path";

import { formatMemoryTopicTag, inferMemoryTopic } from "../agent/memory-topic.js";
import { sanitizeMemoryLinesForPrompt } from "../agent/memory-line-hygiene.js";
import { gateLtmWrite } from "../agentic-memory/ltm-write-gate.js";
import { assertMemoryWriter } from "../memory/memory-authority.js";
import { AGENT_NAME_KV_KEY } from "./agent-identity.js";
import {
  areLinesConflicting,
  dedupeMemoryLines,
  extractOverwriteKey,
  limitLinesByChars,
} from "./memory-record-utils.js";

type SessionMemory = {
  revision: number;
  entries: Record<string, unknown>;
};

type PersistedShape = {
  sessions: Record<string, SessionMemory>;
};

export type MemoryPatchResult =
  | { ok: true; revision: number }
  | { ok: false; reason: string; currentRevision: number };

type MemoryPatchOp = { key: string; op: "put" | "delete"; value?: unknown };


export class AgentMemorySyncService {
  private readonly filePath: string;
  private data: PersistedShape = { sessions: {} };
  private persistChain: Promise<void> = Promise.resolve();
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  /** 磁盘快照只加载一次：重复 load 会覆盖内存态，导致已入队未落盘的写入被旧快照冲掉 */
  private loadPromise: Promise<void> | null = null;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_MEMORY_SYNC_FILE ?? join(getDataDir(), "agent-memory-sync.json");
  }

  load(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        const raw = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as PersistedShape;
        if (parsed?.sessions && typeof parsed.sessions === "object") {
          this.data = parsed;
          this.healPollutedMemoryLines();
        }
      } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
        if (code !== "ENOENT") throw e;
      }
    })();
    return this.loadPromise;
  }

  /**
   * 启动时治愈存量污染行（2026-10-23「新对话把上次对话算进去」根因收口）。
   *
   * 写入侧的洞已在 {@link gateLtmWrite} 补上（新数据不再产生），但库里已有
   * `[11:15] Agent: …` 这类**无日期逐字对话行**与 `[RENDER_HINT]` 残留。
   * 读取侧（memory-line-hygiene）虽然已在注入前剔除，但脏行仍会影响导出、
   * 诊断与二次抽取。这里在加载时一次性清掉并落盘，与 chat-thread-persist
   * 的「启动治愈」同款（幂等：无脏行时零写入）。
   */
  private healPollutedMemoryLines(): void {
    const keys = ["memory_summary", "session_recap", "memory_summary_forgotten"] as const;
    let sessions = 0;
    let removed = 0;
    // 空 handle 残括号：改名叙事行曾无条件拼「（@handle）」，handle 为空
    // （模型取名只给 displayName）就留下「「17赫兹」（@）」这种半截括号。
    let strippedEmptyHandle = 0;
    for (const session of Object.values(this.data.sessions)) {
      const entries = session?.entries;
      if (!entries) continue;
      let dirty = false;
      for (const key of keys) {
        const raw = entries[key];
        if (typeof raw !== "string" || !raw) continue;
        let value: string = raw;
        const r = sanitizeMemoryLinesForPrompt(value);
        if (r.dropped > 0) {
          value = r.text;
          removed += r.dropped;
          dirty = true;
        }
        if (value.includes("（@）")) {
          strippedEmptyHandle += value.split("（@）").length - 1;
          value = value.split("（@）").join("");
          dirty = true;
        }
        entries[key] = value;
      }
      if (dirty) {
        session.revision += 1;
        sessions++;
      }
    }
    if (removed > 0) {
      console.warn(
        `[agent-memory-sync] 启动治愈：清理存量污染行 ${removed} 条（${sessions} 个会话）` +
          `——逐字对话行/协议残留不进长期记忆`,
      );
    }
    if (strippedEmptyHandle > 0) {
      console.warn(
        `[agent-memory-sync] 启动治愈：去掉空 handle 残括号 ${strippedEmptyHandle} 处（${sessions} 个会话）`,
      );
    }
    if (removed > 0 || strippedEmptyHandle > 0) this.schedulePersist();
  }

  /**
   * 等待所有挂起的写入落盘（脚本 / 测试 / 关停用）。
   * setEntry / appendXxx 系列是 fire-and-forget 入队，外部脚本读盘前须先 flush。
   */
  async flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await Promise.all([...this.writeQueues.values()]);
      await this.persistChain;
      if (this.writeQueues.size === 0) return;
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    await writeJsonAtomic(this.filePath, this.data);
  }

  getSnapshot(sessionId: string, keys?: string[]): { revision: number; entries: Record<string, unknown> } {
    const session = this.data.sessions[sessionId] ?? { revision: 0, entries: {} };
    if (!keys?.length) {
      return { revision: session.revision, entries: { ...session.entries } };
    }

    const entries: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(session.entries, key)) {
        entries[key] = session.entries[key];
      }
    }
    return { revision: session.revision, entries };
  }

  listSessionIds(): string[] {
    return Object.keys(this.data.sessions);
  }

  /**
   * 清空指定 actor（sessionId/actorId）的全部结构化记忆条目并落盘。
   * 供“删除全部聊天记录 / 清空 Agent 记忆”类功能使用。
   */
  clearActor(actorId: string): boolean {
    if (!this.data.sessions[actorId]) {
      return false;
    }
    delete this.data.sessions[actorId];
    // 丢弃该 actor 的排队写入，避免清空后又被旧动作回写。
    this.writeQueues.delete(actorId);
    this.schedulePersist();
    console.log(`[AgentMemorySync] clearActor 完成 (actorId=${actorId})`);
    return true;
  }

  private enqueueActorWrite<T>(actorId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(actorId) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.writeQueues.set(actorId, next);
    next.finally(() => {
      if (this.writeQueues.get(actorId) === next) {
        this.writeQueues.delete(actorId);
      }
    });
    return next;
  }

  private applyPatchUnsafe(
    sessionId: string,
    basisRevision: number,
    patches: MemoryPatchOp[],
  ): MemoryPatchResult {
    const current = this.data.sessions[sessionId] ?? { revision: 0, entries: {} };
    if (current.revision !== basisRevision) {
      return { ok: false, reason: "REVISION_MISMATCH", currentRevision: current.revision };
    }

    const nextEntries = { ...current.entries };
    for (const patch of patches) {
      if (patch.op === "delete") {
        delete nextEntries[patch.key];
      } else {
        nextEntries[patch.key] = patch.value;
      }
    }

    const next: SessionMemory = { revision: current.revision + 1, entries: nextEntries };
    this.data.sessions[sessionId] = next;
    this.schedulePersist();
    return { ok: true, revision: next.revision };
  }

  applyPatch(sessionId: string, basisRevision: number, patches: MemoryPatchOp[]): Promise<MemoryPatchResult> {
    return this.enqueueActorWrite(sessionId, () => this.applyPatchUnsafe(sessionId, basisRevision, patches));
  }

  /**
   * 追加一行长期记忆摘要。
   *
   * @param producer 调用方模块名（写入契约的断言对象）。缺省视为本服务自身；
   *   其它模块经此入口写入时必须显式声明自己是谁——否则契约抓不到
   *   「第二个写者」（2026-11-13：Agent 取名走的就是这条路）。
   */
  appendMemorySummaryLine(
    actorId: string,
    line: string,
    topicHint?: string,
    producer = "AgentMemorySyncService",
  ): void {
    // v3 写入门：KV 记忆字段与 Mem0/叙事同门——一次性提醒回执、任务态快照、
    // 协议残留进 memory_summary 就是化石（「01:00 准时喊你」×4 的根因收口）
    const verdict = gateLtmWrite(line, "kv:summary");
    if (!verdict.admit) {
      console.log(`[ltm-gate] 拒绝 KV 写入(${verdict.reason}): ${line.slice(0, 60)}`);
      return;
    }
    assertMemoryWriter("memory_summary", producer);
    void this.enqueueActorWrite(actorId, () => this.doAppendStructuredMemoryLine(actorId, verdict.cleaned, topicHint));
  }

  /**
   * 写入单个 KV 条目（乐观并发重试，最多 12 次）。
   * 供 MemoryCortex 的 personality 域等结构化特质持久化使用。
   */
  setEntry(actorId: string, key: string, value: unknown): void {
    void this.enqueueActorWrite(actorId, () => {
      for (let i = 0; i < 12; i++) {
        const { revision } = this.getSnapshot(actorId, [key]);
        const result = this.applyPatchUnsafe(actorId, revision, [{ key, op: "put", value }]);
        if (result.ok) return true;
      }
      return false;
    });
  }

  /**
   * 写入单个 KV 条目并等待落盘队列完成（返回是否写入成功）。
   * 与 setEntry 同款乐观并发重试，但返回 Promise——改名这类「要么全写、
   * 要么全失败」的原子操作必须用它：setEntry 是 fire-and-forget，进程退出
   * 前可能还没落盘，会留下「账号/界面有名字、prompt 里却没名字」的半截态。
   */
  async setEntryAndWait(actorId: string, key: string, value: unknown): Promise<boolean> {
    // Agent 自我身份（KV agent.name）有自己的权威契约条目——改名是「要么全写、
    // 要么全失败」的原子操作，第二个写者会让 prompt 里的名字与账号名打架。
    if (key === AGENT_NAME_KV_KEY) {
      assertMemoryWriter("agent_name", "AgentIdentityTools");
    }
    const ok = await this.enqueueActorWrite(actorId, () => {
      for (let i = 0; i < 12; i++) {
        const { revision } = this.getSnapshot(actorId, [key]);
        const result = this.applyPatchUnsafe(actorId, revision, [{ key, op: "put", value }]);
        if (result.ok) return true;
      }
      return false;
    });
    if (ok) await this.persistChain;
    return ok;
  }

  /**
   * 幂等种子：仅当目标 KV 键尚不存在时写入（返回 true），否则跳过（返回 false）。
   * 供身份/记忆 Markdown 文档加载使用——绝不覆盖运行时学习到的人格/画像/事实，
   * 只在下层为空时把文档作为默认基底填入。
   */
  seedIfAbsent(actorId: string, key: string, value: unknown): Promise<boolean> {
    return this.enqueueActorWrite(actorId, () => {
      for (let i = 0; i < 12; i++) {
        const { revision, entries } = this.getSnapshot(actorId, [key]);
        if (Object.prototype.hasOwnProperty.call(entries, key)) return false;
        const result = this.applyPatchUnsafe(actorId, revision, [{ key, op: "put", value }]);
        if (result.ok) return true;
      }
      return false;
    });
  }

  appendRelationshipHistoryLine(actorId: string, line: string, topicHint?: string): void {
    this.appendMemorySummaryLine(actorId, `【关系线程】${line}`, topicHint ?? "relationship");
  }

  appendSessionRecapLine(actorId: string, line: string, topicHint?: string): void {
    // 与 memory_summary 同门过闸（2026-10-23 recap 污染收口）：此前本入口无门，
    // daily-chat-sync 曾把 `[HH:MM] [客户端同步] Agent: …` 逐字对话整批塞进来。
    const verdict = gateLtmWrite(line, "kv:recap");
    if (!verdict.admit) {
      console.log(`[ltm-gate] 拒绝 KV recap 写入(${verdict.reason}): ${line.slice(0, 60)}`);
      return;
    }
    void this.enqueueActorWrite(actorId, () =>
      this.doAppendMemorySlotLine(actorId, "session_recap", verdict.cleaned, topicHint ?? "recap"),
    );
  }

  setCurrentMission(actorId: string, mission: string | null, topicHint?: string): void {
    void this.enqueueActorWrite(actorId, () =>
      this.doSetMemorySlotValue(actorId, "memory_current_mission", mission, topicHint ?? "mission"),
    );
  }

  // reconcileStructuredMemoryAfterTurn 已删除（2026-10-23 根因收口）：
  // 它按「token 重叠≥5字符 ≈ 该承诺已完成」的启发式从 commitments/open_loops/recap
  // 槽里删行——承诺板下线后这些槽没有合法写入者，而误判"已完成"会静默吞掉真实待办。
  // 未闭环事项的收口归 consolidation / 统一抽取的语义决策，不做词面猜测。

  private doAppendStructuredMemoryLine(actorId: string, line: string, topicHint?: string): boolean {
    const maxRaw = process.env.AGENT_MEMORY_SUMMARY_MAX_CHARS;
    const maxChars = maxRaw ? Math.max(1000, Number.parseInt(maxRaw, 10) || 16_000) : 16_000;
    const archiveMaxChars = Math.max(maxChars, 48_000);
    const stamp = new Date().toISOString();
    const topicTag = formatMemoryTopicTag(topicHint ?? inferMemoryTopic(line));
    const addition = `[${stamp}] ${topicTag} ${line}`;

    for (let i = 0; i < 12; i++) {
      const { revision, entries } = this.getSnapshot(actorId, [
        "memory_summary",
        "memory_summary_forgotten",
      ]);

      const prev = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
      const forgottenPrev =
        typeof entries.memory_summary_forgotten === "string" ? entries.memory_summary_forgotten : "";
      const merged = this.mergeMemorySummaryLines(prev, addition);
      const { kept, evicted } = limitLinesByChars(merged, maxChars, { preserveTail: true });
      const forgotten = dedupeMemoryLines(
        [...(forgottenPrev ? forgottenPrev.split("\n").filter(Boolean) : []), ...evicted],
        { preferLatest: true },
      );
      const forgottenTrimmed = limitLinesByChars(forgotten, archiveMaxChars, { preserveTail: true }).kept;

      // 2026-11-12 收敛：不再把同一行镜像进 memory_preferences / memory_facts /
      // memory_commitments / memory_open_loops。那四条槽由关键词正则分派，是
      // 「比价这类任务内容进画像槽 → 每轮无条件注入」的根因；档案字段的权威源
      // 是 structured_facts，在办事项的权威源是 commitments/tasks，本类只拥有
      // memory.summary 一个概念（见 memory/memory-authority.ts）。
      const result = this.applyPatchUnsafe(actorId, revision, [
        { key: "memory_summary", op: "put", value: kept.join("\n") },
        { key: "memory_summary_forgotten", op: "put", value: forgottenTrimmed.join("\n") },
      ]);
      if (result.ok) return true;
    }
    return false;
  }

  /**
   * 摘要整体替换（唯一维护入口）：consolidation / forgotten 恢复等需要重写整串的
   * 场景一律走这里，而不是各自 applyPatch 全量覆盖。
   *
   * 存在的理由（2026-11-12）：此前 MemoryManagerService 自己读 revision 后
   * applyPatch 覆盖，与 append 路径并发时 CAS 失败会被静默丢弃（整理白算一场）。
   * 收敛到本方法后：读-改-写在同一把 actor 队列里重试，transform 拿到的是最新串。
   */
  replaceSummaryLines(
    actorId: string,
    transform: (current: { summary: string[]; forgotten: string[] }) => {
      summary: string[];
      forgotten: string[];
    },
    producer = "AgentMemorySyncService",
  ): Promise<boolean> {
    assertMemoryWriter("memory_summary", producer);
    return this.enqueueActorWrite(actorId, () => {
      const maxRaw = process.env.AGENT_MEMORY_SUMMARY_MAX_CHARS;
      const maxChars = maxRaw ? Math.max(1000, Number.parseInt(maxRaw, 10) || 16_000) : 16_000;
      for (let i = 0; i < 12; i++) {
        const { revision, entries } = this.getSnapshot(actorId, [
          "memory_summary",
          "memory_summary_forgotten",
        ]);
        const current = {
          summary: (typeof entries.memory_summary === "string" ? entries.memory_summary : "")
            .split("\n")
            .filter(Boolean),
          forgotten: (typeof entries.memory_summary_forgotten === "string"
            ? entries.memory_summary_forgotten
            : ""
          )
            .split("\n")
            .filter(Boolean),
        };
        const next = transform({ summary: [...current.summary], forgotten: [...current.forgotten] });
        if (next.summary.length === current.summary.length && next.forgotten.length === current.forgotten.length &&
            next.summary.every((l, idx) => l === current.summary[idx])) {
          return true; // 无变化（幂等）
        }
        const kept = limitLinesByChars(
          dedupeMemoryLines(next.summary, { preferLatest: true }),
          maxChars,
          { preserveTail: true },
        ).kept;
        const forgottenKept = limitLinesByChars(
          dedupeMemoryLines(next.forgotten, { preferLatest: true }),
          Math.max(maxChars, 48_000),
          { preserveTail: true },
        ).kept;
        const result = this.applyPatchUnsafe(actorId, revision, [
          { key: "memory_summary", op: "put", value: kept.join("\n") },
          { key: "memory_summary_forgotten", op: "put", value: forgottenKept.join("\n") },
        ]);
        if (result.ok) return true;
      }
      return false;
    });
  }

  private doAppendMemorySlotLine(actorId: string, key: string, line: string, topicHint?: string): boolean {
    const maxRaw = process.env.AGENT_MEMORY_SUMMARY_MAX_CHARS;
    const maxChars = maxRaw ? Math.max(1000, Number.parseInt(maxRaw, 10) || 16_000) : 16_000;
    const stamp = new Date().toISOString();
    const topicTag = formatMemoryTopicTag(topicHint ?? inferMemoryTopic(line));
    const addition = `[${stamp}] ${topicTag} ${line}`;

    for (let i = 0; i < 12; i++) {
      const { revision, entries } = this.getSnapshot(actorId, [key]);
      const prev = typeof entries[key] === "string" ? (entries[key] as string) : "";
      const merged = dedupeMemoryLines([...prev.split("\n").filter(Boolean), addition], { preferLatest: true });
      const kept = limitLinesByChars(merged, maxChars, { preserveTail: true }).kept;
      const result = this.applyPatchUnsafe(actorId, revision, [{ key, op: "put", value: kept.join("\n") }]);
      if (result.ok) return true;
    }

    return false;
  }

  private doSetMemorySlotValue(actorId: string, key: string, value: string | null, topicHint?: string): boolean {
    const normalized = value?.trim() ?? "";
    const slotValue = normalized
      ? `[${new Date().toISOString()}] ${formatMemoryTopicTag(topicHint ?? inferMemoryTopic(normalized))} ${normalized}`
      : "";

    for (let i = 0; i < 12; i++) {
      const { revision } = this.getSnapshot(actorId, [key]);
      const result = this.applyPatchUnsafe(actorId, revision, [{ key, op: "put", value: slotValue }]);
      if (result.ok) return true;
    }

    return false;
  }

  private mergeMemorySummaryLines(prev: string, addition: string): string[] {
    const base = prev
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const overwriteKey = extractOverwriteKey(addition);
    const filtered = overwriteKey
      ? base.filter((line) => {
          const lineKey = extractOverwriteKey(line);
          if (!lineKey || lineKey !== overwriteKey) return true;
          return !areLinesConflicting(line, addition);
        })
      : base;
    return dedupeMemoryLines([...filtered, addition], { preferLatest: true });
  }

}
