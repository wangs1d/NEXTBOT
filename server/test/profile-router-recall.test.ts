/**
 * 画像 v2 评测（ProfileRouter 动态路由 vs 全量注入）。
 *
 * 三组指标：
 *   1. 召回准确度：按类查询的 precision / recall（对种子数据集）
 *   2. token 对比：意图路由 snapshot vs 旧全量注入的注入量
 *   3. 分类正确性：field-taxonomy 映射抽检
 *
 * factStore 用内存 fake（本机 better-sqlite3 与 Node 版本不匹配，真库迁移由
 * 启动期幂等脚本承担，见 structured-fact-store.migrateTemporalColumns）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProfileRouter,
  routeIntentTags,
  classifyIntentFromText,
  recallTagsForTurn,
  SNAPSHOT_CONSTANT_TAGS,
} from "../src/brain/profile-router.js";
import { taxonomyTagFor, type ProfileTag } from "../src/agentic-memory/field-taxonomy.js";
import type { StructuredFact } from "../src/agentic-memory/structured-fact-store.js";

// ─────────────── 种子数据：30 条跨 9 类的画像字段 ───────────────

const SEED: Array<[string, string]> = [
  // identity
  ["称呼", "老铁"], ["职业", "后端开发"], ["居住地", "贵州兴义"], ["生日", "1995-03-12"], ["公司", "某云厂商"],
  ["学校", "贵州大学"], ["专业", "软件工程"], ["部门", "平台组"],
  // rhythm
  ["出门准备", "25分钟"], ["入睡时间", "凌晨1:30"], ["起床时间", "8:30"], ["上班时间", "9:30"], ["午休", "13:00-13:40"],
  // preference
  ["咖啡", "拿铁"], ["爱吃", "酸汤鱼"], ["常点", "奶茶三分糖"], ["爱好", "爬山"], ["品牌", "索尼"], ["球队", "巴萨"],
  ["爱喝的茶", "绿茶"], ["爱吃的水果", "荔枝"], ["喜欢的剧", "科幻悬疑"], ["常听", "后摇"], ["喜欢的运动", "夜跑"], ["常用App", "终端里的AI助手"],
  // aversion
  ["不吃", "香菜"], ["过敏", "芒果"], ["别提", "前公司裁员"], ["反感的推荐", "成功学课程"],
  // relations
  ["指代·妈妈", "王阿姨"], ["指代·老婆", "刘浩存"], ["宠物", "橘猫二饼"],
  ["指代·爸爸", "老王"], ["指代·姐姐", "王姐"], ["指代·闺蜜", "小林"],
  // comms
  ["称呼习惯", "叫我老铁"], ["沟通偏好", "直接说结论别铺垫"], ["详细度", "三句话以内"],
  // spending
  ["月预算", "餐饮2000"], ["订阅", "网易云音乐"], ["常购平台", "京东"],
  ["视频会员", "某讯视频"], ["云存储订阅", "200G"], ["游戏月卡", "已停"],
  // health（敏感类）
  ["过敏原", "花粉"], ["复诊", "每月15号牙医"],
  // goals / note
  ["正在赶", "NEXTBOT 版本"], ["备注", "喜欢黑色系配色"],
];

function makeFactStore(seed: Array<[string, string]>) {
  const facts: StructuredFact[] = seed.map(([field, value], i) => ({
    id: `f${i}`,
    actorId: "u1",
    entity: "user",
    field,
    value,
    category: taxonomyTagFor(field),
    confidence: 0.9,
    sourceRef: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 60_000).toISOString(),
    temporal: "current" as const,
    eventTime: null,
    validFrom: null,
    validTo: null,
    observedAt: "2026-10-01T00:00:00Z",
    confirmCount: 1,
    planState: undefined,
  }) as unknown as StructuredFact);
  return {
    getActiveFactsByCategory(
      actorId: string,
      categories: readonly string[],
      _entity?: string,
      limit = 40,
    ): StructuredFact[] {
      void actorId;
      const wanted = new Set(categories);
      const out: StructuredFact[] = [];
      for (const f of facts) {
        if (wanted.has(f.category)) {
          out.push(f);
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    _facts: facts,
  };
}

function makeRouter(seed: Array<[string, string]>): ProfileRouter {
  const store = makeFactStore(seed);
  return new ProfileRouter({
    factStore: store,
    readProfile: async () => PROFILE_TEXT,
    now: () => Date.now(),
  });
}

const PROFILE_TEXT = [
  "## 基本信息",
  "称呼：老铁",
  "所在地：贵州兴义",
  "职业：后端开发",
  "## 沟通偏好",
  "直接说结论，别铺垫",
].join("\n");

// ─────────────── 1. 召回准确度 ───────────────

test("召回准确度：按类查询 precision=1.0（不串类）", () => {
  const router = makeRouter(SEED);
  const rhythm = router.query("u1", "rhythm");
  assert.equal(rhythm.length, 5, "rhythm 类恰好 5 条");
  assert.ok(rhythm.every((r) => r.tag === "rhythm"), "全部命中 rhythm，零串类");
  assert.ok(rhythm.some((r) => r.field === "出门准备" && r.value === "25分钟"));
  assert.ok(!rhythm.some((r) => r.field === "咖啡"), "偏好类不混入");

  const aversion = router.query("u1", "aversion");
  assert.equal(aversion.length, 4);
  assert.ok(aversion.every((r) => r.tag === "aversion"));
  assert.ok(!aversion.some((r) => r.field === "爱吃"), "偏好不吃混入禁忌");
});

test("召回准确度：意图路由 snapshot 召回该取的类、排除无关类", () => {
  const router = makeRouter(SEED);
  const snap = router.snapshot("u1", { intent: "deadline", tokenBudget: 800 });
  assert.ok(snap);
  const text = `${snap.constant}\n${snap.routed}`;
  // schedule 意图 → rhythm + goals，且恒带层 identity/comms/aversion
  for (const field of ["称呼", "沟通偏好", "不吃", "出门准备", "正在赶"]) {
    assert.ok(text.includes(field), `应包含 ${field}`);
  }
  // 无关类不注入
  assert.ok(!text.includes("拿铁"), "偏好类（咖啡）不进日程意图");
  assert.ok(!text.includes("京东"), "消费类不进日程意图");
  assert.ok(!text.includes("花粉"), "health 敏感类结构性排除");
  assert.deepEqual(snap.tagsUsed.includes("health" as ProfileTag), false);
});

test("召回准确度：taxonomy 映射抽检（45 条种子零错标）", () => {
  const expected: Record<string, ProfileTag> = {};
  for (const [field] of SEED) expected[field] = expectedTag(field);
  const wrong: string[] = [];
  for (const [field, want] of Object.entries(expected)) {
    const got = taxonomyTagFor(field);
    if (got !== want) wrong.push(`${field}: want=${want} got=${got}`);
  }
  assert.equal(wrong.length, 0, `错标字段：${wrong.join(", ")}`);
});

// 种子字段的期望类（独立于 taxonomy 实现，作对照基准）
function expectedTag(field: string): ProfileTag {
  const identity = ["称呼", "职业", "居住地", "生日", "公司", "学校", "专业", "部门"];
  const rhythm = ["出门准备", "入睡时间", "起床时间", "上班时间", "午休"];
  const aversion = ["不吃", "过敏", "别提", "反感的推荐"];
  if (field === "过敏原") return "health";
  const relations = ["指代·妈妈", "指代·老婆", "宠物", "指代·爸爸", "指代·姐姐", "指代·闺蜜"];
  const comms = ["称呼习惯", "沟通偏好", "详细度"];
  const spending = ["月预算", "订阅", "常购平台", "视频会员", "云存储订阅", "游戏月卡"];
  const health = ["过敏原", "复诊"];
  // 「过敏」按 aversion 处理（不吃/忌口语义同族；过敏原/复诊才是 health）
  const goals = ["正在赶"];
  if (identity.includes(field)) return "identity";
  if (rhythm.includes(field)) return "rhythm";
  if (field === "过敏") return "aversion";
  if (aversion.includes(field)) return "aversion";
  if (relations.includes(field)) return "relations";
  if (comms.includes(field)) return "comms";
  if (spending.includes(field)) return "spending";
  if (health.includes(field)) return "health";
  if (goals.includes(field)) return "goals";
  if (field === "备注" || field === "常听" || field === "常用App") return "note" as never;
  return "preference"; // 咖啡/爱吃/常点/爱好/品牌/球队/爱喝的茶/爱吃的水果/喜欢的剧/喜欢的运动
}

// ─────────────── 2. token 对比 ───────────────

test("token 对比：意图路由 snapshot vs 旧全量注入", () => {
  const router = makeRouter(SEED);

  // 旧全量注入 = 全部字段行（renderForPrompt 未加类过滤时的等价文本）
  const allLines = SEED.map(([field, value]) => `${field}:${value}`).join("\n");
  const oldTokens = Math.ceil(allLines.length / 1.5);

  // 新：三个典型意图的 snapshot
  const schedule = router.snapshot("u1", { intent: "schedule", tokenBudget: 800 })!;
  const chat = router.snapshot("u1", { intent: "chat", tokenBudget: 800 })!;
  const spending = router.snapshot("u1", { intent: "spending", tokenBudget: 800 })!;

  const report = [
    "═══ 画像注入 token 对比（种子 45 条 / 中文 ≈ chars/1.5）═══",
    `旧·全量注入          : ${oldTokens} tok（${allLines.length} chars）`,
    `新·schedule snapshot : ${schedule.estTokens} tok（省 ${pct(oldTokens, schedule.estTokens)}）`,
    `新·chat snapshot     : ${chat.estTokens} tok（省 ${pct(oldTokens, chat.estTokens)}）`,
    `新·spending snapshot : ${spending.estTokens} tok（省 ${pct(oldTokens, spending.estTokens)}）`,
  ].join("\n");
  console.log(`\n${report}\n`);

  // 预算语义：均在 800 tok 内；平均节省 ≥50%（设计验收线）
  for (const s of [schedule, chat, spending]) {
    assert.ok(s.estTokens <= 800, "snapshot 受 token 预算约束");
  }
  const avg = (schedule.estTokens + chat.estTokens + spending.estTokens) / 3;
  assert.ok(
    avg <= oldTokens * 0.5,
    `平均注入量应为旧全量的 ≤50%（实测 ${(avg / oldTokens * 100).toFixed(1)}%）`,
  );
});

function pct(oldV: number, newV: number): string {
  return `${(((oldV - newV) / oldV) * 100).toFixed(0)}%`;
}

// ─────────────── 3. 意图词表路由 ───────────────

test("意图词表路由：文本 → 意图族 → 类集合", () => {
  assert.deepEqual(routeIntentTags(classifyIntentFromText("明天早上九点提醒我开会")), ["rhythm"]);
  assert.deepEqual(routeIntentTags(classifyIntentFromText("这周要交什么作业")), ["goals", "rhythm"]);
  assert.deepEqual(routeIntentTags(classifyIntentFromText("这个耳机降到800叫我")), ["spending"]);
  assert.deepEqual(routeIntentTags(classifyIntentFromText("帮我发消息给我妈")), ["relations"]);
  assert.deepEqual(routeIntentTags(classifyIntentFromText("今天天气不错")), [], "未命中意图 → 只剩恒带层");
});

// ─────────────── 3. 召回时机与准确率 ───────────────

test("召回时机：三级合并——意图词表漏掉时字段命中兜住（T2 直提信号）", async () => {
  const store = makeFactStore(SEED);
  const router = makeRouter(SEED);
  const routerWithHits = new ProfileRouter({
    factStore: store,
    matchFactsInText: (actorId, text) =>
      store._facts.filter((f) => {
        if (f.field.length >= 2 && text.includes(f.field)) return true;
        const v = f.value?.trim() ?? "";
        return v.length >= 2 && v.length <= 20 && !/^\d+$/.test(v) && text.includes(v);
      }),
    readProfile: async () => PROFILE_TEXT,
  });

  // "咖啡还喝拿铁吗"：意图词表不命中（无买/价格词），但字段「咖啡」直提 → preference 召回
  const t1 = recallTagsForTurn(router, "u1", "咖啡还喝拿铁吗");
  assert.equal(t1.categories.includes("preference"), false, "无字段命中信号时词表漏召回");
  const t2 = recallTagsForTurn(routerWithHits, "u1", "咖啡还喝拿铁吗");
  assert.equal(t2.categories.includes("preference"), true, "字段命中兜住");
  assert.ok(t2.fieldHits.includes("咖啡"));
  // 恒带层始终在
  for (const tag of ["identity", "comms", "aversion"]) {
    assert.ok(t2.categories.includes(tag as ProfileTag), `恒带层 ${tag}`);
  }
  assert.equal(t2.categories.includes("health"), false, "health 敏感类结构性排除");
  void routerWithHits;
});

test("召回时机决策准确率：标注语句集 micro P/R/F1（含 none 类）", async () => {
  const store = makeFactStore(SEED);
  const router = new ProfileRouter({
    factStore: store,
    matchFactsInText: (actorId, text) =>
      store._facts.filter((f) => {
        if (f.field.length >= 2 && text.includes(f.field)) return true;
        const v = f.value?.trim() ?? "";
        return v.length >= 2 && v.length <= 20 && !/^\d+$/.test(v) && text.includes(v);
      }),
    readProfile: async () => PROFILE_TEXT,
  });

  // 标注集：utterance → 该轮应该召回的类（恒带层不计入——每轮都在，无判别价值）
  const LABELED: Array<{ text: string; want: ProfileTag[] }> = [
    { text: "明天早上九点提醒我开会", want: ["rhythm"] },
    { text: "这周要交什么作业", want: ["rhythm", "goals"] },
    { text: "帮我盯着这款耳机降价", want: ["spending"] },
    { text: "这个耳机降到800以内叫我", want: ["spending"] },
    { text: "帮我发消息给我妈", want: ["relations"] },
    { text: "转告我老婆今晚不回来吃饭", want: ["relations"] },
    { text: "咖啡还喝拿铁吗", want: ["preference"] }, // T2 字段命中
    { text: "我还吃香菜吗", want: [] },                // aversion 在恒带层，每轮已覆盖
    { text: "我出门要多久", want: ["rhythm"] },        // T2 字段命中（出门准备）
    { text: "今天天气怎么样", want: [] },
    { text: "帮我写段代码", want: [] },
  ];

  let tp = 0, fp = 0, fn = 0;
  const misses: string[] = [];
  for (const { text, want } of LABELED) {
    const got = new Set(
      recallTagsForTurn(router, "u1", text).categories.filter(
        (t) => !SNAPSHOT_CONSTANT_TAGS.includes(t),
      ),
    );
    const wantSet = new Set(want);
    for (const t of got) {
      if (wantSet.has(t)) tp += 1;
      else {
        fp += 1;
        misses.push(`FP "${text}" → ${t}`);
      }
    }
    for (const t of wantSet) {
      if (!got.has(t)) {
        fn += 1;
        misses.push(`FN "${text}" ← ${t}`);
      }
    }
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = (2 * precision * recall) / (precision + recall);
  console.log(
    `\n═══ 召回时机决策准确率（${LABELED.length} 条标注语句，恒带层不计）═══\n` +
      `TP=${tp} FP=${fp} FN=${fn}\n` +
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} F1=${f1.toFixed(3)}\n` +
      (misses.length ? `${misses.join("\n")}\n` : ""),
  );
  // 验收线：micro F1 ≥ 0.8（词表+字段命中两级时机）
  assert.ok(f1 >= 0.8, `F1=${f1.toFixed(3)} < 0.8\n${misses.join("\n")}`);
});
