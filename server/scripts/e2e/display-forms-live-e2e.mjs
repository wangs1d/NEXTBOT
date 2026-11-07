// E2E：全展示形态真机触发矩阵（2026-09-22）。
// 前置：server 已运行（ws://127.0.0.1:3000/ws）。
// 每轮独立新会话发一条设计话术，从 assistant_done 载荷收集全部形态证据：
//   - finalText/blocks 里的 [AGENT_RESULT_CARD_START] cardType
//   - mediaCards 结构化字段（照片/视频卡）
//   - [RENDER_AS:xxx] / [RENDER_HINT:xxx] 正文形态标记
//   - CONTENT_SUMMARY_V2（折叠详情卡）
//   - markdown 表格 / 代码块
// 输出触发矩阵；探测产物只报告不判定（预期由调用方对照）。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";

const ROUNDS = [
  { name: "weather 天气卡", text: "明天贵州兴义的天气怎么样？" },
  { name: "schedule 日程卡", text: "我今天有什么日程安排？" },
  { name: "wallet 钱包卡", text: "查一下我钱包还剩多少钱" },
  { name: "order 订单卡", text: "看看我最近的购物订单到哪了" },
  { name: "file 文件卡", text: "把上个月的消费报告导出成文件给我" },
  { name: "search 搜索（不出卡，正文总结）", text: "帮我搜一下刘浩存最近的资讯" },
  { name: "media 照片卡", text: "搜索刘浩存的照片" },
  { name: "travel 行程卡", text: "帮我规划去成都两天的行程" },
  { name: "product_compare 比价卡", text: "帮我推荐对比一下两款适合油皮的粉底液" },
  { name: "steps 步骤卡", text: "分步骤教我怎么手冲咖啡，每一步一行，用第1步第2步这种格式" },
  { name: "metric 数据面板", text: "把我的健康数据整理成数据面板：平均睡眠7.2小时，静息心率58，深睡占比26%，周运动4次" },
  { name: "progress 进度条卡", text: "我的年度目标完成情况：读书完成83%，存款完成64%，健身完成47%，帮我可视化一下进度" },
  { name: "timeline 时间轴卡", text: "帮我按时间轴排一下明天：9点开项目周会，14点牙医复诊，19点半和老周吃饭" },
  { name: "chips 标签胶囊", text: "只给我5个可以聊的话题标签，胶囊那种，一个一行，不要解释" },
  { name: "fold_list 折叠清单", text: "给我列一个搬家准备清单，至少8条，每条一句话" },
  { name: "comparison_table 双栏对比", text: "地铁和自驾两种通勤方式对比一下，各列几条优缺点" },
  { name: "markdown 数字快报（data_brief 已退役，正文 markdown）", text: "出一份8月支出快报：总支出4213元，环比下降12%，餐饮占比38%，记账23天，最大单笔1602元" },
  { name: "summary 详情卡", text: "帮我整理一篇2026年新能源车选购指南，越详细越好，分板块讲" },
  { name: "markdown 表格", text: "用表格对比一下原厂电池和两个第三方电池方案：价格和寿命" },
  { name: "quote 引用卡", text: "帮我用引用块的格式记一句话到今天的日记：不是选择正确的那条路，而是把选的路走对" },
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function runTurn(text) {
  const session = `e2e-forms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.type === "chat.assistant_done") dones.push(evt.payload ?? {});
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1200));
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: session, messageId: `e2e-${Date.now()}`, text, timestamp: new Date().toISOString() },
  }));
  const deadline = Date.now() + 150_000;
  while (dones.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
  return dones[0] ?? {};
}

function collectEvidence(done) {
  const finalText = String(done.finalText ?? "");
  const blocks = Array.isArray(done.blocks) ? done.blocks : [];
  const ev = new Set();
  for (const m of finalText.matchAll(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g)) {
    try { ev.add(`card:${JSON.parse(m[1].trim()).cardType || "generic"}`); } catch { ev.add("card:<parse-fail>"); }
  }
  for (const b of blocks) {
    if (b && b.type === "card" && b.cardType) ev.add(`block:${b.cardType}`);
  }
  for (const m of finalText.matchAll(/\[RENDER_AS:(\w+)\]/g)) ev.add(`marker:${m[1]}`);
  for (const m of finalText.matchAll(/\[RENDER_HINT:(\w+)\]/g)) ev.add(`hint:${m[1]}`);
  if (finalText.includes("CONTENT_SUMMARY_V2")) ev.add("marker:CONTENT_SUMMARY_V2");
  const mediaCount = Array.isArray(done.mediaCards) ? done.mediaCards.length : 0;
  if (mediaCount > 0) ev.add(`mediaCards:${mediaCount}`);
  const pipeLines = finalText.split("\n").filter((l) => (l.match(/\|/g) ?? []).length >= 2).length;
  if (pipeLines >= 2) ev.add(`md-table(${pipeLines}行)`);
  if (finalText.includes("```")) ev.add("md-code");
  if (/^>\s+/m.test(finalText)) ev.add("md-quote");
  return [...ev];
}

const matrix = [];
for (const round of ROUNDS) {
  const done = await runTurn(round.text);
  const evidence = collectEvidence(done);
  const preview = String(done.finalText ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
  matrix.push({ name: round.name, evidence, preview });
  console.log(`\n### ${round.name}`);
  console.log(`    证据: [${evidence.join(", ") || "无"}]`);
  console.log(`    正文: ${preview || "(空)"}`);
}

console.log("\n===== 触发矩阵汇总 =====");
for (const m of matrix) {
  console.log(`${m.name.padEnd(24)} => ${m.evidence.join(", ") || "(未触发)"}`);
}
process.exit(0);
