/**
 * 资料库聚合路由（手机端「资料库」tab 唯一数据口）：
 *
 *   GET /api/library/items?sessionId=&userId=&limit=
 *
 * 把散在各处的「产出物」一次取齐，避免客户端打多个接口再拼：
 *   - files       file.write_text / file.export_format 落盘的产出文件（FileProcessingService）
 *   - images      文生图 / 图生图 / 图搜转存后的本地 PNG（ImageGenerationService，data/images/<actor>/）
 *   - notes       学习/知识笔记（NotesService）
 *   - travelPlans 已完成行程（travelPlanStore 冷层，与桌面端 GET /travel/plans 同一数据源、
 *                 同一 actor 分区，故电脑端生成/编辑过的行程卡片会同步出现在这里）
 *
 * 2026-11-09：新增 groups —— 按「每次对话」折叠的产物分组：
 *   { sessionId, title, updatedAt, counts, items:{files,images,notes,travelPlans} }
 * 图片/文件落盘时记录 sessionId（library-meta），历史产物无归属 → sessionId="" 的
 * 「历史记录」组。客户端据此一次对话只渲染一张卡，点进去看该次对话的全部产出。
 *
 * 只读聚合，不落任何新数据；单源缺失不挡整体（files/images/notes/travelPlans 可为空数组）。
 */
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { sideChatSessionId } from "../../agent/master-chat-session.js";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import type { NotesService } from "../../services/notes-service.js";
import { getSideChatRegistry } from "../../services/side-chat-registry.js";
import { travelPlanStore } from "../../skills/travel-planning/travel-plan-store.js";

type LibraryFileItem = ReturnType<FileProcessingService["listFiles"]>[number];
type LibraryImageItem = ReturnType<ImageGenerationService["listImages"]>[number];
type LibraryNoteItem = { id: string; title: string; category: string; tags: string[]; updatedAt: string; sessionId: string };
type LibraryTravelItem = {
  planId: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  stopCount: number;
  createdAt: number;
  coverImage: string;
  totalCost: number | null;
  sessionId: string;
};

type LibraryGroup = {
  /** 对话 id；空串 = 无归属的历史产物（客户端渲染为「历史记录」） */
  sessionId: string;
  /** 旁聊标题（主对话/历史为空串，客户端按时间兜底展示） */
  title: string;
  /** 组内最新产物的时间（安排排序） */
  updatedAt: string;
  counts: { files: number; images: number; notes: number; travelPlans: number };
  items: {
    files: LibraryFileItem[];
    images: LibraryImageItem[];
    notes: LibraryNoteItem[];
    travelPlans: LibraryTravelItem[];
  };
};

export function registerLibraryRoutes(
  app: FastifyInstance,
  deps: {
    fileProcessingService: FileProcessingService;
    notesService: NotesService | null;
    imageGenerationService: ImageGenerationService;
  },
): void {
  app.get("/api/library/items", async (request) => {
    const q = (request.query ?? {}) as { userId?: string; sessionId?: string; limit?: string };
    const sessionId = typeof q.sessionId === "string" ? q.sessionId : "";
    const actorId = resolveActorId({ userId: q.userId, sessionId });
    // 资料全在本机磁盘，默认全量返回、不截断；limit 仅在调用方显式传入时作为可选上限。
    const rawLimit = Number(q.limit);
    const limit = q.limit && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : Number.MAX_SAFE_INTEGER;

    // 产出文件：FileProcessingService 按 actor 分区落盘（data/user-files/<actor>/）
    const files = deps.fileProcessingService.listFiles(actorId, limit);

    // 图片：生成（文生图/图生图）与图搜转存共用 ImageGenerationService 的
    // data/images/<actor>/ 目录，统一在此列出，客户端不再另打图片接口。
    const images = deps.imageGenerationService.listImages(actorId, limit);

    // 笔记：跨会话取齐（每条自带 sessionId），按 actor 归属过滤
    const notes: LibraryNoteItem[] = deps.notesService
      ? deps.notesService.listNotesForActor(actorId, limit).map((n) => ({
          id: n.id,
          title: n.title,
          category: n.category as string,
          tags: n.tags,
          updatedAt: n.updatedAt,
          sessionId: n.sessionId,
        }))
      : [];

    // 已完成行程：与桌面端「行程」归档页（GET /travel/plans）共用 travelPlanStore，
    // 同一 actor 分区 → 电脑端生成过的行程卡片手机资料库可直接看到并点开详情。
    const travelPlans = travelPlanStore.listSummariesForActor(actorId, limit).map((p) => ({
      planId: p.planId,
      title: p.title,
      destination: p.destination,
      startDate: p.startDate,
      endDate: p.endDate,
      dayCount: p.dayCount,
      stopCount: p.stopCount,
      createdAt: p.createdAt,
      coverImage: p.coverImage ?? "",
      totalCost: p.totalCost ?? null,
      sessionId: p.sessionId ?? "",
    }));

    // 旁聊标题：sessionId → 标题（主对话无注册表条目，客户端按「对话」兜底）
    const titles = new Map<string, string>();
    try {
      const registry = getSideChatRegistry();
      for (const entry of await registry.list(actorId)) {
        if (entry.title?.trim()) titles.set(sideChatSessionId(actorId, entry.id), entry.title.trim());
      }
    } catch {
      // 标题缺失不影响分组
    }

    const groups = buildGroups({ files, images, notes, travelPlans, titles });

    return {
      ok: true,
      actorId,
      groups,
      sections: { files, images, notes, travelPlans },
      counts: {
        files: files.length,
        images: images.length,
        notes: notes.length,
        travelPlans: travelPlans.length,
      },
    };
  });
}

/** 把各来源产物按 sessionId 折叠成对话分组；无归属统一进「历史记录」组。 */
function buildGroups(input: {
  files: LibraryFileItem[];
  images: LibraryImageItem[];
  notes: LibraryNoteItem[];
  travelPlans: LibraryTravelItem[];
  titles: Map<string, string>;
}): LibraryGroup[] {
  const byKey = new Map<string, LibraryGroup>();

  const ensure = (key: string): LibraryGroup => {
    let group = byKey.get(key);
    if (!group) {
      group = {
        sessionId: key,
        title: key ? (input.titles.get(key) ?? "") : "",
        updatedAt: "",
        counts: { files: 0, images: 0, notes: 0, travelPlans: 0 },
        items: { files: [], images: [], notes: [], travelPlans: [] },
      };
      byKey.set(key, group);
    }
    return group;
  };

  const touch = (group: LibraryGroup, iso: string) => {
    if (iso && iso > group.updatedAt) group.updatedAt = iso;
  };

  for (const f of input.files) {
    const g = ensure(f.sessionId ?? "");
    g.items.files.push(f);
    g.counts.files += 1;
    touch(g, f.updatedAt);
  }
  for (const img of input.images) {
    const g = ensure(img.sessionId ?? "");
    g.items.images.push(img);
    g.counts.images += 1;
    touch(g, img.updatedAt);
  }
  for (const n of input.notes) {
    // 无 sessionId 的旧笔记：只有 sessionId 恰好等于 actor 时才归主对话，否则进历史组。
    const g = ensure(n.sessionId ?? "");
    g.items.notes.push(n);
    g.counts.notes += 1;
    touch(g, n.updatedAt);
  }
  for (const p of input.travelPlans) {
    const g = ensure(p.sessionId ?? "");
    g.items.travelPlans.push(p);
    g.counts.travelPlans += 1;
    const ms = Number(p.createdAt ?? 0);
    if (Number.isFinite(ms) && ms > 0) {
      touch(g, new Date(ms).toISOString());
    }
  }

  const list = [...byKey.values()].filter(
    (g) =>
      g.counts.files + g.counts.images + g.counts.notes + g.counts.travelPlans > 0,
  );
  // 有新→旧；「历史记录」组永远排最后（产物无来源信息，不抢新对话的位置）。
  const history = list.find((g) => g.sessionId === "");
  const rest = list
    .filter((g) => g.sessionId !== "")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return history ? [...rest, history] : rest;
}
