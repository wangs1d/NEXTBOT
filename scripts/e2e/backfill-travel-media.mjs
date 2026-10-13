/**
 * 按目的地依次补全 POI 媒体（照片/视频/评论）。
 *
 * 为什么要重试：/travel/data/refresh 有全局互斥（runExclusive），并发触发会立刻
 * 返回 ALREADY_RUNNING。所以这里串行 + 轮询等待，不并发。
 *
 * 用法：node scripts/e2e/backfill-travel-media.mjs [destination...]
 */
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.TRAVEL_BASE ?? 'http://127.0.0.1:3000';
const argv = process.argv.slice(2);

async function snapshot() {
  try {
    const r = await fetch(`${BASE}/travel/data`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function refreshOne(destination, limit) {
  const r = await fetch(`${BASE}/travel/data/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'media', destination, limit }),
  });
  return r.json();
}

async function refreshWithRetry(destination, limit) {
  for (let attempt = 1; attempt <= 40; attempt++) {
    const out = await refreshOne(destination, limit);
    if (out?.ok) return out.result;
    if (out?.reason !== 'ALREADY_RUNNING') return { error: out?.reason ?? 'UNKNOWN' };
    process.stdout.write(`  [${destination}] 互斥占用中，等待重试 ${attempt}…\n`);
    await delay(15_000);
  }
  return { error: 'TIMEOUT_WAITING_LOCK' };
}

const targets = argv.length
  ? argv
  : ['贵阳', '大理', '杭州', '厦门', '巴厘岛', '马尔代夫', '新疆', '北京', '上海', '成都', '重庆'];

const before = await snapshot();
process.stdout.write(`[before] videos=${before?.videos} reviews=${before?.reviews} poisWithVideo=${before?.poisWithVideo}\n`);

for (const d of targets) {
  process.stdout.write(`== ${d}\n`);
  const result = await refreshWithRetry(d, 120);
  process.stdout.write(`   ${JSON.stringify(result)}\n`);
}

const after = await snapshot();
process.stdout.write(
  `[after] images=${after?.images}(本地 ${after?.localImages}, ${(after?.localizedRatio * 100).toFixed(1)}%) ` +
    `videos=${after?.videos} reviews=${after?.reviews} poisWithVideo=${after?.poisWithVideo} ` +
    `poisWithReview=${after?.poisWithReview} mediaPois=${after?.mediaPois}\n`,
);