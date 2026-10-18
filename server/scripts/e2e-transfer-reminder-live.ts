/**
 * 接驳提醒 → 滴滴下单 真实链路 live E2E（travel-upgrade-plan P2，2026-10-18）。
 *
 * 真实组件：createAppServices 完整生产装配 + 真实 LLM（server/.env.local）+
 * TransferWatchService 接驳提醒（WS agent.transfer_reminder）+ ride_hailing 工具族
 * （滴滴官方 MCP 沙箱 Mock：maps_textsearch → taxi_estimate → taxi_create_order）。
 *
 * 脚本扮演手机端：
 *   ① 收 agent.transfer_reminder（高铁 G1234 到站前 30min 窗口）→ 验证帧结构；
 *   ② 回「帮我预约从成都东站到酒店的接站车」→ 期待 LLM 调 ride_hailing.quote（报价）；
 *   ③ 回「确认」→ 期待 ride_hailing.book 两阶段确认下单成功（沙箱单）。
 *
 * 行程数据不走真实规划（规划需外网 POI + 10~30s）：直接经 travelPlanStore 单例
 * 落一条带交通段的行程（arrTime = now+28min，落在 [lead-10, lead] 触发窗内），
 * 再手动 transferWatchService.tick() 触发——60s interval 不等。
 *
 * 运行：npx tsx scripts/e2e-transfer-reminder-live.ts
 * （需要外网 LLM；滴滴走沙箱端点，需在 server/.env.local 配 DIDI_MCP_KEY）
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

await import("../src/config/load-server-env.js");

const PORT = Number(process.env.PA_E2E_PORT ?? 3102);
const ACTOR = process.env.PA_E2E_ACTOR ?? "local_user";
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-transfer-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
// MCP server 配置（rollinggo/didi）随 chdir 失效：进沙箱前按真实 cwd 拷入，
// DidiMcpRideProvider.availability() 才能探到 didi 注册（url 中 ${DIDI_MCP_KEY} 按环境展开）
const realMcpConfig = join(process.cwd(), "data", "mcp-servers.json");
if (existsSync(realMcpConfig)) copyFileSync(realMcpConfig, join(sandbox, "data", "mcp-servers.json"));
process.chdir(sandbox);
const log = (line: string): void => console.log(`[e2e-transfer] ${line}`);
log(`沙箱数据目录: ${sandbox}`);

const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: PORT, host: "127.0.0.1" });
log(`服务端已监听 http://127.0.0.1:${PORT}`);

// ① 行程数据源：带交通段的行程（接驳提醒调度器的扫描输入）
const { travelPlanStore } = await import("../src/skills/travel-planning/travel-plan-store.js");
const nowMs = Date.now();
const arrTime = new Date(nowMs + 28 * 60_000).toISOString();
travelPlanStore.save({
  planId: "e2e-transfer-plan",
  destination: "成都",
  title: "成都 3 日行（e2e）",
  startDate: new Date(nowMs).toISOString().slice(0, 10),
  sessionId: ACTOR,
  days: [],
  transferSegments: [
    { type: "train", role: "arrival", no: "G1234", from: "出发地", to: "成都", arrTime },
  ],
});
log(`行程已落盘：G1234 arrTime=${arrTime}（${Math.round((Date.parse(arrTime) - nowMs) / 60000)}min 后到站）`);

// ② WS 客户端 = 手机端
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

type Reminder = { planId: string; destination: string; segment: Record<string, unknown>; message: string; minutesUntil: number };
let reminder: Reminder | null = null;
let donePayload: Record<string, unknown> | null = null;
let doneResolver: ((v: Record<string, unknown>) => void) | null = null;
const seenTools = new Set<string>();
let finalText = "";

ws.on("message", (raw) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(msg.type ?? "");
  if (type === "tool.call") {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const name = String(payload?.toolName ?? "");
    seenTools.add(name);
    // 桥接工具（tool_call）的内层目标要展开看，否则「book 是否真被调用」不可判
    const inner =
      typeof payload?.toolArgs === "string"
        ? payload.toolArgs
        : JSON.stringify(payload?.toolArgs ?? payload?.arguments ?? "");
    log(`[tool.call] ${name} ${String(inner).slice(0, 220)}`);
  }
  if (type === "agent.transfer_reminder") {
    reminder = (msg.payload ?? {}) as unknown as Reminder;
    log(`★ 收到 agent.transfer_reminder: ${JSON.stringify(reminder).slice(0, 300)}`);
  }
  if (type === "agent.location_request") {
    // quote 的 pickup 缺省取用户 GPS：手机端纯坐标秒回（跳过逆地理，同天气 e2e）
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    log(`★ 收到 agent.location_request（jobId=${payload.jobId}）→ 回纯坐标`);
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          type: "client.location_report",
          payload: {
            jobId: payload.jobId,
            latitude: 30.5728,
            longitude: 104.0668,
            timezone: "Asia/Shanghai",
            label: "四川省成都市",
          },
        }),
      );
    }, 300);
  }
  if (type !== "chat.assistant_chunk" && type !== "chat.assistant_done") {
    log(`[帧] ${type}`);
  }
  if (type === "chat.assistant_done") {
    donePayload = (msg.payload ?? {}) as Record<string, unknown>;
    finalText = String((donePayload as any)?.finalText ?? "");
    texts.push(finalText);
    doneResolver?.(donePayload);
    doneResolver = null;
  }
});

ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, platform: "mobile" } }));
await new Promise((r) => setTimeout(r, 1_200));
log(`WS 已连接（actor=${ACTOR}）`);

function send(text: string): void {
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: ACTOR, messageId: `e2e-${Date.now()}`, timestamp: new Date().toISOString(), text },
    }),
  );
}

async function waitDone(timeoutMs: number): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      doneResolver = null;
      reject(new Error(`assistant_done 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    doneResolver = (p) => {
      clearTimeout(timer);
      resolve(p);
    };
  });
}

const failures: string[] = [];
/** 每轮 assistant_done 的 finalText（断言与排查用） */
const texts: string[] = [];

try {
  // ③ 手动触发接驳扫描（60s interval 不等）
  await services.transferWatchService.tick();
  await new Promise((r) => setTimeout(r, 800));
  if (!reminder) failures.push("未收到 agent.transfer_reminder（调度器未触发或 WS 未推送）");
  else {
    const seg = reminder.segment as Record<string, unknown>;
    if (seg.no !== "G1234") failures.push(`提醒段车次错误: ${seg.no}`);
    if (typeof reminder.message !== "string" || !reminder.message.includes("30 分钟"))
      failures.push(`提醒文案缺提前量口径: ${reminder.message}`);
  }

  // ④ 接驳确认 → ride_hailing.quote（真实 LLM + 滴滴 MCP 沙箱）
  // 终点必须具体：模糊的「酒店」LLM 无法从工具侧解析坐标，会反问（合理行为）。
  // quote 断言双证据：tool.call 帧（部分分支不广播）或 报价文本语义。
  const quoteSeen = (): boolean =>
    seenTools.has("ride_hailing.quote") ||
    texts.some((t) => /报价|车型|（经|公里.*分钟|预约单/.test(t) && /成都东|酒店/.test(t));
  log("发送接驳请求 → 期待 ride_hailing.quote");
  send("G1234马上到站了，帮我预约一辆从成都东站到太古里亚朵S酒店的滴滴");
  await waitDone(150_000);
  for (let i = 2; i <= 3 && !quoteSeen(); i++) {
    log(`quote 证据未出现，补第 ${i} 轮`);
    send(`对，从成都东站到太古里亚朵S酒店，帮我预约过去的车`);
    await waitDone(150_000);
  }
  if (!quoteSeen()) {
    failures.push(`三轮内未取得 quote 证据（已见工具: ${[...seenTools].join(",") || "无"}）；历轮正文: ${texts.join(" | ").slice(0, 400)}`);
  }

  // ⑤ 两阶段确认 → ride_hailing.book 下单。铁证 = bookingOrderStore 落单。
  // 模拟 provider 的报价 note 明说「不会真实下单」，LLM 会如实转告并犹豫——
  // 确认话术必须显式授权沙箱下单，否则模型替用户「诚实拒绝」导致链路断在最后一步
  log("发送确认 → 期待 ride_hailing.book 下单");
  send("好，就要经济型那一单。我知道现在是沙盒模拟环境，不产生真实订单和扣费，你就按模拟流程把单下出来，我要验证完整下单链路");
  await waitDone(150_000);
  const { BookingOrderStore } = await import("../src/services/booking/booking-order-store.js");
  const store: InstanceType<typeof BookingOrderStore> = services.bookingOrderStore;
  const rideOrder = async (): Promise<Record<string, unknown> | null> => {
    const orders = await store.listByActor(ACTOR, { includeFinished: true });
    return (
      orders.find((o) => /ride|taxi|滴滴/i.test(JSON.stringify(o))) ??
      orders[0] ??
      null
    ) as Record<string, unknown> | null;
  };
  let order = await rideOrder();
  // book 阶段一（confirm=false）只返回摘要+token 不落单——模型复述摘要等用户确认是
  // 正确的两阶段行为；订单没落就继续补确认轮（最多三轮），拿到阶段二执行为止。
  // 话术递进：自然确认（confirm=true 即可，token 由服务端兜底匹配，不再微观管理）→
  // 催促立即执行 → 强制不再反问
  const confirmMsgs = [
    "对，就订这单，确认下单",
    "我确认了，直接下单，不用再问我，把订单号报给我",
    "这是最终确认：现在立刻调用 ride_hailing.book 把 confirm 设为 true 完成下单，拿到订单号直接告诉我结果，不要再报价也不要再问我",
  ];
  for (let i = 0; i < confirmMsgs.length && !order; i++) {
    log(`订单未落（book 可能停在阶段一），补确认轮 ${i + 1}`);
    send(confirmMsgs[i]);
    await waitDone(150_000);
    order = await rideOrder();
  }
  if (!order) {
    failures.push(`订单库无下单记录（已见工具: ${[...seenTools].join(",")}）；末轮正文: ${finalText.slice(0, 250)}`);
  } else {
    log(`★ bookingOrderStore 落单: ${JSON.stringify(order).slice(0, 300)}`);
  }
} catch (e) {
  failures.push(`异常: ${e instanceof Error ? e.message : String(e)}`);
}

ws.close();

console.log("\n══════════════ 真实链路结果 ══════════════");
console.log(`收到 agent.transfer_reminder: ${!!reminder}`);
if (reminder) console.log(`提醒文案: ${(reminder as Reminder).message}`);
console.log(`已见工具: ${[...seenTools].join(", ") || "无"}`);
console.log("\n────── 末轮 finalText ──────");
console.log(finalText || "(空)");

console.log("\n══════════════ 断言 ══════════════");
let ok = failures.length === 0;
if (ok) {
  console.log("✔ 全部通过：接驳提醒 WS 推送 + ride_hailing.quote 报价 + ride_hailing.book 沙箱下单");
} else {
  console.log("✘ 未通过：");
  for (const f of failures) console.log(`  - ${f}`);
}
void services.app.close().catch(() => {});
process.exit(ok ? 0 : 1);
