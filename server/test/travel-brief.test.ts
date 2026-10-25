/**
 * 规划简报（travel-brief）+ 意图槽位抽取（intent-parser F0 部分）+ 日期工具单测。
 *
 * 覆盖三条契约：
 *   1. 默认直出：信息缺口不阻塞，按 原文 > 画像/推断 > 默认 补齐并如实标注来源；
 *   2. 溯源诚实：卡片只展示「不是你亲口说的」行，provenance 分档稳定；
 *   3. 一次问询：心愿点/餐厅/出发地/出发日的问询最多 2 条，回答并入后不被推断覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { extractWishlist, extractFoodWishlist, extractDiningStyle, extractParty, extractOrigin, extractStartDate, extractHotelFocus, extractPreferences } =
  await import("../src/skills/travel-planning/intent-parser.js");
const { buildBrief, briefAssumptions, briefOpenQuestions, applyBriefAnswers, buildBriefCardPayload } =
  await import("../src/skills/travel-planning/travel-brief.js");
const { localTodayISO, addDaysISO, weekdayOfISO, formatDateLabel, daysFromToday } =
  await import("../src/skills/travel-planning/travel-date.js");

// ======================== 日期工具 ========================

test("本地日期不再按 UTC 截（东八区凌晨不回到昨天）", () => {
  const cnEarlyMorning = new Date("2026-11-03T00:30:00+08:00");
  const iso = localTodayISO(cnEarlyMorning);
  // 无论运行机时区如何，localTodayISO 必须与同一 Date 的本地年月日一致
  const y = cnEarlyMorning.getFullYear();
  const m = String(cnEarlyMorning.getMonth() + 1).padStart(2, "0");
  const d = String(cnEarlyMorning.getDate()).padStart(2, "0");
  assert.equal(iso, `${y}-${m}-${d}`);
});

test("加减天数与星期：跨月不漂、周日=0", () => {
  assert.equal(addDaysISO("2026-01-31", 1), "2026-02-01");
  assert.equal(addDaysISO("2026-11-03", 4), "2026-11-07");
  assert.equal(weekdayOfISO("2026-11-01"), 0); // 该日确为周日
  assert.equal(weekdayOfISO("not-a-date"), -1);
  assert.equal(formatDateLabel("2026-11-03"), "11-03 周二");
});

test("daysFromToday：今天 0、昨天 -1、非法 null", () => {
  const now = new Date("2026-11-03T12:00:00");
  assert.equal(daysFromToday("2026-11-03", now), 0);
  assert.equal(daysFromToday("2026-11-02", now), -1);
  assert.equal(daysFromToday("2026-13-99", now), null);
});

// ======================== 槽位抽取 ========================

test("心愿景点：点名并列都抽出，目的地自身不当心愿", () => {
  assert.deepEqual(extractWishlist("去成都玩5天，想去看看宽窄巷子、都江堰"), ["宽窄巷子", "都江堰"]);
  assert.deepEqual(extractWishlist("一定要去三星堆和金沙遗址", "成都").sort(), ["三星堆", "金沙遗址"].sort());
  assert.deepEqual(extractWishlist("想去成都玩", "成都"), []);
  assert.deepEqual(extractWishlist("把青海湖排进行程", "西宁"), ["青海湖"]);
});

test("点名餐厅 vs 菜系词：想吃海鲜不产生餐厅心愿", () => {
  assert.deepEqual(extractFoodWishlist("想吃陈麻婆豆腐和蜀香居"), ["陈麻婆豆腐", "蜀香居"]);
  assert.deepEqual(extractFoodWishlist("想吃海鲜"), []);
  assert.equal(extractDiningStyle("想找本地人常去的老字号，别带我去网红店"), "local");
  assert.equal(extractDiningStyle("想去网红店打卡漂亮饭"), "trendy");
  assert.equal(extractDiningStyle("随便吃点"), undefined);
});

test("同行人 / 出发地 / 住宿落位", () => {
  assert.equal(extractParty("我一个人去"), "solo");
  assert.equal(extractParty("一个女生去玩半个月"), "solo_female");
  assert.equal(extractParty("带爸妈和孩子一起"), "family");
  assert.equal(extractOrigin("从上海出发去成都玩5天", "成都"), "上海");
  assert.equal(extractOrigin("成都飞大理", "大理"), "成都");
  assert.deepEqual(extractHotelFocus("酒店想离机场近一点，赶早班机"), { focus: "airport" });
  assert.deepEqual(extractHotelFocus("住宿靠海，推窗见海"), { focus: "seaside" });
  assert.deepEqual(extractHotelFocus("想住在兵马俑附近的酒店", ), { focus: "attraction", ref: "兵马俑" });
});

test("出发日抽取：年月日/月日/相对/节日，跨年顺延", () => {
  const now = new Date("2026-11-03T12:00:00");
  assert.equal(extractStartDate("2026年12月5日出发", now), "2026-12-05");
  assert.equal(extractStartDate("12月5日走", now), "2026-12-05");
  assert.equal(extractStartDate("3月2日走", now), "2027-03-02"); // 已过 → 明年
  assert.equal(extractStartDate("明天出发", now), "2026-11-04");
  assert.equal(extractStartDate("三天后去", now), "2026-11-06");
  assert.equal(extractStartDate("10月1日国庆走", now), "2027-10-01"); // 10-1 已过 → 明年国庆
  assert.equal(extractStartDate("国庆走", now), "2027-10-01");
  assert.equal(extractStartDate("去成都玩5天", now), undefined);
});

test("extractPreferences 把新槽位连同来源一起给出", () => {
  const prefs = extractPreferences("从上海出发，11月10日去成都玩5天，一定要去看都江堰，想吃陈麻婆豆腐，带老人", undefined, "成都");
  assert.equal(prefs.origin, "上海");
  assert.equal(prefs.startDate, "2026-11-10");
  assert.deepEqual(prefs.wishlist, ["都江堰"]);
  assert.deepEqual(prefs.foodWishlist, ["陈麻婆豆腐"]);
  assert.equal(prefs.elderly, true);
  assert.equal(prefs.sources.wishlist, "user");
  assert.equal(prefs.sources.startDate, "user");
});

test("吃饭倾向由画像派生并标 profile（用户没点菜风也不空着）", () => {
  const prefs = extractPreferences("去大理玩3天", undefined, "大理", { photoDriven: true });
  assert.equal(prefs.diningStyle, "trendy");
  assert.equal(prefs.sources.diningStyle, "profile");
});

// ======================== 简报槽位与溯源 ========================

test("简报：原话行不显示，推断/默认行显示且带来源话术", () => {
  const prefs = extractPreferences("去成都玩5天，住海景房靠海的", undefined, "成都");
  const brief = buildBrief({ destination: "成都", days: 5, prefs, inferredStartDate: "2026-11-03" });
  const rows = briefAssumptions(brief);
  const text = rows.map((r) => `${r.label}：${r.value}`).join("\n");
  assert.ok(text.includes("出发日：11-03 周二（先这么定，可改）"), text);
  assert.ok(text.includes("同行人：2 位成人（先这么定，可改）"), text);
  assert.ok(text.includes("出发地：没提到"), `没说出发地就该露出这一行：${text}`);
  assert.ok(!text.includes("住宿落位"), "用户自己说了靠海，不该当假设重复播报");
  assert.equal(brief.provenance.startDate, "default");
  assert.equal(brief.provenance.days, "stated");
});

test("简报：缺出发地/日期时如实标「没提到」", () => {
  const prefs = extractPreferences("去三亚玩3天", undefined, "三亚");
  const brief = buildBrief({ destination: "三亚", days: 3, prefs });
  assert.equal(brief.origin, null);
  assert.equal(brief.startDate, null);
  const rows = briefAssumptions(brief);
  assert.ok(rows.some((r) => r.key === "origin" && r.value.includes("没提到")));
  assert.ok(rows.some((r) => r.key === "startDate" && r.value.includes("没提到")));
});

test("问询：默认两条、心愿已答过就不再问，且永不阻塞", () => {
  const prefs = extractPreferences("去成都玩5天", undefined, "成都");
  const brief = buildBrief({ destination: "成都", days: 5, prefs });
  const qs = briefOpenQuestions(brief);
  assert.equal(qs.length, 2);
  assert.deepEqual(qs.map((q) => q.id), ["wishlist", "foodWishlist"]);

  const answered = applyBriefAnswers(brief, { wishlist: ["都江堰"], foodWishlist: ["陈麻婆豆腐"] });
  assert.deepEqual(answered.wishlist, ["都江堰"]);
  assert.equal(answered.provenance.wishlist, "asked");
  // 心愿答完，剩下的一问自动让给更基础的信息（仍然最多 2 条、仍然不阻塞）
  assert.deepEqual(briefOpenQuestions(answered).map((q) => q.id), ["origin", "startDate"]);
});

test("回答不覆盖用户原话（stated 优先于 asked）", () => {
  const prefs = extractPreferences("从上海出发去成都", undefined, "成都");
  const brief = buildBrief({ destination: "成都", prefs });
  assert.equal(brief.provenance.origin, "stated");
  const next = applyBriefAnswers(brief, { origin: "南京" });
  assert.equal(next.origin, "上海", "原话说的出发地不被追问回答改掉");
});

test("简报卡：假设 + 核实 + 候选一键加入；无内容返回 null", () => {
  const prefs = extractPreferences("去成都玩5天", undefined, "成都");
  const brief = buildBrief({ destination: "成都", days: 5, prefs });
  const card = buildBriefCardPayload({
    brief,
    destination: "成都",
    candidates: [{ name: "青城山", type: "attraction" }, { name: "西岭雪山" }],
    issues: [
      { level: "block", message: "都江堰 周一闭馆（Day 3正是周一）" },
      { level: "info", message: "某馆开放时间未取到" },
    ],
  });
  assert.ok(card);
  assert.equal(card!.cardType, "");
  assert.ok(card!.items.some((i) => i.type === "warn" && i.text.includes("闭馆")));
  assert.ok(!card!.items.some((i) => i.text.includes("未取到")), "info 级不上卡");
  assert.equal(card!.actions[0]!.label, "把「青城山」排进行程");
  assert.deepEqual(card!.actions[0]!.payload, { wishlist: ["青城山"] });
  assert.ok(card!.footer.includes("再谈预订"), "预订后置：卡尾话术不得诱导先订");

  const empty = buildBriefCardPayload({ brief: fullyStatedBrief() });
  assert.equal(empty, null, "全是原话、无候选、无冲突时不出卡（不占版面）");
});

/** 全部槽位都来自用户原话且已答过问询 → 简报卡没有可说的，应返回 null */
function fullyStatedBrief() {
  const base = buildBrief({
    destination: "成都",
    days: 5,
    prefs: extractPreferences("从上海出发，11月10日两个人去成都玩5天，预算中等，住靠海，想去都江堰，想吃陈麻婆豆腐", undefined, "成都"),
  });
  return { ...base, provenance: Object.fromEntries(Object.keys(base.provenance).map((k) => [k, "stated"])) as typeof base.provenance };
}
