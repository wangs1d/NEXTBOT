import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveActorId } from "../../agent/actor-id.js";
import type { IcsSubscriptionService } from "../../services/ics-subscription-service.js";
import type { IngestService } from "../../services/ingest-service.js";
import type { IngestPayload } from "../../services/ingest-types.js";

/**
 * 数据入口（Ingest）HTTP 子域——**用户自助上传数据的唯一入口**。
 *
 *   POST /ingest/preview     上传任意载体（截图 / 表格 / ics / 粘贴文本）→ 返回可勾选草稿
 *   POST /ingest/commit      确认草稿中的条目 → 写台账
 *   GET  /ingest/items       看已入库的条目（课表 / DDL 清单）
 *   POST /ingest/remove      删条目（keys 为空 = 清空）
 *   GET  /ingest/capability  当前能不能读图 / 有没有可用模型（入口页据此提示）
 *
 * 为什么是"两段式"而不是一次上传直接入库：抽取必然有误（把周二读成周三、
 * 把第3-4节读成第1-2节），静默入库的代价是用户错过一节课才发现。
 * preview 让用户先核对，commit 才算数——见 ingest-service 的说明。
 *
 * 为什么不在这里判断"这是课表还是行程表"：载体形态由内容判定（detectPayloadKind），
 * 用户的 `hint` 只进提示词。这样新增来源（健身房课表、排班表）不需要改代码。
 */

const previewBodySchema = z.object({
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  payload: z.object({
    /** 不信任调用方给的 kind：只按内容判定，避免"标成 ics 但内容不是"走错分支 */
    kind: z.string().optional(),
    text: z.string().max(400_000).optional(),
    /** Excel 二进制（base64）；ics/csv 这类纯文本请走 text，不要走二进制 */
    fileBase64: z.string().max(30_000_000).optional(),
    imageBase64: z.string().max(20_000_000).optional(),
    imageMimeType: z.string().max(80).optional(),
    fileName: z.string().max(260).optional(),
    hint: z.string().max(200).optional(),
  }),
});

const commitBodySchema = z.object({
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  draftId: z.string().min(1).max(80),
  /** 缺省 = 草稿全部条目；传空数组 = 一条都不要 */
  keys: z.array(z.string().max(200)).max(2000).optional(),
});

const removeBodySchema = z.object({
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  keys: z.array(z.string().max(200)).max(2000).optional(),
});

const itemsQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const subscribeBodySchema = z.object({
  name: z.string().max(60).optional(),
  url: z.string().min(8).max(2000),
});

const unsubscribeBodySchema = z.object({
  name: z.string().min(1).max(2000),
});

export function registerIngestRoutes(
  app: FastifyInstance,
  deps: {
    ingestService?: IngestService;
    icsSubscriptionService?: IcsSubscriptionService;
  },
): void {
  const { ingestService } = deps;

  app.post("/ingest/preview", async (request, reply) => {
    if (!ingestService) {
      return reply.code(503).send({ ok: false, message: "数据入口未启用" });
    }
    const parsed = previewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const payload = parsed.data.payload;
    if (!payload.text && !payload.imageBase64 && !payload.fileBase64) {
      return reply
        .code(400)
        .send({ ok: false, message: "没有收到内容：text / fileBase64 / imageBase64 至少给一个" });
    }

    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const result = await ingestService.preview({
      actorId,
      sessionId: parsed.data.sessionId,
      payload: {
        // kind 由服务端按内容判定，这里给个占位值
        kind: "prose",
        text: payload.text,
        fileBase64: payload.fileBase64,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        fileName: payload.fileName,
        hint: payload.hint,
      } satisfies IngestPayload,
    });
    return { ok: !result.error, actorId, ...result };
  });

  app.post("/ingest/commit", async (request, reply) => {
    if (!ingestService) {
      return reply.code(503).send({ ok: false, message: "数据入口未启用" });
    }
    const parsed = commitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const result = await ingestService.commit({
      actorId,
      draftId: parsed.data.draftId,
      keys: parsed.data.keys,
    });
    if (result.written === 0 && result.totalInLedger === 0) {
      // 草稿不存在/已过期/不属于该用户：如实说，别静默成功
      return reply.code(404).send({ ok: false, message: "草稿不存在或已过期（草稿保留 2 小时），请重新上传" });
    }
    return { ok: true, actorId, ...result };
  });

  app.get("/ingest/items", async (request, reply) => {
    if (!ingestService) {
      return reply.code(503).send({ ok: false, message: "数据入口未启用" });
    }
    const parsed = itemsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const { items, updatedAt } = ingestService.list(actorId);
    return { ok: true, actorId, updatedAt, count: items.length, items };
  });

  app.post("/ingest/remove", async (request, reply) => {
    if (!ingestService) {
      return reply.code(503).send({ ok: false, message: "数据入口未启用" });
    }
    const parsed = removeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const actorId = resolveActorId({
      userId: parsed.data.userId,
      sessionId: parsed.data.sessionId ?? "",
    });
    const result = await ingestService.remove({ actorId, keys: parsed.data.keys });
    return { ok: true, actorId, ...result };
  });

  app.get("/ingest/capability", async (_request, reply) => {
    if (!ingestService) {
      return reply.code(503).send({ ok: false, message: "数据入口未启用" });
    }
    return { ok: true, ...ingestService.capability() };
  });

  // ---- 日历订阅（上班族安排表的最优路径）---------------------------------
  //
  // Outlook / Google / 飞书 / 企微 / 钉钉 都能给出一个**只读的 ics 订阅链接**：
  // 不用给密码、可随时撤销、会议改期自动跟着变。粘一次链接，长期自动同步。
  // 这条路径之前只能靠环境变量 ICS_SUB_URLS 配置，等于"必须由部署方动手"，
  // 现在改成用户自己能加能删。

  app.get("/ingest/subscriptions", async (_request, reply) => {
    const ics = deps.icsSubscriptionService;
    if (!ics) {
      return reply.code(503).send({ ok: false, message: "日历订阅未启用" });
    }
    return { ok: true, ...ics.status() };
  });

  app.post("/ingest/subscriptions", async (request, reply) => {
    const ics = deps.icsSubscriptionService;
    if (!ics) {
      return reply.code(503).send({ ok: false, message: "日历订阅未启用" });
    }
    const parsed = subscribeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = await ics.addFeed({ name: parsed.data.name, url: parsed.data.url });
    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.error });
    }
    return { ...result, status: ics.status() };
  });

  app.post("/ingest/subscriptions/remove", async (request, reply) => {
    const ics = deps.icsSubscriptionService;
    if (!ics) {
      return reply.code(503).send({ ok: false, message: "日历订阅未启用" });
    }
    const parsed = unsubscribeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const result = ics.removeFeed(parsed.data.name);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.error });
    }
    return { ...result, status: ics.status() };
  });
}
