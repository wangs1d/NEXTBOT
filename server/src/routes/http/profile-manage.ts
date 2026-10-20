import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { applyProfileOps, verifyProfileOps } from "../../brain/user-profile-aggregator.js";
import {
  touchProfileLines,
  readProfileMeta,
  parseProfileLines,
} from "../../brain/profile-lines-meta.js";
import { UserProfileStore } from "../../services/user-personalization/user-profile-store.js";

const SECTION_KEYS = new Set(["basic", "interest", "communication", "note"]);
const SECTION_TITLE_TO_KEY: Record<string, string> = {
  基本信息: "basic",
  兴趣与习惯: "interest",
  沟通偏好: "communication",
  备注: "note",
};

/**
 * 「它眼里的你」记忆管理 API（2026-09-29 P0-1，对标 ChatGPT Saved Memories）：
 * 用户可见、可改、可删自己的画像行。理解档案/事实库 v1 只读展示（它们自带
 * 演变历史，改写语义交还给对话中的纠正回路，避免用户直改破坏演变链）。
 */
export function registerProfileManageRoutes(app: FastifyInstance): void {
  app.get("/api/profile/manage", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });

    const store = new UserProfileStore();
    const markdown = await store.read(actorId);
    const meta = await readProfileMeta(actorId);
    const metaByLine = new Map(meta.map((m) => [m.line, m]));

    const sections = new Map<
      string,
      { key: string; title: string; lines: Array<Record<string, unknown>> }
    >();
    for (const { section, line } of parseProfileLines(markdown)) {
      const key = SECTION_TITLE_TO_KEY[section] ?? section;
      if (!sections.has(key)) sections.set(key, { key, title: section, lines: [] });
      const m = metaByLine.get(line);
      sections.get(key)!.lines.push({
        text: line,
        lastConfirmedAt: m?.lastConfirmedAt ?? null,
        seenCount: m?.seenCount ?? 0,
      });
    }

    // 理解档案 / 事实库只读概览（库未装配时为空数组）
    let understandings: Array<Record<string, unknown>> = [];
    let facts: Array<Record<string, unknown>> = [];
    try {
      const { getMemoryComponents } = await import("../../agentic-memory/index.js");
      const components = getMemoryComponents();
      understandings = (components.understandingStore?.getActiveUnderstandings?.(actorId) ?? []).map(
        (n) => ({ topic: n.topic, note: n.note, kind: n.kind }),
      );
      facts = (components.factStore?.getActiveFacts?.(actorId) ?? []).map((f) => ({
        field: f.field,
        value: f.value,
      }));
    } catch {
      /* 记忆系统未启用 → 空概览 */
    }

    let pendingTurns = 0;
    try {
      const pendingPath = join(dirname(store.profilePath(actorId)), "pending-turns.json");
      const parsed = JSON.parse(await readFile(pendingPath, "utf8"));
      if (Array.isArray(parsed)) pendingTurns = parsed.length;
    } catch {
      /* 无队列文件 */
    }

    return {
      ok: true,
      actorId,
      markdown,
      sections: [...sections.values()],
      understandings,
      facts,
      pendingTurns,
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/profile/manage/line", async (request, reply) => {
    const body = request.body ?? {};
    const actorId = String(body.actorId ?? "").trim();
    const op = String(body.op ?? "").trim();
    const section = String(body.section ?? "").trim();
    const line = typeof body.line === "string" ? body.line.trim() : "";
    const match = typeof body.match === "string" ? body.match.trim() : "";
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!["ADD", "UPDATE", "DELETE"].includes(op)) {
      return reply.code(400).send({ ok: false, error: "op 必须是 ADD/UPDATE/DELETE" });
    }
    if (!SECTION_KEYS.has(section)) {
      return reply.code(400).send({ ok: false, error: "section 必须是 basic/interest/communication/note" });
    }
    if ((op === "ADD" || op === "UPDATE") && !line) {
      return reply.code(400).send({ ok: false, error: "line required" });
    }
    if ((op === "UPDATE" || op === "DELETE") && !match) {
      return reply.code(400).send({ ok: false, error: "match required" });
    }

    const store = new UserProfileStore();
    const current = await store.read(actorId);
    const { profile: next, applied, skipped } = applyProfileOps(current, [
      {
        op: op as "ADD" | "UPDATE" | "DELETE",
        section: section as "basic" | "interest" | "communication" | "note",
        ...(line ? { line } : {}),
        ...(match ? { match } : {}),
      },
    ]);
    // 写入门槛：疑问句/临时安排/行为频率/对助手的观察/不确定推断/无明确主语
    // 的条目被确定性丢弃——明确回绝而不是静默无变更，避免用户以为"写进去了"。
    if (skipped.length > 0 && applied.length === 0) {
      return reply.code(400).send({
        ok: false,
        error: `该内容不符合画像写入门槛（疑问句 / 临时安排 / 行为频率 / 对助手的观察 / 不确定推断 / 无明确主语），未写入：${skipped[0]}`,
      });
    }
    if (applied.length === 0) {
      return reply.code(409).send({ ok: false, error: "没有产生变更（行已存在或定位词未命中）" });
    }
    await store.write(actorId, next);
    const written = await store.read(actorId);
    const failures = verifyProfileOps(written, applied);
    try {
      await touchProfileLines(actorId, written, applied.map((a) => a.expectLine ?? "").filter(Boolean));
    } catch {
      /* sidecar 失败不影响 */
    }
    if (failures.length > 0) {
      return reply.code(500).send({ ok: false, error: "写入校验未通过" });
    }
    return { ok: true, markdown: written };
  });

  /**
   * 用户自报的结构化事实写入（首启向导「怎么称呼你」等）：与对话纠正同走
   * factStore.applyFact 字段级事务（旧值入历史、新值生效），prompt 的 userAlias
   * 由 userFacts 块现成通道消费，无需动记忆管线。
   */
  app.post<{ Body: Record<string, unknown> }>("/api/profile/manage/fact", async (request, reply) => {
    const body = request.body ?? {};
    const actorId = String(body.actorId ?? "").trim();
    const field = String(body.field ?? "").trim();
    const value = String(body.value ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!field || !value) return reply.code(400).send({ ok: false, error: "field/value required" });

    const { getMemoryComponents } = await import("../../agentic-memory/index.js");
    const factStore = getMemoryComponents().factStore;
    if (!factStore) {
      return reply.code(503).send({ ok: false, error: "事实库未装配（记忆系统未启用）" });
    }
    const result = factStore.applyFact({ actorId, entity: "user", field, value, confidence: 1.0 });
    if (!result) {
      return reply.code(400).send({ ok: false, error: "字段或值不合法（值过长/字段未识别）" });
    }
    return { ok: true, changed: result.changed, field, value };
  });
}
