/**
 * 渲染场景模块验收（2026-11-05 结构化回复收敛）。
 *
 * 锁定四件事：
 *   1. 注册表：id 唯一、优先级稳定、兜底场景必须存在（新增场景不能把兜底挤掉）；
 *   2. 天气/明日预览/工具卡面：确定性建卡与排版，同一输入字节一致（不靠 prompt）；
 *   3. 结构卡：契约不合格整块剥掉；盘点清单：结构只来自工具回执，
 *      模型怎么写（不配合/自写版式/甩裸 JSON）都不影响版式 → 配合率 100%；
 *   4. 可扩展：新场景只需注册，不改 decide.ts。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decideRender } from "../src/render/decide.js";
import { applyBodyForm } from "../src/render/body.js";
import { applyCards, collectCardPayloads, diagnoseRegisteredCardPayload } from "../src/render/cards.js";
import { buildReminderConfirmPayload } from "../src/render/scenes/reminder-confirm.scene.js";
import { normalizeReplyCardLayout } from "../src/services/reply-envelope.js";
import {
  rememberReminderCards,
  buildReminderCardUpdate,
} from "../src/services/reminder-card-state.js";
import { SceneRegistry, sceneRegistry } from "../src/render/scenes/registry.js";
import { planRenderScene, listSceneContracts } from "../src/render/scenes/plan.js";
import { planPreRenderScene } from "../src/render/scenes/index.js";
import { renderTomorrowPreviewFacts, formatPreviewDate } from "../src/render/scenes/tomorrow-preview.scene.js";
import { auditResultCards } from "../src/render/scenes/result-card.scene.js";
import { WEATHER_CARD_INSTRUCTION } from "../src/agent/synthesis-strategy.js";
import type { RenderScene, SceneContext } from "../src/render/scenes/types.js";

const WEATHER_RECEIPT = {
  ok: true,
  summary: "明天中雨",
  weatherText: "中雨",
  todayRangeC: "18–24",
  humidityPct: 88,
  windKmh: 12,
  peakRainPct: 70,
  todayRainPeriod: "下午两点到五点",
  locationLabel: "上海",
};

const DIGEST = {
  date: "2026-11-06",
  tomorrowSchedule: [
    { id: "t1", title: "部门例会", time: "09:30" },
    { id: "t2", title: "牙医复诊", time: "14:00" },
  ],
  tomorrowWeather: {
    text: "多云转晴",
    minC: 12,
    maxC: 22,
    rainWindowLabel: "下午 14–17 点",
    alerts: ["大风"],
  },
  deadlineReminders: [{ title: "交实验报告", dueAt: "11-06" }],
  importantDays: [{ label: "妈妈生日", daysUntil: 3 }],
};

function runFull(ctx: SceneContext): string {
  const decision = decideRender(ctx);
  const body = applyBodyForm(decision.text ?? ctx.text, decision, { userText: ctx.userText });
  return applyCards(body, decision).text;
}

// ── 1. 注册表 ────────────────────────────────────────────────────────────────

test("注册表：默认场景齐全、id 唯一、优先级降序、兜底存在", () => {
  const problems = sceneRegistry.assertIntegrity({ requireFallbackId: "markdown" });
  assert.deepEqual(problems, []);

  const list = listSceneContracts();
  assert.deepEqual(
    list.map((s) => s.id),
    [
      "tomorrow_preview",
      "weather",
      "reminder_confirm",
      "tool_cards",
      "result_card",
      "digest_roundup",
      "markdown",
    ],
  );
  const priorities = list.map((s) => s.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test("注册表：重复 id 直接抛错（防热更两次逻辑翻倍）", () => {
  const reg = new SceneRegistry();
  const scene: RenderScene = {
    id: "dup",
    label: "重复",
    priority: 1,
    detect: () => ({ reason: "x" }),
    plan: () => null,
  };
  reg.register(scene);
  assert.throws(() => reg.register(scene), /重复登记/);
});

// ── 1b. 提醒确认卡（2026-11-07 方案 A：一轮一张卡、卡内多行、只读） ──────────

const REMINDER_RECEIPT = {
  ok: true,
  taskId: "task-1",
  title: "叫阿哲起床",
  reminderMessage: "叫阿哲起床",
  // Asia/Shanghai = UTC+8 → 2026-11-07 07:00，与 whenSpoken「明早七点」一致
  nextRunAt: "2026-11-06T23:00:00.000Z",
  runAt: "2026-11-06T23:00:00.000Z",
  timezone: "Asia/Shanghai",
  whenSpoken: "明早七点",
  recurrence: "none",
  status: "created",
};

type ReminderEffect = { tool: string; status: "ok"; result: Record<string, unknown> };

function reminderEffects(results: Array<Record<string, unknown>>): ReminderEffect[] {
  return results.map((result) => ({ tool: "calendar.create", status: "ok" as const, result }));
}

function reminderOf(card: Record<string, unknown>): Record<string, unknown> {
  return (card.extra as Record<string, unknown>).reminder as Record<string, unknown>;
}

test("提醒确认卡：单条创建回执 → 一张只读卡，正文在前、卡在后", () => {
  const out = runFull({
    text: "好嘞阿哲，七点准时叫你。",
    effects: reminderEffects([{ ...REMINDER_RECEIPT }]),
  });
  const cards = collectCardPayloads(out);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.cardType, "reminder_confirm");
  assert.equal(card.title, "已定好提醒");
  assert.deepEqual(card.actions, []);
  assert.equal(card.footer, "", "一次性 + 本地时区不显示脚注");
  assert.deepEqual(card.items, [{ type: "text", text: "明早 07:00 · 叫阿哲起床" }]);
  const reminder = reminderOf(card);
  assert.equal(reminder.status, "created");
  assert.equal(reminder.rows.length, 1);
  assert.deepEqual(reminder.taskIds, ["task-1"]);
  assert.ok(out.indexOf("好嘞") < out.indexOf("[AGENT_RESULT_CARD_START]"));
  assert.ok(
    normalizeReplyCardLayout(out).indexOf("好嘞") <
      normalizeReplyCardLayout(out).indexOf("[AGENT_RESULT_CARD_START]"),
    "版式归一化不得把确认卡提到正文前",
  );
});

test("提醒确认卡：一轮 4 条合并一张卡，全量 rows 下发、无折叠收口（轮动由 UI 处理）", () => {
  const out = runFull({
    text: "行，都排上了。",
    effects: reminderEffects(
      Array.from({ length: 4 }, (_, i) => ({
        ...REMINDER_RECEIPT,
        taskId: `task-${i}`,
        title: `事项${i}`,
        reminderMessage: `事项${i}`,
      })),
    ),
  });
  const cards = collectCardPayloads(out);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "已定好 4 条提醒");
  assert.equal((cards[0].items as unknown[]).length, 4, "全部条目都要下发，界面一次只渲染一条");
  const reminder = reminderOf(cards[0]);
  assert.equal(reminder.total, 4);
  assert.equal((reminder.rows as unknown[]).length, 4);
  assert.equal(reminder.shown, undefined, "不再有 3 行截断字段");
  assert.equal(reminder.more, undefined, "不再有「共 N 条」收口文字");
  assert.ok(!out.includes("查看全部"), "只读卡不得留跳转入口");
  assert.ok(!out.includes("其余"), "不得出现折叠收口文案");
});

test("提醒确认卡：按 taskId 去重；失败轮 / 缺时区不出卡", () => {
  const duplicated = runFull({
    text: "定好了。",
    effects: reminderEffects([{ ...REMINDER_RECEIPT }, { ...REMINDER_RECEIPT }]),
  });
  assert.equal(reminderOf(collectCardPayloads(duplicated)[0]).total, 1);
  const failed = decideRender({
    text: "没设成。",
    effects: [{ tool: "calendar.create", status: "error" }],
  });
  assert.equal(failed.cards.length, 0);
  const noTimezone = decideRender({
    text: "定好了。",
    effects: reminderEffects([{ ...REMINDER_RECEIPT, timezone: undefined }]),
  });
  assert.equal(noTimezone.cards.length, 0, "时区缺失时宁可不出卡，也不猜时间");
});

test("提醒确认卡：脚注仅重复规则 / 跨时区时出现", () => {
  const base = [{ tool: "calendar.create", status: "ok" as const, result: { ...REMINDER_RECEIPT } }];
  assert.equal(buildReminderConfirmPayload(base, "Asia/Shanghai")?.footer, "");
  const weekly = [{ ...base[0], result: { ...REMINDER_RECEIPT, recurrence: "weekly" } }];
  assert.equal(buildReminderConfirmPayload(weekly, "Asia/Shanghai")?.footer, "每周");
  assert.equal(buildReminderConfirmPayload(base, "America/New_York")?.footer, "按 Asia/Shanghai");
});

test("提醒确认卡：修改 / 取消走 card.update 原地刷新，不追加新卡", () => {
  const out = runFull({
    text: "定好了，到点叫你。",
    effects: reminderEffects([{ ...REMINDER_RECEIPT }]),
  });
  const card = collectCardPayloads(out)[0];
  rememberReminderCards("actor-reminder-test", "msg-1", [card]);

  const updated = buildReminderCardUpdate("actor-reminder-test", [
    {
      tool: "calendar.update_task",
      status: "ok",
      result: {
        ...REMINDER_RECEIPT,
        nextRunAt: "2026-11-06T23:30:00.000Z",
        runAt: "2026-11-06T23:30:00.000Z",
        whenSpoken: "明早七点半",
        status: "active",
      },
    },
  ]);
  assert.ok(updated);
  assert.equal(updated.messageId, "msg-1");
  assert.equal(updated.card.title, "已改为提醒");
  assert.equal(reminderOf(updated.card).status, "updated");
  assert.equal((reminderOf(updated.card).rows as Array<Record<string, unknown>>)[0].time, "07:30");

  const cancelled = buildReminderCardUpdate("actor-reminder-test", [
    {
      tool: "calendar.delete_task",
      status: "ok",
      result: { ok: true, taskId: "task-1", status: "cancelled" },
    },
  ]);
  assert.ok(cancelled);
  assert.equal(cancelled.card.title, "已取消提醒");
  assert.equal(reminderOf(cancelled.card).status, "cancelled");

  const updateRound = decideRender({
    text: "改好了。",
    effects: [
      {
        tool: "calendar.update_task",
        status: "ok",
        result: { ...REMINDER_RECEIPT, status: "active" },
      },
    ],
  });
  assert.equal(updateRound.cards.length, 0, "修改/取消轮不得追加新卡");
});

// ── 2. 天气（Tier A：回执确定性建卡） ─────────────────────────────────────────

test("天气场景：真实回执 → weather 卡，正文只作前导", () => {
  const out = runFull({
    text: "明天有雨，出门带伞。",
    effects: [{ tool: "weather.get_local", status: "ok", result: WEATHER_RECEIPT }],
  });
  assert.ok(out.includes("[AGENT_RESULT_CARD_START]"), "应附天气卡");
  assert.ok(out.startsWith("明天有雨，出门带伞。"), "正文前导保留");
  const decision = decideRender({
    text: "明天有雨，出门带伞。",
    effects: [{ tool: "weather.get_local", status: "ok", result: WEATHER_RECEIPT }],
  });
  assert.equal(decision.scene?.id, "weather");
  assert.equal(decision.body.form, "plain");
  assert.equal(decision.cards.length, 1);
});

test("天气场景：工具全部失败 → 场景让位不出卡（空态卡 2026-11-06 退役）", () => {
  const decision = decideRender({
    text: "天气没查到。",
    effects: [{ tool: "weather.get_local", status: "error" }],
  });
  assert.equal(decision.cards.length, 0, "天气失败不应出任何卡");
  assert.notEqual(decision.scene?.id, "weather");
});

test("天气场景的 prompt 片段与 synthesis 再导出同源（防两处漂移）", () => {
  const weather = sceneRegistry.get("weather");
  assert.ok(weather);
  const plan = weather.plan({ text: "", effects: [] }, { reason: "t" });
  assert.equal(plan?.promptFragment, WEATHER_CARD_INSTRUCTION);
});

// ── 3. 明日预览（Tier B：服务端确定性排版） ───────────────────────────────────

test("明日预览：同一份载荷两次序列化字节一致，事实齐全", () => {
  const a = renderTomorrowPreviewFacts(DIGEST);
  const b = renderTomorrowPreviewFacts(DIGEST);
  assert.equal(a, b, "确定性序列化：同输入必须同输出");
  // digest.date 是「今天」，事实块里的日期必须是 +1 天的明天
  assert.match(a, /明天 11月7日 周六/);
  assert.match(a, /09:30 部门例会/);
  assert.match(a, /14:00 牙医复诊/);
  assert.match(a, /多云转晴 12–22℃/);
  assert.match(a, /降雨集中在 下午 14–17 点/);
  assert.match(a, /预警：大风/);
  assert.match(a, /交实验报告（今天到期）/);
  assert.match(a, /妈妈生日（还有 3 天）/);
  // 到期时刻必须是人话，不是 ISO 原文
  assert.doesNotMatch(a, /T18:00|00Z/);
});

test("明日预览：无载荷/无明日意图不命中（不往每轮回复里塞预览）", () => {
  assert.equal(decideRender({ text: "今天好累", userText: "今天好累" }).scene?.id, "markdown");
  // 有载荷但用户没问明天、也未显式要求 → 不命中
  const noIntent = decideRender({
    text: "在的",
    userText: "在吗",
    payloads: { eveningDigest: DIGEST },
  });
  assert.notEqual(noIntent.scene?.id, "tomorrow_preview");
});

test("明日预览：命中时不接管正文，正文仍由模型自己写", () => {
  const decision = decideRender({
    text: "好的我看看（模型自己写的正文，必须原样保留）",
    userText: "明天什么安排",
    payloads: { eveningDigest: DIGEST },
  });
  assert.equal(decision.scene?.id, "tomorrow_preview");
  assert.equal(decision.body.form, "markdown");
  assert.equal(decision.text, undefined, "场景不得替换正文");
});

test("结构化摘要轮声明 singleBubble：整块呈现，不分泡", () => {
  for (const id of ["tomorrow_preview", "digest_roundup"]) {
    assert.equal(
      sceneRegistry.get(id)?.produces?.singleBubble,
      true,
      `${id} 是整块内容，拆成几条绿泡就散了`,
    );
  }
  // 这条只给摘要类，不许把闲聊/天气带走
  assert.notEqual(sceneRegistry.get("markdown")?.produces?.singleBubble, true);
  assert.notEqual(sceneRegistry.get("weather")?.produces?.singleBubble, true);
});

test("明日预览：日期解析容错", () => {
  assert.equal(formatPreviewDate("2026-11-06"), "11月6日 周五");
  assert.equal(formatPreviewDate("下周"), "下周");
});

// ── 4. 结构卡（Tier B：契约校验） ─────────────────────────────────────────────

function cardBlock(payload: unknown): string {
  return `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload)}\n[AGENT_RESULT_CARD_END]`;
}

test("结构卡：合法载荷原样保留，正文不改写", () => {
  const block = cardBlock({
    cardType: "steps",
    title: "开通流程",
    items: [{ type: "num", text: "打开设置" }, { type: "num", text: "授权通知" }],
  });
  const text = `${block}\n\n按上面两步就行。`;
  const decision = decideRender({ text });
  assert.equal(decision.scene?.id, "result_card");
  assert.equal(decision.cards.length, 0, "模型卡不算 CardSpec（已在正文里）");
  assert.equal(decision.text, undefined, "合规卡不做正文改写");
  const audit = auditResultCards(text);
  assert.equal(audit.total, 1);
  assert.equal(audit.issues.length, 0);
});

test("结构卡：cardType 不在白名单 → 整块剥掉，正文按 markdown 兜底", () => {
  const bad = cardBlock({ cardType: "随便编的卡", title: "标题", items: [{ type: "num", text: "x" }] });
  const text = `${bad}\n\n正文说明。`;
  const decision = decideRender({ text });
  assert.equal(decision.scene?.id, "result_card");
  assert.equal(decision.body.form, "markdown");
  assert.ok(!decision.text?.includes("[AGENT_RESULT_CARD_START]"), "坏块必须剥掉");
  assert.ok(decision.text?.includes("正文说明。"), "正文保留");
});

test("结构卡：JSON 断裂 / items 超量 / 条目缺 text 都判不合格", () => {
  const brokenJson = "[AGENT_RESULT_CARD_START]\n{cardType:steps}\n[AGENT_RESULT_CARD_END]";
  const tooMany = cardBlock({
    cardType: "fold_list",
    title: "清单",
    items: Array.from({ length: 13 }, (_, i) => ({ type: "num", text: `第${i + 1}条` })),
  });
  const noText = cardBlock({ cardType: "steps", title: "标题", items: [{ type: "num" }] });

  assert.equal(auditResultCards(brokenJson).issues[0].reason, "JSON 解析失败");
  assert.match(auditResultCards(tooMany).issues[0].reason, /items 超量/);
  assert.match(auditResultCards(noText).issues[0].reason, /缺少 text/);
});

test("结构卡：坏块从出口链路真正剥掉（用户看不到裸 JSON）", () => {
  const bad = cardBlock({ cardType: "steps", title: "", items: [] });
  const out = runFull({ text: `${bad}\n\n那就按步骤来吧。` });
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `出口仍残留坏块：${out}`);
  assert.ok(out.includes("那就按步骤来吧。"));
});

// ── 5. 工具卡面 + 正文兜底 ───────────────────────────────────────────────────

test("工具卡面：calendar.list_tasks 回执 → schedule 卡，正文只作前导", () => {
  const decision = decideRender({
    text: "今天两项。",
    effects: [
      {
        tool: "calendar.list_tasks",
        status: "ok",
        result: { ok: true, tasks: [{ title: "部门例会", nextRunAt: "2026-11-05T09:30:00+08:00" }], count: 1 },
      },
    ],
  });
  assert.equal(decision.scene?.id, "tool_cards");
  assert.equal(decision.cards.length, 1);
  assert.equal(decision.cards[0].topic, "schedule");
});

test("正文兜底：无回执的散文走规则链，不注入任何版式指令", () => {
  const decision = decideRender({ text: "今天挺冷的，记得加件外套。", userText: "冷不冷" });
  assert.equal(decision.scene?.id, "markdown");
  assert.equal(decision.cards.length, 0);
  assert.ok(["plain", "markdown"].includes(decision.body.form));
});

// ── 6. 可扩展：新增场景只注册，不改 decide.ts ────────────────────────────────

test("扩展：运行期注册新场景即可接管（示例：一句话结论卡）", () => {
  const reg = new SceneRegistry();
  const quoteScene: RenderScene = {
    id: "quote_scene",
    label: "结论卡",
    priority: 50,
    detect: (ctx) => (ctx.userText?.includes("一句话总结") ? { reason: "用户要一句话结论" } : null),
    plan: () => ({
      sceneId: "quote_scene",
      label: "结论卡",
      cards: [],
      bodyForm: "quote",
      reason: "结论卡",
    }),
  };
  reg.register(quoteScene);
  reg.register({
    id: "markdown",
    label: "正文兜底",
    priority: 0,
    detect: () => ({ reason: "fallback" }),
    plan: () => ({ sceneId: "markdown", label: "兜底", cards: [], reason: "fallback" }),
  });

  const hit = reg.plan({ text: "x", userText: "给我一句话总结" });
  assert.equal(hit.primary, "quote_scene");
  assert.equal(hit.bodyForm, "quote");

  const miss = reg.plan({ text: "x", userText: "随便聊聊" });
  assert.equal(miss.primary, "markdown");
  assert.equal(miss.bodyForm, undefined, "兜底不越权指定形态");
});

test("扩展：场景之间卡按 topic 去重，高优先级先占位", () => {
  const cardSpec = (message: string) => ({
    kind: "card" as const,
    topic: "weather",
    payload: { cardType: "weather", items: [{ type: "text", text: message }] },
  });
  const reg = new SceneRegistry();
  reg.register({
    id: "first",
    label: "高优先",
    priority: 10,
    detect: () => ({ reason: "1" }),
    plan: () => ({
      sceneId: "first",
      label: "高优先",
      cards: [cardSpec("a")],
      reason: "1",
    }),
  });
  reg.register({
    id: "second",
    label: "低优先",
    priority: 5,
    detect: () => ({ reason: "2" }),
    plan: () => ({
      sceneId: "second",
      label: "低优先",
      cards: [cardSpec("b")],
      reason: "2",
    }),
  });
  const plan = reg.plan({ text: "" });
  assert.equal(plan.cards.length, 1);
  const items = (plan.cards[0] as { payload?: { items?: Array<{ text: string }> } }).payload?.items;
  assert.equal(items?.[0]?.text, "a", "高优先级场景的卡先占位");
});

test("默认注册表：planRenderScene 与 decideRender 口径一致", () => {
  const ctx: SceneContext = {
    text: "明天有雨，出门带伞。",
    effects: [{ tool: "weather.get_local", status: "ok", result: WEATHER_RECEIPT }],
  };
  const plan = planRenderScene(ctx);
  const decision = decideRender(ctx);
  assert.equal(decision.scene?.id, plan.primary);
  assert.deepEqual(decision.cards, plan.cards);
});
// ── 5. 盘点清单（2026-11-05 二次根改：数据面直供，不要求模型配合）────────────

const ROUNDUP_RECEIPT = {
  ok: true,
  items: [
    {
      title: "《想飞的女孩》定档 12 月 12 日",
      snippet: "文晏执导，刘浩存、文淇演一对表姐妹，影片曾入围柏林电影节主竞赛单元。",
      source: "SearchApi",
    },
    {
      title: "出席品牌活动 谈新角色准备",
      snippet: "11 月 3 日现身上海，受访说为新片学了三个月现代舞，每天训练 5 小时。",
      source: "SearchApi",
    },
    {
      title: "工作室通报维权进展",
      snippet: "10 月 28 日通报：已对 12 个侵权账号取证，其中 5 个已公开道歉。",
      source: "SearchApi",
    },
  ],
};

const roundupCtx = (text: string, userText = "刘浩存最近有什么新动态？") => ({
  text,
  userText,
  effects: [{ tool: "search_web", status: "ok" as const, result: ROUNDUP_RECEIPT }],
});

const EXPECTED_FACTS = [
  "- 《想飞的女孩》定档 12 月 12 日 — 文晏执导，刘浩存、文淇演一对表姐妹，影片曾入围柏林电影节主竞赛单元。",
  "- 出席品牌活动 谈新角色准备 — 11 月 3 日现身上海，受访说为新片学了三个月现代舞，每天训练 5 小时。",
  "- 工作室通报维权进展 — 10 月 28 日通报：已对 12 个侵权账号取证，其中 5 个已公开道歉。",
].join("\n");

test("盘点清单：条目只作为事实进 prompt，正文不再被服务端接管", () => {
  const d = decideRender(roundupCtx("她最近重心明显在电影上。"));
  assert.equal(d.scene?.id, "digest_roundup");
  assert.equal(d.text, undefined, "场景不得替换正文");
  const pre = planPreRenderScene({
    userText: "刘浩存最近有什么新动态？",
    toolResults: [{ toolName: "search_web", ok: true, result: ROUNDUP_RECEIPT }],
  });
  assert.ok(pre.matched.includes("digest_roundup"));
  const boundary = pre.boundaries.join("\n");
  assert.ok(boundary.includes(EXPECTED_FACTS), "事实行必须进 prompt");
  assert.match(boundary, /盘点轮/);
});

test("盘点清单：模型四种写法都不再被服务端重排", () => {
  const variants = [
    "她最近重心明显在电影上。", // 不写任何结构
    "**新片**\n- 定档 12 月 12 日\n\n**维权**\n- 5 个账号道歉", // 自写加粗分组
    '{"summary":"两件事","groups":[{"title":"新片","items":["a"]}]}', // 甩裸 JSON
    "## 汇总\n| 项目 | 值 |\n| --- | --- |\n最值得盯的是那部片子。", // markdown 表格
  ];
  for (const v of variants) {
    assert.equal(
      decideRender(roundupCtx(v)).text,
      undefined,
      `正文由模型自己写，服务端不得重排：${v}`,
    );
  }
});

test("盘点清单：模型正文原样保留（不再剥语气句、不再去结构化行）", () => {
  const text = [
    "先给你捋一下。",
    "",
    "**新片**",
    "- 定档 12 月 12 日",
    "",
    "最值得盯的是那部片子。",
  ].join("\n");
  assert.equal(decideRender(roundupCtx(text)).text, undefined);
});

test("盘点清单：非盘点意图 / 少于 2 条 / 失败回执都不命中", () => {
  const chat = decideRender(roundupCtx("她最近重心明显在电影上。", "在吗"));
  assert.notEqual(chat.scene?.id, "digest_roundup");

  const one = decideRender({
    text: "就这一条。",
    userText: "她最近有什么动态",
    effects: [{ tool: "search_web", status: "ok", result: { ok: true, items: [ROUNDUP_RECEIPT.items[0]] } }],
  });
  assert.notEqual(one.scene?.id, "digest_roundup");

  const failed = decideRender({
    text: "没查到。",
    userText: "她最近有什么动态",
    effects: [{ tool: "search_web", status: "error", result: { ok: false } }],
  });
  assert.notEqual(failed.scene?.id, "digest_roundup");
});

test("盘点清单：多个工具带回同一条结果时事实行去重", () => {
  const boundary = planPreRenderScene({
    userText: "她最近有什么动态",
    toolResults: [
      { toolName: "search_web", ok: true, result: ROUNDUP_RECEIPT },
      { toolName: "fetch_web", ok: true, result: ROUNDUP_RECEIPT },
    ],
  }).boundaries.join("\n");
  assert.equal((boundary.match(/^- /gm) ?? []).length, 3);
});

test("盘点清单：输出顺序在结构卡之后（卡片优先）", () => {
  const card = '[AGENT_RESULT_CARD_START]\n{"cardType":"steps","title":"流程","items":[{"type":"num","text":"先做 A"}]}\n[AGENT_RESULT_CARD_END]';
  const plan = planRenderScene(roundupCtx(card));
  assert.equal(plan.primary, "result_card");
  assert.ok(plan.matched.some((m) => m.sceneId === "digest_roundup"));
});

test("盘点清单：prompt 里不再有任何盘点格式契约", async () => {
  const { RENDER_PROTOCOL_PROMPT } = await import("../src/services/render-protocol-prompt.js");
  assert.ok(!RENDER_PROTOCOL_PROMPT.includes("AGENT_DIGEST"));
  assert.ok(!RENDER_PROTOCOL_PROMPT.includes("groups"));
  assert.ok(!/盘点分组/.test(RENDER_PROTOCOL_PROMPT));
});

// ── 5. 新增渲染形态的回归门（2026-11-07）─────────────────────────────────────
// 目标：以后加场景 / 加卡型，「不能正常返回」必须在测试里变红，而不是真机才发现。

test("故障隔离：单个场景 detect/plan 抛异常只跳过自己，兜底仍给出正文落点", () => {
  const reg = new SceneRegistry();
  const brokenDetect: RenderScene = {
    id: "broken_detect",
    label: "检测抛错",
    priority: 95,
    detect: () => { throw new Error("boom-detect"); },
    plan: () => null,
  };
  const brokenPlan: RenderScene = {
    id: "broken_plan",
    label: "计划抛错",
    priority: 94,
    detect: () => ({ reason: "hit" }),
    plan: () => { throw new Error("boom-plan"); },
  };
  const fallback: RenderScene = {
    id: "markdown",
    label: "正文兜底",
    priority: 0,
    detect: () => ({ reason: "fallback" }),
    plan: () => ({ sceneId: "markdown", label: "正文兜底", cards: [], reason: "fallback" }),
  };
  reg.register(brokenDetect);
  reg.register(brokenPlan);
  reg.register(fallback);

  const result = reg.plan({ text: "一句话。" });
  assert.equal(result.primary, "markdown");
  assert.equal(result.matched.length, 1);
  assert.deepEqual(result.failures.map((f) => f.split(":")[0]), ["broken_detect", "broken_plan"]);
  assert.match(result.reason, /scene-failures=broken_detect:boom-detect\|broken_plan:boom-plan/);
});

test("默认场景：畸形上下文不抛异常，decideRender 恒有正文形态与文本", () => {
  const ctxs: SceneContext[] = [
    { text: "" },
    { text: "在呢。", userText: "随便聊聊" },
    { text: "## 标题\n- 条目", payloads: { eveningDigest: null } },
    { text: "天气不错", effects: [{ tool: "weather.current", status: "ok" as const, result: {} }] },
    {
      text: "看清单",
      userText: "最近有什么动态",
      effects: [{ tool: "search_web", status: "ok" as const, result: { items: [null, { title: "A" }] } }],
    },
  ];
  for (const ctx of ctxs) {
    const d = decideRender(ctx);
    assert.ok(d.body.form, `body.form 缺失：${JSON.stringify(ctx)}`);
    assert.equal(typeof (d.text ?? ctx.text), "string");
  }
});

test("卡片落地：畸形 payload 可诊断，不再静默丢弃", () => {
  assert.match(diagnoseRegisteredCardPayload(undefined) ?? "", /payload/);
  assert.match(diagnoseRegisteredCardPayload({}) ?? "", /cardType/);
  assert.match(diagnoseRegisteredCardPayload({ cardType: "steps", items: [] }) ?? "", /items/);
  assert.equal(
    diagnoseRegisteredCardPayload({ cardType: "steps", items: [{ text: "A" }] }),
    null,
  );
});

test("双端契约：服务端 cardType 枚举必须有客户端分支（或显式豁免）", () => {
  // 与 speech-stream-contract.test.ts 同一手法：读源码字符串做跨端集合断言。
  // 客户端对未知 cardType 是静默降级成通用列表卡，靠肉眼发现不了漂移。
  const protocol = readFileSync(
    new URL("../../packages/agent-protocol/src/display-effects.ts", import.meta.url),
    "utf8",
  );
  const listBlock = /export const DISPLAY_EFFECT_TYPES = \[([\s\S]*?)\] as const/.exec(protocol)?.[1] ?? "";
  const serverTypes = [...listBlock.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .filter(Boolean)
    .sort();
  assert.ok(serverTypes.length >= 10, "枚举解析失败：清单为空");

  const dartCases = (rel: string): string[] =>
    [...readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8").matchAll(/case\s+"([^"]+)":/g)]
      .map((m) => m[1]);
  const clientTypes = new Set([
    ...dartCases("client/flutter_app/lib/features/chat/display_effects/display_effects.dart"),
    ...dartCases("client/flutter_app/lib/features/chat/agent_result_card.dart"),
  ]);

  // 已知历史债务：这 4 个 cardType 客户端没有专用分支，走通用列表卡。
  // 新增卡型必须同步客户端 switch，或显式写进这份豁免清单。
  const KNOWN_EXEMPT = ["file", "order", "schedule", "wallet"];
  const unexpected = serverTypes.filter((t) => !clientTypes.has(t) && !KNOWN_EXEMPT.includes(t));
  assert.deepEqual(unexpected, [], "新增 cardType 未接入客户端渲染分支");
});
