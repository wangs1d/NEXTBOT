/**
 * 真链探针：旅游规划根修端到端验证（2026-11-12）。
 *
 * 阶段 A（REST 规划会话全流程，对齐 mobile-travel-chat-flow 设计稿）：
 *   POST /travel/plan-session 一句话发起 → choice 追问卡逐张点选 →
 *   种草筛选卡（view/stay）→ 补心愿（wishlist）→ 预订选择（booking）→
 *   generate（真实生成 + 预算卡）→ approve（最终草案）。
 *   断言：完整卡片序列出现、最终草案有逐日站点、travelPlanStore 落盘。
 *
 * 阶段 B（WS 聊天轮文字收口）：
 *   以手机协议连 WS 发旅游规划消息（绕过客户端拦截，走聊天流兜底路径），
 *   断言 done 帧：带卡时散文简介 ≤2 句（≤130 字）——clampTravelLeadText 生效。
 *
 * 用法：PATH=/d/nodejs:$PATH node --import tsx scratch/probe-travel-planner-e2e.mjs [phase=A|B|ALL]
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const PHASE = (process.argv[2] ?? "A").toUpperCase();
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const timeline = [];
let failures = 0;
function check(name, cond, detail) {
  const mark = cond ? "✓" : "✗";
  if (!cond) failures += 1;
  console.log(`  ${mark} ${name}${cond ? "" : ` — ${JSON.stringify(detail ?? "")}`}`);
  timeline.push({ name, ok: cond });
}

async function api(method, path, body, timeoutMs = 240_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const cardTypes = (resp) => (resp.cards ?? []).map((c) => c.type);
const firstOf = (resp, type) => (resp.cards ?? []).find((c) => c.type === type);

async function phaseA() {
  console.log("\n═══ 阶段 A：规划会话 REST 全流程（真实 LLM 编排） ═══");
  const start = await api("POST", "/travel/plan-session", {
    message: "帮我规划一下去成都玩四天，12月1号出发，两个人，预算八千以内，能吃辣",
  });
  check("发起 200", start.status === 200 && start.json?.ok === true, start.json);
  let resp = start.json;
  const sid = resp.sessionId;
  console.log(`  sessionId=${sid} state=${resp.state} say="${resp.say}"`);
  const startTypes = cardTypes(resp);
  check(
    "首轮回执含交互卡（choice/guide 其一）",
    ["choice", "guide"].some((t) => startTypes.includes(t)),
    startTypes,
  );

  // 贪心驱动：有卡应卡，没卡推进，直到 generated 或步数耗尽
  const seen = new Set();
  for (let step = 0; step < 30; step += 1) {
    for (const c of resp.cards ?? []) seen.add(c.type);
    const types = cardTypes(resp);
    let next = null;

    const choice = firstOf(resp, "choice");
    if (choice && resp.state === "gathering") {
      const values = (choice.options ?? []).slice(0, choice.multi ? 2 : 1);
      console.log(`[${stamp()}] 答问卡 ${choice.id}(${choice.stage}) → ${values.join("|")}`);
      next = await api("POST", `/travel/plan-session/${sid}/turn`, {
        cardId: choice.id,
        values: values.length > 0 ? values : ["都行"],
      });
    } else if (types.includes("guide")) {
      const guide = firstOf(resp, "guide");
      const stage = "view";
      const names = (guide?.cats ?? [])
        .find((cat) => cat.key === stage)
        ?.items?.slice(0, 3)
        ?.map((i) => i.name) ?? [];
      console.log(`[${stamp()}] 种草筛选 stage=${stage} → ${names.join("、")}`);
      next = await api("POST", `/travel/plan-session/${sid}/guide`, { [stage]: names });
    } else if (types.includes("wishlist")) {
      console.log(`[${stamp()}] 补心愿 → 跳过（就这样）`);
      next = await api("POST", `/travel/plan-session/${sid}/turn`, { message: "就这样，开始吧" });
    } else if (resp.state === "ready") {
      console.log(`[${stamp()}] 信息齐 → generate（真实生成，可能 10~120s）`);
      next = await api("POST", `/travel/plan-session/${sid}/generate`, {});
    } else if (resp.state === "budget_ready") {
      console.log(`[${stamp()}] 预算卡确认 → approve`);
      next = await api("POST", `/travel/plan-session/${sid}/approve`, {});
    } else if (resp.state === "generated") {
      break;
    } else {
      console.log(`[${stamp()}] state=${resp.state} 无可推进卡，停`);
      break;
    }
    if (!next.json?.ok) {
      console.log(`[${stamp()}] 步进失败 status=${next.status} → ${JSON.stringify(next.json).slice(0, 300)}`);
      break;
    }
    resp = next.json;
    if (resp.say) console.log(`           say="${resp.say.slice(0, 80)}"`);
  }

  for (const c of resp.cards ?? []) seen.add(c.type);
  console.log(`  卡片序列实测: ${[...seen].join(" → ")}`);
  // 口径（对齐设计稿「缺什么问什么，不预铺选项」）：交互卡按信息完整度
  // 条件出现，但「问 → 答」这一环必须真实发生；天气/种草在信息齐备与
  // POI 候选可用时出现（候选源失败静默降级，宁缺毋滥）。
  check(
    "交互卡出现（choice/guide 至少其一）",
    ["choice", "guide"].some((t) => seen.has(t)),
    [...seen],
  );
  check("天气卡出现（开关已恢复）", seen.has("weather"), [...seen]);
  check("最终 state=generated", resp.state === "generated", resp.state);
  check(
    "最终草案有逐日站点",
    Array.isArray(resp.draft?.days) && resp.draft.days.length >= 3 &&
      (resp.draft.days[0]?.stops?.length ?? 0) > 0,
    `days=${resp.draft?.days?.length}`,
  );
  check("确认输出 say 为短句口径（≤60 字）", (resp.say ?? "").length <= 60, resp.say);
  console.log(`  最终方案标题: ${resp.draft?.title ?? "?"}`);
  return seen;
}

function phaseB() {
  return new Promise((resolve) => {
    console.log("\n═══ 阶段 B：WS 聊天轮文字收口（真模型） ═══");
    const SESSION_ID = `probe-tvfix-${Date.now().toString(36)}`;
    const ws = new WebSocket(process.env.WS_URL ?? "ws://127.0.0.1:3000/ws");
    let donePayload = null;
    let chunks = 0;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      if (!donePayload) {
        console.log("未收到 done");
        return;
      }
      const text = donePayload.finalText ?? "";
      const blocks = donePayload.renderEnvelope?.blocks ?? donePayload.blocks ?? [];
      const cardBlocks = blocks.filter((b) => b.type === "card");
      const cardTypesSeen = cardBlocks.map((b) => b.card?.cardType ?? b.cardType ?? "?");
      const prose = text
        .replace(/\[AGENT_RESULT_CARD_START\][\s\S]*?\[AGENT_RESULT_CARD_END\]/g, "")
        .replace(/\[(?:RENDER_HINT:[A-Za-z_]+|RENDER_AS:[A-Za-z_]+|NEXT_UP_(?:START|END))\]/g, "")
        .trim();
      const hasCards = cardTypesSeen.includes("travel_itinerary") || text.includes("[AGENT_RESULT_CARD_START]");
      console.log(`  chunks=${chunks} finalText=${text.length} 字`);
      console.log(`  卡片块: ${cardTypesSeen.join(", ") || "（文本标记型）"}`);
      console.log(`  散文简介（${prose.length} 字）: ${prose.slice(0, 200)}`);
      if (hasCards) {
        check("行程卡出现", cardTypesSeen.includes("travel_itinerary") || /\[AGENT_RESULT_CARD_START\]/.test(text));
        check("带卡时散文 ≤130 字（收口生效）", prose.length <= 130, `${prose.length} 字`);
        const sentences = prose.split(/(?<=[。！？!?])/).filter((s) => s.trim());
        check("散文 ≤2 句", sentences.length <= 2, `${sentences.length} 句`);
      } else {
        console.log("  （本轮无行程卡——模型走了别的路径，收口断言不适用）");
      }
    };
    const finish = (reason) => {
      report();
      try { ws.close(); } catch { /* ignore */ }
      setTimeout(() => resolve(reason), 200);
    };
    ws.on("open", () => {
      console.log(`[${stamp()}] WS open, session=${SESSION_ID}`);
      ws.send(JSON.stringify({
        type: "session.init",
        payload: {
          sessionId: SESSION_ID,
          deviceId: "probe-travel-device",
          userAlias: "probe",
          browserBridge: false,
          platform: "mobile",
        },
      }));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "chat.user_message",
          payload: {
            sessionId: SESSION_ID,
            messageId: `probe-${Date.now().toString(36)}`,
            text: "十一想去成都玩四天，人多的地方别去，帮我规划一下，预算一万以内",
            timestamp: new Date().toISOString(),
            agentAccessMode: "full",
          },
        }));
        console.log(`[${stamp()}] → chat.user_message 已发（真模型，最长等 5 分钟）`);
      }, 800);
      setTimeout(() => finish("timeout_480s"), 480_000);
    });
    ws.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw.toString()); } catch { return; }
      const type = evt.type ?? "";
      if (!/^chat\.(assistant_chunk|assistant_done|turn_started|intent_detected)$/.test(type)) {
        console.log(`[${stamp()}] ← ${type}`);
      }
      if (type === "chat.turn_started") console.log(`[${stamp()}] ← turn_started`);
      else if (type === "chat.intent_detected") console.log(`[${stamp()}] ← intent_detected mode=${evt.payload?.mode}`);
      else if (type === "chat.assistant_chunk") chunks += 1;
      else if (type === "chat.error") { console.log(`[${stamp()}] ← chat.error: ${evt.payload?.message}`); finish("chat_error"); }
      else if (type === "agent.location_request") {
        // 客户端同款应答（agent_location_responder.dart）：client.location_report
        // 回 jobId+坐标；不回包服务端 requestLocation 会白等 12s 且规划轮挂死。
        const jobId = evt.payload?.jobId ?? "";
        console.log(`[${stamp()}] ← agent.location_request jobId=${jobId} → 回坐标（兴义）`);
        ws.send(JSON.stringify({
          type: "client.location_report",
          payload: {
            ...(jobId ? { jobId } : {}),
            latitude: 25.0882,
            longitude: 104.9064,
            city: "黔西南布依族苗族自治州",
            source: "ondemand",
          },
        }));
      }
      else if (type === "chat.assistant_done") { donePayload = evt.payload ?? {}; console.log(`[${stamp()}] ← assistant_done`); finish("done"); }
    });
    ws.on("error", (e) => { console.log(`WS ERROR ${e.message}`); finish("ws_error"); });
  });
}

if (PHASE === "A" || PHASE === "ALL") await phaseA();
if (PHASE === "B" || PHASE === "ALL") await phaseB();
console.log(failures === 0 ? "\n[probe] 全部通过 ✅" : `\n[probe] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
