// 叫醒语音链路单测 —— 注入式 TTS/话术，验证「建钟时预生成 → 随 alarm.sync
// 下发 → 到点 alarm.trigger 复用同一份音频」不依赖外部 TTS 账户。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  AlarmClockService,
  buildWakeFallback,
  localizeFireAt,
  type AlarmClockServiceDeps,
} from "../src/services/alarm-clock/alarm-clock-service.js";
import { registerAlarmRoutes } from "../src/routes/http/alarms.js";
import type { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

type Frame = { type: string; payload?: Record<string, unknown> };

function frames(sent: string[], type: string): Frame[] {
  return sent
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((m) => m.type === type);
}

function makeService(sent: string[], opts: {
  synthesizeSpeech?: AlarmClockServiceDeps["synthesizeSpeech"];
  composeWakeScript?: AlarmClockServiceDeps["composeWakeScript"];
  resolveTimezone?: AlarmClockServiceDeps["resolveTimezone"];
  now: () => number;
  dataDir?: string;
}): AlarmClockService {
  const wsRegistry = {
    trySend(_actorId: string, data: string) {
      sent.push(data);
      return true;
    },
    trySendToDeviceClassOrder(_a: string, data: string) {
      sent.push(data);
      return true;
    },
    trySendToActiveDevice() {
      return false;
    },
  } as unknown as WsConnectionRegistry;
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "alarm-voice-test-"));
  return new AlarmClockService({
    wsRegistry,
    dataDir,
    now: opts.now,
    synthesizeSpeech: opts.synthesizeSpeech ?? null,
    composeWakeScript: opts.composeWakeScript ?? null,
    resolveTimezone: opts.resolveTimezone ?? null,
    log: { info: () => {}, warn: () => {} },
  });
}

const waitFor = async (predicate: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("叫醒语音：话术 → 预合成 → alarm.sync 下发 → 到点 trigger 复用同一份", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async ({ label }) => `早上好，${label}，该起来啦`,
    synthesizeSpeech: async (text) => ({
      format: "mp3",
      base64: Buffer.from(`FAKE_MP3:${text}`).toString("base64"),
    }),
  });
  const fireAt = new Date(now + 60_000).toISOString();
  const { alarm } = service.createAlarm({
    actorId: "voice-test",
    label: "起床",
    kind: "alarm",
    fireAt,
    wakeMode: { level: "voice_talk", volumeRamp: true },
  });

  // 第一条同步必须立即到达（先把本地精确闹钟排上，不等 LLM/TTS）
  const first = frames(sent, "alarm.sync")[0];
  assert.ok(first, "应立即下发 alarm.sync");
  assert.equal((first.payload!.alarm as Record<string, unknown>).ttsBase64, null);

  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const syncs = frames(sent, "alarm.sync");
  assert.ok(syncs.length >= 2, "话术/音频就绪后应补发第二条同步");
  const last = syncs[syncs.length - 1].payload!.alarm as Record<string, unknown>;
  assert.equal(last.voiceText, "早上好，起床，该起来啦");
  assert.equal(last.voiceReady, true);
  assert.match(String(last.ttsBase64), /^RkFLRV9NUDM/); // base64("FAKE_MP3:")
  assert.equal(service.listAlarmsPayload("voice-test")[0].voiceReady, true);
  assert.equal(service.getAlarm(alarm.id)?.wakeMode?.voiceScript, "早上好，起床，该起来啦");

  // 到点触发：服务端兜底路直接复用预合成音频，不再调 LLM/联网合成
  await (service as unknown as { tickAll: (ms: number) => Promise<void> }).tickAll(now + 61_000);
  await waitFor(() => frames(sent, "alarm.trigger").length > 0);
  const trig = frames(sent, "alarm.trigger")[0].payload! as Record<string, unknown>;
  assert.equal((trig.tts as { base64: string }).base64, last.ttsBase64);
  assert.equal(trig.voiceText, "早上好，起床，该起来啦");
  service.stop();
});

test("重启加载缓存：门禁上线前落盘的坏 mp3 被丢弃，话术仍保留", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-cache-test-"));
  fs.mkdirSync(path.join(dataDir, "voice-clips"));
  const bad = Buffer.concat([
    Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.alloc(2048, 0),
  ]);
  fs.writeFileSync(
    path.join(dataDir, "voice-clips", "alarm_bad.json"),
    JSON.stringify({
      text: "早上好，该起床啦，今天也要精神一点。",
      tts: { format: "mp3", base64: bad.toString("base64") },
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const wsRegistry = {
    trySend: () => true,
    trySendToDeviceClassOrder: () => true,
    trySendToActiveDevice: () => false,
  } as unknown as WsConnectionRegistry;
  const service = new AlarmClockService({
    wsRegistry,
    dataDir,
    now: () => Date.now(),
    synthesizeSpeech: null,
    composeWakeScript: null,
    log: { info: () => {}, warn: () => {} },
  });
  const clip = service.getVoiceClip("alarm_bad");
  assert.ok(clip, "缓存应被加载");
  assert.equal(clip!.tts, null, "坏 mp3 不能复活成到点静音");
  assert.match(clip!.text, /该起床啦/, "话术保留，端侧仍可本地/系统 TTS 念出来");
  service.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("TTS 不可用：话术文本仍落库并下发，闹钟不中断", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async () => null, // LLM 熔断/超时
    synthesizeSpeech: async () => null, // 账户欠费/网关不支持
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-fallback",
    label: "起床",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id) != null);
  const clip = service.getVoiceClip(alarm.id)!;
  assert.equal(clip.tts, null);
  assert.match(clip.text, /该起床啦/);
  const last = frames(sent, "alarm.sync").at(-1)!.payload!.alarm as Record<string, unknown>;
  assert.equal(last.voiceReady, false);
  assert.equal(last.ttsBase64, null);
  assert.equal(last.voiceText, clip.text);
  service.stop();
});

test("语音缓存 TTL：未响不过期、到点宽限内可用、超期自动清内存与磁盘", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-ttl-test-"));
  const service = makeService(sent, {
    now: () => now,
    dataDir,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => ({
      format: "mp3",
      base64: Buffer.from(`TTL_MP3:${text}`).toString("base64"),
    }),
  });
  const fireAt = new Date(now + 60_000).toISOString();
  const { alarm } = service.createAlarm({
    actorId: "voice-ttl",
    label: "起床",
    kind: "alarm",
    fireAt,
    wakeMode: { level: "voice_talk", volumeRamp: true },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const clip = service.getVoiceClip(alarm.id)!;
  assert.ok(clip.expiresAt, "每份音频都要带 TTL 到期时刻");
  assert.ok(Date.parse(clip.expiresAt) > Date.parse(fireAt), "到期必须晚于到点");
  const clipFile = path.join(dataDir, "voice-clips", `${alarm.id}.json`);
  assert.equal(fs.existsSync(clipFile), true);

  const tickAll = (service as unknown as { tickAll: (ms: number) => Promise<void> }).tickAll.bind(service);
  await tickAll(now + 30_000);
  assert.ok(service.getVoiceClip(alarm.id), "未到点不能过期");

  await tickAll(now + 61_000);
  await waitFor(() => frames(sent, "alarm.trigger").length > 0);
  const trig = frames(sent, "alarm.trigger")[0].payload! as Record<string, unknown>;
  assert.ok((trig.tts as { base64: string }).base64, "到点仍复用同一份音频");
  assert.ok(service.getVoiceClip(alarm.id), "到点后宽限内保留（贪睡/兜底/对账要用）");

  const expiry = Date.parse(service.getVoiceClip(alarm.id)!.expiresAt);
  await tickAll(expiry + 1);
  assert.equal(service.getVoiceClip(alarm.id), null, "TTL 到期后内存清除");
  assert.equal(fs.existsSync(clipFile), false, "磁盘 json 也要一起删");
  assert.equal(service.toPayload(service.getAlarm(alarm.id)!).voiceReady, false, "过期后不再下发音频");
  service.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("重启加载：过期缓存与无 expiresAt 的孤儿文件直接删除", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-ttl-load-"));
  fs.mkdirSync(path.join(dataDir, "voice-clips"));
  const stamp = new Date(Date.now() - 86_400_000).toISOString();
  fs.writeFileSync(
    path.join(dataDir, "voice-clips", "alarm_expired.json"),
    JSON.stringify({ text: "过期音频", tts: null, generatedAt: stamp, expiresAt: stamp }),
  );
  fs.writeFileSync(
    path.join(dataDir, "voice-clips", "alarm_orphan.json"),
    JSON.stringify({ text: "没人认领的旧音频", tts: null, generatedAt: stamp }),
  );
  const wsRegistry = {
    trySend: () => true,
    trySendToDeviceClassOrder: () => true,
    trySendToActiveDevice: () => false,
  } as unknown as WsConnectionRegistry;
  const service = new AlarmClockService({
    wsRegistry,
    dataDir,
    now: () => Date.now(),
    synthesizeSpeech: null,
    composeWakeScript: null,
    log: { info: () => {}, warn: () => {} },
  });
  assert.equal(service.getVoiceClip("alarm_expired"), null);
  assert.equal(service.getVoiceClip("alarm_orphan"), null);
  assert.equal(fs.existsSync(path.join(dataDir, "voice-clips", "alarm_expired.json")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "voice-clips", "alarm_orphan.json")), false);
  service.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("贪睡顺延会刷新语音缓存 TTL，音频不会提前被清", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => ({
      format: "mp3",
      base64: Buffer.from(`SNOOZE_MP3:${text}`).toString("base64"),
    }),
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-snooze",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const before = Date.parse(service.getVoiceClip(alarm.id)!.expiresAt);
  service.snoozeAlarm(alarm.id, 10);
  const after = Date.parse(service.getVoiceClip(alarm.id)!.expiresAt);
  assert.ok(after > before, `贪睡后 TTL 应顺延：${before} → ${after}`);
  service.stop();
});

// ─── 用完即删除（事件驱动，TTL 只兜底） ───

test("用完即删：端侧消费回执立即清云端内存 + 磁盘 json，文本话术保留", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-consume-test-"));
  const service = makeService(sent, {
    now: () => now,
    dataDir,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => ({ format: "mp3", base64: Buffer.from(`ACK_MP3:${text}`).toString("base64") }),
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-consume",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const clipFile = path.join(dataDir, "voice-clips", `${alarm.id}.json`);
  assert.equal(fs.existsSync(clipFile), true, "生成后云端有磁盘缓存");

  assert.deepEqual(service.consumeVoiceClip(alarm.id), { consumed: true, delivered: true });
  assert.equal(service.getVoiceClip(alarm.id), null, "回执后内存立即为空");
  assert.equal(fs.existsSync(clipFile), false, "回执后磁盘 json 立即删除");
  const payload = service.toPayload(service.getAlarm(alarm.id)!);
  assert.equal(payload.ttsBase64, null);
  assert.equal(payload.voiceReady, false);
  assert.equal(payload.voiceText, "早上好，该起床啦", "话术文本仍在 wakeMode，不随音频消失");
  assert.equal(service.consumeVoiceClip(alarm.id).consumed, false, "重复回执幂等");
  service.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("已交付后：重复同步不再合成，到点 trigger 零 TTS 调用", async () => {
  const sent: string[] = [];
  const now = Date.now();
  let ttsCalls = 0;
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => {
      ttsCalls += 1;
      return { format: "mp3", base64: Buffer.from(`ONCE_MP3:${text}`).toString("base64") };
    },
  });
  const input = {
    actorId: "voice-once",
    label: "起床",
    kind: "alarm" as const,
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" as const },
  };
  const { alarm } = service.createAlarm(input);
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  service.consumeVoiceClip(alarm.id);
  const afterConsume = ttsCalls;
  assert.equal(afterConsume, 1, "建钟时只合成一次");

  const dup = service.createAlarm(input);
  assert.equal(dup.duplicate, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ttsCalls, afterConsume, "同一预约已交付，重复对账不得反复合成");

  await (service as unknown as { tickAll: (ms: number) => Promise<void> }).tickAll(now + 61_000);
  await waitFor(() => frames(sent, "alarm.trigger").length > 0);
  assert.equal(ttsCalls, afterConsume, "端侧已有音频，到点不得再调云端 TTS");
  const trig = frames(sent, "alarm.trigger")[0].payload! as Record<string, unknown>;
  assert.equal(trig.tts, null);
  assert.equal(trig.voiceText, "早上好，该起床啦");
  service.stop();
});

test("用完即删：dismiss / acked 触发回执都立即清云端音频", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const make = () => makeService(sent, {
    now: () => now,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => ({ format: "mp3", base64: Buffer.from(`USE_MP3:${text}`).toString("base64") }),
  });
  const mkAlarm = (s: AlarmClockService, actor: string) => s.createAlarm({
    actorId: actor,
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  }).alarm;

  const a = make();
  const dismissId = mkAlarm(a, "voice-dismiss").id;
  await waitFor(() => a.getVoiceClip(dismissId)?.tts != null);
  a.dismissAlarm(dismissId);
  assert.equal(a.getVoiceClip(dismissId), null, "关闭响铃 = 用完，立即删");
  a.stop();

  const b = make();
  const ackId = mkAlarm(b, "voice-acked").id;
  await waitFor(() => b.getVoiceClip(ackId)?.tts != null);
  b.reportTriggerCallback(ackId, { firedAtMs: now, via: "local", outcome: "acked" });
  assert.equal(b.getVoiceClip(ackId), null, "端侧确认这一跳已接手 = 用完，立即删");
  b.stop();
});

test("重复闹钟：推进下一跳时删旧音频并按新时刻重新实时生成", async () => {
  const sent: string[] = [];
  const now = Date.now();
  let ttsCalls = 0;
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async ({ fireAt }) => `下一次叫醒 ${fireAt}`,
    synthesizeSpeech: async (text) => {
      ttsCalls += 1;
      return { format: "mp3", base64: Buffer.from(`HOP_MP3:${text}:${ttsCalls}`).toString("base64") };
    },
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-repeat",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    repeatRule: "RRULE:FREQ=DAILY",
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const firstB64 = service.getVoiceClip(alarm.id)!.tts!.base64;
  service.consumeVoiceClip(alarm.id); // 这一跳已交付，云端已删
  service.dismissAlarm(alarm.id); // 推进到下一跳
  assert.equal(service.getAlarm(alarm.id)?.status, "active");
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  assert.ok(ttsCalls >= 2, "每跳都是一次新的实时生成");
  assert.notEqual(service.getVoiceClip(alarm.id)!.tts!.base64, firstB64, "绝不复用上一跳音频");
  const repeatSyncs = frames(sent, "alarm.sync").filter(
    (f) => (f.payload!.alarm as Record<string, unknown>).voiceReady === true,
  );
  assert.ok(repeatSyncs.length >= 2, "新音频再次随 alarm.sync 下发，端侧再次落盘并回报消费");
  service.stop();
});

test("HTTP /api/alarms/:id/voice/consume：回执即时删且幂等，REST 对账不再带音频", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async () => "早上好，该起床啦",
    synthesizeSpeech: async (text) => ({ format: "mp3", base64: Buffer.from(`HTTP_MP3:${text}`).toString("base64") }),
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-http",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const app = Fastify();
  registerAlarmRoutes(app, { alarmClockService: service });
  await app.ready();
  try {
    const r1 = await app.inject({ method: "POST", url: `/api/alarms/${alarm.id}/voice/consume`, payload: {} });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().consumed, true);
    const r2 = await app.inject({ method: "POST", url: `/api/alarms/${alarm.id}/voice/consume`, payload: {} });
    assert.equal(r2.json().consumed, false, "幂等");
    const voice = await app.inject({ method: "GET", url: `/api/alarms/${alarm.id}/voice` });
    assert.equal(voice.json().voice, null, "云端已无音频可拉取");
    const list = await app.inject({ method: "GET", url: "/api/alarms?actorId=voice-http" });
    assert.equal(list.json().alarms[0].ttsBase64, null);
    assert.equal(list.json().alarms[0].voiceText, "早上好，该起床啦");
  } finally {
    await app.close();
    service.stop();
  }
});

// ─── UTC 话术缺陷修复：触发时刻按用户时区本地化后再进 facts ───

test("localizeFireAt：UTC 11:45Z 在北京时区 = 19:45，时区非法时回退不抛错", () => {
  // 北京 2026-11-09 19:45 = UTC 11:45（差 8 小时，正是真机实测念错的那一跳）
  const utc = "2026-11-09T11:45:00.000Z";
  const cn = localizeFireAt(utc, "Asia/Shanghai");
  assert.match(cn.text, /19:45/, `应为北京本地 19:45，实际：${cn.text}`);
  assert.match(cn.text, /11月9日/);
  assert.equal(cn.hour, 19);

  const ny = localizeFireAt(utc, "America/New_York"); // EST = UTC-5 → 06:45
  assert.match(ny.text, /06:45/, `应为纽约本地 06:45，实际：${ny.text}`);
  assert.equal(ny.hour, 6);

  const badTz = localizeFireAt(utc, "Mars/Olympus_Mons"); // 非法时区 → 回退服务器时区，不抛
  assert.equal(typeof badTz.hour, "number");
  assert.ok(badTz.text.length > 0);
  const garbage = localizeFireAt("not-a-date", "Asia/Shanghai"); // 不可解析 → 原样返回
  assert.equal(garbage.text, "not-a-date");
});

test("buildWakeFallback：问候语按用户时区本地小时判断，不再看服务器时钟", () => {
  const utc = "2026-11-09T11:45:00.000Z"; // 北京 19:45（晚上），纽约 06:45（早上）
  assert.match(buildWakeFallback("起床", utc, 19), /^你好，/);
  assert.match(buildWakeFallback("起床", utc, 7), /^早上好，/);
  // 不传 localHour 时保持旧行为（服务器时区），仅供无时区能力的调用方兜底
  assert.match(buildWakeFallback("起床", utc), /该起床啦。$/);
});

test("话术 facts 里的触发时刻是用户时区本地时间（UTC 服务器不再念错小时）", async () => {
  const sent: string[] = [];
  // 固定 now：UTC 2026-11-09 11:44:00，建 11:45Z 的钟 → 北京应为 19:45
  const now = Date.parse("2026-11-09T11:44:00.000Z");
  const captured: Array<Record<string, unknown>> = [];
  const service = makeService(sent, {
    now: () => now,
    resolveTimezone: () => "Asia/Shanghai",
    composeWakeScript: async (input) => {
      captured.push({ ...input });
      return `现在是${input.fireAtLocal}，该起床了`;
    },
    synthesizeSpeech: async (text) => ({
      format: "mp3",
      base64: Buffer.from(`TZ_MP3:${text}`).toString("base64"),
    }),
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-tz",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  assert.equal(captured.length, 1, "话术生成器应被调用一次");
  const input = captured[0]!;
  assert.equal(input.fireAt, "2026-11-09T11:45:00.000Z", "原始 UTC 串保留（程序用）");
  assert.match(String(input.fireAtLocal), /19:45/, `facts 应为北京 19:45，实际：${input.fireAtLocal}`);
  assert.equal(input.fireAtLocalHour, 19);
  assert.match(service.getVoiceClip(alarm.id)!.text, /19:45/, "落盘话术念的是本地时间");
  service.stop();
});

test("未装配 resolveTimezone：回退服务器时区，建钟链路不受影响", async () => {
  const sent: string[] = [];
  const now = Date.now();
  const service = makeService(sent, {
    now: () => now,
    composeWakeScript: async ({ fireAtLocal }) => `该起床了（${fireAtLocal}）`,
    synthesizeSpeech: async (text) => ({
      format: "mp3",
      base64: Buffer.from(`NOTZ_MP3:${text}`).toString("base64"),
    }),
  });
  const { alarm } = service.createAlarm({
    actorId: "voice-notz",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(now + 60_000).toISOString(),
    wakeMode: { level: "voice_talk" },
  });
  await waitFor(() => service.getVoiceClip(alarm.id)?.tts != null);
  const text = service.getVoiceClip(alarm.id)!.text;
  assert.ok(text.length > 0, "无时区 provider 时照常生成话术");
  service.stop();
});
