/**
 * 学习/知识笔记 HTTP 路由
 *
 * 端点：
 *   GET    /notes                    列表（按 sessionId + 过滤）
 *   GET    /notes/:id                详情
 *   POST   /notes                    创建
 *   PATCH  /notes/:id                更新
 *   DELETE /notes/:id                删除
 *   POST   /notes/search             关键词检索（BM25 + 标题/正文包含加权）
 *   POST   /notes/:id/summarize      生成/返回摘要（懒写回）
 *   POST   /notes/:id/flashcards     生成记忆卡片
 *   POST   /notes/:id/quiz           生成自测题
 *   POST   /notes/:id/schedule-review 创建复习提醒（落入 schedule）
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { ScheduleTaskService } from "../../services/schedule-task-service.js";
import {
  notesCreateBodySchema,
  notesListQuerySchema,
  notesScheduleReviewBodySchema,
  notesSearchBodySchema,
  notesUpdateBodySchema,
} from "../../schemas/api.js";
import { formatNextRunAtLocal } from "../../tools/calendar-tools.js";
import {
  generateNoteFlashcards,
  generateNoteQuiz,
  generateNoteSummary,
} from "../../services/notes-ai.js";
import type { NotesService } from "../../services/notes-service.js";

/** 从鉴权钉死后的 query/body 解析调用者身份（缺省按 sessionId）。 */
function actorOf(request: FastifyRequest, sessionId?: string, userId?: string): string {
  const q = (request.query ?? {}) as Record<string, unknown>;
  const b = (request.body ?? {}) as Record<string, unknown>;
  const uid =
    userId ??
    (typeof q.userId === "string" ? q.userId : typeof b.userId === "string" ? b.userId : undefined);
  const sid =
    sessionId ??
    (typeof q.sessionId === "string"
      ? q.sessionId
      : typeof b.sessionId === "string"
        ? b.sessionId
        : "");
  return resolveActorId({ userId: uid, sessionId: sid });
}

export function registerNotesRoutes(
  app: FastifyInstance,
  deps: { notesService: NotesService; scheduleTaskService: ScheduleTaskService; externalChat: ExternalChatProvider | null },
): void {
  const { notesService, scheduleTaskService, externalChat } = deps;

  app.get("/notes", async (request, reply) => {
    const parsed = notesListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, userId, category, tag, from, to, limit } = parsed.data;
    const actorId = actorOf(request, sessionId, userId);
    const notes = notesService.listNotes({ sessionId, actorId, category, tag, from, to, limit });
    return { ok: true, notes, count: notes.length };
  });

  app.get<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    const note = notesService.getNote(request.params.id, actorOf(request));
    if (!note) return reply.code(404).send({ ok: false, error: "笔记不存在" });
    return { ok: true, note };
  });

  app.post("/notes", async (request, reply) => {
    const parsed = notesCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const note = await notesService.createNote({
        ...parsed.data,
        actorId: actorOf(request, parsed.data.sessionId, parsed.data.userId),
      });
      return reply.code(201).send({ ok: true, note });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.patch<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    const parsed = notesUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const note = await notesService.updateNote(request.params.id, parsed.data, actorOf(request));
      return { ok: true, note };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = /不存在/.test(message) ? 404 : 400;
      return reply.code(code).send({ ok: false, message });
    }
  });

  app.delete<{ Params: { id: string } }>("/notes/:id", async (request, reply) => {
    try {
      const result = await notesService.deleteNote(request.params.id, actorOf(request));
      return { ok: true, ...result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = /不存在/.test(message) ? 404 : 400;
      return reply.code(code).send({ ok: false, message });
    }
  });

  app.post("/notes/search", async (request, reply) => {
    const parsed = notesSearchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, userId, query, topK, category } = parsed.data;
    const results = notesService.searchNotes(
      sessionId,
      query,
      topK,
      category,
      actorOf(request, sessionId, userId),
    );
    return { ok: true, query, results, count: results.length };
  });

  app.post<{ Params: { id: string } }>("/notes/:id/summarize", async (request, reply) => {
    const note = notesService.getNote(request.params.id, actorOf(request));
    if (!note) return reply.code(404).send({ ok: false, error: "笔记不存在" });
    if (note.summary) {
      return { ok: true, note, summary: note.summary, cached: true };
    }
    try {
      const summary = await generateNoteSummary(
        externalChat ?? null,
        note.sessionId,
        note.title,
        note.content,
      );
      const updated = await notesService.updateNote(note.id, { summary }, actorOf(request));
      return { ok: true, note: updated, summary, cached: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { count?: number; persist?: boolean };
  }>("/notes/:id/flashcards", async (request, reply) => {
    const note = notesService.getNote(request.params.id, actorOf(request));
    if (!note) return reply.code(404).send({ ok: false, error: "笔记不存在" });
    const count = Math.max(1, Math.min(20, Number(request.body?.count ?? 5)));
    const persist = request.body?.persist !== false;
    try {
      const cards = await generateNoteFlashcards(
        externalChat ?? null,
        note.sessionId,
        note.title,
        note.content,
        count,
      );
      const updated = persist
        ? await notesService.updateNote(note.id, { flashcards: cards }, actorOf(request))
        : note;
      return { ok: true, note: updated, flashcards: cards };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { count?: number; persist?: boolean };
  }>("/notes/:id/quiz", async (request, reply) => {
    const note = notesService.getNote(request.params.id, actorOf(request));
    if (!note) return reply.code(404).send({ ok: false, error: "笔记不存在" });
    const count = Math.max(1, Math.min(20, Number(request.body?.count ?? 3)));
    const persist = request.body?.persist !== false;
    try {
      const quiz = await generateNoteQuiz(
        externalChat ?? null,
        note.sessionId,
        note.title,
        note.content,
        count,
      );
      const updated = persist
        ? await notesService.updateNote(note.id, { quiz }, actorOf(request))
        : note;
      return { ok: true, note: updated, quiz };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, message });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/notes/:id/schedule-review",
    async (request, reply) => {
      const note = notesService.getNote(request.params.id, actorOf(request));
      if (!note) return reply.code(404).send({ ok: false, error: "笔记不存在" });
      const parsed = notesScheduleReviewBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const { sessionId, userId, runAt, timezone, recurrence, reminderMessage } = parsed.data;
      const actorId = actorOf(request, sessionId, userId);
      if (sessionId !== note.sessionId) {
        return reply.code(400).send({ ok: false, message: "sessionId 与笔记归属不一致" });
      }
      try {
        const message = (reminderMessage ?? `复习笔记：${note.title}`).trim();
        const task = await scheduleTaskService.createTask({
          sessionId,
          title: `复习：${note.title}`,
          description: `复习笔记《${note.title}》(${note.id})`,
          kind: "reminder",
          runAt,
          recurrence,
          timezone: timezone?.trim() || "Asia/Shanghai",
          reminderMessage: message,
        });
        const reviewed = await notesService.markReviewed(note.id, actorId);
        return {
          ok: true,
          task,
          taskId: task.taskId,
          nextRunAt: task.nextRunAt,
          nextRunAtLocal: formatNextRunAtLocal(task.nextRunAt, timezone || "Asia/Shanghai"),
          note: reviewed,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ ok: false, message });
      }
    },
  );
}
