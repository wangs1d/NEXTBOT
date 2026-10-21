/**
 * 用户画像根修接线测试（2026-09-29 P0-1/P0-2/P1/P2 落地配套）。
 *
 * 覆盖四个新机制：
 *  - hasRealProfileContent：模板画像判定（prompt 注入闸——模板不注入）
 *  - mergeUserProfilePromptSources：文件画像 + manager 派生摘要合并（互斥改合并）
 *  - shouldExtractNow：抽取 token 闸（highSignal/个人陈述预筛，寒暄轮跳过）
 *  - UserProfileStore.deleteAll：隐私闭环级联删除
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  UserProfileStore,
  hasRealProfileContent,
  defaultUserProfileMarkdown,
  isNoisyProfileLine,
  sanitizeProfileMarkdown,
} from "../src/services/user-personalization/user-profile-store.js";
import { mergeUserProfilePromptSources } from "../src/agent/prompt-context-builder.js";
import { UserProfileAggregator, applyProfileOps } from "../src/brain/user-profile-aggregator.js";

/* ── hasRealProfileContent：模板/样板行不算真实事实 ── */

test("模板判定：默认模板画像 = 无真实内容", () => {
  assert.equal(hasRealProfileContent(defaultUserProfileMarkdown("u1")), false);
});

test("模板判定：只含语气同步样板行 = 无真实内容", () => {
  const p = defaultUserProfileMarkdown("u1").replace(
    "- 语气风格：自然均衡（系统根据对话自动调整）",
    "- 语气风格：温馨亲切（系统根据对话自动调整）",
  );
  assert.equal(hasRealProfileContent(p), false);
});

test("模板判定：任一真实内容行（称呼/爱好）= 有真实内容", () => {
  const p = defaultUserProfileMarkdown("u1").replace(
    "- （待了解：称呼、所在地、职业等）",
    "- 称呼：周明远",
  );
  assert.equal(hasRealProfileContent(p), true);
});

test("模板判定：占位括号行不算（LLM 写的「（待补充）」变体）", () => {
  const p = defaultUserProfileMarkdown("u1").replace("- （待了解）", "- （待补充）");
  assert.equal(hasRealProfileContent(p), false);
});

/* ── mergeUserProfilePromptSources：互斥改合并 ── */

test("合并：文件画像为主位，manager 摘要非重复行追加", () => {
  const file = "## 基本信息\n- 称呼：周明远\n- 所在地：成都";
  const manager = "- 称呼：周明远\n- 职业：消防员";
  const merged = mergeUserProfilePromptSources(file, manager);
  assert.ok(merged!.includes("称呼：周明远"));
  assert.equal(merged!.match(/称呼：周明远/g)!.length, 1, "重复行去重");
  assert.ok(merged!.includes("职业：消防员"), "manager 独有行保留");
});

test("合并：只有文件画像 / 只有 manager 摘要 / 双空", () => {
  assert.equal(mergeUserProfilePromptSources("A", undefined), "A");
  assert.equal(mergeUserProfilePromptSources(undefined, "B"), "B");
  assert.equal(mergeUserProfilePromptSources(undefined, undefined), undefined);
});

test("合并：manager 摘要全部重复时不追加空尾巴", () => {
  const file = "- 称呼：周明远";
  const merged = mergeUserProfilePromptSources(file, "- 称呼：周明远");
  assert.equal(merged, file);
});

/* ── 确定性净噪器：写入门槛（2026-10-20） ── */

test("净噪：疑问句不算事实（备注里的「我多少事？」）", () => {
  assert.equal(isNoisyProfileLine("我多少事？", "note"), true);
  assert.equal(isNoisyProfileLine("你现在能记住我多少事？", "note"), true);
  assert.equal(isNoisyProfileLine("你会一直记得我吗", "note"), true);
});

test("净噪：对助手/记忆的 meta 观察不算用户画像", () => {
  assert.equal(isNoisyProfileLine("会主动询问宠物相关信息", "interest"), true);
  assert.equal(isNoisyProfileLine("会主动让助手帮忙记事情，并事后抽查记忆", "interest"), true);
  // 规则边界：不以 meta 前缀开头的正经偏好不受影响
  assert.equal(isNoisyProfileLine("习惯用简单问答方式获取信息，偏好直接回答而非展开说明", "communication"), false);
});

test("净噪：临时安排与行程不进画像（近期出差/周末计划）", () => {
  assert.equal(isNoisyProfileLine("近期有出差安排，涉及与对接人接洽", "basic"), true);
  assert.equal(isNoisyProfileLine("近期关注出差行程安排（深圳出差、酒店位置、往返时间规划）", "interest"), true);
});

test("净噪：行为频率与变化的描述不进画像（旅游目的频繁切换）", () => {
  assert.equal(isNoisyProfileLine("旅游目的频繁切换", "interest"), true);
  assert.equal(isNoisyProfileLine("经常更换旅行目的地", "interest"), true);
});

test("净噪：「常用语言」不是画像字段 + 不确定推断不写", () => {
  assert.equal(isNoisyProfileLine("常用语言：中文", "basic"), true);
  assert.equal(isNoisyProfileLine("职业：可能是个设计师", "basic"), true);
});

test("净噪：system 样板行与占位行永不判噪声", () => {
  assert.equal(isNoisyProfileLine("语气风格：温馨亲切（系统根据对话自动调整）", "communication"), false);
  assert.equal(isNoisyProfileLine("回复偏好：精简直接，口语化，像身边熟人回话；少客服腔、少标题、少表格、少长解释", "communication"), false);
  assert.equal(isNoisyProfileLine("（待了解：称呼、所在地、职业等）", "basic"), false);
});

test("净噪：基本信息只留档案字段行（猫粮细节这类塞进来的细节清掉）", () => {
  assert.equal(isNoisyProfileLine("养了一只白色短毛猫，名叫咪咪，今年两岁", "basic"), true);
  assert.equal(isNoisyProfileLine("咪咪喜欢吃三文鱼味猫粮，不喜欢牛肉味", "basic"), true);
  assert.equal(isNoisyProfileLine("称呼：王铭川", "basic"), false);
});

test("整文净噪：已删噪声行 + 有真实事实时清残留占位行（mem50 实盘样本）", () => {
  const md = [
    "# 用户画像",
    "",
    "## 基本信息",
    "",
    "- 养了一只白色短毛猫，名叫咪咪，今年两岁",
    "- 称呼：王铭川",
    "- （待了解：称呼、所在地、职业等）",
    "",
    "## 兴趣与习惯",
    "",
    "- 会主动询问宠物相关信息",
    "- 周末有户外活动的意愿，关注爬山推荐",
    "",
    "## 备注",
    "- 我多少事？",
    "",
  ].join("\n");
  const out = sanitizeProfileMarkdown(md);
  assert.ok(!out.includes("名叫咪咪"), "基本信息里的宠物细节被清");
  assert.ok(!out.includes("待了解：称呼"), "有真实事实后占位行被清");
  assert.ok(!out.includes("会主动询问宠物相关信息"), "meta 观察被清");
  assert.ok(!out.includes("我多少事？"), "疑问句备注被清");
  assert.ok(out.includes("- 称呼：王铭川"), "档案字段行保留");
  assert.ok(out.includes("关注爬山推荐"), "正常的兴趣行保留");
});

test("整文净噪：幂等（无变化返回原字符串）", () => {
  const clean = ["# 用户画像", "", "## 基本信息", "", "- 称呼：王铭川", ""].join("\n");
  assert.equal(sanitizeProfileMarkdown(clean), clean);
  assert.equal(sanitizeProfileMarkdown(defaultUserProfileMarkdown("u1")), defaultUserProfileMarkdown("u1"));
});

test("净噪落位：applyProfileOps 丢弃噪声条目并记 skipped，正常条目照写", () => {
  const profile = ["# 用户画像", "", "## 备注", ""].join("\n");
  const { profile: next, applied, skipped } = applyProfileOps(profile, [
    { op: "ADD", section: "note", line: "我多少事？", match: "" },
    { op: "ADD", section: "note", line: "用户养了两只猫", match: "" },
  ]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0], "我多少事？");
  assert.equal(applied.length, 1);
  assert.ok(!next.includes("我多少事？"), "噪声行未进盘");
  assert.ok(next.includes("用户养了两只猫"), "正常条目已写入");
});

/* ── 抽取 token 闸（私有方法直测：shouldExtractNow） ── */

const agg = new UserProfileAggregator();
const gate = (text: string, highSignal = false) =>
  (agg as unknown as { shouldExtractNow: (t: string, h: boolean) => boolean }).shouldExtractNow(
    text,
    highSignal,
  );

/** 关闭统一抽取，回退到"本类自己抽画像"的旧档语义 */
function withLegacyUnified<T>(fn: () => T): T {
  const prev = process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED;
  process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED = "0";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED;
    else process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED = prev;
  }
}

test("抽取闸：统一抽取启用时不单独发画像 LLM（改由同一次调用捎带）", () => {
  assert.equal(gate("我叫周明远，在成都当消防员"), false);
  assert.equal(gate("在吗", true), false);
});

test("抽取闸（回退档）：highSignal 轮无条件放行", () => {
  withLegacyUnified(() => {
    assert.equal(gate("在吗", true), true);
    assert.equal(gate("嗯", true), true);
  });
});

test("抽取闸（回退档）：个人陈述正则命中放行（我叫/住在/喜欢/最近在学）", () => {
  withLegacyUnified(() => {
    assert.equal(gate("我叫周明远，在成都当消防员"), true);
    assert.equal(gate("我最近在学日语"), true);
    assert.equal(gate("我喜欢钓鱼"), true);
  });
});

test("抽取闸（回退档）：寒暄轮拦截（省 MINI 抽取调用）", () => {
  withLegacyUnified(() => {
    assert.equal(gate("在吗"), false);
    assert.equal(gate("晚上一起吃饭不"), false);
    assert.equal(gate("今天加班好累啊"), false);
    assert.equal(gate("嗯嗯好的"), false);
  });
});

test("抽取闸（回退档）：改口/迁移类表述放行（2026-09-29 纠错腿盲区回归）", () => {
  withLegacyUnified(() => {
    assert.equal(gate("我民宿上个月转让出去了，现在在泉州开咖啡店，以后就在泉州长住了"), true);
    assert.equal(gate("我改行了，现在不教书了"), true);
    assert.equal(gate("过阵子搬到杭州去"), true);
  });
});

test("抽取闸（回退档）：MEMORY_PROFILE_EXTRACT_PRESCREEN=0 关闭预筛全放行", () => {
  const prev = process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN;
  process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN = "0";
  try {
    withLegacyUnified(() => {
      // config 在构造时定格：预筛开关必须作用于新实例
      const a2 = new UserProfileAggregator();
      const gate2 = (t: string) =>
        (a2 as unknown as { shouldExtractNow: (t: string, h: boolean) => boolean }).shouldExtractNow(t, false);
      assert.equal(gate2("在吗"), true, "关闭预筛后寒暄也放行");
    });
  } finally {
    if (prev === undefined) delete process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN;
    else process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN = prev;
  }
});

/* ── observeTurn 新签名：highSignal 透传 + 不再落后台队列 ── */

test("observeTurn：新签名（含 highSignal）正常调用且不落后台队列", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-store-"));
  const prevExtract = process.env.MEMORY_PROFILE_EXTRACT_ENABLED;
  try {
    process.env.AGENT_USER_PROFILE_DIR = dir;
    // 关掉每轮抽取（有 key 环境防真实 LLM 调用）；本测只验证无队列副作用
    process.env.MEMORY_PROFILE_EXTRACT_ENABLED = "0";
    const a = new UserProfileAggregator();
    a.observeTurn("actor-x", "我叫周明远", "你好呀", { highSignal: true });
    a.observeTurn("actor-y", "在吗", "在的");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(existsSync(join(dir, "actor-x", "pending-turns.json")), false);
    assert.equal(existsSync(join(dir, "actor-y", "pending-turns.json")), false);
  } finally {
    delete process.env.AGENT_USER_PROFILE_DIR;
    if (prevExtract === undefined) delete process.env.MEMORY_PROFILE_EXTRACT_ENABLED;
    else process.env.MEMORY_PROFILE_EXTRACT_ENABLED = prevExtract;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── deleteAll：隐私闭环级联删除 ── */

test("deleteAll：画像文件 + 附属文件目录整删", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-del-"));
  try {
    process.env.AGENT_USER_PROFILE_DIR = dir;
    const store = new UserProfileStore();
    await store.write("actor-z", "# 用户画像\n- 称呼：测试");
    writeFileSync(join(dir, "actor-z", "profile-lines.json"), "{}", "utf8");
    assert.ok(existsSync(store.profilePath("actor-z")));
    assert.equal(await store.deleteAll("actor-z"), true);
    assert.ok(!existsSync(join(dir, "actor-z")), "目录整删");
    assert.equal(await store.deleteAll("actor-z"), true, "幂等：不存在也返回成功");
  } finally {
    delete process.env.AGENT_USER_PROFILE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
