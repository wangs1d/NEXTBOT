/**
 * 笔记（notes.*）工具：把 NotesService 与外部 LLM、ScheduleTaskService 串起来，
 * 让 Agent 在对话中能直接落库/检索/摘要/抽问/排复习。
 */
import { resolveActorId } from "../agent/actor-id.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import {
  generateNoteFlashcards,
  generateNoteQuiz,
  generateNoteSummary,
} from "../services/notes-ai.js";
import type { Note, NotesService } from "../services/notes-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { NarrativeMemoryPort } from "../services/narrative-memory-port.js";
import { formatNextRunAtSpoken } from "./calendar-tools.js";
import type { ToolRegistry } from "./tool-registry.js";

const VALID_CATEGORIES = [
  "study",
  "meeting",
  "video",
  "reading",
  "idea",
  "todo",
  "other",
] as const;

type CategoryLiteral = (typeof VALID_CATEGORIES)[number];

function isCategory(v: unknown): v is CategoryLiteral {
  return typeof v === "string" && (VALID_CATEGORIES as readonly string[]).includes(v);
}

export function registerNotesTools(
  registry: ToolRegistry,
  notesService: NotesService,
  scheduleTaskService: ScheduleTaskService,
  externalChat: ExternalChatProvider | null,
  narrativeMemory: NarrativeMemoryPort | null = null,
): void {
  /* -----------------------------------------------------------------
   * notes.create
   * ----------------------------------------------------------------- */
  registry.register("notes.create", async (input, context) => {
    const sessionId = resolveActorId(context);
    const title = String(input.title ?? "").trim();
    const content = String(input.content ?? "").trim();
    if (!title) return { ok: false, error: "title 必填" };
    if (!content) return { ok: false, error: "content 必填" };
    const category = isCategory(input.category) ? input.category : "other";
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const source = input.source ? String(input.source).trim() : undefined;

    // 状态连续性：先 search 查重，避免重复落库
    const topHits = notesService.searchNotes(sessionId, title, 3, undefined, sessionId);
    const dup = topHits.find((h) => h.title.trim() === title);
    if (dup) {
      const existing = notesService.getNote(dup.id, sessionId);
      if (existing) {
        const mergedContent = `${existing.content}\n\n---\n补充：\n${content}`;
        const updated = await notesService.updateNote(existing.id, {
          content: mergedContent,
          tags: Array.from(new Set([...existing.tags, ...tags])),
          source: source ?? existing.source ?? null,
        }, sessionId);
        return {
          ok: true,
          duplicateHandled: true,
          note: updated,
          summary: "已合并到现有笔记，未创建新条目",
        };
      }
    }

    try {
      const note = await notesService.createNote({
        sessionId,
        actorId: sessionId,
        title,
        content,
        category,
        tags,
        source,
      });
      return { ok: true, note, summary: "笔记已创建" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.list
   * ----------------------------------------------------------------- */
  registry.register("notes.list", async (input, context) => {
    const sessionId = resolveActorId(context);
    const category = isCategory(input.category) ? input.category : undefined;
    const tag = input.tag ? String(input.tag).trim() : undefined;
    const limit = Math.max(1, Math.min(200, Number(input.limit ?? 30)));
    const notes = notesService.listNotes({ sessionId, actorId: sessionId, category, tag, limit });
    return {
      ok: true,
      count: notes.length,
      notes: notes.map(stripNote),
    };
  });

  /* -----------------------------------------------------------------
   * notes.get
   * ----------------------------------------------------------------- */
  registry.register("notes.get", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    const note = notesService.getNote(id, actorId);
    if (!note) return { ok: false, error: "笔记不存在" };
    return { ok: true, note };
  });

  /* -----------------------------------------------------------------
   * notes.update
   * ----------------------------------------------------------------- */
  registry.register("notes.update", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填（必须先 notes.list/notes.search 拿到真实 id）" };
    const patch: Parameters<NotesService["updateNote"]>[1] = {};
    if (input.title !== undefined) patch.title = String(input.title).trim();
    if (input.content !== undefined) patch.content = String(input.content).trim();
    if (isCategory(input.category)) patch.category = input.category;
    if (Array.isArray(input.tags)) {
      patch.tags = input.tags.map((t) => String(t).trim()).filter(Boolean);
    }
    if (input.source !== undefined) {
      patch.source = input.source ? String(input.source).trim() : null;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: "至少传入一个可更新字段" };
    }
    try {
      const note = await notesService.updateNote(id, patch, actorId);
      return { ok: true, note, summary: "笔记已更新" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.delete
   * ----------------------------------------------------------------- */
  registry.register("notes.delete", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    try {
      const result = await notesService.deleteNote(id, actorId);
      return { ok: true, ...result, summary: "笔记已删除" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.search
   * ----------------------------------------------------------------- */
  registry.register("notes.search", async (input, context) => {
    const sessionId = resolveActorId(context);
    const query = String(input.query ?? "").trim();
    if (!query) return { ok: false, error: "query 必填" };
    const topK = Math.max(1, Math.min(50, Number(input.topK ?? 5)));
    const category = isCategory(input.category) ? input.category : undefined;
    const results = notesService.searchNotes(sessionId, query, topK, category, sessionId);
    return { ok: true, query, count: results.length, results };
  });

  /* -----------------------------------------------------------------
   * notes.summarize
   * ----------------------------------------------------------------- */
  registry.register("notes.summarize", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    const note = notesService.getNote(id, actorId);
    if (!note) return { ok: false, error: "笔记不存在" };
    const force = input.force === true;
    if (note.summary && !force) {
      return { ok: true, summary: note.summary, note, cached: true };
    }
    try {
      const summary = await generateNoteSummary(
        externalChat,
        note.sessionId,
        note.title,
        note.content,
      );
      const updated = await notesService.updateNote(id, { summary }, actorId);
      return { ok: true, summary, note: updated, cached: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.flashcards
   * ----------------------------------------------------------------- */
  registry.register("notes.flashcards", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    const note = notesService.getNote(id, actorId);
    if (!note) return { ok: false, error: "笔记不存在" };
    const count = Math.max(1, Math.min(20, Number(input.count ?? 5)));
    const persist = input.persist !== false;
    try {
      const cards = await generateNoteFlashcards(
        externalChat,
        note.sessionId,
        note.title,
        note.content,
        count,
      );
      const updated = persist
        ? await notesService.updateNote(id, { flashcards: cards }, actorId)
        : note;
      return { ok: true, flashcards: cards, note: updated };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.quiz
   * ----------------------------------------------------------------- */
  registry.register("notes.quiz", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    const note = notesService.getNote(id, actorId);
    if (!note) return { ok: false, error: "笔记不存在" };
    const count = Math.max(1, Math.min(20, Number(input.count ?? 3)));
    const persist = input.persist !== false;
    try {
      const quiz = await generateNoteQuiz(
        externalChat,
        note.sessionId,
        note.title,
        note.content,
        count,
      );
      const updated = persist
        ? await notesService.updateNote(id, { quiz }, actorId)
        : note;
      return { ok: true, quiz, note: updated };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.schedule_review
   * ----------------------------------------------------------------- */
  registry.register("notes.schedule_review", async (input, context) => {
    const sessionId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "id 必填" };
    const note = notesService.getNote(id, sessionId);
    if (!note) return { ok: false, error: "笔记不存在" };
    const runAt = String(input.runAt ?? "").trim();
    if (!runAt) return { ok: false, error: "runAt（ISO 时间）必填" };
    const tz = String(input.timezone ?? "Asia/Shanghai").trim() || "Asia/Shanghai";
    const recurrence = ["none", "daily", "weekly"].includes(String(input.recurrence ?? "none"))
      ? (String(input.recurrence ?? "none") as "none" | "daily" | "weekly")
      : "none";
    const reminderMessage =
      (input.reminderMessage ? String(input.reminderMessage).trim() : "") ||
      `复习笔记：${note.title}`;

    try {
      const task = await scheduleTaskService.createTask({
        sessionId,
        title: `复习：${note.title}`,
        description: `复习笔记《${note.title}》(${note.id})`,
        kind: "reminder",
        runAt,
        recurrence,
        timezone: tz,
        reminderMessage,
      });
      const reviewed = await notesService.markReviewed(id, sessionId);
      return {
        ok: true,
        taskId: task.taskId,
        nextRunAt: task.nextRunAt,
        whenSpoken: formatNextRunAtSpoken(task.nextRunAt, tz),
        note: reviewed,
        summary: "复习提醒已加入日程",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  });

  /* -----------------------------------------------------------------
   * notes.recall_main
   *
   * 供**笔记 Agent**在 notes 会话里查询主会话沉淀下来的记忆。
   * 与 `notes.recall_history` 镜像：双向独立存储、显式跨越。
   * 适用：用户在笔记页问"我主会话里说过相关话题吗"。
   * ----------------------------------------------------------------- */
  registry.register("notes.recall_main", async (input, context) => {
    if (!narrativeMemory) {
      return { ok: false, error: "narrativeMemory 未启用，无法跨上下文召回" };
    }
    const actorId = resolveActorId(context);
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { ok: false, error: "query 必填" };
    }
    const recall = await narrativeMemory.buildCrossContextRecall(actorId, query);
    const filtered = recall
      .split("\n")
      .filter((line) => {
        if (line.startsWith("以下为") || line.trim() === "") return true;
        if (/^\d+\.\s/.test(line)) {
          return line.includes(" [main]");
        }
        return true;
      })
      .join("\n");
    const trimmed = filtered.trim();
    if (!trimmed) {
      return { ok: true, query, recalled: "", summary: "无相关主会话记忆" };
    }
    return {
      ok: true,
      query,
      recalled: trimmed,
      summary: "已从主会话上下文召回相关记忆",
    };
  });

  /* -----------------------------------------------------------------
   * notes.recall_history
   *
   * 供**主 Agent**在主会话里查询笔记/学习会话里沉淀下来的记忆。
   * 默认仅查询 context=notes 记忆，避免与主会话记忆混淆。
   * 适用：用户问"我最近学过什么/笔记里有相关点吗"时，Agent 可显式调用。
   * ----------------------------------------------------------------- */
  registry.register("notes.recall_history", async (input, context) => {
    if (!narrativeMemory) {
      return { ok: false, error: "narrativeMemory 未启用，无法跨上下文召回" };
    }
    const actorId = resolveActorId(context);
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { ok: false, error: "query 必填" };
    }
    const scope: "notes" | "any" = input.scope === "any" ? "any" : "notes";
    // NarrativeMemoryFacade 的 buildCrossContextRecall 永远跨上下文召回
    // 并在每条 item 行尾加 ` [notes]` / ` [main]` 标签
    const recall = await narrativeMemory.buildCrossContextRecall(actorId, query);
    const filtered = scope === "notes"
      ? recall
          .split("\n")
          .filter((line) => {
            // 头部行（标题/说明）放行
            if (line.startsWith("以下为") || line.trim() === "") return true;
            // 列表项行 `${i}. 相关度...` 才需要过滤
            if (/^\d+\.\s/.test(line)) {
              return line.includes(" [notes]");
            }
            // 缩进行跟随上一条
            return true;
          })
          .join("\n")
      : recall;
    const trimmed = filtered.trim();
    if (!trimmed) {
      return { ok: true, query, scope, recalled: "", summary: "无相关笔记记忆" };
    }
    return {
      ok: true,
      query,
      scope,
      recalled: trimmed,
      summary: "已从笔记上下文召回相关记忆（仅展示与 query 相关的若干条）",
    };
  });
}

function stripNote(note: Note): Record<string, unknown> {
  return {
    id: note.id,
    title: note.title,
    category: note.category,
    tags: note.tags,
    source: note.source,
    summary: note.summary,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    lastReviewedAt: note.lastReviewedAt,
    reviewCount: note.reviewCount,
    hasFlashcards: Array.isArray(note.flashcards) && note.flashcards.length > 0,
    hasQuiz: Array.isArray(note.quiz) && note.quiz.length > 0,
    contentPreview: note.content.length <= 200 ? note.content : `${note.content.slice(0, 199)}…`,
  };
}
