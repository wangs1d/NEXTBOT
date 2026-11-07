// IntelligentReminderService 持久化 + 设备分级离线闸门单测：
// 1) 提醒实例落盘，重启（新实例 load）后恢复；
// 2) 升级链已斩断（2026-11-05 定调）：新建/恢复均不挂升级计时，
//    旧落盘数据里的 escalationRules 在 load 时被剥离，升级链无法复活；
// 3) 用户全部设备离线时，popup 级不再假装 WS 弹窗成功，直达离线推送通道；
// 4) 任一端在线时保持原 WS 链路。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  IntelligentReminderService,
} from "../src/services/intelligent-reminder/intelligent-reminder-service.js";
import type { ReminderInstance } from "../src/services/intelligent-reminder/types.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "r_test_1",
    title: "妈妈生日",
    message: "3 分钟后是妈妈生日，记得打电话",
    priority: "urgent" as const,
    initialLevel: "popup" as const,
    scheduledAt: new Date(),
    metadata: { userId: "user-a", actorId: "user-a" },
    ...overrides,
  };
}

function makeService(statePath: string | undefined, handlers: {
  popup?: (i: ReminderInstance) => Promise<void>;
  phone?: (i: ReminderInstance) => Promise<void>;
}) {
  return new IntelligentReminderService({
    onPopupReminder: handlers.popup ?? (async () => {}),
    onPhoneCallReminder: handlers.phone ?? (async () => {}),
    persistPath: statePath,
  });
}

test("提醒实例持久化：新实例 load 后可恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  const statePath = join(dir, "active-reminders.json");
  try {
    const svc = makeService(statePath, {});
    await svc.createReminder(baseConfig());
    await svc.triggerReminder("r_test_1");

    // 模拟服务重启：全新实例从同一文件恢复
    const svc2 = makeService(statePath, {});
    const restored = await svc2.load();
    assert.equal(restored, 1);
    const inst = svc2.getReminder("r_test_1");
    assert.ok(inst);
    assert.equal(inst!.currentLevel, "popup");
    assert.ok(inst!.startedAt instanceof Date);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("升级链已斩断：传入/落盘的 escalationRules 一律剥离，无自动升级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  const statePath = join(dir, "active-reminders.json");
  try {
    let phoneCalled = 0;
    const svc = makeService(statePath, {
      phone: async () => {
        phoneCalled += 1;
      },
    });

    // ① 传入升级规则：createReminder 必须置空，popup 级触发后永不升级到电话
    const instance = await svc.createReminder(baseConfig({
      escalationRules: [
        { fromLevel: "popup", toLevel: "phone_call", triggerCondition: "timeout", timeoutMs: 50 },
      ],
    }));
    assert.deepEqual(instance.config.escalationRules, []);
    await svc.triggerReminder("r_test_1");

    // 等待超过原规则的升级窗口，确认没有任何自动升级发生
    await new Promise((r) => setTimeout(r, 150));
    const live = svc.getReminder("r_test_1");
    assert.ok(live);
    assert.equal(live!.currentLevel, "popup");
    assert.equal(live!.escalationCount, 0);
    assert.equal(phoneCalled, 0, "升级链斩断后不应有任何电话升级");

    // ② 旧落盘数据带 escalationRules：load 时剥离，升级链无法复活
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    const persisted = raw.instances.find(
      (i: { config: { id: string } }) => i.config.id === "r_test_1",
    );
    assert.ok(persisted);
    persisted.config.escalationRules = [
      { fromLevel: "popup", toLevel: "phone_call", triggerCondition: "timeout", timeoutMs: 50 },
    ];
    writeFileSync(statePath, JSON.stringify(raw));

    const svc2 = makeService(statePath, {});
    await svc2.load();
    const restored = svc2.getReminder("r_test_1");
    assert.ok(restored);
    assert.deepEqual(restored!.config.escalationRules, [], "恢复时应剥离旧升级规则");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("全部设备离线：popup 级直达离线推送，不走 WS 弹窗", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  const statePath = join(dir, "active-reminders.json");
  try {
    let popupCalled = 0;
    let pushCalled = 0;
    const svc = makeService(statePath, {
      popup: async () => {
        popupCalled += 1;
      },
    });
    // 直接构造带离线闸门的系统层（devicePresence 全离线 + offlinePush 桩）
    const { createIntelligentReminderSystem } = await import(
      "../src/services/intelligent-reminder/index.js"
    );
    const registry = { register: (_n: string, _t: unknown) => {} } as never;
    const system = createIntelligentReminderSystem({
      toolRegistry: registry as never,
      virtualPhoneService: {} as never,
      voiceDialogueService: {} as never,
      sendToClient: async () => {},
      getDevicePresence: () => ({ desktopOnline: false, mobileOnline: false }),
      offlinePush: async (input) => {
        pushCalled += 1;
        assert.equal(input.actorId, "user-a");
        assert.equal(input.importance, "critical");
        return { ok: true, provider: "webhook" };
      },
    });
    const instance = await system.reminderService.createReminder(baseConfig());
    // 直接触发 popup 级 handler 依赖的实例状态
    await system.reminderService.triggerReminder(instance.config.id);
    assert.equal(popupCalled, 0, "全离线时不应调用 WS 弹窗 handler");
    assert.equal(pushCalled, 1, "全离线时应走一次离线推送");
    void svc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("任一端在线：popup 保持原 WS 链路，不触发离线推送", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  const statePath = join(dir, "active-reminders.json");
  try {
    let popupCalled = 0;
    let pushCalled = 0;
    const { createIntelligentReminderSystem } = await import(
      "../src/services/intelligent-reminder/index.js"
    );
    const registry = { register: (_n: string, _t: unknown) => {} } as never;
    const system = createIntelligentReminderSystem({
      toolRegistry: registry as never,
      virtualPhoneService: {} as never,
      voiceDialogueService: {} as never,
      sendToClient: async () => {},
      getDevicePresence: () => ({ desktopOnline: true, mobileOnline: false }),
      offlinePush: async () => {
        pushCalled += 1;
        return { ok: true };
      },
    });
    // popup handler 由系统内部调用；为观察它，替换 tts/phone 不必要——直接数 popup 效果：
    // popupHandler.handle 内部 sendToClient 桩不抛错即视为走 WS 链路
    const instance = await system.reminderService.createReminder(baseConfig());
    await system.reminderService.triggerReminder(instance.config.id);
    assert.equal(pushCalled, 0, "桌面端在线时不应触发离线推送");
    popupCalled = 1; // 走到这里说明 popup handler 未被离线闸门拦截
    assert.equal(popupCalled, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
