/**
 * POI 打卡视频下放 live 预览（travel 视频下放）。
 *
 * 对 data/travel-plans 里的一份现有行程执行真实视频回填（真实三源搜索 +
 * 从严门禁 + 落盘），完成后打印各景点命中的视频，供浏览器打开行程页看效果。
 * 写生产 data（默认目录，不设沙箱覆盖）——3000 端口在跑的 server 每次请求
 * 实时读盘，落盘后立即可见，无需重启。
 *
 * 运行：npx tsx scripts/preview-poi-video-live.ts [planId]   （默认 plan-preview-chengdu）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ① 先加载 env（.env + .env.local；搜索上游依赖其中配置）
await import("../src/config/load-server-env.js");

const { travelPlanStore } = await import("../src/skills/travel-planning/travel-plan-store.js");
const { TravelPoiVideoService } = await import("../src/services/travel-poi-video-service.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");

const planId = process.argv[2] ?? "plan-preview-chengdu";
const log = (line: string): void => console.log(`[preview-video] ${line}`);

const plan = travelPlanStore.get(planId);
if (!plan) {
  console.error(`行程不存在：${planId}`);
  process.exit(1);
}
const attractions = (plan.days ?? []).flatMap((d) => (d.items ?? []).filter((i) => i.type === "attraction" && i.name));
log(`行程：${plan.title}（${plan.destination}），景点 ${attractions.map((a) => a.name).join("、")}`);

const svc = new TravelPoiVideoService(
  { searchVideos: (q, limit) => new UpstreamSearchService(new InfoHubService()).searchVideos(q, limit) },
  travelPlanStore,
);
svc.backfillForPlan(plan);

// 轮询等回填完成：景点 videos 数量稳定（含 null 不落盘的兜底）即认为完成
const storeFile = join(process.cwd(), "data", "travel-plans", `${planId}.json`);
const countVideos = (): number => {
  try {
    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as {
      days: Array<{ items: Array<{ type: string; name: string; videos?: unknown[] }> }>;
    };
    return raw.days.flatMap((d) => d.items).filter((i) => i.type === "attraction" && (i.videos ?? []).length > 0).length;
  } catch {
    return -1;
  }
};
let last = -1;
let stable = 0;
for (let i = 0; i < 30 && stable < 2; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const n = countVideos();
  if (n === last) stable++;
  else {
    stable = 0;
    last = n;
    log(`已命中 ${n}/${attractions.length} 个景点…`);
  }
}

const done = travelPlanStore.get(planId)!;
log("======== 回填结果（视频以 URL 落盘，真实相关才带，无命中留空）========");
for (const day of done.days ?? []) {
  for (const item of day.items ?? []) {
    if (item.type !== "attraction") continue;
    const v = item.videos?.[0];
    log(`${v ? "▶" : "·"} ${item.name} → ${v ? `${v.source}｜${v.title}｜${v.url}` : "（无相关视频，留空）"}`);
  }
}
log(`打开行程页看效果：http://127.0.0.1:3000/travel-map?planId=${planId}`);
