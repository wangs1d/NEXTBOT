/**
 * POI 视频下放 效果预览 server（临时实例，看完即关）。
 *
 * 沙箱 data（不碰生产 SQLite/调度），把已回填视频的行程拷进去，
 * 起新代码实例供浏览器直接打开行程页看「▶ 视频」效果。
 * 3000 端口在跑的旧进程不受影响。
 *
 * 运行：npx tsx scripts/preview-video-server.ts   （Ctrl+C 关闭）
 */
import { mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

await import("../src/config/load-server-env.js");

const PORT = Number(process.env.PA_PREVIEW_PORT ?? 3102);
const PLAN_ID = process.argv[2] ?? "plan-preview-chengdu";
const log = (line: string): void => console.log(`[preview-server] ${line}`);

const sandbox = mkdtempSync(join(tmpdir(), "pa-preview-video-"));
mkdirSync(join(sandbox, "data", "travel-plans"), { recursive: true });
const srcPlan = join(process.cwd(), "data", "travel-plans", `${PLAN_ID}.json`);
copyFileSync(srcPlan, join(sandbox, "data", "travel-plans", `${PLAN_ID}.json`));
process.chdir(sandbox);
log(`沙箱数据目录: ${sandbox}（行程 ${PLAN_ID} 已拷入）`);

const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: PORT, host: "127.0.0.1" });
log(`预览 server 已监听: http://127.0.0.1:${PORT}/travel-map?planId=${PLAN_ID}`);
log(`手机竖屏版:          http://127.0.0.1:${PORT}/travel-map/mobile?planId=${PLAN_ID}`);
