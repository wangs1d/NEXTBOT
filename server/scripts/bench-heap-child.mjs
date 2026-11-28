/**
 * 堆/GC 基准的子进程负载（由 bench-optimizations.ts 以不同 node 参数拉起）。
 *
 * 负载特征对齐线上：
 *   1. 常驻约 160MB 的小对象（记忆快照/画像路由/工具索引常驻 Map）
 *   2. 持续产生短命对象（工具结果、流式分片、SQLite 行），总量远超堆上限
 * 观察点：GC 次数、major GC 次数、GC 总耗时占比、任务总耗时。
 */

import { PerformanceObserver, performance } from "node:perf_hooks";

const gcs = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) gcs.push(entry);
});
observer.observe({ entryTypes: ["gc"] });

const started = performance.now();

// 常驻：老生代压力（这部分会长期占住，逼出晋升与 major GC）
const shared = "常驻记忆条目-用户画像与工具索引".repeat(2);
const resident = new Array(2_400_000);
for (let i = 0; i < resident.length; i++) {
  resident[i] = { id: i, text: shared, tags: [i % 7, i % 13], score: i * 0.5 };
}

for (let i = 0; i < 300; i++) {
  // 短命对象洪流：每轮约 4~5MB，跑完即弃
  let pool = [];
  for (let j = 0; j < 15_000; j++) {
    pool.push({ i, j, text: "流式文本片段-" + j + "-" + i, arr: [i, j, i + j], nested: { a: i, b: j } });
  }
  pool = null;
  await new Promise((r) => setImmediate(r));
}

const totalMs = performance.now() - started;
observer.disconnect();

const gcMs = gcs.reduce((sum, e) => sum + e.duration, 0);
// kind: 2 = major (mark-compact), 4 = major (incremental marking)
const major = gcs.filter((e) => e.detail?.kind === 2 || e.detail?.kind === 4).length;

console.log(
  JSON.stringify({
    totalMs: Math.round(totalMs),
    gcCount: gcs.length,
    majorGcCount: major,
    gcMs: Math.round(gcMs * 10) / 10,
    gcRatio: Math.round((gcMs / totalMs) * 1000) / 10,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    residentCount: resident.length,
  }),
);
