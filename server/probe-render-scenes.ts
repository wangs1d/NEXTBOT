/**
 * 渲染场景模块实测探针（2026-11-05）。
 *
 * 跑真实链路（decideRender → applyBodyForm → applyCards），打印用户能看到的东西：
 *   1. 天气：回执 → 卡 + 正文
 *   2. 明日预览：同载荷 3 次渲染比对（确定性证据）
 *   3. 结构卡：合法卡 vs 三类坏块（契约校验真的拦住）
 *   4. 正文兜底：散文不进任何版式指令
 *   5. 扩展性：运行期注册新场景
 *
 * 用法：cd server && node --import tsx probe-render-scenes.ts
 */

import { decideRender } from "./src/render/decide.js";
import { applyBodyForm } from "./src/render/body.js";
import { applyCards, collectCardPayloads } from "./src/render/cards.js";
import { SceneRegistry, sceneRegistry } from "./src/render/scenes/registry.js";
import { renderTomorrowPreviewMarkdown } from "./src/render/scenes/tomorrow-preview.scene.js";
import { auditResultCards } from "./src/render/scenes/result-card.scene.js";
import { collectRoundupItems, renderRoundupMarkdown } from "./src/render/scenes/digest-roundup.scene.js";
import { listSceneContracts } from "./src/render/scenes/plan.js";
import {
  registerPreviewDigestSource,
  resolvePreviewPayloads,
  wantsTomorrowPreview,
} from "./src/services/tomorrow-preview-bridge.js";
import type { RenderScene, SceneContext } from "./src/render/scenes/types.js";

function run(ctx: SceneContext) {
  const decision = decideRender(ctx);
  const body = applyBodyForm(decision.text ?? ctx.text, decision, { userText: ctx.userText });
  const out = applyCards(body, decision).text;
  return { decision, out, cards: collectCardPayloads(out) };
}

function strip(text: string): string {
  return text
    .replace(/\[AGENT_RESULT_CARD_START\]\s*[\s\S]*?\s*\[AGENT_RESULT_CARD_END\]/g, "〔卡〕")
    .replace(/\[RENDER_AS:[a-z_]+\]\n?/g, "")
    .trim();
}

const line = (c = "─") => console.log(c.repeat(72));

console.log("\n场景注册表（优先级降序）：");
for (const s of listSceneContracts()) {
  console.log(`  ${String(s.priority).padStart(3)}  ${s.id.padEnd(18)} ${s.label}  | ${s.contract}`);
}

// ── 1. 天气 ────────────────────────────────────────────────────────────────
line();
console.log("【1】天气：真实回执 → 确定性卡");
const weather = run({
  text: "明天有雨，出门记得带伞。",
  userText: "明天天气怎么样",
  effects: [
    {
      tool: "weather.get_local",
      status: "ok",
      result: {
        ok: true,
        summary: "明天中雨",
        weatherText: "中雨",
        todayRangeC: "18–24",
        peakRainPct: 70,
        todayRainPeriod: "下午两点到五点",
        locationLabel: "上海",
        humidityPct: 88,
        windKmh: 12,
      },
    },
  ],
});
console.log(`场景：${weather.decision.scene?.id}  正文形态：${weather.decision.body.form}  卡数：${weather.cards.length}`);
console.log(`卡型：${weather.cards.map((c) => c.cardType).join(",")}  条目：`);
for (const item of (weather.cards[0]?.items ?? []) as Array<{ text: string }>) console.log(`   - ${item.text}`);
console.log(`用户可见正文：${strip(weather.out)}`);

// ── 2. 明日预览 ────────────────────────────────────────────────────────────
line();
console.log("【2】明日预览：同一份载荷连续渲染 3 次");
const digest = {
  date: "2026-11-06",
  tomorrowSchedule: [
    { id: "t1", title: "部门例会", time: "09:30" },
    { id: "t2", title: "牙医复诊", time: "14:00" },
    { id: "t3", title: "取快递", time: "19:00" },
  ],
  tomorrowWeather: { text: "多云转晴", minC: 12, maxC: 22, rainWindowLabel: "下午 14–17 点", alerts: ["大风"] },
  deadlineReminders: [{ title: "交实验报告", dueAt: "11-06" }],
  importantDays: [{ label: "妈妈生日", daysUntil: 3 }],
};
const renders = [1, 2, 3].map(() => renderTomorrowPreviewMarkdown(digest));
console.log(`三次输出逐字节一致：${renders[0] === renders[1] && renders[1] === renders[2]}  长度：${renders[0].length} 字`);
console.log(renders[0]);

const preview = run({
  text: "（模型原稿：好的，明天你上午有会，下午复诊，晚上取快递……）",
  userText: "明天什么安排",
  payloads: { eveningDigest: digest },
});
console.log(
  `\n场景：${preview.decision.scene?.id}  正文形态：${preview.decision.body.form}  ` +
    `正文来自渲染器：${Boolean(preview.decision.text)}  模型原稿被替换：${!String(preview.decision.text).includes("模型原稿")}`,
);

// ── 2b. 生产投递（2026-11-05 接生产链路：桥 → 渲染出口）───────────────────
line();
console.log("【2b】生产投递：聊天里问「明天什么安排」走真实取数口 → 场景接管");
registerPreviewDigestSource(() => digest);
const intentCases = [
  "明天什么安排",
  "明天的日程",
  "明天呢",
  "明天天气怎么样",
  "明天几点下雨",
  "今天好累",
];
for (const text of intentCases) {
  console.log(`   ${wantsTomorrowPreview(text) ? "注入" : "不注入"}  「${text}」`);
}
{
  const payloads = await resolvePreviewPayloads("probe-session", "明天什么安排");
  const decision = decideRender({
    text: "（模型原稿：明天你上午九点半有个部门例会，下午两点复诊，晚上七点取快递，记得带伞……）",
    userText: "明天什么安排",
    payloads,
  });
  console.log(
    `\n   注入载荷：${Object.keys(payloads ?? {}).join(",")}  场景：${decision.scene?.id}  ` +
      `正文形态：${decision.body.form}`,
  );
  console.log(`   模型原稿被渲染器替换：${!String(decision.text ?? "").includes("模型原稿")}`);
  console.log("   —— 用户可见 ——");
  console.log(
    String(decision.text ?? "")
      .split("\n")
      .map((l) => `   ${l}`)
      .join("\n"),
  );
}

// ── 3. 结构卡 ──────────────────────────────────────────────────────────────
line();
console.log("【3】结构卡：模型声明 → 契约校验");
const goodCard = `[AGENT_RESULT_CARD_START]\n${JSON.stringify({
  cardType: "steps",
  title: "通知权限开通",
  items: [{ type: "num", text: "打开系统设置" }, { type: "num", text: "授予通知使用权" }],
})}\n[AGENT_RESULT_CARD_END]`;
const goodRun = run({ text: `${goodCard}\n\n按上面两步走完就行。` });
console.log(
  `合法卡 → 场景 ${goodRun.decision.scene?.id}，保留卡块：${goodRun.out.includes("[AGENT_RESULT_CARD_START]")}，` +
    `卡型 ${String(goodRun.cards[0]?.cardType)}，条目 ${(goodRun.cards[0]?.items as unknown[])?.length}`,
);

const badCases: Array<[string, string]> = [
  ["cardType 不在白名单", `{"cardType":"新闻卡","title":"今日要闻","items":[{"type":"num","text":"x"}]}`],
  ["items 超量（13 条）", `{"cardType":"fold_list","title":"清单","items":${JSON.stringify(
    Array.from({ length: 13 }, (_, i) => ({ type: "num", text: `第${i + 1}条` })),
  )}}`],
  ["条目缺 text", `{"cardType":"steps","title":"流程","items":[{"type":"num"}]}`],
];
for (const [label, payload] of badCases) {
  const text = `[AGENT_RESULT_CARD_START]\n${payload}\n[AGENT_RESULT_CARD_END]\n\n正经说明文字。`;
  const audit = auditResultCards(text);
  const res = run({ text });
  console.log(
    `坏卡（${label}）→ 判因：${audit.issues[0]?.reason ?? "未检出"}；出口残留卡块：` +
      `${res.out.includes("[AGENT_RESULT_CARD_START]")}；用户可见：${strip(res.out)}`,
  );
}
const brokenJson = `[AGENT_RESULT_CARD_START]\n{cardType:steps}\n[AGENT_RESULT_CARD_END]\n\n正文。`;
console.log(`坏卡（JSON 断裂）→ 判因：${auditResultCards(brokenJson).issues[0]?.reason}`);

// ── 4. 正文兜底 ────────────────────────────────────────────────────────────
line();
console.log("【4】无结构化面的散文：不注入版式");
const plain = run({ text: "今天挺冷的，记得加件外套，别硬扛。", userText: "冷不冷" });
console.log(`场景：${plain.decision.scene?.id}  正文形态：${plain.decision.body.form}  卡数：${plain.decision.cards.length}`);
console.log(`可见正文：${strip(plain.out)}`);

// ── 4b. 盘点槽位（Tier B：模型只填槽）──────────────────────────────────────
line();
console.log("【4b】盘点清单：结构只来自工具回执，模型怎么写都不影响版式");
const roundupReceipt = {
  ok: true,
  items: [
    { title: "新剧《唐探》衍生开机", snippet: "已在泰国开机，搭档肖央，预计明年上线。", source: "SearchApi" },
    { title: "平台五周年直播", snippet: "定在 9 月 12 日，本人确认出席。", source: "SearchApi" },
    { title: "工作室通报维权进展", snippet: "5 个侵权账号已公开道歉并删除内容。", source: "SearchApi" },
  ],
};
const roundupEffects = [{ tool: "search_web", status: "ok" as const, result: roundupReceipt }];
console.log(`回执条目：${collectRoundupItems({ text: "", effects: roundupEffects }).length} 条`);
const variants = [
  ["只写语气", "给你捋了下最近的情况。"],
  ["自写加粗分组", "**新剧**\n- 唐探衍生开机\n\n**维权**\n- 5 个账号道歉"],
  ["甩裸 JSON", '{"summary":"两件事","groups":[{"title":"新剧","items":["a"]}]}'],
  ["markdown 表格", "## 汇总\n| 项目 | 值 |\n| --- | --- |\n最值得盯的是新剧。"],
];
const listOf = (s: string) => s.slice(s.indexOf("**要点**"));
const shapes: string[] = [];
for (const [label, text] of variants) {
  const res = run({ text, userText: "她最近有什么动态", effects: roundupEffects });
  shapes.push(listOf(String(res.decision.text ?? "")));
  console.log(
    `   ${label.padEnd(14, " ")} 场景=${res.decision.scene?.id}  ` +
      `裸JSON残留=${res.out.includes('"groups"')}  自写标题残留=${res.out.includes("**新剧**")}`,
  );
}
console.log(`四种写法的清单逐字节一致：${new Set(shapes).size === 1 ? "true" : "false"}`);
console.log("—— 用户可见（以「只写语气」为例）——");
console.log(String(run({ text: variants[0][1], userText: "她最近有什么动态", effects: roundupEffects }).decision.text ?? "")
  .split("\n").map((l) => `   ${l}`).join("\n"));
console.log(`渲染器直出（无模型参与）：\n${renderRoundupMarkdown(collectRoundupItems({ text: "", effects: roundupEffects }))
  .split("\n").map((l) => `   ${l}`).join("\n")}`);

// ── 5. 扩展性 ──────────────────────────────────────────────────────────────
line();
console.log("【5】扩展性：运行期注册一个新场景（示例：一句话结论卡）");
const reg = new SceneRegistry();
reg.register(sceneRegistry.get("weather")!);
const quoteScene: RenderScene = {
  id: "quote_scene",
  label: "结论卡",
  priority: 50,
  detect: (ctx) => (ctx.userText?.includes("一句话") ? { reason: "用户要一句话结论" } : null),
  plan: () => ({ sceneId: "quote_scene", label: "结论卡", cards: [], bodyForm: "quote", reason: "结论卡" }),
};
reg.register(quoteScene);
reg.register({ ...sceneRegistry.get("markdown")! });
console.log(`注册后场景：${reg.list().map((s) => s.id).join(" > ")}`);
console.log(`「给我一句话总结」→ 主场景：${reg.plan({ text: "x", userText: "给我一句话总结" }).primary}`);
console.log(`「随便聊聊」→ 主场景：${reg.plan({ text: "x", userText: "随便聊聊" }).primary}`);
console.log("\n完成。\n");
