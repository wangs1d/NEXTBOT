// 手机信号 15 分钟桶落库（需求 §7.2）单测：幂等、口径对齐、按天汇总、保留窗口。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PhoneSignalBucketStore } from "../src/proactivity/phone-signal-buckets.js";

const BUCKET_MS = 15 * 60 * 1000;
const DAY = 24 * 60 * 60_000;
// 固定成本地正午，避开 UTC 偏移对「夜间」判定的干扰
const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();

function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  return join(dir, "phone-buckets.json");
}

function bucket(offsetBuckets: number, over: Record<string, unknown> = {}) {
  return {
    bucket: NOW - offsetBuckets * BUCKET_MS,
    unlocks: 2,
    screenOnMin: 10,
    inCallMin: 0,
    charging: false,
    dnd: false,
    ...over,
  };
}

test("桶按 actorId+bucket 幂等：心跳重发与重连补报不会记两次", () => {
  const path = tmpPath("buckets-dedup-");
  const store = new PhoneSignalBucketStore(path);
  const first = [bucket(1), bucket(2)];
  assert.equal(store.append("u1", first, NOW), 2);
  // 同一批原样再来一次（心跳补报）
  assert.equal(store.append("u1", first, NOW), 0);
  // 换桶起点但字段完全相同（不同 actor）→ 是新记录，幂等键含 actor
  assert.equal(store.append("u2", first, NOW), 2);
  assert.equal(store.size(), 4);
  assert.equal(store.recent("u1", 10).length, 2);
  rmSync(path, { force: true });
});

test("入站桶被对齐到 15 分钟边界，超桶长的时长被截断", () => {
  const path = tmpPath("buckets-norm-");
  const store = new PhoneSignalBucketStore(path);
  const skewed = NOW + 7 * 60 * 1000; // 未对齐
  assert.equal(store.append("u1", [bucket(0, { bucket: skewed, screenOnMin: 880 })], NOW), 1);
  const [row] = store.recent("u1", 1);
  assert.equal(row!.bucket % BUCKET_MS, 0, "桶起点应对齐");
  assert.equal(row!.bucket, Math.floor(skewed / BUCKET_MS) * BUCKET_MS);
  assert.equal(row!.screenOnMin, 15, "一个桶只有 15 分钟，坏帧按桶长截断");
  rmSync(path, { force: true });
});

test("坏帧与未来帧丢弃：时钟不可信，未来的桶没有历史含义", () => {
  const path = tmpPath("buckets-junk-");
  const store = new PhoneSignalBucketStore(path);
  const added = store.append(
    "u1",
    [
      null,
      "nonsense",
      {},
      bucket(0, { bucket: 0 }),
      bucket(-3, { bucket: NOW + 3 * BUCKET_MS }), // 超出一个桶的宽容带
    ] as unknown[],
    NOW,
  );
  assert.equal(added, 0);
  assert.equal(store.size(), 0);
  // 当前未闭合的桶（起点=本桶）仍收：端上只在桶结束后上报，这里不做二次门禁
  assert.equal(store.append("u1", [bucket(0)], NOW), 1);
  rmSync(path, { force: true });
});

test("重启后从文件恢复，且旧桶不会因再次上报而重复", () => {
  const path = tmpPath("buckets-restore-");
  const store = new PhoneSignalBucketStore(path);
  const frames = [bucket(1), bucket(2), bucket(3)];
  store.append("u1", frames, NOW);
  const reopened = new PhoneSignalBucketStore(path);
  assert.equal(reopened.size(), 3);
  assert.equal(reopened.append("u1", frames, NOW), 0, "重连补报应全部命中幂等键");
  rmSync(path, { force: true });
});

test("按天汇总：夜间亮屏单独计，actor 与窗口过滤生效", () => {
  const path = tmpPath("buckets-daily-");
  const store = new PhoneSignalBucketStore(path);
  const night = new Date(2026, 10, 23, 2, 30, 0).getTime(); // 本地 02:30 → 夜间
  store.append(
    "u1",
    [
      bucket(0, { bucket: NOW, screenOnMin: 12, unlocks: 3 }),
      bucket(1, { bucket: NOW - BUCKET_MS, screenOnMin: 8, inCallMin: 15, dnd: true }),
      bucket(0, { bucket: night, screenOnMin: 20, charging: true }),
    ],
    NOW,
  );
  store.append("u2", [bucket(0, { screenOnMin: 5 })], NOW);

  const [today] = store.dailySummary("u1", 7, NOW);
  assert.equal(today!.day, "2026-11-23");
  assert.equal(today!.buckets, 3);
  assert.equal(today!.unlocks, 3 + 2 + 2);
  assert.equal(today!.screenOnMin, 12 + 8 + 15); // 夜间那帧 20 被截断成 15
  assert.equal(today!.inCallMin, 15);
  assert.equal(today!.nightScreenOnMin, 15, "只有 22:00-07:00 的桶进夜间口径");
  assert.equal(today!.dndBuckets, 1);
  assert.equal(today!.chargingBuckets, 1);

  const all = store.dailySummary(undefined, 7, NOW);
  assert.equal(all[0]!.screenOnMin, 12 + 8 + 15 + 5, "不传 actor 时全量汇总");
  assert.equal(store.dailySummary("u1", 7, NOW + 8 * DAY).length, 0, "窗口外的桶不进汇总");
  rmSync(path, { force: true });
});

test("保留窗口：过期帧当场拒收，落盘历史在构造时按 keepDays 清理", () => {
  const path = tmpPath("buckets-keep-");
  const store = new PhoneSignalBucketStore(path, 7);
  // 40 天前的桶不可能有节律含义，append 即拒收（返回值等于真实收录数）
  assert.equal(store.append("u1", [bucket(0), bucket(40 * 96)], NOW), 1);
  assert.equal(store.size(), 1);

  // 手工造一份带历史包袱的落盘文件：老版本写进去的过期桶不该被读回来
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      buckets: [
        { ...bucket(0), actorId: "u1" },
        { ...bucket(40 * 96), actorId: "u1" },
      ],
    }),
  );
  const reopened = new PhoneSignalBucketStore(path, 7);
  assert.equal(reopened.size(), 1, "构造即按 keepDays 清理落盘历史");
  assert.equal(
    reopened.append("u1", [bucket(40 * 96)], NOW),
    0,
    "清理不等于留了个洞：同一批旧桶重传仍然不进",
  );
  rmSync(path, { force: true });
});
