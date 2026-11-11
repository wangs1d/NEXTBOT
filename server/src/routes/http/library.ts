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

    const groups = buildGroups({ actorId, files, images, notes, travelPlans, titles });

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

/** 无轮次归属的主对话历史产物按时间间隙聚类的阈值：30 分钟内的产出视为同一次对话。 */
const LEGACY_TURN_CLUSTER_GAP_MS = 30 * 60 * 1000;

/** 组键分隔符（不可见字符，不与 sessionId/turnId 字符集冲突）。 */
const KEY_SEP = "\u241E";

/** 把各来源产物折叠成「每次对话一张卡」；无归属统一进「历史记录」组。
 * 2026-11-12 改版：主对话是单一会话（sessionId=actorId 恒定），原来按 sessionId
 * 折叠会把主对话全部产物挤进一张卡。现规则：
 *   - 主对话产物带轮次归属（turnId，落盘时记录）→ 每次对话一张卡，卡标题取用户请求原文；
 *   - 主对话历史产物（升级前落盘，无轮次）→ 按 30 分钟时间间隙聚类近似还原「每次对话」；
 *   - 旁聊等其它会话 → 仍按会话一张卡（标题取旁聊注册表）；
 *   - 无归属产物 → 「历史记录」组，永远排最后。
 *
 * 导出仅为单测（library-groups.test.ts）。
 */
export function buildGroups(input: {
  actorId: string;
  files: LibraryFileItem[];
  images: LibraryImageItem[];
  notes: LibraryNoteItem[];
  travelPlans: LibraryTravelItem[];
  titles: Map<string, string>;
}): LibraryGroup[] {
  const byKey = new Map<string, LibraryGroup>();

  const ensure = (key: string, title = ""): LibraryGroup => {
    let group = byKey.get(key);
    if (!group) {
      group = {
        sessionId: key,
        title: key ? title : "",
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

  /**
   * 组键裁决：
   *   - 无归属 → 历史组（""）；
   *   - 主对话 + 有轮次 → 每次对话独立组；
   *   - 其余（旁聊会话 / 主对话无轮次）→ 返回 null 表示交给调用方细分
   *     （旁聊直接整组，主对话无轮次走时间聚类）。
   */
  const keyFor = (sessionId: string, turnId: string): string | null => {
    if (!sessionId) return "";
    if (sessionId === input.actorId) {
      return turnId ? `${sessionId}${KEY_SEP}turn${KEY_SEP}${turnId}` : null;
    }
    return sessionId;
  };

  // 主对话无轮次归属的产物（升级前落盘）：按 updatedAt 时间间隙聚类
  type LegacyWrap = {
    kind: "files" | "images" | "notes" | "travelPlans";
    sessionId: string;
    updatedAt: string;
    item: LibraryFileItem | LibraryImageItem | LibraryNoteItem | LibraryTravelItem;
  };
  const legacyPending: LegacyWrap[] = [];
  const pushOrDefer = (
    wrap: LegacyWrap,
    write: (group: LibraryGroup) => void,
  ): void => {
    const key = keyFor(wrap.sessionId, "");
    if (key !== null) {
      write(ensure(key, input.titles.get(key) ?? ""));
      return;
    }
    legacyPending.push(wrap);
  };

  for (const f of input.files) {
    // 轮次拆分只作用于主对话：旁聊等其它会话保持「一整个会话一张卡」。
    const turnKey = f.sessionId === input.actorId && f.turnId
      ? `${f.sessionId}${KEY_SEP}turn${KEY_SEP}${f.turnId}`
      : null;
    if (turnKey) {
      const g = ensure(turnKey, f.turnTitle ?? "");
      g.items.files.push(f);
      g.counts.files += 1;
      touch(g, f.updatedAt);
    } else {
      pushOrDefer(
        { kind: "files", sessionId: f.sessionId ?? "", updatedAt: f.updatedAt, item: f },
        (g) => {
          g.items.files.push(f);
          g.counts.files += 1;
          touch(g, f.updatedAt);
        },
      );
    }
  }
  for (const img of input.images) {
    const turnKey = img.sessionId === input.actorId && img.turnId
      ? `${img.sessionId}${KEY_SEP}turn${KEY_SEP}${img.turnId}`
      : null;
    if (turnKey) {
      const g = ensure(turnKey, img.turnTitle ?? "");
      g.items.images.push(img);
      g.counts.images += 1;
      touch(g, img.updatedAt);
    } else {
      pushOrDefer(
        { kind: "images", sessionId: img.sessionId ?? "", updatedAt: img.updatedAt, item: img },
        (g) => {
          g.items.images.push(img);
          g.counts.images += 1;
          touch(g, img.updatedAt);
        },
      );
    }
  }
  for (const n of input.notes) {
    // 笔记只有会话归属（无轮次）：主对话笔记按时间聚类，其余按会话整组。
    pushOrDefer(
      { kind: "notes", sessionId: n.sessionId ?? "", updatedAt: n.updatedAt, item: n },
      (g) => {
        g.items.notes.push(n);
        g.counts.notes += 1;
        touch(g, n.updatedAt);
      },
    );
  }
  for (const p of input.travelPlans) {
    const ms = Number(p.createdAt ?? 0);
    const iso = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
    pushOrDefer(
      { kind: "travelPlans", sessionId: p.sessionId ?? "", updatedAt: iso, item: p },
      (g) => {
        g.items.travelPlans.push(p);
        g.counts.travelPlans += 1;
        touch(g, iso);
      },
    );
  }

  // 主对话无轮次的产物：新→旧排序后按 30 分钟间隙切簇，每簇一张卡（标题空 → 客户端按时间兜底）。
  legacyPending.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let current: { key: string; lastMs: number } | null = null;
  for (const w of legacyPending) {
    const ms = w.updatedAt ? Date.parse(w.updatedAt) : NaN;
    const sameCluster =
      current !== null &&
      Number.isFinite(ms) &&
      current.lastMs - ms <= LEGACY_TURN_CLUSTER_GAP_MS;
    if (!sameCluster) {
      current = { key: `${w.sessionId}${KEY_SEP}gap${KEY_SEP}${w.updatedAt}`, lastMs: Number.isFinite(ms) ? ms : 0 };
    }
    if (!current) continue;
    const g = ensure(current.key);
    if (w.kind === "files") {
      g.items.files.push(w.item as LibraryFileItem);
      g.counts.files += 1;
    } else if (w.kind === "images") {
      g.items.images.push(w.item as LibraryImageItem);
      g.counts.images += 1;
    } else if (w.kind === "notes") {
      g.items.notes.push(w.item as LibraryNoteItem);
      g.counts.notes += 1;
    } else {
      g.items.travelPlans.push(w.item as LibraryTravelItem);
      g.counts.travelPlans += 1;
    }
    touch(g, w.updatedAt);
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
