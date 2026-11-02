/**
 * 学习笔记（Notes）服务
 *
 * 设计要点：
 * - 单用户本地存储：每个 `sessionId` 一份 `data/notes/<sessionId>.json`
 * - 进程内缓存（Map）+ 启动时 load，写入时 persist
 * - 关键词搜索复用已有 {@link Bm25LiteIndex}（中英混排友好）
 * - LLM 摘要/抽问懒生成，结果写回 Note.summary / Note.flashcards / Note.quiz
 * - 复习提醒不直接落 ScheduleTask，由工具层（notes.schedule_review）把任务交给 ScheduleTaskService
 *
 * 设计上保持「服务不知道 LLM、不知道 schedule」—— 协调交给工具层
 * （避免循环依赖 + 便于单测）。
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { Bm25LiteIndex, tokenizeForBm25 } from "../agent/retrieval/bm25-lite.js";

export type NoteCategory =
  | "study"
  | "meeting"
  | "video"
  | "reading"
  | "idea"
  | "todo"
  | "other";

export const NOTE_CATEGORIES: readonly NoteCategory[] = [
  "study",
  "meeting",
  "video",
  "reading",
  "idea",
  "todo",
  "other",
];

export type NoteFlashcard = { q: string; a: string };
export type NoteQuiz = { question: string; answer: string };

export type Note = {
  id: string;
  sessionId: string;
  /** 归属用户（多租户隔离；旧笔记缺省视为未认领） */
  actorId?: string;
  title: string;
  content: string;
  category: NoteCategory;
  tags: string[];
  source?: string;
  summary?: string;
  flashcards?: NoteFlashcard[];
  quiz?: NoteQuiz[];
  createdAt: string;
  updatedAt: string;
  lastReviewedAt?: string;
  reviewCount: number;
};

export type CreateNoteInput = {
  sessionId: string;
  actorId?: string;
  title: string;
  content: string;
  category?: NoteCategory;
  tags?: string[];
  source?: string;
};

export type UpdateNoteInput = Partial<{
  title: string;
  content: string;
  category: NoteCategory;
  tags: string[];
  source: string | null;
  summary: string | null;
  flashcards: NoteFlashcard[] | null;
  quiz: NoteQuiz[] | null;
}>;

export type ListNotesFilter = {
  sessionId: string;
  actorId?: string;
  category?: NoteCategory;
  tag?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type SearchResult = {
  id: string;
  title: string;
  category: NoteCategory;
  score: number;
  snippet: string;
};

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 归属过滤。未带归属的旧笔记只在该会话本身就是调用者身份时可见
 * （本地单用户：actorId 由 sessionId 派生），迁移命令负责补归属。
 */
function ownedBy(note: Note, actorId?: string): boolean {
  if (!actorId) return true;
  if (note.actorId) return note.actorId === actorId;
  return note.sessionId === actorId;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeSnippet(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export class NotesService {
  private readonly bySession = new Map<string, Note[]>();
  /** noteId -> sessionId 反向索引，便于 update/delete 校验 */
  private readonly sessionByNoteId = new Map<string, string>();
  /** 每会话的 BM25 索引，按 title + content 建索引 */
  private readonly indexBySession = new Map<string, Bm25LiteIndex>();
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  private get persistPath(): string {
    return join(this.dataDir, "notes.json");
  }

  /** 启动时加载所有 session 的笔记；幂等 */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await mkdir(this.dataDir, { recursive: true });
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as { notes?: Note[] };
      for (const note of parsed.notes ?? []) {
        if (!note?.id || !note?.sessionId) continue;
        const list = this.bySession.get(note.sessionId) ?? [];
        list.push(note);
        this.bySession.set(note.sessionId, list);
        this.sessionByNoteId.set(note.id, note.sessionId);
      }
      // 重建索引
      for (const [sessionId, notes] of this.bySession.entries()) {
        this.rebuildIndex(sessionId, notes);
      }
      this.loaded = true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw e;
    }
  }

  private rebuildIndex(sessionId: string, notes: Note[]): void {
    const idx = new Bm25LiteIndex(Math.max(100, notes.length + 100));
    for (const n of notes) {
      idx.upsert(n.id, `${n.title}\n${n.tags.join(" ")}\n${n.content}`);
    }
    this.indexBySession.set(sessionId, idx);
  }

  private getIndex(sessionId: string): Bm25LiteIndex {
    let idx = this.indexBySession.get(sessionId);
    if (!idx) {
      idx = new Bm25LiteIndex(500);
      this.indexBySession.set(sessionId, idx);
    }
    return idx;
  }

  private async persist(): Promise<void> {
    const all: Note[] = [];
    for (const list of this.bySession.values()) all.push(...list);
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(
      this.persistPath,
      JSON.stringify({ notes: all }, null, 2),
      "utf8",
    );
  }

  /** 工具：拿掉所有 session（测试用） */
  resetForTests(): void {
    this.bySession.clear();
    this.sessionByNoteId.clear();
    this.indexBySession.clear();
    this.loaded = false;
  }

  async createNote(input: CreateNoteInput): Promise<Note> {
    await this.load();
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw new Error("title 不能为空");
    if (!content) throw new Error("content 不能为空");
    const category: NoteCategory = input.category ?? "other";
    if (!NOTE_CATEGORIES.includes(category)) {
      throw new Error(`category 非法: ${category}`);
    }
    const note: Note = {
      id: `n_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      sessionId,
      ...(input.actorId?.trim() ? { actorId: input.actorId.trim() } : {}),
      title,
      content,
      category,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      source: input.source?.trim() || undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      reviewCount: 0,
    };
    const list = this.bySession.get(sessionId) ?? [];
    list.push(note);
    this.bySession.set(sessionId, list);
    this.sessionByNoteId.set(note.id, sessionId);
    this.getIndex(sessionId).upsert(
      note.id,
      `${note.title}\n${note.tags.join(" ")}\n${note.content}`,
    );
    await this.persist();
    return note;
  }

  getNote(id: string, actorId?: string): Note | null {
    if (!SAFE_ID_REGEX.test(id) && !id.startsWith("n_")) {
      // 容错：接受合法 n_ 前缀或宽松 ID；非法字符直接拒
      if (!/^n_[a-zA-Z0-9]{8,40}$/.test(id)) return null;
    }
    const sessionId = this.sessionByNoteId.get(id);
    if (!sessionId) return null;
    const list = this.bySession.get(sessionId);
    const note = list?.find((n) => n.id === id) ?? null;
    return note && ownedBy(note, actorId) ? note : null;
  }

  async updateNote(id: string, patch: UpdateNoteInput, actorId?: string): Promise<Note> {
    await this.load();
    const existing = this.getNote(id, actorId);
    if (!existing) throw new Error("笔记不存在");
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new Error("title 不能为空");
      existing.title = t;
    }
    if (patch.content !== undefined) {
      const c = patch.content.trim();
      if (!c) throw new Error("content 不能为空");
      existing.content = c;
    }
    if (patch.category !== undefined) {
      if (!NOTE_CATEGORIES.includes(patch.category)) {
        throw new Error(`category 非法: ${patch.category}`);
      }
      existing.category = patch.category;
    }
    if (patch.tags !== undefined) {
      existing.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
    }
    if (patch.source !== undefined) {
      existing.source = patch.source ? patch.source.trim() : undefined;
    }
    if (patch.summary !== undefined) {
      existing.summary = patch.summary ?? undefined;
    }
    if (patch.flashcards !== undefined) {
      existing.flashcards = patch.flashcards ?? undefined;
    }
    if (patch.quiz !== undefined) {
      existing.quiz = patch.quiz ?? undefined;
    }
    existing.updatedAt = nowIso();
    this.getIndex(existing.sessionId).upsert(
      existing.id,
      `${existing.title}\n${existing.tags.join(" ")}\n${existing.content}`,
    );
    await this.persist();
    return existing;
  }

  async deleteNote(id: string, actorId?: string): Promise<{ id: string; deleted: true }> {
    await this.load();
    const existing = this.getNote(id, actorId);
    if (!existing) throw new Error("笔记不存在");
    const list = this.bySession.get(existing.sessionId) ?? [];
    const idx = list.findIndex((n) => n.id === id);
    if (idx >= 0) list.splice(idx, 1);
    this.bySession.set(existing.sessionId, list);
    this.sessionByNoteId.delete(id);
    this.indexBySession.get(existing.sessionId)?.remove(id);
    await this.persist();
    return { id, deleted: true };
  }

  listNotes(filter: ListNotesFilter): Note[] {
    const sessionId = filter.sessionId;
    const all = this.bySession.get(sessionId) ?? [];
    const fromMs = filter.from ? new Date(filter.from).getTime() : -Infinity;
    const toMs = filter.to ? new Date(filter.to).getTime() : Number.POSITIVE_INFINITY;
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    return all
      .filter((n) => ownedBy(n, filter.actorId))
      .filter((n) => !filter.category || n.category === filter.category)
      .filter((n) => !filter.tag || n.tags.includes(filter.tag))
      .filter((n) => {
        const t = new Date(n.createdAt).getTime();
        return Number.isFinite(t) && t >= fromMs && t <= toMs;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /**
   * 关键词检索：先用 BM25 粗排，再用 token 重叠度做一次精排（保证简短 query 也能命中标题）。
   * 返回最相关的 topK 条。
   */
  searchNotes(
    sessionId: string,
    query: string,
    topK = 10,
    category?: NoteCategory,
    actorId?: string,
  ): SearchResult[] {
    const scoped = this.bySession.get(sessionId) ?? [];
    const all = scoped.filter((n) => ownedBy(n, actorId));
    if (all.length === 0 || !query.trim()) return [];
    const idx = this.getIndex(sessionId);
    // 索引按整个会话重建（含其他用户的笔记），命中结果再按归属过滤
    if (idx.size !== scoped.length) this.rebuildIndex(sessionId, scoped);
    const bm = idx.search(query, Math.max(topK * 3, 10));
    const qTokens = new Set(tokenizeForBm25(query));
    const candidates = new Map<string, number>();
    for (const hit of bm) candidates.set(hit.id, hit.score);
    // 补一条"标题完全包含查询串"的强信号
    const q = query.trim().toLowerCase();
    for (const n of all) {
      if (category && n.category !== category) continue;
      const titleLc = n.title.toLowerCase();
      const contentLc = n.content.toLowerCase();
      let bonus = 0;
      if (titleLc.includes(q)) bonus += 5;
      if (contentLc.includes(q)) bonus += 2;
      // token 重叠
      if (qTokens.size > 0) {
        const nTokens = new Set(tokenizeForBm25(`${n.title} ${n.content}`));
        let overlap = 0;
        for (const t of qTokens) if (nTokens.has(t)) overlap++;
        bonus += overlap * 0.3;
      }
      if (bonus > 0) {
        const base = candidates.get(n.id) ?? 0;
        candidates.set(n.id, base + bonus);
      }
    }
    const ranked = [...candidates.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return ranked
      .map((r) => {
        const note = all.find((n) => n.id === r.id);
        if (!note) return null;
        if (category && note.category !== category) return null;
        return {
          id: note.id,
          title: note.title,
          category: note.category,
          score: Number(r.score.toFixed(4)),
          snippet: safeSnippet(note.content),
        };
      })
      .filter((x): x is SearchResult => x !== null);
  }

  /**
   * 标记一次复习：更新 `lastReviewedAt` 与 `reviewCount`。
   * 不抛错（找不到 id 时返回 null）。
   */
  async markReviewed(id: string, actorId?: string): Promise<Note | null> {
    await this.load();
    const existing = this.getNote(id, actorId);
    if (!existing) return null;
    existing.lastReviewedAt = nowIso();
    existing.reviewCount = (existing.reviewCount ?? 0) + 1;
    existing.updatedAt = existing.lastReviewedAt;
    await this.persist();
    return existing;
  }
}
