// Agent Brain Center —— HTTP 路由
import type { FastifyInstance } from "fastify";
import type { HttpRouteDeps } from "./types.js";
import type {
  AudioBufferRef,
  BrainSignalInput,
  MemoryDomainKind,
  MemoryItem,
  MemoryItemKind,
} from "../../brain/types.js";
import type { MemoryFeedbackOutcome } from "../../brain/memory-strength-model.js";

/**
 * 从请求体构建 Brain 信号输入（用于 /brain/proactive/test）。
 * 校验必填字段，组装为 BrainSignalInput。
 */
function buildSignal(body: Record<string, unknown>): BrainSignalInput {
  const actorId = String(body.actorId ?? "").trim();
  if (!actorId) throw new Error("actorId is required");
  const kind = String(body.kind ?? "").trim();
  if (!kind) throw new Error("kind is required");
  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("title is required");
  const summary = body.summary != null ? String(body.summary) : undefined;
  const importance =
    body.importance != null
      ? (String(body.importance) as BrainSignalInput["importance"])
      : undefined;
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : undefined;
  return { actorId, kind, title, summary, importance, metadata };
}

/**
 * 注册 Brain Center 相关的 HTTP 路由。
 * - GET  /brain/capabilities      程序化能力清单
 * - GET  /brain/state             大脑状态快照
 * - POST /brain/proactive/test    注入测试信号走完整决策流水线
 * - POST /brain/sensory/listen    感官「听」：base64 音频 → ASR
 * - POST /brain/sensory/look      感官「看」：截屏 + VLM 描述
 * - POST /brain/sensory/speak     感官「说」：TTS 合成 + 投递
 * - POST /brain/memory/remember   记忆写入
 * - POST /brain/memory/recall     记忆召回
 * - POST /brain/memory/feedback   记忆相关性在线反馈（relevant/irrelevant/correction）
 * - POST /brain/memory/continuity/diagnose  记忆连续性诊断（锚点+反馈+开放环路）
 * - POST /brain/synapse/fire      突触发射（进程内事件）
 * - POST /brain/synapse/sendToAgent  突触跨 Agent 投递（facade 未暴露，503）
 * - POST /brain/limbic/checkSafety   边缘安全检查
 * - POST /brain/limbic/inferEmotion  边缘情绪推断（facade 未暴露，503）
 * - POST /brain/planner/plan      规划
 * - POST /brain/planner/routeSystem  快慢双系统路由
 *
 * brainCenter 为 null（未启用）时，每个端点返回 503 + not enabled。
 */
export function registerBrainRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  // 程序化能力清单
  app.get("/brain/capabilities", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const actorId =
        String((request.query as { actorId?: string }).actorId ?? "default").trim() ||
        "default";
      const capabilities = deps.brainCenter.introspect(actorId);
      return reply.send({ ok: true, capabilities });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 大脑状态快照
  app.get("/brain/state", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const actorId =
        String((request.query as { actorId?: string }).actorId ?? "default").trim() ||
        "default";
      const snapshot = deps.brainCenter.snapshot(actorId);
      return reply.send({ ok: true, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 注入测试信号走完整决策流水线
  app.post("/brain/proactive/test", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const signal = buildSignal((request.body ?? {}) as Record<string, unknown>);
      const decision = await deps.brainCenter.decide(signal);
      return reply.send({ ok: true, decision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // ============ 神经解剖分区路由（SensoryCortex / MemoryCortex / SynapseBus / LimbicCortex / PlannerCortex） ============

  // ---- 感官皮层（SensoryCortex）----

  // 感官「听」：将 base64 音频转为 Buffer 后调用 SensoryCortex.listen
  app.post("/brain/sensory/listen", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const audio = body.audio as
        | { data?: string; format?: string; sampleRate?: number; channels?: number }
        | undefined;
      if (!audio || !audio.data) {
        throw new Error("audio.data is required");
      }
      const audioBufferRef: AudioBufferRef = {
        data: Buffer.from(audio.data, "base64"),
        format: (audio.format ?? "wav") as AudioBufferRef["format"],
        sampleRate: audio.sampleRate,
        channels: audio.channels,
      };
      const language = body.language != null ? String(body.language) : undefined;
      const result = await deps.brainCenter.listen(
        audioBufferRef,
        language ? { language } : undefined,
      );
      if (result.error) {
        return reply.code(503).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 感官「看」：调用 SensoryCortex.look 截屏并生成视觉描述
  app.post("/brain/sensory/look", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const region = body.region as
        | { x: number; y: number; width: number; height: number }
        | undefined;
      const result = await deps.brainCenter.look(
        region ? { source: "screenshot", region } : undefined,
      );
      if (result.error) {
        return reply.code(503).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 感官「说」：调用 SensoryCortex.speak 合成并投递语音
  app.post("/brain/sensory/speak", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const text = String(body.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const voiceId = body.voiceId != null ? String(body.voiceId) : undefined;
      const channel = body.channel != null ? String(body.channel) : undefined;
      const result = await deps.brainCenter.speak(text, { voiceId, channel });
      if (result.error) {
        return reply.code(503).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // ---- 记忆皮层（MemoryCortex）----

  // 记忆写入：调用 MemoryCortex.remember
  app.post("/brain/memory/remember", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? "").trim();
      if (!actorId) throw new Error("actorId is required");
      const itemBody = body.item as
        | {
            content?: string;
            kind?: string;
            domain?: string;
            importance?: string;
            source?: string;
            sessionId?: string;
          }
        | undefined;
      if (!itemBody || !itemBody.content) {
        throw new Error("item.content is required");
      }
      const item: MemoryItem = {
        actorId,
        kind: (itemBody.kind ?? "fact") as MemoryItemKind,
        content: String(itemBody.content),
        domain: itemBody.domain as MemoryDomainKind | undefined,
        importance: itemBody.importance as MemoryItem["importance"],
        source: itemBody.source as MemoryItem["source"],
        sessionId: itemBody.sessionId,
        timestamp: new Date().toISOString(),
      };
      await deps.brainCenter.remember(actorId, item);
      return reply.send({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 记忆召回：调用 MemoryCortex.recall
  app.post("/brain/memory/recall", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? "").trim();
      if (!actorId) throw new Error("actorId is required");
      const query = String(body.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const domain = body.domain as MemoryDomainKind | undefined;
      const limit = body.limit != null ? Number(body.limit) : undefined;
      const result = await deps.brainCenter.recall(actorId, query, { domain, limit });
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 记忆相关性在线反馈：记录用户对召回记忆的反馈（relevant/irrelevant/correction）
  app.post("/brain/memory/feedback", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? "").trim();
      if (!actorId) throw new Error("actorId is required");
      const content = String(body.content ?? "").trim();
      if (!content) throw new Error("content is required");
      const outcome = String(body.outcome ?? "").trim() as MemoryFeedbackOutcome;
      if (!["relevant", "irrelevant", "correction"].includes(outcome)) {
        throw new Error("outcome must be relevant|irrelevant|correction");
      }
      deps.brainCenter.recordMemoryFeedback({ actorId, content, outcome });
      return reply.send({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 记忆连续性诊断：聚合最近召回锚点 + 反馈惩罚 + 跨会话开放环路（定位跳转根因）
  app.post("/brain/memory/continuity/diagnose", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actorId = String(body.actorId ?? "").trim();
      if (!actorId) throw new Error("actorId is required");
      const result = deps.brainCenter.diagnoseContinuity(actorId);
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // ---- 突触总线（SynapseBus）----

  // 突触发射：调用 SynapseBus.fire 发布进程内事件
  app.post("/brain/synapse/fire", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const type = String(body.type ?? "").trim();
      if (!type) throw new Error("type is required");
      const data =
        body.data && typeof body.data === "object"
          ? (body.data as Record<string, unknown>)
          : {};
      const actorId = body.actorId != null ? String(body.actorId) : undefined;
      const source = body.source != null ? String(body.source) : undefined;
      const result = deps.brainCenter.fire(type, data, { actorId, source });
      if (result.error) {
        return reply.code(503).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 突触跨 Agent 投递：BrainCenter facade 未暴露 sendToAgent，返回 503
  app.post("/brain/synapse/sendToAgent", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      return reply.code(503).send({
        ok: false,
        error: "sendToAgent not exposed at BrainCenter facade level",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // ---- 边缘系统（LimbicCortex）----

  // 边缘安全检查：调用 LimbicCortex.checkSafety
  app.post("/brain/limbic/checkSafety", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const tool = String(body.tool ?? "").trim();
      if (!tool) throw new Error("tool is required");
      const args =
        body.args && typeof body.args === "object"
          ? (body.args as Record<string, unknown>)
          : {};
      const ctx =
        body.ctx && typeof body.ctx === "object"
          ? (body.ctx as Record<string, unknown>)
          : undefined;
      const result = deps.brainCenter.checkSafety({ tool, args }, ctx);
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 边缘情绪推断：BrainCenter facade 未暴露 inferEmotion，返回 503
  app.post("/brain/limbic/inferEmotion", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      return reply.code(503).send({
        ok: false,
        error: "inferEmotion not exposed at BrainCenter facade level",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // ---- 规划皮层（PlannerCortex）----

  // 规划：调用 PlannerCortex.plan
  app.post("/brain/planner/plan", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const goal = String(body.goal ?? "").trim();
      if (!goal) throw new Error("goal is required");
      const actorId = body.actorId != null ? String(body.actorId) : undefined;
      const maxSteps = body.maxSteps != null ? Number(body.maxSteps) : undefined;
      const result = await deps.brainCenter.plan(goal, { actorId, maxSteps });
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  // 快慢双系统路由：调用 PlannerCortex.routeSystem
  app.post("/brain/planner/routeSystem", async (request, reply) => {
    try {
      if (!deps.brainCenter) {
        return reply.code(503).send({ ok: false, error: "Brain Center not enabled" });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const userMessage = String(body.userMessage ?? "").trim();
      if (!userMessage) throw new Error("userMessage is required");
      const actorId = body.actorId != null ? String(body.actorId) : undefined;
      const result = deps.brainCenter.routeSystem(userMessage, { actorId });
      return reply.send({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });
}
