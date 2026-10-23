import { getDataDir } from "../../config/data-dir.js";
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

import type { FastifyInstance } from "fastify";

import { adminAudit, requireAdmin } from "./admin-auth.js";
import { adminInboxSendBodySchema } from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 管理后台「消息发送」：平台 → 用户站内信的运营发送入口。
 *
 * 与开放路由 routes/http/inbox.ts 的边界：那边是服务内部/工具调用的
 * 点对点推送（自带 userId）；这边面向运营者，负责收件人解析
 * （全体 / 指定用户 / 分组）、发送台账与管理审计，全部走 requireAdmin。
 *
 * - GET  /api/admin/inbox/recipients   收件人候选（用户列表 + 分组计数）
 * - POST /api/admin/inbox/send         群发/单发（先落盘必达 + 在线 WS 直推）
 * - GET  /api/admin/inbox/sent         发送记录（台账倒序）
 *
 * 存储复用 InboxService（data/inbox/{actorId}.json，字段即
 * 接收人 ID/标题/内容/已读状态/发送时间）；本文件只追加一份发送台账
 * data/inbox/_admin-sent-log.jsonl（5MB 轮转保留一代）供后台回看。
 */

const SENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 内置分组定义：从账号状态推导，无独立分组实体 */
const GROUPS = [
  { key: "active", label: "正常用户" },
  { key: "disabled", label: "已禁用用户" },
  { key: "new7d", label: "近 7 日注册" },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

function sentLogPath(): string {
  return join(getDataDir(), "inbox", "_admin-sent-log.jsonl");
}

async function appendSentLog(entry: Record<string, unknown>): Promise<void> {
  const path = sentLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    try {
      const s = await stat(path);
      if (s.size > SENT_LOG_MAX_BYTES) {
        await rename(path, `${path}.1`).catch(() => {});
      }
    } catch {
      // 首次写入：文件尚不存在
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("[admin-inbox] sent log write failed:", err);
  }
}

async function readSentLog(limit: number): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(sentLogPath(), "utf8");
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed?.time && parsed?.title) entries.push(parsed);
    } catch {
      // 跳过损坏行
    }
  }
  return entries.slice(-limit).reverse();
}

function matchGroup(
  account: { disabled?: boolean; createdAt: string },
  group: GroupKey,
): boolean {
  const now = Date.now();
  switch (group) {
    case "active":
      return !account.disabled;
    case "disabled":
      return Boolean(account.disabled);
    case "new7d":
      return Date.parse(account.createdAt) >= now - 7 * 86_400_000;
  }
}

export function registerAdminInboxRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const hub = (): NonNullable<HttpRouteDeps["inboxService"]> => {
    if (!deps.inboxService) throw Object.assign(new Error("inbox service not enabled"), { statusCode: 503 });
    return deps.inboxService;
  };

  // 收件人候选：全量账号 + 分组计数（选择器与发送前的人数预览共用）
  app.get("/api/admin/inbox/recipients", { preHandler: requireAdmin }, async () => {
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const users = accounts
      .map((a) => ({
        userId: a.userId,
        displayName: a.displayName,
        email: a.email ?? null,
        disabled: Boolean(a.disabled),
        setupComplete: Boolean(a.setupComplete),
        createdAt: a.createdAt,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      ok: true,
      groups: [
        { key: "all", label: "全体用户", count: users.length },
        ...GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          count: users.filter((u) =>
            matchGroup({ disabled: u.disabled, createdAt: u.createdAt }, g.key),
          ).length,
        })),
      ],
      users,
    };
  });

  app.post("/api/admin/inbox/send", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = adminInboxSendBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { title, body, kind, importance, targetType, userIds, group } = parsed.data;
    const inbox = hub();
    const accounts = deps.agentAccountService?.listAll() ?? [];
    const byId = new Map(accounts.map((a) => [a.userId, a]));

    // 收件人解析：all = 全体；users = 指定列表（未知 ID 跳过并回报）；
    // group = 按账号状态过滤。解析全部在服务端做，前端人数仅作预览。
    const skipped: string[] = [];
    let targets: string[] = [];
    if (targetType === "all") {
      targets = accounts.map((a) => a.userId);
    } else if (targetType === "users") {
      for (const id of userIds ?? []) {
        if (byId.has(id)) targets.push(id);
        else skipped.push(id);
      }
    } else {
      targets = accounts
        .filter((a) => group && matchGroup(a, group))
        .map((a) => a.userId);
    }
    targets = [...new Set(targets)];
    if (targets.length === 0) {
      return reply.code(400).send({ ok: false, message: "没有可发送的收件人" });
    }

    // 逐人落盘（InboxService 必达语义）；批次幂等键按目标展开，整包重试不产生重复
    const batchId = `admin_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    let deliveredLive = 0;
    const targetResults: Array<{ userId: string; deliveredLive: boolean }> = [];
    for (const target of targets) {
      const sent = await inbox.send({
        actorId: target,
        title,
        body,
        kind: kind ?? "announcement",
        importance,
        fromActorId: "admin",
        messageId: `${batchId}:${target}`,
      });
      targetResults.push({ userId: target, deliveredLive: sent.deliveredLive });
      if (sent.deliveredLive) deliveredLive++;
    }

    const logEntry = {
      time: new Date().toISOString(),
      batchId,
      title,
      body,
      kind: kind ?? "announcement",
      importance: importance ?? "normal",
      targetType,
      ...(targetType === "group" ? { group } : {}),
      ...(targetType === "users" ? { userIds: targets } : {}),
      targets: targetResults,
      recipients: targets.length,
      deliveredLive,
    };
    await appendSentLog(logEntry);
    await adminAudit(
      "inbox.send",
      { batchId, title, targetType, ...(targetType === "group" ? { group } : {}), recipients: targets.length, deliveredLive },
      request,
    );
    return {
      ok: true,
      batchId,
      sent: targets.length,
      deliveredLive,
      ...(skipped.length ? { skipped } : {}),
    };
  });

  app.get("/api/admin/inbox/sent", { preHandler: requireAdmin }, async (request) => {
    const q = request.query as { limit?: string } | undefined;
    const parsed = q?.limit ? Number.parseInt(q.limit, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return { ok: true, entries: await readSentLog(limit) };
  });

  // 单次发送的逐人明细：每个收件人的送达方式与已读状态（供后台「详情」展开）
  app.get<{ Params: { batchId: string } }>(
    "/api/admin/inbox/sent/:batchId",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const batchId = String(request.params.batchId ?? "").trim();
      if (!/^[A-Za-z0-9_-]+$/.test(batchId)) {
        return reply.code(400).send({ ok: false, message: "invalid batchId" });
      }
      const entry = (await readSentLog(200)).find((e) => e.batchId === batchId);
      if (!entry) {
        return reply.code(404).send({ ok: false, message: "record not found" });
      }
      const accounts = deps.agentAccountService?.listAll() ?? [];
      const byId = new Map(accounts.map((a) => [a.userId, a]));

      // 新台账自带逐人列表；旧台账（无 targets）按当前账号快照重解析
      let targets = entry.targets as Array<{ userId: string; deliveredLive: boolean }> | undefined;
      if (!Array.isArray(targets) || targets.length === 0) {
        let ids: string[] = [];
        const targetType = String(entry.targetType ?? "");
        if (targetType === "all") {
          ids = accounts.map((a) => a.userId);
        } else if (targetType === "users") {
          ids = Array.isArray(entry.userIds) ? (entry.userIds as string[]) : [];
        } else if (targetType === "group") {
          const group = String(entry.group ?? "") as GroupKey;
          ids = accounts.filter((a) => matchGroup(a, group)).map((a) => a.userId);
        }
        targets = ids.map((userId) => ({ userId, deliveredLive: false }));
      }

      const inbox = hub();
      const rows: Array<{
        userId: string;
        displayName: string | null;
        accountGone: boolean;
        deliveredLive: boolean;
        found: boolean;
        read: boolean | null;
        readAt: string | null;
      }> = [];
      for (const t of targets) {
        const acc = byId.get(t.userId);
        const messages = await inbox.list(t.userId, { limit: 500 });
        const msg = messages.find((m) => m.messageId === `${batchId}:${t.userId}`);
        rows.push({
          userId: t.userId,
          displayName: acc?.displayName ?? null,
          accountGone: !acc,
          deliveredLive: Boolean(t.deliveredLive),
          found: Boolean(msg),
          read: msg ? msg.readAt != null : null,
          readAt: msg?.readAt ?? null,
        });
      }
      rows.sort((a, b) => Number(a.read === true) - Number(b.read === true));
      return {
        ok: true,
        entry,
        rows,
        total: rows.length,
        readCount: rows.filter((r) => r.read === true).length,
      };
    },
  );

  // 单个用户的完整收件箱（含已读状态），供后台逐人排查
  app.get<{ Params: { userId: string } }>(
    "/api/admin/inbox/user/:userId",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const userId = String(request.params.userId ?? "").trim();
      // 账号主键现已统一为登录邮箱（含 @ / +），这里只拦路径级危险字符；
      // InboxService 落盘时另有一层 safe() 文件名净化
      if (!/^[A-Za-z0-9._@+-]+$/.test(userId)) {
        return reply.code(400).send({ ok: false, message: "invalid userId" });
      }
      const inbox = hub();
      const [messages, unreadCount] = await Promise.all([
        inbox.list(userId, { limit: 100 }),
        inbox.unreadCount(userId),
      ]);
      return { ok: true, userId, unreadCount, messages };
    },
  );
}
