// 手机时机模型 M1（2026-11-23，需求文档 §3.7）单测。
//
// 覆盖 R1 的三个病根：
//   1. 「连着」不等于「在场」——手机锁屏揣兜里不再被桌面 idle=0 判成最佳时机；
//   2. 通话 / 勿扰 / 睡眠这类高打断成本要真的反映到成本数字上；
//   3. 两端都在时挑打断成本最低的那一端弹横幅（人在电脑前就不往手机推）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { PresenceService } from "../src/proactivity/presence-service.js";
import { interruptCost, type ContextSnapshot } from "../src/proactivity/arbiter-v2.js";
import { PHONE_GRADE_COST } from "../src/proactivity/phone-presence.js";

/** 本地正午（避开睡眠判定的夜间窗口） */
function noon(offsetMin = 0): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() + offsetMin * 60_000;
}
/** 本地凌晨 2 点（睡眠判定的夜间窗口内） */
function night(offsetMin = 0): number {
  const d = new Date();
  d.setHours(2, 0, 0, 0);
  return d.getTime() + offsetMin * 60_000;
}

type PhoneFlags = { interactive: boolean; screenOn: boolean; inCall: boolean; dnd: boolean; charging: boolean };
const flags = (over: Partial<PhoneFlags> = {}): PhoneFlags => ({
  interactive: false,
  screenOn: false,
  inCall: false,
  dnd: false,
  charging: false,
  ...over,
});

function gradeOf(p: PresenceService, at: number) {
  return p.phoneGrade("u1", at)?.grade;
}

test("手机分级：解锁在用 / 刚锁屏 / 锁屏中 / 通话 / 勿扰 / 睡眠各归各档", () => {
  const p = new PresenceService();
  p.markConnected("u1", noon());

  // 正在用（解锁且在 2min 内有交互）
  p.notePhoneState("u1", flags({ interactive: true, screenOn: true }), noon());
  assert.equal(gradeOf(p, noon()), "phone_active");
  assert.equal(p.phoneGrade("u1", noon() + 60_000)?.cost, PHONE_GRADE_COST.phone_active);

  // 放下 5 分钟：还在手边
  p.notePhoneState("u1", flags(), noon(5));
  assert.equal(gradeOf(p, noon(5)), "phone_recent");

  // 放下 30 分钟：兜里
  assert.equal(gradeOf(p, noon(30)), "phone_away");

  // 通话中优先于其它一切判断
  p.notePhoneState("u1", flags({ interactive: true, screenOn: true, inCall: true }), noon(31));
  assert.equal(gradeOf(p, noon(31)), "in_call");

  // 勿扰：不打电话也不该说
  p.notePhoneState("u1", flags({ dnd: true }), noon(32));
  assert.equal(gradeOf(p, noon(32)), "dnd");

  // 夜间 + 充电 + 锁屏 ≥30min：睡了（前台服务每 10 分钟心跳保鲜，状态不会过期）
  const q = new PresenceService();
  q.markConnected("u1", night());
  q.notePhoneState("u1", flags({ charging: true }), night());
  assert.equal(q.phoneGrade("u1", night(10))?.grade, "phone_recent", "锁屏才 10 分钟，还不算睡");
  q.notePhoneState("u1", flags({ charging: true }), night(10));
  q.notePhoneState("u1", flags({ charging: true }), night(20));
  q.notePhoneState("u1", flags({ charging: true }), night(30));
  q.notePhoneState("u1", flags({ charging: true }), night(40));
  assert.equal(q.phoneGrade("u1", night(45))?.grade, "sleeping");
  assert.equal(q.phoneGrade("u1", night(45))?.cost, 10);
  // 心跳停了（App 被杀）：40 分钟没刷新 → 状态作废，不拿旧状态一直挡消息
  assert.equal(q.phoneGrade("u1", night(90)), null);
});

test("持续灭屏的心跳不把锁屏起点推回当下（否则永远 phone_recent）", () => {
  const p = new PresenceService();
  p.markConnected("u1", noon());
  p.notePhoneState("u1", flags(), noon());
  // 前台服务每 10 分钟心跳一次，状态仍是灭屏
  p.notePhoneState("u1", flags(), noon(10));
  p.notePhoneState("u1", flags(), noon(20));
  assert.equal(gradeOf(p, noon(20)), "phone_away", "心跳刷新 at 但锁屏起点仍是第一次灭屏");
  // 亮屏 → 起点清空；再灭屏重新计时
  p.notePhoneState("u1", flags({ screenOn: true, interactive: true }), noon(25));
  p.notePhoneState("u1", flags(), noon(26));
  assert.equal(gradeOf(p, noon(30)), "phone_recent", "刚重新锁屏，回到 recent");
});

test("打断成本：没有手机信号时与桌面口径逐位一致；手机锁屏后不再是 idle=0", () => {
  const base: ContextSnapshot = {
    now: new Date(),
    presence: "idle",
    inConversation: false,
    screenFocus: null,
    nextEventMin: null,
    quietHours: false,
    receptivity: 0.5,
    recentBurst: 0,
  };
  // 无手机信号（桌面用户 / 旧客户端）：0 上下文 + 1 接受度加成
  assert.equal(interruptCost(base), 1);
  // 只用手机、锁屏在兜里：成本按手机档走，「最佳时机」的假象消失
  assert.equal(
    interruptCost({ ...base, desktopOnline: false, phoneCost: PHONE_GRADE_COST.phone_away }),
    6,
    "桌面端根本不在，屏幕权重那 0 分不算数",
  );
  // 通话中：非 must 一律挂起（>4.5 的 alert 上限）
  assert.ok(interruptCost({ ...base, desktopOnline: false, phoneCost: PHONE_GRADE_COST.in_call }) >= 9);
  // 两端都在且人在电脑前活跃：取更低的那一端
  assert.equal(
    interruptCost({
      ...base,
      presence: "active",
      screenFocus: "browsing",
      desktopOnline: true,
      phoneCost: PHONE_GRADE_COST.phone_away,
    }),
    2,
    "桌面 browsing(1)+加成(1)，手机 away(5) —— 取桌面",
  );
  // 两端都在但桌面没人动：以手机为准（§3.1 原则 2）
  assert.equal(
    interruptCost({ ...base, desktopOnline: true, phoneCost: PHONE_GRADE_COST.phone_away }),
    6,
    "桌面在线却没人在用，不能凭空 0 分",
  );
  // 手机刚解锁 = 最佳时机
  assert.equal(
    interruptCost({ ...base, desktopOnline: false, phoneCost: PHONE_GRADE_COST.phone_active }),
    3,
  );
});

test("横幅归属：单端不指定，双端归人此刻在的那一端", () => {
  const classes = new Map<string, string[]>([["u1", ["mobile"]]]);
  let attended: string | null = null;
  const p = new PresenceService({
    onlineDeviceClasses: (id) => classes.get(id) ?? [],
    attendedDeviceClass: () => attended,
  });
  p.markConnected("u1", noon());
  p.notePhoneState("u1", flags({ interactive: true, screenOn: true }), noon());
  assert.equal(p.bannerSurface("u1", noon()), null, "只有一端在线没得选，维持原 fan-out 语义");

  classes.set("u1", ["mobile", "desktop"]);
  // 手机正解锁在用 → 归手机
  assert.equal(p.bannerSurface("u1", noon()), "mobile");
  // 手机锁屏了，桌面最近有真人业务活动 → 归桌面（人在电脑前，别往手机弹）
  p.notePhoneState("u1", flags(), noon(30));
  attended = "desktop";
  assert.equal(p.bannerSurface("u1", noon(30)), "desktop");
  // 两端都没动静 → 归手机（至少落在通知栏等人回来看）
  attended = null;
  assert.equal(p.bannerSurface("u1", noon(30)), "mobile");
  // 手机状态过期（App 被杀）→ 不指定，各端自决
  assert.equal(p.bannerSurface("u1", noon(90)), null);
});

test("在场分级：手机揣兜里 1 小时，presence 不再显示 active", () => {
  const p = new PresenceService();
  p.markConnected("u1", noon());
  p.notePhoneState("u1", flags({ interactive: true, screenOn: true }), noon());
  assert.equal(p.getPresence("u1", noon()), "active");
  // 只有灭屏心跳（interactive=false），不再刷活动
  p.notePhoneState("u1", flags(), noon(20));
  p.notePhoneState("u1", flags(), noon(60));
  assert.equal(p.getPresence("u1", noon(75)), "idle");
});
