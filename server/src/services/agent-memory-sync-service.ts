import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { join } from "node:path";

import { formatMemoryTopicTag, inferMemoryTopic } from "../agent/memory-topic.js";
import { gateLtmWrite } from "../agentic-memory/ltm-write-gate.js";
import {
  areLinesConflicting,
  dedupeMemoryLines,
  dropExpiredCommitmentLines,
  extractOverwriteKey,
  limitLinesByChars,
  normalizeMemoryLine,
  stripMemoryLineDecorators,
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

const TURN_COMPLETED_RE =
  /(搞定了|完成了|结束了|处理好了|已经完成|处理完成|任务完成|执行完成|全部完成|done|fixed|resolved)/i;

export class AgentMemorySyncService {
  private readonly filePath: string;
  private data: PersistedShape = { sessions: {} };
  private persistChain: Promise<void> = Promise.resolve();
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_MEMORY_SYNC_FILE ?? join(process.cwd(), "data", "agent-memory-sync.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed?.sessions && typeof parsed.sessions === "object") {
        this.data = parsed;
      }
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw e;
    }
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

  appendMemorySummaryLine(actorId: string, line: string, topicHint?: string): void {
    // v3 写入门：KV 记忆字段与 Mem0/叙事同门——一次性提醒回执、任务态快照、
    // 协议残留进 memory_summary 就是化石（「01:00 准时喊你」×4 的根因收口）
    const verdict = gateLtmWrite(line, "kv:summary");
    if (!verdict.admit) {
      console.log(`[ltm-gate] 拒绝 KV 写入(${verdict.reason}): ${line.slice(0, 60)}`);
      return;
    }
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
    void this.enqueueActorWrite(actorId, () =>
      this.doAppendMemorySlotLine(actorId, "session_recap", line, topicHint ?? "recap"),
    );
  }

  setCurrentMission(actorId: string, mission: string | null, topicHint?: string): void {
    void this.enqueueActorWrite(actorId, () =>
      this.doSetMemorySlotValue(actorId, "memory_current_mission", mission, topicHint ?? "mission"),
    );
  }

  reconcileStructuredMemoryAfterTurn(actorId: string, userText: string, assistantText: string): void {
    void this.enqueueActorWrite(actorId, () =>
      this.doReconcileStructuredMemoryAfterTurn(actorId, userText, assistantText),
    );
  }

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
        "memory_preferences",
        "memory_facts",
        "memory_commitments",
        "memory_open_loops",
        "session_recap",
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
      const slotPatches = this.buildStructuredMemorySlotPatches(line, topicHint, entries);

      const result = this.applyPatchUnsafe(actorId, revision, [
        { key: "memory_summary", op: "put", value: kept.join("\n") },
        { key: "memory_summary_forgotten", op: "put", value: forgottenTrimmed.join("\n") },
        ...slotPatches,
      ]);
      if (result.ok) return true;
    }
    return false;
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

  private buildStructuredMemorySlotPatches(
    line: string,
    topicHint: string | undefined,
    entries: Record<string, unknown>,
  ): MemoryPatchOp[] {
    const slotLine = `[${new Date().toISOString()}] ${formatMemoryTopicTag(topicHint ?? inferMemoryTopic(line))} ${line}`;
    const patches: MemoryPatchOp[] = [];
    const text = `${line}`.trim();
    const lower = text.toLowerCase();
    const preferenceMatch = /(喜欢|偏好|不喜欢|讨厌|习惯|不要|别|prefer|like|hate|dislike)/i.test(text);
    // 亲密关系陈述（老婆/对象/正主…）也是事实：旧词表漏掉关系类，导致
    // "我的老婆是刘浩存"进不了 memory_facts 槽位、槽位内新旧值也无法互相替换
    const factMatch =
      /(我是|我在做|我最近在|我的项目|我住在|我计划|我需要|(?:我的|未来的?)(?:老婆|媳妇|妻子|未婚妻|未婚夫|对象|正主|女朋友|女友|男朋友|男友)|my project|i am|i'm)/i.test(text) ||
      /(?:^|\s)(?:i|user)\s+(?:live|lives|am living|am based|based)\s+(?:in|at)\s+/i.test(text);
    // 承诺匹配（2026-09-05 扩充）：原词表漏掉管家的高频口头应承表述
    // （"给你设个提醒/记下了/到点喊你"）与用户委托（"提醒我…"），这类话
    // 承诺没进【待办与承诺】槽位，后续轮次 agent 会把约定细节说岔且无从对证
    const commitmentMatch =
      /(我会|我将|已经帮你|已为你|稍后|接下来|记下了|记着|给你设|帮你设|帮你记|给你记|提醒我|提醒你|到点喊|i will|i can|i'll)/i.test(
        text,
      );
    const loopMatch = /(待办|未完成|后续|继续|下一步|pending|todo|follow up)/i.test(text);

    const summaryAdd = (key: string, value: string, limitLines = 8): void => {
      const prev = typeof entries[key] === "string" ? (entries[key] as string) : "";
      let prevLines = prev.split("\n").filter(Boolean);
      // 承诺/开环槽位写入时顺带清僵尸：超 TTL 未闭环的旧承诺不许再占行数预算。
      if (key === "memory_commitments" || key === "memory_open_loops") {
        prevLines = dropExpiredCommitmentLines(prevLines);
      }
      const merged = this.mergeMemorySlotLines(key, prevLines, value);
      const kept = limitLinesByChars(merged, 6000, { preserveTail: true }).kept.slice(-limitLines);
      patches.push({ key, op: "put", value: kept.join("\n") });
    };

    if (preferenceMatch) summaryAdd("memory_preferences", slotLine);
    if (factMatch) summaryAdd("memory_facts", slotLine);
    if (commitmentMatch) summaryAdd("memory_commitments", slotLine);
    if (loopMatch) summaryAdd("memory_open_loops", slotLine);

    if (patches.length === 0 && lower.length > 0) {
      summaryAdd("session_recap", slotLine, 6);
    }
    if (patches.length > 0) {
      summaryAdd("session_recap", slotLine, 6);
    }
    return patches;
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

  private mergeMemorySlotLines(key: string, existingLines: string[], addition: string): string[] {
    if (key === "memory_preferences") {
      return this.mergePreferenceLines(existingLines, addition);
    }
    if (key === "memory_facts") {
      return this.mergeFactLines(existingLines, addition);
    }
    return dedupeMemoryLines([...existingLines, addition], { preferLatest: true });
  }

  private mergePreferenceLines(existingLines: string[], addition: string): string[] {
    const additionSubject = this.extractPreferenceSubject(addition);
    const filtered = additionSubject
      ? existingLines.filter((line) => this.extractPreferenceSubject(line) !== additionSubject)
      : existingLines;
    return dedupeMemoryLines([...filtered, addition], { preferLatest: true });
  }

  private extractPreferenceSubject(line: string): string | null {
    const plain = stripMemoryLineDecorators(line);
    const normalized = normalizeMemoryLine(plain);
    if (!normalized) return null;

    const patterns: RegExp[] = [
      /(?:^|\s)(?:user|i|we)\s+(?:really\s+)?(?:prefer|prefers|like|likes|dislike|dislikes|hate|hates)\s+(.+)$/,
      /(?:^|\s)(?:user|i|we)\s+(?:do not want|dont want|does not want|doesnt want|want|wants)\s+(.+)$/,
      /(?:^|\s)(?:用户|我)?\s*(?:喜欢|偏好|习惯|不喜欢|讨厌|不要|别)\s*(.+)$/,
      // 购物偏好（2026-10-05 扩充，推荐线 P4）：「想买 X / 在用 X / 一直用 X」
      // 是品类/品牌偏好的高频口语句式，进 user_profile 后 personalize 的
      // 推荐决策能引用（如「你在用的 XM5 已是旗舰」）；金额预算不在此抽
      // （subject 语义弱），预算随原话留在画像摘要里。
      /(?:^|\s)(?:用户|我)?\s*(?:想买|想入手|打算买|准备买|考虑买|想换|想添置)\s*(.+)$/,
      /(?:^|\s)(?:用户|我)?\s*(?:一直|都|全)?(?:在用|用的?是|用着)\s*(.+)$/,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      const subject = match?.[1]?.trim();
      if (subject) {
        return subject.replace(/^(to|that)\s+/, "").trim();
      }
    }
    return null;
  }

  private mergeFactLines(existingLines: string[], addition: string): string[] {
    const additionSlot = this.extractFactSlot(addition);
    const filtered = additionSlot
      ? existingLines.filter((line) => this.extractFactSlot(line) !== additionSlot)
      : existingLines;
    return dedupeMemoryLines([...filtered, addition], { preferLatest: true });
  }

  private extractFactSlot(line: string): string | null {
    const plain = stripMemoryLineDecorators(line);
    const normalized = normalizeMemoryLine(plain);
    if (!normalized) return null;

    const slotPatterns: Array<{ slot: string; pattern: RegExp }> = [
      { slot: "location", pattern: /(?:^|\s)(?:user|i)\s+(?:live|lives|am living|am based|based)\s+(?:in|at)\s+.+$/ },
      { slot: "location", pattern: /(?:^|\s)(?:用户|我)\s*(?:住在|在)\s*.+$/ },
      { slot: "project", pattern: /(?:^|\s)(?:my project|the project|users project|user project)\s+(?:is|uses|focuses on)\s+.+$/ },
      { slot: "project", pattern: /(?:^|\s)(?:我的项目|项目)\s*(?:是|在做|使用|关于)\s*.+$/ },
      { slot: "identity", pattern: /(?:^|\s)(?:user|i)\s+(?:am|m)\s+.+$/ },
      { slot: "identity", pattern: /(?:^|\s)(?:用户|我)\s*(?:是)\s*.+$/ },
      { slot: "need", pattern: /(?:^|\s)(?:user|i)\s+(?:need|needs|plan|plans)\s+.+$/ },
      { slot: "need", pattern: /(?:^|\s)(?:用户|我)\s*(?:需要|计划)\s*.+$/ },
      // 亲密关系单值槽位（root fix）：新值入槽时自动替换旧值行，
      // "我的老婆是景甜"与"我的老婆是刘浩存"（含「未来老婆」等变体）不再并存
      {
        slot: "relationship",
        pattern:
          /(?:我的|未来的?|自家的)(?:老婆|媳妇|妻子|夫人|爱人|未婚妻|未婚夫|对象|正主|女朋友|女友|男朋友|男友)|(?:老婆|媳妇|妻子|未婚妻|对象|正主)(?:是|叫|才是)/,
      },
    ];

    for (const { slot, pattern } of slotPatterns) {
      if (pattern.test(normalized)) return slot;
    }
    return null;
  }

  private doReconcileStructuredMemoryAfterTurn(actorId: string, userText: string, assistantText: string): boolean {
    if (!TURN_COMPLETED_RE.test(userText) && !TURN_COMPLETED_RE.test(assistantText)) {
      return false;
    }

    const completionContext = `${userText}\n${assistantText}`.trim();

    for (let i = 0; i < 12; i++) {
      const { revision, entries } = this.getSnapshot(actorId, [
        "memory_commitments",
        "memory_open_loops",
        "session_recap",
      ]);
      const currentCommitments =
        typeof entries.memory_commitments === "string" ? entries.memory_commitments.split("\n").filter(Boolean) : [];
      const currentOpenLoops =
        typeof entries.memory_open_loops === "string" ? entries.memory_open_loops.split("\n").filter(Boolean) : [];
      const currentRecap =
        typeof entries.session_recap === "string" ? entries.session_recap.split("\n").filter(Boolean) : [];

      const filteredCommitments = dropExpiredCommitmentLines(
        currentCommitments.filter((line) => !this.isResolvedByTurnContext(line, completionContext)),
      );
      const filteredOpenLoops = dropExpiredCommitmentLines(
        currentOpenLoops.filter((line) => !this.isResolvedByTurnContext(line, completionContext)),
      );
      const filteredRecap = currentRecap.filter((line) => !this.isResolvedByTurnContext(line, completionContext));

      if (
        filteredCommitments.length === currentCommitments.length &&
        filteredOpenLoops.length === currentOpenLoops.length &&
        filteredRecap.length === currentRecap.length
      ) {
        return false;
      }

      const patches: MemoryPatchOp[] = [
        { key: "memory_commitments", op: "put", value: filteredCommitments.join("\n") },
        { key: "memory_open_loops", op: "put", value: filteredOpenLoops.join("\n") },
        { key: "session_recap", op: "put", value: filteredRecap.join("\n") },
      ];
      const result = this.applyPatchUnsafe(actorId, revision, patches);
      if (result.ok) return true;
    }

    return false;
  }

  private isResolvedByTurnContext(line: string, completionContext: string): boolean {
    const lineTokens = this.extractComparableTokens(line);
    const contextTokens = this.extractComparableTokens(completionContext);
    if (lineTokens.length === 0 || contextTokens.length === 0) {
      return false;
    }

    const contextSet = new Set(contextTokens);
    const overlap = lineTokens.filter((token) => contextSet.has(token));
    if (overlap.length === 0) {
      return false;
    }

    const significantOverlap = overlap.filter((token) => token.length >= 5);
    if (significantOverlap.length > 0) {
      return true;
    }

    return overlap.length >= Math.min(2, lineTokens.length);
  }

  private extractComparableTokens(text: string): string[] {
    const normalized = normalizeMemoryLine(stripMemoryLineDecorators(text));
    if (!normalized) return [];

    return normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token, index, arr) => arr.indexOf(token) === index);
  }
}
