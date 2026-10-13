/**
 * 日常对话「无关内容」实盘泄漏探针（2026-10-11，配套口径统一 + 元决策自述闸）。
 *
 * 走真实 WS 全链（session.init → chat.user_message → 流式 chunk → assistant_done），
 * 用**隔离探针账号**跑一批日常对话，逐轮收集用户实际会看到的内容并做泄漏判定：
 *   - streamed 视图：assistant_chunk 按 messageId 重组（= 分泡后用户先看到的）；
 *   - final 视图：assistant_done.finalText（= 收口后的权威文本）；
 *   - 若 done.finalTextReplacesStream=true，用户最终看到 finalText，否则看到 streamed。
 *
 * 泄漏规则（命中即记，供人工复核）：
 *   元决策自述（「根据规范必须调用…」「系统已注入…」「直接调用。」）/ 元术语独白 /
 *   内部控制帧（<system> 等）/ think 标签 / 协议标记与工具原始物 / prompt 元词汇。
 *
 * 用法：node scripts/probe-daily-chat-leak.mjs
 *   LEAK_ACTOR=xxx LEAK_REPEATS=2 LEAK_ONLY="现在几点" 可覆盖。
 */
import WebSocket from "ws";

const WS_URL = process.env.LEAK_WS_URL ?? "ws://127.0.0.1:3000/ws";
const ACTOR = process.env.LEAK_ACTOR ?? `leak-probe-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
const REPEATS = Number.parseInt(process.env.LEAK_REPEATS ?? "1", 10) || 1;
const TURN_TIMEOUT_MS = 150_000;

const BASE_PROMPTS = [
  "现在几点", // 2026-10-11 事故原句
  "现在几点了？", // 同族复测（时好时坏指纹）
  "今天几号，星期几",
  "在吗",
  "我有点累了",
  "我现在在哪个城市", // 位置 → 强制 clock.get_user_location 轮
  "今天天气怎么样", // 工具轮（weather.*，有前导话）
  "帮我看看今天有什么科技新闻", // 检索轮（search_web，长回复）
  "晚安",
];
const ONLY = process.env.LEAK_ONLY?.trim();
const PROMPTS = ONLY
  ? [ONLY]
  : process.env.LEAK_PROMPTS?.trim()
    ? process.env.LEAK_PROMPTS.split("|").map((s) => s.trim()).filter(Boolean)
    : BASE_PROMPTS;

/** 泄漏规则：name + 正则 + scope。scope="stream" 只判流式气泡视图——
 *  协议块（AGENT_RESULT_CARD / RENDER_HINT）出现在 assistant_done.finalText
 *  是**合法渲染载荷**（客户端解析渲染），只有透进流式气泡才算泄漏。 */
const LEAK_RULES = [
  { name: "元决策自述", scope: "both", re: /(根据(?:规范|规则|要求)|按照(?:规范|规则|要求)|遵守(?:规范|规则)|遵循(?:规范|规则)|强制(?:调用)?规则|必须调用|应当调用|禁止臆测|系统已注入|\[系统注入\]|\[system[-_ ]?context\]|（system注入）|已为你联网检索|直接调用。|调用\s*clock)/ },
  { name: "元术语独白", scope: "both", re: /(对话脑|执行脑|规划任务|已接手|后台处理|正在处理|上一轮转入|turnIntent|routeConfidence)/ },
  { name: "内部控制帧", scope: "both", re: /(<\s*\/?\s*system(?:-reminder)?\s*>|\[STOP\s|\[话题已?切换|\[trajectory-slicing\])/i },
  { name: "思考标签", scope: "both", re: /<\s*\/?\s*(?:think(?:ing)?|reasoning)\s*>/i },
  { name: "渲染协议标记透出", scope: "stream", re: /(RENDER_HINT|RENDER_AS|\[[A-Z_]+_(?:START|END)\])/ },
  { name: "prompt 元词汇复读", scope: "both", re: /(【当前时间】|【消息时间戳】|【对话时间轴】|session-recap|\[ts:\d{4}-)/ },
];

function checkLeaks(text, scope) {
  const hits = [];
  if (!text) return hits;
  for (const rule of LEAK_RULES) {
    if (rule.scope !== "both" && rule.scope !== scope) continue;
    const m = rule.re.exec(text);
    if (m) {
      const idx = m.index;
      hits.push({
        rule: rule.name,
        matched: m[0],
        context: text.slice(Math.max(0, idx - 24), idx + 60).replace(/\s+/g, " "),
      });
    }
  }
  return hits;
}

/** 时间正确性：时间问句的回答必须包含今天的日期（2026-10-11 的常见写法）。 */
const TODAY = new Date();
const TODAY_DATE_CN = `${TODAY.getFullYear()}年${TODAY.getMonth() + 1}月${TODAY.getDate()}日`;
const TODAY_DATE_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, "0")}-${String(TODAY.getDate()).padStart(2, "0")}`;
const TODAY_DATE_SLASH = `${TODAY.getFullYear()}/${String(TODAY.getMonth() + 1).padStart(2, "0")}/${String(TODAY.getDate()).padStart(2, "0")}`;
const TIME_QUESTION_RE = /(现在.*几点|几点了|现在时间|当前时间|今天.*(几号|多少号|日期|星期|周[一二三四五六日天])|星期几|周几|礼拜几)/i;
const sp = "\\s*"; // 模型会在数字与单位之间加空格/加粗（「2026 年 10 月 11 日」）
const TODAY_RE = new RegExp(
  [
    `${TODAY.getFullYear()}${sp}年${sp}${TODAY.getMonth() + 1}${sp}月${sp}${TODAY.getDate()}${sp}日`,
    TODAY_DATE_ISO,
    TODAY_DATE_SLASH,
    `${TODAY.getMonth() + 1}${sp}月${sp}${TODAY.getDate()}`,
    `${TODAY.getMonth() + 1}-${String(TODAY.getDate()).padStart(2, "0")}`,
  ].join("|"),
);

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.startsWith("十")) return 10 + (s.length > 1 ? CN_NUM[s[1]] ?? 0 : 0);
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    return (CN_NUM[a] ?? 0) * 10 + (b ? CN_NUM[b] ?? 0 : 0);
  }
  return CN_NUM[s] ?? null;
}

function checkTimeAnswer(prompt, text) {
  if (!TIME_QUESTION_RE.test(prompt) || !text) return [];
  // 对 = ① 含今天日期；② 含接近当前时刻（±40min）的 HH:MM；
  // ③ 含中文数字报时且小时与当前小时吻合（12 小时制，「下午一点四十」= 13:40 合格）。
  if (TODAY_RE.test(text)) return [];
  const nowMin = TODAY.getHours() * 60 + TODAY.getMinutes();
  for (const m of text.matchAll(/(\d{1,2})[:：](\d{2})/g)) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) continue;
    const t = hh * 60 + mm;
    const diff = Math.abs(t - nowMin) > 720 ? 1440 - Math.abs(t - nowMin) : Math.abs(t - nowMin);
    if (diff <= 40) return [];
  }
  for (const m of text.matchAll(/([零一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(?:([零一二两三四五六七八九十]{1,3}|\d{1,2})\s*分?|半)?/g)) {
    const h = cnToInt(m[1]);
    if (h == null || h > 24) continue;
    if ((h % 12) === (TODAY.getHours() % 12)) return [];
  }
  return [{ rule: "时间答案不含今天日期", matched: TODAY_DATE_CN, context: text.slice(0, 80).replace(/\s+/g, " ") }];
}

const results = [];
let ws;
let current = null;

function send(obj) {
  ws.send(JSON.stringify(obj));
}

function startTurn(text) {
  return new Promise((resolve) => {
    const turn = {
      prompt: text,
      chunks: new Map(), // messageId -> text（按 messageId 重组气泡）
      chunkOrder: [],
      finalText: "",
      bubbles: null,
      replaces: false,
      toolCalls: [],
      done: false,
    };
    current = turn;

    const timer = setTimeout(() => {
      turn.timeout = true;
      finish();
    }, TURN_TIMEOUT_MS);

    const onMessage = (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (current !== turn) return;
      const p = ev.payload ?? {};

      if (ev.type === "agent.location_request") {
        send({
          type: "client.location_report",
          payload: { jobId: p.jobId, latitude: 25.088, longitude: 104.897, city: "贵州省黔西南布依族苗族自治州", source: "ondemand" },
        });
        return;
      }
      if (ev.type === "chat.assistant_chunk") {
        const id = p.messageId ?? "?";
        if (!turn.chunks.has(id)) turn.chunkOrder.push(id);
        turn.chunks.set(id, (turn.chunks.get(id) ?? "") + (p.chunk ?? p.delta ?? p.text ?? ""));
        return;
      }
      if (ev.type === "chat.assistant_done") {
        turn.finalText = p.finalText ?? "";
        turn.bubbles = Array.isArray(p.bubbles) ? p.bubbles : null;
        turn.replaces = p.finalTextReplacesStream === true;
        turn.collapse = p.collapse === true;
        turn.collapseReason = p.collapseReason ?? "";
        turn.toolCalls = Array.isArray(p.toolCalls) ? p.toolCalls.map((t) => t?.toolName ?? t?.name ?? "?") : [];
        turn.done = true;
        finish();
      }
    };

    function finish() {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(turn);
    }

    ws.on("message", onMessage);
    send({
      type: "chat.user_message",
      payload: { text, messageId: `leak-${Date.now()}`, sessionId: ACTOR, userId: ACTOR, timestamp: new Date().toISOString() },
    });
  });
}

function streamedView(turn) {
  if (turn.bubbles && turn.bubbles.length > 0) {
    return turn.bubbles.map((b) => b.text ?? "").join("\n---\n");
  }
  return turn.chunkOrder.map((id) => turn.chunks.get(id) ?? "").join("\n---\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => {
  ws = new WebSocket(WS_URL);
  ws.once("open", r);
});
send({ type: "session.init", payload: { userId: ACTOR, sessionId: ACTOR } });
await sleep(1200);

console.log(`[leak-probe] actor=${ACTOR} prompts=${PROMPTS.length} repeats=${REPEATS} ws=${WS_URL}`);

for (let r = 0; r < REPEATS; r++) {
  for (const prompt of PROMPTS) {
    const turn = await startTurn(prompt);
    const streamed = streamedView(turn);
    const finalText = turn.finalText;
    const userVisible = turn.replaces ? finalText : streamed;

    const leakStreamed = checkLeaks(streamed, "stream");
    const leakFinal = checkLeaks(finalText, "final");
    const timeHits = checkTimeAnswer(prompt, userVisible);
    const leakVisible = turn.replaces
      ? [...leakFinal, ...timeHits]
      : [...leakStreamed, ...timeHits];

    results.push({ turn, streamed, finalText, leakStreamed, leakFinal, leakVisible });

    const bubbleCount = turn.bubbles?.length ?? turn.chunkOrder.length;
    const status = turn.timeout ? "TIMEOUT" : leakVisible.length ? "LEAK" : "OK";
    console.log(`\n[${status}] #${results.length} "${prompt}" bubbles=${bubbleCount} tools=[${turn.toolCalls.join(",") || "-"}] replaces=${turn.replaces} collapse=${turn.collapse}${turn.collapseReason ? `(${turn.collapseReason})` : ""}`);
    console.log(`  泡内容: ${streamed.replace(/\n---\n/g, " ⏎ ").slice(0, 400) || "(空)"}`);
    if (turn.replaces && finalText !== streamed) {
      console.log(`  finalText(替换): ${finalText.slice(0, 300)}`);
    }
    for (const h of leakVisible) {
      console.log(`  ⚠ 泄漏[${h.rule}] 匹配「${h.matched}」 上下文: …${h.context}…`);
    }
    await sleep(1200);
  }
}

const total = results.length;
const leaks = results.filter((r) => r.leakVisible.length > 0);
const timeouts = results.filter((r) => r.turn.timeout);
console.log(`\n=== 汇总 ===`);
console.log(`总轮数=${total} 干净=${total - leaks.length - timeouts.length} 泄漏=${leaks.length} 超时=${timeouts.length}`);
if (leaks.length) {
  console.log("\n泄漏轮详情：");
  for (const r of leaks) {
    console.log(`- "${r.turn.prompt}" → ${r.leakVisible.map((h) => h.rule).join(", ")}`);
  }
}

try { ws.close(); } catch {}
process.exit(leaks.length ? 1 : 0);
