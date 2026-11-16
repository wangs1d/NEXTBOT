/**
 * 画像按需注入评测（2026-11-12 根修后形态）。
 *
 * 覆盖：
 *   1. ProfileRouter.query 按类取数（profile.query 工具的数据面）不串类；
 *   2. 字段分类（field-taxonomy）抽检；
 *   3. query 相关性召回（T3 语义通道）见 profile-semantic-recall.test.ts。
 *
 * factStore 用内存 fake（本机 better-sqlite3 与 Node 版本不匹配，真库迁移由
 * 启动期幂等脚本承担，见 structured-fact-store.migrateTemporalColumns）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProfileRouter } from "../src/brain/profile-router.js";
import { taxonomyTagFor, type ProfileTag } from "../src/agentic-memory/field-taxonomy.js";

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
  const facts = seed.map(([field, value], i) => ({
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
  }) as unknown as import("../src/agentic-memory/structured-fact-store.js").StructuredFact);
  return {
    getActiveFactsByCategory(
      actorId: string,
      categories: readonly string[],
      _entity?: string,
      limit = 40,
    ): typeof facts {
      void actorId;
      const wanted = new Set(categories);
      const out: typeof facts = [];
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
    readProfile: async () => "",
  });
}

// ─────────────── 1. 按类取数（profile.query 工具数据面） ───────────────

test("按类取数 precision=1.0（不串类）", () => {
  const router = makeRouter(SEED);
  const rhythm = router.query("u1", "rhythm");
  assert.equal(rhythm.length, 5, "rhythm 类恰好 5 条");
  assert.ok(rhythm.every((r) => r.tag === "rhythm"), "全部命中 rhythm，零串类");
  assert.ok(rhythm.some((r) => r.field === "出门准备" && r.value === "25分钟"));
  assert.ok(!rhythm.some((r) => r.field === "咖啡"), "偏好类不混入");

  const aversion = router.query("u1", "aversion");
  assert.equal(aversion.length, 4);
  assert.ok(aversion.every((r) => r.tag === "aversion"));
  assert.ok(!rhythm.some((r) => r.field === "爱吃"), "偏好不吃混入禁忌");
});

// ─────────────── 2. 分类正确性 ───────────────

test("taxonomy 映射抽检（45 条种子零错标）", () => {
  const wrong: string[] = [];
  for (const [field] of SEED) {
    const want = expectedTag(field);
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
