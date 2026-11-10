/**
 * 闹钟/即时提醒 HTTP 路由（alarm-clock）
 *
 * 端点：
 *   POST   /api/alarms                       创建（Header Idempotency-Key 可选，语义去重兜底）
 *   GET    /api/alarms?actorId=&status=      查询列表
 *   GET    /api/alarms/:id                   详情
 *   PATCH  /api/alarms/:id                   修改（时间/标签/贪睡/wakeMode/状态）
 *   DELETE /api/alarms/:id                   取消（软删 → canceled，跨设备同步停响）
 *   POST   /api/alarms/:id/snooze            贪睡 { minutes }
 *   POST   /api/alarms/:id/dismiss           停止本次响铃（重复闹钟推进下一跳）
 *   GET    /api/alarms/:id/voice             单独取叫醒语音（按需补拉；已消费则为 null）
 *   POST   /api/alarms/:id/voice/consume     端侧确认音频已落盘 → 云端立即「用完即删」
 *   POST   /api/alarms/:id/trigger-callback  客户端触发回执（幂等，驱动服务端兜底判定）
 *   GET    /api/alarms/:id/triggers          触发台账
 *   POST   /api/reminders                    创建即时提醒（kind=reminder 薄壳）
 *   GET    /api/voice/health                 二阶段语音能力健康探测（客户端降级判定）
 */
import type { FastifyInstance } from "fastify";

import type { AlarmClockService } from "../../services/alarm-clock/alarm-clock-service.js";
import type { AlarmCreateInput } from "../../services/alarm-clock/alarm-store.js";

type CreateBody = {
  actorId: string;
  label: string;
  kind?: "alarm" | "reminder";
  fireAt: string;
  repeatRule?: string | null;
  snooze?: { enabled?: boolean; presetsMinutes?: number[]; maxCount?: number };
  wakeMode?: { level: "gentle_normal" | "voice_talk" | "music"; voiceScript?: string; musicPlaylist?: string; volumeRamp?: boolean };
  dndBypass?: boolean;
  deviceId?: string | null;
  source?: "agent" | "user" | "sync";
  channelPlan?: string[];
  escalateAfterSec?: number;
  requireAck?: boolean;
  remindText?: string;
};

function resolveActor(query: unknown, body: unknown): string | null {
  const q = (query ?? {}) as { actorId?: string; sessionId?: string };
  const b = (body ?? {}) as { actorId?: string; sessionId?: string };
  return b.actorId ?? q.actorId ?? b.sessionId ?? q.sessionId ?? null;
}

export function registerAlarmRoutes(
  app: FastifyInstance,
  deps: { alarmClockService: AlarmClockService | null },
): void {
  const service = deps.alarmClockService;

  app.post<{ Body: CreateBody }>("/api/alarms", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const b = request.body;
    if (!b?.actorId || !b?.label || !b?.fireAt) {
      return reply.code(400).send({ ok: false, error: "actorId / label / fireAt 必填" });
    }
    const fireMs = new Date(b.fireAt).getTime();
    if (!Number.isFinite(fireMs)) {
      return reply.code(400).send({ ok: false, error: "fireAt 不是合法的 ISO8601 时间" });
    }
    const input: AlarmCreateInput = {
      actorId: b.actorId,
      label: b.label,
      kind: b.kind ?? "alarm",
      fireAt: b.fireAt,
      repeatRule: b.repeatRule ?? null,
      snooze: b.snooze,
      wakeMode: b.wakeMode,
      dndBypass: b.dndBypass,
      deviceId: b.deviceId ?? null,
      idempotencyKey: (request.headers["idempotency-key"] as string) ?? null,
      source: b.source ?? "agent",
      channelPlan: b.channelPlan as AlarmCreateInput["channelPlan"],
      escalateAfterSec: b.escalateAfterSec,
      requireAck: b.requireAck,
      remindText: b.remindText,
    };
    const { alarm, duplicate } = service.createAlarm(input);
    return reply.code(duplicate ? 200 : 201).send({ ok: true, alarm: service.toPayload(alarm), duplicate });
  });

  app.get("/api/alarms", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const actorId = resolveActor(request.query, null);
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId 必填" });
    const status = (request.query as { status?: string }).status;
    // 对账列表带预合成语音：客户端启动/重连时一次拉齐，本地精确闹钟即可离线播
    const alarms = service.listAlarmsPayload(actorId, status);
    return { ok: true, alarms, count: alarms.length };
  });

  app.get<{ Params: { id: string } }>("/api/alarms/:id", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const alarm = service.getAlarm(request.params.id);
    if (!alarm) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, alarm: service.toPayload(alarm) };
  });

  /** 单独取叫醒语音（客户端按需补拉，避免列表里重复携带大 base64） */
  app.get<{ Params: { id: string } }>("/api/alarms/:id/voice", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    if (!service.getAlarm(request.params.id)) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, voice: service.getVoiceClip(request.params.id) };
  });

  /**
   * 「用完即删除」回执：端侧把 mp3 落到应用私有文件、本地精确闹钟排好后调用。
   * 服务端立即删内存与 voice-clips/*.json；幂等（重复 ACK 返回 consumed=false）。
   * 没收到这个回执（端侧离线/旧版本/被杀）时由兜底 TTL 最终清扫。
   */
  app.post<{ Params: { id: string } }>("/api/alarms/:id/voice/consume", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    if (!service.getAlarm(request.params.id)) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, ...service.consumeVoiceClip(request.params.id) };
  });

  app.patch<{ Params: { id: string }; Body: Partial<CreateBody> }>("/api/alarms/:id", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const alarm = service.updateAlarm(request.params.id, request.body as Partial<AlarmCreateInput>);
    if (!alarm) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, alarm: service.toPayload(alarm) };
  });

  app.delete<{ Params: { id: string } }>("/api/alarms/:id", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const alarm = service.cancelAlarm(request.params.id);
    if (!alarm) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, alarm };
  });

  app.post<{ Params: { id: string }; Body: { minutes?: number } }>("/api/alarms/:id/snooze", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const minutes = Number(request.body?.minutes ?? 5);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return reply.code(400).send({ ok: false, error: "minutes 需在 (0, 1440] 内" });
    }
    const alarm = service.snoozeAlarm(request.params.id, minutes);
    if (!alarm) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, alarm };
  });

  app.post<{ Params: { id: string } }>("/api/alarms/:id/dismiss", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const alarm = service.dismissAlarm(request.params.id);
    if (!alarm) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, alarm };
  });

  app.post<{
    Params: { id: string };
    Body: { firedAtMs: number; via?: string; outcome?: string; snoozeCount?: number; actualChannel?: string };
  }>("/api/alarms/:id/trigger-callback", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const result = service.reportTriggerCallback(request.params.id, request.body ?? { firedAtMs: Date.now() });
    return { ok: true, ...result };
  });

  app.get<{ Params: { id: string } }>("/api/alarms/:id/triggers", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    if (!service.getAlarm(request.params.id)) return reply.code(404).send({ ok: false, error: "闹钟不存在" });
    return { ok: true, triggers: service.listTriggers(request.params.id) };
  });

  // 即时提醒薄壳：kind 固定 reminder，channelPlan 缺省走"通知→弹窗"一阶段链
  app.post<{ Body: CreateBody }>("/api/reminders", async (request, reply) => {
    if (!service) return reply.code(503).send({ ok: false, error: "alarm-clock service not enabled" });
    const b = request.body;
    if (!b?.actorId || !b?.label || !b?.fireAt) {
      return reply.code(400).send({ ok: false, error: "actorId / label / fireAt 必填" });
    }
    const { alarm, duplicate } = service.createAlarm({
      actorId: b.actorId,
      label: b.label,
      kind: "reminder",
      fireAt: b.fireAt,
      repeatRule: null,
      dndBypass: b.dndBypass ?? false, // Agent 主动提醒默认不突破免打扰
      deviceId: b.deviceId ?? null,
      idempotencyKey: (request.headers["idempotency-key"] as string) ?? null,
      source: b.source ?? "agent",
      channelPlan: (b.channelPlan as AlarmCreateInput["channelPlan"]) ?? ["notification", "popup"],
      escalateAfterSec: b.escalateAfterSec ?? 120,
      requireAck: b.requireAck ?? true,
      remindText: b.remindText ?? b.label,
    });
    return reply.code(duplicate ? 200 : 201).send({ ok: true, alarm, duplicate });
  });

  // 二阶段语音能力健康探测（客户端降级判定，预算 ≤1.5s）
  app.get("/api/voice/health", async () => {
    if (!service) return { ok: false, model: "e2e", available: false, reason: "service_disabled" };
    return service.voiceHealth();
  });
}
