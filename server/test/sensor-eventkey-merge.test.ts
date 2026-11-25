// 事件键（接缝 1）：同一件现实世界的事跨信源只存一条。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SourceStore } from "../src/proactivity/source-store.js";
import {
  dateKeyOf,
  mailEventKey,
  mailThreadKey,
  transportEventKey,
} from "../src/proactivity/sensors/event-key.js";
import type { Signal } from "../src/proactivity/sensors/types.js";

const T0 = Date.UTC(2026, 10, 25, 2, 0, 0);

function withStore(fn: (store: SourceStore, dir: string) => void, env: Record<string, string> = {}): void {
  const dir = mkdtempSync(join(tmpdir(), "srcstore-eventkey-"));
  try {
    const store = new SourceStore({ dataPath: dir, nowFn: () => T0, disablePersist: true, env });
    fn(store, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("事件日期锚定：显式年份 / 中文月日 / 无年份跨年滚动", () => {
  assert.equal(dateKeyOf("2026年12月30日 出发"), "2026-12-30");
  assert.equal(dateKeyOf("12月30日 出发", T0), "2026-12-30");
  assert.equal(dateKeyOf("1月5日 出发", Date.UTC(2026, 11, 20)), "2027-01-05");
  assert.equal(dateKeyOf("没有日期", T0), "2026-11-25", "取不到就退回 fallback 日");
});

test("航班/车次键带日期：航班号每天重复，不带日期会把两天的航班并成一件", () => {
  assert.equal(
    transportEventKey("机票 CA1234 12月30日 北京-三亚", T0),
    "flight:CA1234:2026-12-30",
  );
  assert.equal(
    transportEventKey("高铁 G1234 12月30日 上海-杭州", T0),
    "train:G1234:2026-12-30",
  );
  assert.equal(transportEventKey("编号 ID123456 的表单", T0), null, "非航班前缀不能被当成航班");
});

test("邮件线程键：Re/回复/空白差异归一，隔日算另一件", () => {
  const a = mailThreadKey("u1", "Re: 合同 review", T0);
  const b = mailThreadKey("u1", "回复: 合同review", T0);
  assert.equal(a, b);
  assert.notEqual(a, mailThreadKey("u1", "Re: 合同 review", T0 + 86_400_000));
  assert.equal(mailEventKey("u1", "Re: 合同 review", "", T0), a);
});

test("SourceStore：同一 eventKey 的邮件与日历合并成一条，refs 记所有来源", () => {
  withStore((store) => {
    const mail: Signal = {
      stream: "mail",
      actorId: "u1",
      at: T0,
      fingerprint: "mail:u1:101",
      salience: "high",
      delta: "新邮件：机票行程确认",
      eventKey: "flight:CA1234:2026-12-30",
      payload: { uid: 101, subject: "机票行程确认 CA1234 12月30日", text: "12月30日 CA1234 北京-三亚" },
    };
    const ics: Signal = {
      stream: "schedule",
      actorId: "u1",
      at: Date.UTC(2026, 11, 30, 1),
      fingerprint: "ics:u1:feed:abc",
      salience: "high",
      delta: "日历事件：CA1234 北京-三亚",
      eventKey: "flight:CA1234:2026-12-30",
      payload: { source: "ics", summary: "CA1234 北京-三亚", startMs: Date.UTC(2026, 11, 30, 1) },
    };
    store.feed(mail);
    store.feed(ics);

    const stats = store.stats();
    assert.equal(stats.windowSize, 1, "两封信/两个日历项 = 一件事，只留一条");
    assert.equal(stats.eventMerge.merged, 1);
    assert.equal(stats.eventMerge.keys, 1);

    const [primary] = store.findByEventKey("flight:CA1234:2026-12-30");
    assert.ok(primary);
    assert.equal(primary.fingerprint, "mail:u1:101", "先到的信号是主事件（事件时刻语义不变）");
    assert.deepEqual(primary.payload?.sources, ["mail", "schedule"]);
    assert.equal((primary.payload?.refs as string[]).length, 2);
    assert.equal(primary.payload?.lastSeenAt, Date.UTC(2026, 11, 30, 1));

    // 后到信号的实体也要能被跨源检索到（命中指向主事件）
    const hits = store.findByEntity("三亚");
    assert.ok(hits.length >= 1, "合并不能把后来者的实体丢掉");
    assert.equal(hits[0]!.fingerprint, "mail:u1:101");
  });
});

test("事件键不跨用户合并；关掉开关一行代码回到旧行为", () => {
  withStore((store) => {
    const mk = (actorId: string, fingerprint: string): Signal => ({
      stream: "mail",
      actorId,
      at: T0,
      fingerprint,
      salience: "medium",
      delta: "新邮件：行程",
      eventKey: "flight:CA1234:2026-12-30",
    });
    store.feed(mk("u1", "mail:u1:1"));
    store.feed(mk("u2", "mail:u2:1"));
    assert.equal(store.stats().windowSize, 2, "不同用户的事件键互不影响");
  });

  withStore(
    (store) => {
      const mk = (fp: string): Signal => ({
        stream: "mail",
        actorId: "u1",
        at: T0,
        fingerprint: fp,
        salience: "medium",
        delta: "新邮件：行程",
        eventKey: "flight:CA1234:2026-12-30",
      });
      store.feed(mk("mail:u1:1"));
      store.feed(mk("mail:u1:2"));
      assert.equal(store.stats().windowSize, 2, "SENSOR_EVENT_KEY_MERGE=0 → 各存一条");
    },
    { SENSOR_EVENT_KEY_MERGE: "0" },
  );
});

test("重启后从日分区重建同一件事：原始记录各一行，窗口里仍只留主事件", () => {
  const dir = mkdtempSync(join(tmpdir(), "srcstore-eventkey-load-"));
  try {
    const mk = (stream: "mail" | "schedule", fp: string, at: number): Signal => ({
      stream,
      actorId: "u1",
      at,
      fingerprint: fp,
      salience: "high",
      delta: stream === "mail" ? "新邮件：机票" : "日历事件：航班",
      eventKey: "flight:CA1234:2026-12-30",
    });
    const before = new SourceStore({ dataPath: dir, nowFn: () => T0 });
    before.feed(mk("mail", "mail:u1:1", T0));
    before.feed(mk("schedule", "ics:u1:1", Date.UTC(2026, 11, 30, 1)));
    assert.equal(before.stats().eventMerge.merged, 1);

    const after = new SourceStore({ dataPath: dir, nowFn: () => T0 });
    const loaded = after.loadRecent({ days: 7 });
    assert.equal(loaded, 2, "磁盘上保留每条来源的原始记录");
    assert.equal(after.stats().windowSize, 1, "加载后窗口里仍只留主事件");
    const [primary] = after.findByEventKey("flight:CA1234:2026-12-30");
    assert.equal((primary?.payload?.refs as string[]).length, 2, "重启不丢跨源 refs");
    assert.deepEqual(primary?.payload?.sources, ["mail", "schedule"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
