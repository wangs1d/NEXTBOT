// HTTP 路由：记忆管理（记忆可见、可改、可纠错）
//
//   GET  /api/memory/items?actorId=&q=&limit=   列出某 actor 的长期记忆（可选关键词过滤）
//   POST /api/memory/update      {actorId,id,content}   编辑一条记忆（mem0 原生 update，向量同步重建）
//   POST /api/memory/delete      {actorId,id}           删除一条记忆（bridge 调和 + 强化侧表级联回收）
//   GET  /api/memory/profile?actorId=            读取"我对用户的理解"（USER_PROFILE.md）
//
// 编辑/删除后会失效记忆目录缓存（memory-inventory），保证下一轮召回即见最新。
// 画像文件由 UserProfileAggregator 按轮次增量维护，这里仅提供只读视图。
import type { FastifyInstance } from "fastify";

import { getAgenticMemoryRuntime, getMemoryComponents } from "../../agentic-memory/index.js";
import { getMemorySuppressionStore } from "../../agentic-memory/memory-suppression.js";
import { getRerankStatsSnapshot } from "../../agentic-memory/rerank-cross-encoder.js";
import { canonicalFactField } from "../../agentic-memory/structured-fact-store.js";
import { actorIdVariants } from "../../agentic-memory/actor-key.js";
import { getGlobalMemoryInventory } from "../../brain/memory-inventory.js";
import { UserProfileStore } from "../../services/user-personalization/user-profile-store.js";

type Mem0Record = {
  id: string;
  memory?: string;
  metadata?: { actorId?: string; source?: string; importance?: number; highSignal?: boolean };
  createdAt?: string;
  updatedAt?: string;
};

export function registerMemoryCrudRoutes(app: FastifyInstance): void {
  app.get("/api/memory/items", async (request, reply) => {
    const query = request.query as { actorId?: string; q?: string; limit?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.memory) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用（检查 OPENAI_API_KEY / AGENT_AGENTIC_MEMORY_ENABLED）" });
    }
    const keyword = String(query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(query.limit) > 0 ? Number(query.limit) : 200, 1), 1000);
    try {
      // mem0ai v3 getAll 强制 filters.user_id；actor 存量数据两种形式并存，逐形式扫
      const records: Mem0Record[] = [];
      for (const variant of actorIdVariants(actorId)) {
        const allResult = (await runtime.memory.getAll({
          topK: 10000,
          filters: { user_id: variant },
        })) as { results?: Mem0Record[] };
        records.push(...(allResult.results ?? []));
      }
      const items = records
        .filter((m) => (m.metadata?.actorId ?? actorId) === actorId)
        .filter((m) => !keyword || String(m.memory ?? "").toLowerCase().includes(keyword))
        .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          content: String(m.memory ?? ""),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          source: m.metadata?.source,
          importance: m.metadata?.importance,
          highSignal: m.metadata?.highSignal === true,
        }));
      return { ok: true, actorId, count: items.length, items };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/memory/update", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; id?: string; content?: string };
    const actorId = String(body.actorId ?? "").trim();
    const id = String(body.id ?? "").trim();
    const content = String(body.content ?? "").trim();
    if (!actorId || !id) return reply.code(400).send({ ok: false, error: "actorId and id required" });
    if (!content) return reply.code(400).send({ ok: false, error: "content required（清空请直接删除）" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.memory) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用" });
    }
    try {
      await runtime.memory.update(id, content);
      getGlobalMemoryInventory()?.invalidate(actorId);
      return { ok: true, id };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `更新记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/memory/delete", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; id?: string };
    const actorId = String(body.actorId ?? "").trim();
    const id = String(body.id ?? "").trim();
    if (!actorId || !id) return reply.code(400).send({ ok: false, error: "actorId and id required" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.lifecycle) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用" });
    }
    try {
      const deleted = await runtime.lifecycle.deleteByIds([id]);
      if (deleted.length === 0) {
        return reply.code(404).send({ ok: false, error: "记忆不存在或删除失败" });
      }
      getGlobalMemoryInventory()?.invalidate(actorId);
      return { ok: true, id };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `删除记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get("/api/memory/profile", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    try {
      const markdown = await new UserProfileStore().read(actorId);
      return { ok: true, actorId, markdown };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取用户画像失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ─── 档案面板（2026-10-19 P2：记忆可见、可改、可软抑制）───
  // 与 /api/memory/items（原始 Mem0 条目）互补：这里返回**结构化档案**的
  // 现状 / 计划 / 历史三类，带来源与时间，供面板直接渲染。

  app.get("/api/memory/facts", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    const store = getMemoryComponents().factStore;
    if (!store) return reply.code(503).send({ ok: false, error: "结构化事实库未启用" });
    try {
      return {
        ok: true,
        actorId,
        current: store.getActiveFacts(actorId),
        plans: store.getPlannedFacts(actorId),
        // 只有历史、没有现状的字段（"以前住浙江"但没说过现在）
        past: store.getPastFacts(actorId).map((f) => ({ ...f })),
        suppressed: [...(getMemorySuppressionStore()?.suppressedFields(actorId) ?? [])],
      };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取档案失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /**
   * 忘掉前的影响预览（P2-10）：让用户在点"忘掉"之前知道会动什么。
   * 只读，不产生任何变更。
   */
  app.post("/api/memory/facts/forget/preview", async (request, reply) => {
    const body = request.body as { actorId?: string; field?: string };
    const actorId = String(body?.actorId ?? "").trim();
    const field = String(body?.field ?? "").trim();
    if (!actorId || !field) return reply.code(400).send({ ok: false, error: "actorId/field required" });
    const store = getMemoryComponents().factStore;
    if (!store) return reply.code(503).send({ ok: false, error: "结构化事实库未启用" });
    const canonical = canonicalFactField(field);
    return {
      ok: true,
      field: canonical,
      active: store.getFact(actorId, canonical),
      plannedCount: store.getPlannedFacts(actorId).filter((p) => p.field === canonical).length,
      historicalCount: store.getPastFacts(actorId, canonical).length,
      note: "现状值与未执行的计划将下线；历史行保留可追溯，不会物理删除。",
    };
  });

  /** 字段级遗忘：supersede 下线（历史保留），不是物理删除 */
  app.post("/api/memory/facts/forget", async (request, reply) => {    const body = request.body as { actorId?: string; field?: string };
    const actorId = String(body?.actorId ?? "").trim();
    const field = String(body?.field ?? "").trim();
    if (!actorId || !field) return reply.code(400).send({ ok: false, error: "actorId/field required" });
    const store = getMemoryComponents().factStore;
    if (!store) return reply.code(503).send({ ok: false, error: "结构化事实库未启用" });
    const cleared = store.clearFact(actorId, field);
    if (cleared === null) return reply.code(400).send({ ok: false, error: "字段名无效" });
    return { ok: true, cleared };
  });

  /**
   * 计划确认：必须带证据（用户明确陈述 / 位置）。
   * 这是"计划 → 事实"的唯一人工入口——不提供"无证据确认"。
   */
  app.post("/api/memory/facts/plan/confirm", async (request, reply) => {
    const body = request.body as {
      actorId?: string;
      field?: string;
      evidenceRef?: string;
      became?: "current" | "past";
    };
    const actorId = String(body?.actorId ?? "").trim();
    const field = String(body?.field ?? "").trim();
    const evidenceRef = String(body?.evidenceRef ?? "").trim();
    if (!actorId || !field || !evidenceRef) {
      return reply.code(400).send({ ok: false, error: "actorId/field/evidenceRef required" });
    }
    const store = getMemoryComponents().factStore;
    if (!store) return reply.code(503).send({ ok: false, error: "结构化事实库未启用" });
    const result = store.confirmPlan(actorId, field, {
      became: body?.became === "past" ? "past" : "current",
      evidenceRef,
    });
    if (!result) return reply.code(404).send({ ok: false, error: "没有待确认的计划" });
    return { ok: true, fact: result.fact, changed: result.changed };
  });

  // ─── 生活模型（Life Model）：实体 / 关系 可查可删（2026-10-20 P2）───
  // 「我妹妹叫什么」「我和老王最近怎么样」这类问题的数据结构；用户可查看与删除。

  app.get("/api/memory/life", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    const store = getMemoryComponents().lifeModel;
    if (!store) return reply.code(503).send({ ok: false, error: "生活模型未启用" });
    try {
      const all = store.listEntities(actorId);
      const byId = new Map(all.map((e) => [e.id, e]));
      return {
        ok: true,
        actorId,
        selfAgentEdge: store.getSelfAgentEdge(actorId),
        entities: all
          .filter((e) => e.kind !== "self")
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.canonicalName,
            aliases: e.aliases,
            sensitivity: e.sensitivity,
            lastSeenAt: e.lastSeenAt,
          })),
        relations: store
          .getEdges(actorId)
          .filter((e) => e.kind !== "self_agent")
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            subKind: e.subKind,
            intimacy: e.intimacy,
            sentiment: e.sentiment,
            status: e.status,
            from: byId.get(e.fromEntityId)?.canonicalName ?? e.fromEntityId,
            to: byId.get(e.toEntityId)?.canonicalName ?? e.toEntityId,
          })),
      };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取生活模型失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /** 「忘掉这个人」：实体 + 边 + 轨迹 + 该实体名下事实 三清（隐私级物理删除）。 */
  app.post("/api/memory/life/forget", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; entityId?: string; name?: string };
    const actorId = String(body.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    const store = getMemoryComponents().lifeModel;
    if (!store) return reply.code(503).send({ ok: false, error: "生活模型未启用" });
    const entityId = String(body.entityId ?? "").trim();
    const name = String(body.name ?? "").trim();
    const entity = entityId
      ? store.getEntity(actorId, entityId)
      : name
        ? store.findEntityByName(actorId, name)
        : null;
    if (!entity) return reply.code(404).send({ ok: false, error: "实体不存在" });
    const removed = store.deleteEntity(actorId, entity.id);
    const removedFacts = getMemoryComponents().factStore?.deleteFactsByEntity(actorId, entity.canonicalName) ?? 0;
    return {
      ok: true,
      entity: entity.canonicalName,
      removedEntities: removed.entities,
      removedEdges: removed.edges,
      removedFacts,
    };
  });

  // ─── 软抑制："别再提这个"（不删源，只降低主动提及）───

  /** 精排门控观测（P0-3）：跑几天真实对话后据此决定 adaptive 是否设默认 */
  app.get("/api/memory/rerank-stats", async () => {
    return { ok: true, stats: getRerankStatsSnapshot() };
  });

  app.get("/api/memory/suppressions", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    return { ok: true, actorId, items: getMemorySuppressionStore()?.list(actorId) ?? [] };
  });

  app.post("/api/memory/suppressions", async (request, reply) => {
    const body = request.body as {
      actorId?: string;
      kind?: "field" | "text";
      key?: string;
      reason?: string;
    };
    const actorId = String(body?.actorId ?? "").trim();
    const key = String(body?.key ?? "").trim();
    if (!actorId || !key) return reply.code(400).send({ ok: false, error: "actorId/key required" });
    const store = getMemorySuppressionStore();
    if (!store) return reply.code(503).send({ ok: false, error: "抑制存储未启用" });
    const item = store.add(actorId, body?.kind === "text" ? "text" : "field", key, body?.reason);
    if (!item) return reply.code(400).send({ ok: false, error: "key 无效" });
    return { ok: true, item };
  });

  app.post("/api/memory/suppressions/remove", async (request, reply) => {
    const body = request.body as { actorId?: string; kind?: "field" | "text"; key?: string };
    const actorId = String(body?.actorId ?? "").trim();
    const key = String(body?.key ?? "").trim();
    if (!actorId || !key) return reply.code(400).send({ ok: false, error: "actorId/key required" });
    const removed = getMemorySuppressionStore()?.remove(
      actorId,
      body?.kind === "text" ? "text" : "field",
      key,
    );
    return { ok: true, removed: Boolean(removed) };
  });
}
