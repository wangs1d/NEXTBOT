import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProactiveOutboundMessageService } from "../src/services/proactive-outbound-message-service.js";

// 票夹是模块级单例，必须在 import 前重定向存储目录
process.env.TRAVEL_TICKET_STORE_DIR = mkdtempSync(path.join(os.tmpdir(), "arrival-monitor-test-"));

const { travelTicketStore } = await import("../src/skills/travel-planning/travel-ticket-store.js");
const { ArrivalMonitorService, composePickupMessage } = await import(
  "../src/services/arrival-concierge/arrival-monitor-service.js"
);
const { ManualScheduleProvider } = await import("../src/services/arrival-concierge/providers/manual-schedule-provider.js");
const { VariflightFlightProvider } = await import("../src/services/arrival-concierge/providers/variflight-flight-provider.js");

const NOW = new Date("2026-09-06T15:00:00");

function fakeOutbound(sent: Array<Record<string, unknown>>): ProactiveOutboundMessageService {
  return {
    send: async (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
  } as unknown as ProactiveOutboundMessageService;
}

/** 本地时区 "YYYY-MM-DD HH:mm"（票面时间格式；不能用 toISOString，会偏时区）。 */
function iso(offsetMinutes: number): string {
  const d = new Date(NOW.getTime() + offsetMinutes * 60_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makeService(sent: Array<Record<string, unknown>>, getLocation: ((actorId: string) => { latitude: number; longitude: number; label?: string } | null) | null = null): InstanceType<typeof ArrivalMonitorService> {
  return new ArrivalMonitorService({
    outbound: fakeOutbound(sent),
    providers: [new VariflightFlightProvider(), new ManualScheduleProvider()],
    emailSms: null,
    platformGateway: null,
    getLocation,
    now: () => NOW,
  });
}

test("到站阶段推导：到达前 30 分钟 → approaching；票面已过 30 分钟 → landed（宽限期）", async () => {
  const service = makeService([]);
  const approachingTicket = travelTicketStore.save({
    type: "flight",
    source: "manual",
    actorId: "u1",
    carrier: "东方航空",
    code: "MU5107",
    toStation: "上海虹桥机场 T2",
    departTime: iso(-120),
    arriveTime: iso(30),
    arrivalRideOptIn: false,
  });
  const landedTicket = travelTicketStore.save({
    type: "train",
    source: "manual",
    actorId: "u1",
    carrier: "G1027",
    code: "G1027",
    toStation: "上海虹桥站",
    departTime: iso(-300),
    arriveTime: iso(-30),
    arrivalRideOptIn: false,
  });

  const approaching = await service.getSnapshot(approachingTicket.ticketId, "u1");
  assert.equal(approaching.ok, true);
  assert.equal(approaching.snapshot?.stage, "approaching");

  const landed = await service.getSnapshot(landedTicket.ticketId, "u1");
  assert.equal(landed.ok, true);
  assert.equal(landed.snapshot?.stage, "landed");
});

test("到站监控 tick：定位命中到达地时提前判 landed 并触发接站提案", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const service = makeService(
    sent,
    () => ({ latitude: 31.19, longitude: 121.33, label: "上海虹桥国际机场" }),
  );
  // 票面还有 30 分钟到（无动态 API 本应为 approaching），但定位显示已在机场 → landed
  const ticket = travelTicketStore.save({
    type: "flight",
    source: "manual",
    actorId: "u1",
    carrier: "东方航空",
    code: "MU5107",
    toStation: "上海虹桥机场 T2",
    departTime: iso(-120),
    arriveTime: iso(30),
    arrivalRideOptIn: false,
  });
  const enabled = service.enable(ticket.ticketId, "u1");
  assert.equal(enabled.ok, true);

  await service.tick();
  assert.ok(sent.length >= 1, "landed 阶段应产生主动提案");
  assert.ok(
    sent.some((m) => String(m.title ?? "").includes("已落地")),
    "无接站人时应提示用户指定接站人",
  );
});

test("接站人设置与消息文案；免确认直发失败时如实回退为用户通知", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const service = makeService(sent);
  const ticket = travelTicketStore.save({
    type: "train",
    source: "manual",
    actorId: "u1",
    carrier: "G1027",
    code: "G1027",
    passenger: "小王",
    toStation: "上海虹桥站",
    arriveTime: iso(-10),
    arrivalRideOptIn: false,
  });

  const set = service.setPickupContact(ticket.ticketId, "u1", {
    name: "小李",
    phone: "13800138000",
    autoSend: true,
  });
  assert.equal(set.ok, true);

  const message = composePickupMessage(travelTicketStore.get(ticket.ticketId)!, null);
  assert.ok(message.includes("G1027"));
  assert.ok(message.includes("小王"));
  assert.ok(message.includes("小李") === false, "接站消息里不含接站人自己的称呼");
  assert.ok(message.includes("私人管家"));

  // autoSend 直发：短信服务未配置（emailSms=null → 桩服务未装配）→ 失败回退通知
  await service.sendPickupNow(ticket.ticketId, "u1");
  const sentDirect = await service.sendPickupNow(ticket.ticketId, "u1");
  assert.equal(sentDirect.ok, false);
  assert.ok(sentDirect.summary.length > 0);
});

test("未配置动态 API 时 provider 链落到票面兜底", () => {
  const manual = new ManualScheduleProvider();
  assert.deepEqual(manual.availability(), { ok: true });
  // 航旅纵横未配置 key → 不可用，monitor 自动降级
  const variflight = new VariflightFlightProvider();
  assert.equal(variflight.availability().ok, false);
});
