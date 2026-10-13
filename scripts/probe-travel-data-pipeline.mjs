/**
 * 旅行数据链路验收（P0~P3）
 *
 * 一条命令看清四层是否都健康：
 *   P0 配图源   —— 见 /travel/data 的图片数与本地化率（图从哪来、有多少）
 *   P1 权威源   —— SQLite 里的城市/POI 规模 + 库大小
 *   P2 照片本地化 —— 本地图片占比（外链会失效，本地才靠得住）
 *   P3 底图离线包 —— 每个目的地是否备齐（断网能否浏览）
 *
 * 用法：确保本机 server 在 3000（tsx watch 已起），然后
 *   node scripts/probe-travel-data-pipeline.mjs
 * 加 --pack=杭州 可为该目的地补建离线包（需要传坐标时用 --points=lat,lng;lat,lng）。
 */
const BASE = process.env.PAI_BASE || "http://127.0.0.1:3000";

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function postJson(path, body, timeoutMs = 240_000) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => Number(v ?? 0).toLocaleString("zh-CN");
const pct = (v) => `${(Number(v ?? 0) * 100).toFixed(1)}%`;

console.log("════ 旅行数据链路验收 ════\n");

// ── P1 + P2：数据规模与图片本地化 ──
const data = await getJson("/travel/data");
console.log("【P1 权威源 · SQLite】");
console.log(`  城市 ${pad(data.cities, 6)} POI ${pad(num(data.pois), 8)} 媒体条目 ${pad(num(data.mediaPois), 6)} 库大小 ${(data.dbBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  最近媒体写入: ${data.lastMediaUpdateAt || "（暂无）"}`);
const top = (data.topDestinations || []).map((d) => `${d.destination}(${d.poiCount}站/${d.accessCount}次)`).join("  ");
console.log(`  热点目的地: ${top}\n`);

console.log("【P0 配图源 + P2 照片本地化】");
console.log(`  图片 ${pad(num(data.images), 8)} 其中本地 ${pad(num(data.localImages), 8)} → 本地化率 ${pct(data.localizedRatio)}`);
const pending = data.images - data.localImages;
console.log(
  `  ${pending > 0 ? `待本地化 ${pending} 张（POST /travel/data/refresh {mode:"localize"} 补齐）` : "全部已落地本机 ✓"}\n`,
);

// ── P3：底图瓦片与离线包 ──
const tiles = await getJson("/travel-basemap/stats");
console.log("【P3 底图缓存】");
console.log(`  瓦片文件 ${pad(num(tiles.diskFiles), 8)} 磁盘 ${ (tiles.diskBytes / 1024 / 1024).toFixed(1)} MB  内存条目 ${num(tiles.memoryEntries)}`);

const packs = (await getJson("/travel-basemap/offline")).packs || [];
console.log(`  离线包 ${packs.length} 个：`);
for (const p of packs.slice(0, 8)) {
  const flag = p.complete ? "离线可用" : `有缺口(${p.failed})`;
  console.log(
    `    ${pad(p.destination, 10)} z${p.overviewZooms?.[0]}~${p.detailZooms?.at(-1)} 共${pad(p.total, 5)} 已有${pad(p.ready, 5)} 失败${pad(p.failed, 4)} → ${flag}`,
  );
  if (!p.complete && p.failedSamples?.length) {
    console.log(`      失败样本: ${p.failedSamples.slice(0, 3).join("  ")}`);
  }
}
if (packs.length === 0) console.log("    （还没有离线包：规划一次行程，或 POST /travel-basemap/offline）");

// ── 可选：按需补建离线包 ──
const packArg = process.argv.find((a) => a.startsWith("--pack="));
if (packArg) {
  const destination = packArg.slice("--pack=".length);
  const pointsArg = process.argv.find((a) => a.startsWith("--points="));
  const points = (pointsArg ? pointsArg.slice("--points=".length) : "")
    .split(";")
    .map((s) => s.split(",").map(Number))
    .filter((a) => a.length === 2 && a.every(Number.isFinite))
    .map(([latitude, longitude]) => ({ latitude, longitude }));
  if (points.length === 0) {
    console.log(`\n!! 补建离线包需要 --points=lat,lng;lat,lng`);
  } else {
    console.log(`\n补建离线包「${destination}」（${points.length} 个点）…`);
    const r = await postJson("/travel-basemap/offline", { destination, points });
    const pack = r.body?.pack;
    console.log(
      pack
        ? `  → 共${pack.total} 已有${pack.ready} 新拉${pack.fetched} 失败${pack.failed} 完整=${pack.complete}`
        : `  → HTTP ${r.status} ${JSON.stringify(r.body)}`,
    );
  }
}

console.log("\n════ 判定 ════");
const verdicts = [
  ["P0 配图可用", data.images > 0],
  ["P1 数据在库", data.cities > 0 && data.pois > 0],
  ["P2 图片本地化过半", data.localizedRatio >= 0.5],
  ["P3 至少一个离线包完整", packs.some((p) => p.complete)],
];
for (const [name, ok] of verdicts) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
process.exitCode = verdicts.every(([, ok]) => ok) ? 0 : 1;
