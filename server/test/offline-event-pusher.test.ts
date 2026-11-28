// 离线事件统一降级（2026-11-26 P3 验收）：白名单、静默标记、稳定键去重、
// registry 的 mobileDelivered 判定都在这里固定口径。
import assert from "node:assert/strict";
import { test } from "node:test";

import { ServerEventType } from "@nextbot/agent-protocol";

import { createOfflineEventPusher } from "../src/proactivity/offline-event-pusher.js";
import type { PushInput } from "../src/proactivity/mobile-push-service.js";
import { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

function harness(nowRef: { value: number }) {
  const pushed: PushInput[] = [];
  const pusher = createOfflineEventPusher({
    push: async (input) => {
      pushed.push(input);
      return { ok: true, provider: "huawei" };
    },
    hasChannel: () => true,
    now: () => nowRef.value,
  });
  return { pushed, pusher };
}

function doneFrame(): string {
  return JSON.stringify({
    type: ServerEventType.ChatAssistantDone,
    payload: {
      sessionId: "u@example.com",
      messageId: "assistant-t1",
      traceId: "t1",
      finalText: "行程已经订好了",
      deliveryId: "d_1",
      importance: "high",
    },
  });
}

function eveningDigestFrame(): string {
  return JSON.stringify({
    type: ServerEventType.EveningDigest,
    payload: {
      sessionId: "u@example.com",
      messageId: "evening-digest-2026-11-28",
      narrationText: "明天有小雨，记得带伞。",
      digest: {
        date: "2026-11-28",
        tomorrowWeather: { text: "小雨", minC: 15, maxC: 19, alerts: [] },
        narrationText: "明天有小雨，记得带伞。",
      },
    },
  });
}

test("聊天收口离线时走 push，重复稳定键只推一次", () => {
  const nowRef = { value: 1_000_000 };
  const { pushed, pusher } = harness(nowRef);
  pusher.handle({ actorId: "u@example.com", data: doneFrame(), mobileDelivered: false });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]?.stableKey, "d_1");
  assert.equal(pushed[0]?.silent, false);
  assert.equal(pushed[0]?.event, ServerEventType.ChatAssistantDone);
  assert.ok(pushed[0]?.wire?.includes("assistant-t1"));

  pusher.handle({ actorId: "u@example.com", data: doneFrame(), mobileDelivered: false });
  assert.equal(pushed.length, 1, "10 分钟内同一 stableKey 不再重复推");

  nowRef.value += 11 * 60_000;
  pusher.handle({ actorId: "u@example.com", data: doneFrame(), mobileDelivered: false });
  assert.equal(pushed.length, 2, "TTL 过后允许再推");
});

test("手机端已收到时不镜像；卡片与看板只写穿不弹通知", () => {
  const { pushed, pusher } = harness({ value: 1_000_000 });
  pusher.handle({ actorId: "u@example.com", data: doneFrame(), mobileDelivered: true });
  assert.equal(pushed.length, 0);

  // 主动消息已由 proactive-pipeline 自带离线必达，镜像必须让路，避免双通知。
  pusher.handle({
    actorId: "u@example.com",
    data: JSON.stringify({
      type: ServerEventType.ChatAssistantDone,
      payload: { messageId: "assistant-p", finalText: "到点提醒", proactive: { deliveryId: "dp_1" } },
    }),
    mobileDelivered: false,
  });
  assert.equal(pushed.length, 0);

  pusher.handle({
    actorId: "u@example.com",
    data: JSON.stringify({
      type: ServerEventType.CardUpdate,
      payload: { messageId: "assistant-t1", card: { cardType: "booking", ok: true } },
    }),
    mobileDelivered: false,
  });
  assert.equal(pushed[0]?.silent, true);
  assert.equal(pushed[0]?.event, ServerEventType.CardUpdate);

  pusher.handle({
    actorId: "u@example.com",
    data: JSON.stringify({
      type: "agent.today_board",
      payload: { ok: true, title: "今天没什么要操心的", text: "管家在", updatedAt: 123 },
    }),
    mobileDelivered: false,
  });
  assert.equal(pushed[1]?.silent, true);
  assert.equal(pushed[1]?.kind, "reminder");
});

test("registry 只有桌面端在线时也触发镜像，手机端在线则标记已送达", () => {
  const registry = new WsConnectionRegistry();
  const seen: Array<{ actorId: string; mobileDelivered: boolean }> = [];
  registry.onOfflineEvent = (actorId, _data, mobileDelivered) =>
    seen.push({ actorId, mobileDelivered });

  const desktop = { send: () => undefined };
  registry.register("u@example.com", desktop, { deviceClass: "desktop" });
  assert.equal(registry.trySend("u@example.com", doneFrame()), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.mobileDelivered, false);

  const mobile = { send: () => undefined };
  registry.register("u@example.com", mobile, { deviceClass: "mobile" });
  seen.length = 0;
  assert.equal(registry.trySend("u@example.com", doneFrame()), true);
  assert.equal(seen.length, 0, "手机端已收到：不触发离线镜像");
});

test("明日预览离线时推送完整卡片帧，并弹系统通知", () => {
  const { pushed, pusher } = harness({ value: 1_000_000 });
  const frame = eveningDigestFrame();
  pusher.handle({ actorId: "u@example.com", data: frame, mobileDelivered: false });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]?.event, ServerEventType.EveningDigest);
  assert.equal(pushed[0]?.wire, frame);
  assert.equal(pushed[0]?.title, "明日速览");
  assert.equal(pushed[0]?.body, "明天有小雨，记得带伞。");
  assert.equal(pushed[0]?.kind, "evening_digest");
  assert.equal(pushed[0]?.silent, false);
  assert.equal(pushed[0]?.stableKey, "evening-digest-2026-11-28");
});

test("明日预览手机优先：桌面在线不吞手机推送，手机在线后不重复推", () => {
  const registry = new WsConnectionRegistry();
  const { pushed, pusher } = harness({ value: 1_000_000 });
  registry.onOfflineEvent = (actorId, data, mobileDelivered) =>
    pusher.handle({ actorId, data, mobileDelivered });
  const desktopFrames: string[] = [];
  const mobileFrames: string[] = [];
  registry.register(
    "u@example.com",
    { send: (data: string) => desktopFrames.push(data) },
    { deviceClass: "desktop" },
  );

  assert.equal(
    registry.trySendToDeviceClassOrder("u@example.com", eveningDigestFrame(), ["mobile", "desktop"]),
    true,
  );
  assert.equal(desktopFrames.length, 1, "桌面只作在线兜底");
  assert.equal(mobileFrames.length, 0);
  assert.equal(pushed.length, 1, "桌面在线也必须给离线手机完整透传");

  registry.register(
    "u@example.com",
    { send: (data: string) => mobileFrames.push(data) },
    { deviceClass: "mobile" },
  );
  assert.equal(
    registry.trySendToDeviceClassOrder("u@example.com", eveningDigestFrame(), ["mobile", "desktop"]),
    true,
  );
  assert.equal(mobileFrames.length, 1, "手机在线时独占接收");
  assert.equal(desktopFrames.length, 1, "不再向桌面重复投递");
  assert.equal(pushed.length, 1, "手机已收到，不再触发系统推送");
});
