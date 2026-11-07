/**
 * 资料库聚合路由（手机端「资料库」tab 唯一数据口）：
 *
 *   GET /api/library/items?sessionId=&userId=&limit=
 *
 * 把散在各处的「产出物」一次取齐，避免客户端打多个接口再拼：
 *   - files       file.write_text / file.export_format 落盘的产出文件（FileProcessingService）
 *   - notes       学习/知识笔记（NotesService，按 sessionId 归属）
 *   - travelPlans 行程规划会话摘要（travel-plan-session 落盘会话，复用 listPlanSessionSummaries）
 *
 * 只读聚合，不落任何新数据；单源缺失不挡整体（files/notes 可为空数组）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { NotesService } from "../../services/notes-service.js";
import { listPlanSessionSummaries } from "../../skills/travel-planning/travel-plan-session.js";

export function registerLibraryRoutes(
  app: FastifyInstance,
  deps: { fileProcessingService: FileProcessingService; notesService: NotesService | null },
): void {
  app.get("/api/library/items", async (request) => {
    const q = (request.query ?? {}) as { userId?: string; sessionId?: string; limit?: string };
    const sessionId = typeof q.sessionId === "string" ? q.sessionId : "";
    const actorId = resolveActorId({ userId: q.userId, sessionId });
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);

    // 产出文件：FileProcessingService 按 actor 分区落盘（data/user-files/<actor>/）
    const files = deps.fileProcessingService.listFiles(actorId, limit);

    // 笔记：NotesService 按 sessionId 分桶 + actor 归属过滤（与 /notes 同口径）
    const notes = deps.notesService
      ? deps.notesService
          .listNotes({ sessionId, actorId, limit })
          .map((n) => ({
            id: n.id,
            title: n.title,
            category: n.category as string,
            tags: n.tags,
            updatedAt: n.updatedAt,
          }))
      : [];

    // 行程规划会话摘要（与 GET /travel/plan-sessions 同一函数，口径一致）
    const travelPlans = listPlanSessionSummaries(actorId, limit).map((s) => ({
      id: s.id,
      destination: s.destination,
      days: s.days,
      startDate: s.startDate,
      endDate: s.endDate,
      state: s.state,
      originalMessage: s.originalMessage,
      updatedAt: s.updatedAt,
    }));

    return {
      ok: true,
      actorId,
      sections: { files, notes, travelPlans },
      counts: {
        files: files.length,
        notes: notes.length,
        travelPlans: travelPlans.length,
      },
    };
  });
}
