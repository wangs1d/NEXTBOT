/**
 * travel-ticket-store 单测：票夹存储的保存/去重/过期过滤/提醒标记。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TRAVEL_TICKET_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "travel-tickets-test-"));

const { travelTicketStore } = await import("../src/skills/travel-planning/travel-ticket-store.js");

function futureDate(daysAhead: number, hm = "08:30"): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = d.toISOString().slice(0, 10);
  return `${ymd} ${hm}`;
}

test("save + get 往返一致", () => {
  const saved = travelTicketStore.save({
    type: "flight",
    source: "sms",
    carrier: "东方航空",
    code: "MU5107",
    fromCity: "北京",
    fromStation: "首都机场 T3",
    toCity: "上海",
    departTime: futureDate(2),
    arriveTime: futureDate(2, "10:45"),
    seat: "经济舱 32A",
    arrivalRideOptIn: true,
  });
  assert.ok(saved.ticketId.startsWith("ticket-"));
  const loaded = travelTicketStore.get(saved.ticketId);
  assert.equal(loaded?.code, "MU5107");
  assert.equal(loaded?.arrivalRideOptIn, true);
});

test("findByCode 去重：同航班同日只匹配一张", () => {
  const depart = futureDate(3);
  travelTicketStore.save({ type: "train", source: "sms", carrier: "G1027", code: "G1027", departTime: depart });
  travelTicketStore.save({ type: "train", source: "sms", carrier: "G1027", code: "G1027", departTime: futureDate(5) });
  const hit = travelTicketStore.findByCode("train", "g1027", depart);
  assert.ok(hit);
  assert.equal(hit!.departTime, depart);
  assert.equal(travelTicketStore.findByCode("train", "XXXX", depart), null);
});

test("listUpcoming 过滤已过期，按出发时间升序", () => {
  travelTicketStore.save({
    type: "flight",
    source: "manual",
    carrier: "已过期航班",
    departTime: "2020-01-01 08:00",
  });
  travelTicketStore.save({
    type: "hotel",
    source: "manual",
    carrier: "已过期酒店",
    checkInDate: "2020-01-01",
    checkOutDate: "2020-01-03",
  });
  const near = travelTicketStore.save({
    type: "train",
    source: "manual",
    carrier: "K1",
    departTime: futureDate(1),
  });
  const far = travelTicketStore.save({
    type: "train",
    source: "manual",
    carrier: "K2",
    departTime: futureDate(10),
  });
  const upcoming = travelTicketStore.listUpcoming(50);
  const carriers = upcoming.map((t) => t.carrier);
  assert.ok(!carriers.includes("已过期航班"));
  assert.ok(!carriers.includes("已过期酒店"));
  const idxNear = upcoming.findIndex((t) => t.ticketId === near.ticketId);
  const idxFar = upcoming.findIndex((t) => t.ticketId === far.ticketId);
  assert.ok(idxNear >= 0 && idxFar >= 0 && idxNear < idxFar, "近票在前");
  // 无时间的票保留（人工确认）
  travelTicketStore.save({ type: "hotel", source: "manual", carrier: "无日期酒店" });
  assert.ok(travelTicketStore.listUpcoming(50).some((t) => t.carrier === "无日期酒店"));
});

test("markRideReminderCreated 幂等标记", () => {
  const saved = travelTicketStore.save({
    type: "flight",
    source: "manual",
    carrier: "CA1234",
    departTime: futureDate(4),
    arriveTime: futureDate(4, "12:00"),
    arrivalRideOptIn: true,
  });
  assert.notEqual(saved.arrivalRideReminderCreated, true);
  travelTicketStore.markRideReminderCreated(saved.ticketId);
  assert.equal(travelTicketStore.get(saved.ticketId)?.arrivalRideReminderCreated, true);
});

test("归属隔离：别人的票读不到，列表/去重只命中自己的票", () => {
  const mine = travelTicketStore.save({
    type: "flight",
    source: "manual",
    actorId: "alice@example.com",
    carrier: "归属测试",
    code: "MU9000",
    departTime: futureDate(7),
  });
  assert.equal(travelTicketStore.get(mine.ticketId, "bob@example.com"), null);
  assert.equal(travelTicketStore.get(mine.ticketId, "alice@example.com")?.ticketId, mine.ticketId);
  assert.ok(!travelTicketStore.listUpcoming(50, "bob@example.com").some((t) => t.ticketId === mine.ticketId));
  assert.equal(travelTicketStore.findByCode("flight", "MU9000", futureDate(7), "bob@example.com"), null);
});

test("按票 ID 保存更新不产生重复（parse-ticket 的去重路径）", () => {
  const first = travelTicketStore.save({
    type: "train",
    source: "manual",
    carrier: "G9",
    code: "G9",
    departTime: futureDate(6),
    seat: "二等座",
  });
  // parse-ticket 的去重路径：先 findByCode 命中，再带同一 ticketId 保存
  const existing = travelTicketStore.findByCode("train", "G9", futureDate(6));
  assert.equal(existing?.ticketId, first.ticketId);
  const updated = travelTicketStore.save({
    ...existing!,
    source: "manual",
    seat: "一等座 05F",
  });
  assert.equal(updated.ticketId, first.ticketId);
  assert.equal(travelTicketStore.get(first.ticketId)?.seat, "一等座 05F");
});
