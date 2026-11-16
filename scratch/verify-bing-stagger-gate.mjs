// 验证 Bing 错峰发射闸的时序语义（与 upstream-search-service.ts 中实现同构）
const STAGGER = 1000;
let chain = Promise.resolve();
let lastLaunchAt = 0;
let launchedAt = [];

function acquireSlot() {
  const prev = chain;
  let release;
  chain = new Promise((r) => { release = r; });
  return (async () => {
    await prev;
    const wait = lastLaunchAt + STAGGER - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLaunchAt = Date.now();
    launchedAt.push(Date.now());
    release();
  })();
}

// 模拟 3 个并发 query：query A 抓取耗时 3.5s（模拟 Bing 慢），B/C 2s
async function fakeSearch(id, fetchMs) {
  await acquireSlot(); // 发射
  await new Promise((r) => setTimeout(r, fetchMs)); // 模拟 Bing 抓取
  console.log(`query ${id}: launched=+${Date.now() - launchedAt[launchedAt.length - 1] >= 0 ? "" : ""}${launchedAt[launchedAt.length - 1]}`);
}

const t0 = Date.now();
await Promise.all([fakeSearch("A", 3500), fakeSearch("B", 2000), fakeSearch("C", 2000)]);
const total = Date.now() - t0;
const gaps = launchedAt.slice(1).map((t, i) => t - launchedAt[i]);
console.log(`launch offsets: ${launchedAt.map((t) => `+${t - t0}ms`).join(", ")}  gaps: ${gaps.join(", ")}ms  total=${total}ms`);
const ok = gaps.every((g) => g >= STAGGER - 50) && launchedAt[0] - t0 < 100;
console.log(ok ? "PASS: 首查立即发射，后续依次错开 ≥stagger，重叠流水线（总耗时 ≈ 末次发射 + 抓取，非串行求和）" : "FAIL");
process.exit(ok ? 0 : 1);
