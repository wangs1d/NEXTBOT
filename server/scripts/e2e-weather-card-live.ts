/**
 * 天气卡轮 + 按需定位 真实链路 live E2E（2026-10-08）。
 *
 * 真实组件：createAppServices 完整生产装配 + 真实 LLM（server/.env.local 的
 * OpenAI 兼容端点）+ 真实 tool-loop 合成轮（含【回复策略】注入）+
 * tool-card-registry 天气卡 + LocationCoordinator 按需定位 + Open-Meteo 真实天气
 * + 服务端逆地理（bigdatacloud/amap）。
 *
 * 脚本扮演「修复后的手机端」：收到 agent.location_request 后按新协议回
 * 纯坐标（北京天安门 39.9042,116.4074，不做客户端逆地理——秒回语义）。
 *
 * 验证点：
 *   ① 定位链路真实发生：weather 工具触发 agent.location_request，脚本回包后
 *      server 在 12s 窗口内拿到坐标（旧配置 6s + 客户端逆地理串行会恒超时）；
 *   ② 天气卡由坐标构建，title 出城市名（服务端逆地理补 label 生效）；
 *   ③ finalText 不再复读卡片数据：无「## 天气标题」、无 markdown 表格、
 *      无 > 引用块（weather_card 策略短路生效），只剩口语建议散文。
 *
 * 运行：npx tsx scripts/e2e-weather-card-live.ts   （需要外网：LLM + open-meteo + 逆地理）
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// ① cwd 仍在 server/ 时先加载 env（.env + .env.local，模块加载时自动执行）
await import("../src/config/load-server-env.js");

const PORT = Number(process.env.PA_E2E_PORT ?? 3101);
const ACTOR = process.env.PA_E2E_ACTOR ?? "local_user";
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-weather-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
const log = (line: string): void => console.log(`[e2e-weather] ${line}`);

/**
 * 真实出口定位（2026-10-08）：不再硬编码坐标——查本机公网出口的真实位置
 * （ip-api，城市级精度）。开发机挂代理时出口在境外，这正是「定位答错城市」
 * 的真实来源之一；拿它回包，整条链路用的都是真实数据。
 */
async function fetchRealEgressLocation(): Promise<{ lat: number; lon: number; label: string }> {
  try {
    const r = await fetch("http://ip-api.com/json/?lang=zh-CN", { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { lat?: number; lon?: number; city?: string; regionName?: string; country?: string };
    if (typeof j.lat === "number" && typeof j.lon === "number") {
      const label = [j.city, j.regionName, j.country].filter(Boolean).join(" · ");
      log(`真实出口位置（ip-api）: ${label} (${j.lat}, ${j.lon})`);
      return { lat: j.lat, lon: j.lon, label };
    }
  } catch (e) {
    log(`ip-api 查询失败（${String(e).slice(0, 80)}），退回硬编码坐标`);
  }
  return { lat: 39.9042, lon: 116.4074, label: "39.9042, 116.4074" };
}
const REAL_LOC = await fetchRealEgressLocation();

// ② 沙箱数据目录（仓库 data/ 不受影响）+ 真实生产装配
// PA_E2E_ATTACH=1：不内嵌装配，作为纯客户端连接已在跑的生产 server
//（配合 PA_E2E_PORT / PA_E2E_ACTOR）——「真实跑一遍」模式。
const ATTACH = process.env.PA_E2E_ATTACH === "1";
if (ATTACH) {
  log(`attach 模式：连接 ws://127.0.0.1:${PORT}/ws（actor=${ACTOR}，不内嵌服务端）`);
} else {
  process.chdir(sandbox);
  log(`沙箱数据目录: ${sandbox}`);
}
const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
if (!ATTACH) {
  const services = await createAppServices();
  await services.app.listen({ port: PORT, host: "127.0.0.1" });
  log(`服务端已监听 http://127.0.0.1:${PORT}`);
}

// ③ WS 客户端 = 模拟手机端
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

let locationRequested = false;
let donePayload: Record<string, unknown> | null = null;
let chunkCount = 0;
const seenTools = new Set<string>();

ws.on("message", (raw) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(msg.type ?? "");

  if (type === "tool.call") {
    seenTools.add(String((msg.payload as Record<string, unknown>)?.toolName ?? ""));
  }
  if (type === "agent.location_request") {
    locationRequested = true;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    log(`★ 收到 agent.location_request（jobId=${payload.jobId} reason=${payload.reason ?? ""}）`);
    // 模拟修复后的手机端：纯坐标秒回（真实出口位置，不做客户端逆地理）
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          type: "client.location_report",
          payload: {
            jobId: payload.jobId,
            latitude: REAL_LOC.lat,
            longitude: REAL_LOC.lon,
            timezone: "Asia/Shanghai",
            label: REAL_LOC.label,
          },
        }),
      );
      log(`  → 已回纯坐标 client.location_report（真实出口：${REAL_LOC.label}）`);
    }, 300);
  }

  if (type === "chat.assistant_chunk") chunkCount += 1;

  if (type.includes("error") || type.includes("Error")) {
    log(`✘ 错误帧 ${type}: ${JSON.stringify(msg.payload).slice(0, 300)}`);
  }
  if (type !== "chat.assistant_chunk") {
    log(`[帧] ${type} ${JSON.stringify(msg.payload ?? {}).slice(0, 160)}`);
  }

  if (type === "chat.assistant_done") {
    donePayload = (msg.payload ?? {}) as Record<string, unknown>;
  }
});

ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR } }));
await new Promise((r) => setTimeout(r, 1_500));
log(`WS 已连接（actor=${ACTOR}），发聊天消息…`);

// ④ 真实聊天消息（问句可从命令行传入，默认天气意图）
const question = process.argv[2] ?? "明天天气怎么样？穿什么合适？";
ws.send(
  JSON.stringify({
    type: "chat.user_message",
    payload: {
      sessionId: ACTOR,
      messageId: `e2e-${Date.now()}`,
      timestamp: new Date().toISOString(),
      text: question,
    },
  }),
);
log(`问句: ${question}`);

// ⑤ 等 assistant_done（LLM 数轮 + 定位 12s 窗口 + 天气 API）
const deadline = Date.now() + 150_000;
while (!donePayload && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}

ws.close();

// 后台旁路审计落盘宽限（2026-10-20）：记忆写入/画像抽取/滚动摘要等
// fire-and-forget 调用常在 assistant_done 之后才完成，立即 exit 会丢失其审计
// 记录（token A/B 采集时这些环节的归属不可见）。默认 0 保持既有行为；
// 采集时设 PA_E2E_GRACE_MS=20000 即可等到旁路落盘。
const graceMs = Number(process.env.PA_E2E_GRACE_MS ?? 0);
if (graceMs > 0) {
  log(`等待后台旁路审计落盘 ${graceMs}ms…`);
  await new Promise((r) => setTimeout(r, graceMs));
}

// ── 结果输出 ──
const finalText = String((donePayload as any)?.finalText ?? "");
const toolCalls = ((donePayload as any)?.toolCalls ?? []) as Array<Record<string, unknown>>;
const blocks = ((donePayload as any)?.replyBlocks ?? []) as Array<Record<string, unknown>>;

console.log("\n══════════════ 真实链路结果 ══════════════");
console.log(`assistant_chunk 数: ${chunkCount}`);
console.log(`toolCalls: ${JSON.stringify(toolCalls)}`);
console.log(`收到过 agent.location_request: ${locationRequested}`);
console.log(`replyBlocks 类型: [${blocks.map((b) => b.type ?? b.blockType ?? "?").join(", ")}]`);
console.log("\n────── finalText（正文原样）──────");
console.log(finalText || "(空)");
console.log("────── 卡片 payload ──────");
const cardBlock = blocks.find((b) => JSON.stringify(b).includes("weather"))
  ?? (finalText.includes("[AGENT_RESULT_CARD_START]") ? { raw: finalText } : null);
if (cardBlock) console.log(JSON.stringify(cardBlock).slice(0, 800));
else console.log("(未找到 weather 卡)");

// ── 断言 ──
const failures: string[] = [];
const hasWeatherCard = /"cardType":"weather"/.test(finalText);
const hasLlmCard = finalText.includes("[AGENT_RESULT_CARD_START]");
if (!finalText) failures.push("finalText 为空（LLM 未产出正文）");
// weather 执行证据：tool.call 帧（assistant_done.toolCalls 在部分路径为空）
if (!seenTools.has("weather.get_local"))
  failures.push("本轮没有执行 weather.get_local 工具");
if (!locationRequested) failures.push("server 未下发 agent.location_request（按需定位链路未发生）");

const tableLines = finalText.split("\n").filter((l) => l.trim().startsWith("|"));
if (tableLines.length > 0) failures.push(`正文含 markdown 表格（${tableLines.length} 行）——卡片数据被复读`);
if (/^#{1,6}\s/.test(finalText.trim()) || /\n#{1,6}\s.*天气/.test(finalText))
  failures.push("正文含天气标题（## …）——卡片标题被复读");
const quoteLines = finalText.split("\n").filter((l) => l.trim().startsWith(">"));
if (quoteLines.length > 0) failures.push(`正文含引用块（${quoteLines.length} 行）`);

console.log("\n══════════════ 断言 ══════════════");
if (failures.length === 0) {
  console.log("✔ 全部通过：定位链路真实发生 + 天气卡生成 + 正文不再复读卡片数据");
  process.exit(0);
} else {
  console.log("✘ 未通过：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
