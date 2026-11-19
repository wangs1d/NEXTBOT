/**
 * 档案字段单一权威源（profile-fact-authority）回归测试。
 *
 * 锁定四件事：
 *  1) 字段标签/别名归一（称呼 / 用户称呼 / 职业相关 → 标准字段）
 *  2) USER_PROFILE.md 投影：别名去重、清行内历史、保留非字段行、幂等
 *  3) KV 副本识别：显式线索词 + 「我是旧称呼」陈旧值（含历史值）
 *  4) 端到端收敛：画像投影 + 画像 KV 副本同步 + 槽位清理，且第二次无副作用
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalFieldMap,
  gateProfileMarkdownForPrompt,
  isProfileFieldCopyLine,
  parseFieldLine,
  parseRenderedFactBlock,
  profileFieldOfLabel,
  projectProfileMarkdown,
  reconcileProfileFactsFromStores,
  stripProfileFactDuplicateLines,
  upsertManagedProfileLine,
  type ProfileAuthorityDeps,
} from "../src/services/user-personalization/profile-fact-authority.js";

const MD = `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。
> 用户标识：\`u1\`

## 基本信息

- 称呼：王哥；也曾使用“王king”
- 常用语言：中文，口语化
- 职业相关：写代码/程序员，常有加班
- 用户称呼：王哥

## 兴趣与习惯

- 会打游戏，周末常觉得无聊

## 沟通偏好

- 语气风格：温馨亲切（系统根据对话自动调整）
`;

test("A 字段标签归一：别名收敛到标准字段，非档案字段返回空", () => {
  assert.equal(profileFieldOfLabel("称呼"), "称呼");
  assert.equal(profileFieldOfLabel("用户称呼"), "称呼");
  // 2026-11-18 拆分：名字/姓名归「姓名」，称呼只表示希望被怎么叫
  assert.equal(profileFieldOfLabel("名字"), "姓名");
  assert.equal(profileFieldOfLabel("全名"), "姓名");
  assert.equal(profileFieldOfLabel("年龄"), "年龄");
  assert.equal(profileFieldOfLabel("职业相关"), "职业");
  assert.equal(profileFieldOfLabel("居住地（城市）"), "居住地");
  assert.equal(profileFieldOfLabel("常用语言"), "");
  assert.equal(profileFieldOfLabel("回复偏好"), "");
  assert.equal(profileFieldOfLabel("语气风格"), "");
});

test("B parseFieldLine 只认「字段：值」，列表前缀与冒号均可", () => {
  assert.deepEqual(parseFieldLine("- 称呼：王哥"), { label: "称呼", value: "王哥" });
  assert.deepEqual(parseFieldLine("职业: 程序员"), { label: "职业", value: "程序员" });
  assert.equal(parseFieldLine("- 会打游戏，周末常觉得无聊"), null);
});

test("B2 画像注入门控：身份字段只跟本轮权威块，非身份行原样保留", () => {
  const md = `# 用户画像

## 基本信息

- 称呼：大哥
- 姓名：王铭川
- 年龄：20岁
- 居住地：贵州兴义下午屯九华苑

## 兴趣与习惯

- 喜欢刘浩存

## 沟通偏好

- 回复偏好：精简直接
`;
  const out = gateProfileMarkdownForPrompt(md, {
    injectedFactFields: new Set(["称呼"]),
  })!;
  assert.ok(out.includes("- 称呼：大哥"), "本轮注入的身份字段保留");
  assert.ok(!out.includes("姓名"), "未注入的身份字段不进 prompt");
  assert.ok(!out.includes("年龄"), "未注入的身份字段不进 prompt");
  assert.ok(!out.includes("居住地"), "未注入的身份字段不进 prompt");
  assert.ok(out.includes("喜欢刘浩存"), "兴趣行是风格背景，原样保留");
  assert.ok(out.includes("回复偏好"), "沟通偏好不是身份字段，原样保留");
});

test("B3 门控后空 section 连标题一起丢弃", () => {
  const md = "## 基本信息\n\n- 姓名：王铭川\n\n## 沟通偏好\n\n- 回复偏好：精简\n";
  const out = gateProfileMarkdownForPrompt(md, {
    injectedFactFields: new Set<string>(),
  })!;
  assert.ok(!out.includes("基本信息"), "身份字段全被门控掉后 section 标题也应消失");
  assert.ok(out.includes("沟通偏好"), "仍有内容的 section 保留");
});

test("B4 画像门控：传 query 时自由文本也按相关性过滤", () => {
  const out = gateProfileMarkdownForPrompt(MD, {
    injectedFactFields: new Set(["称呼"]),
    query: "我几岁",
  })!;
  assert.ok(out.includes("- 称呼：王哥"), "本轮注入的身份字段保留");
  assert.ok(!out.includes("常用语言"), "无关自由文本不注入");
  assert.ok(!out.includes("会打游戏"), "无关兴趣行不注入");
  assert.ok(!out.includes("语气风格"), "无关沟通偏好不注入");
  assert.ok(out.includes("王哥；也曾使用"), "身份字段行原样保留（去重交给投影层）");
});

test("C 投影：别名行合并为一行权威行，清掉行内历史注解，保留非字段行", () => {
  const out = projectProfileMarkdown(MD, [{ field: "称呼", value: "王哥" }]);
  assert.ok(out.includes("- 称呼：王哥\n"), "应有唯一的权威称呼行");
  assert.ok(!out.includes("也曾使用"), "行内历史注解应被清掉");
  assert.ok(!out.includes("用户称呼"), "别名重复行应被合并");
  assert.ok(out.includes("- 常用语言：中文，口语化"), "非档案字段行应保留");
  assert.ok(out.includes("- 职业相关：写代码/程序员，常有加班"), "无权威值的字段行应原样保留");
  assert.ok(out.includes("- 会打游戏，周末常觉得无聊"), "其它 section 不受影响");
  // 称呼行只出现一次
  assert.equal(out.split("称呼：王哥").length - 1, 1);
});

test("D 投影幂等 + 空权威库零注入", () => {
  const once = projectProfileMarkdown(MD, [{ field: "称呼", value: "王哥" }]);
  const twice = projectProfileMarkdown(once, [{ field: "称呼", value: "王哥" }]);
  assert.equal(twice, once, "二次投影必须不再变化");
  assert.equal(projectProfileMarkdown(MD, []), MD, "无权威值时不改画像");
});

test("E 投影：权威库有值但画像缺该行时补齐", () => {
  const noField = `# 用户画像\n\n## 基本信息\n\n- 常用语言：中文\n\n## 备注\n`;
  const out = projectProfileMarkdown(noField, [{ field: "称呼", value: "王哥" }]);
  assert.ok(out.includes("- 称呼：王哥"));
  assert.ok(out.includes("- 常用语言：中文"));
});

test("F KV 副本识别：显式线索词 / 陈旧值自称 / 自由描述不误伤", () => {
  const fields = new Set(["称呼"]);
  const known = new Map<string, readonly string[]>([["称呼", ["王哥", "王king"]]]);
  assert.equal(isProfileFieldCopyLine("[t] [topic:profile] 我喜欢被称呼为「王哥」", fields, known), true);
  assert.equal(isProfileFieldCopyLine("[t] [topic:profile] 我是王哥", fields, known), true);
  assert.equal(isProfileFieldCopyLine("[t] [topic:profile] 我是王king", fields, known), true, "旧值自称也应识别");
  assert.equal(isProfileFieldCopyLine("[t] [topic:profile] 我是程序员", fields, known), false, "职业自称不是称呼副本");
  assert.equal(isProfileFieldCopyLine("[t] [topic:habit] 工作节奏偏忙，加班到很晚才吃饭是常态", fields, known), false);
  assert.equal(isProfileFieldCopyLine("[t] [topic:x] 我喜欢刘浩存，把她当老婆", fields, known), false);
});

/* ── 端到端收敛（内存假依赖）── */

function memoryDeps(md: string, entries: Record<string, unknown>) {
  const state = { md, entries: { ...entries } };
  const deps: ProfileAuthorityDeps = {
    profileStore: {
      read: async () => state.md,
      write: async (_a, content) => {
        state.md = content.trim();
      },
    },
    factStore: {
      getActiveFacts: () => [{ field: "称呼", value: "王哥" }],
      getAllValuesForField: () => ["王哥", "王king"],
    },
    memorySync: {
      getSnapshot: (_a, keys) => ({
        revision: 1,
        entries: Object.fromEntries(
          (keys ?? Object.keys(state.entries)).map((k) => [k, state.entries[k]]),
        ),
      }),
      setEntry: (_a, key, value) => {
        state.entries[key] = value;
      },
    },
  };
  return { state, deps };
}

test("I 端到端收敛：画像投影 + 存量 KV 画像全文副本作废", async () => {
  const { state, deps } = memoryDeps(MD, {
    user_profile: "旧画像全文（未投影）",
  });

  const report = await reconcileProfileFactsFromStores("u1", deps);
  assert.equal(report.profileChanged, true, "画像应被投影");
  // 2026-11-12：画像不再写 KV 副本（权威 = USER_PROFILE.md）
  assert.equal(report.profileKvSynced, false, "不得再同步画像 KV 副本");
  assert.equal(report.legacyProfileKvCleared, true, "存量 KV 副本应被作废");
  assert.deepEqual(report.fields, { 称呼: "王哥" });

  assert.ok(state.md.includes("- 称呼：王哥"));
  assert.ok(!state.md.includes("用户称呼"));
  assert.equal(state.entries["user_profile"], "", "KV 画像副本必须被清空（读取走 md）");
});

test("J 端到端收敛幂等：第二次调用零副作用", async () => {
  const { state, deps } = memoryDeps(MD, {
    user_profile: "旧画像全文",
  });
  await reconcileProfileFactsFromStores("u1", deps);
  const snapshot = JSON.stringify(state);
  const second = await reconcileProfileFactsFromStores("u1", deps);
  assert.equal(second.profileChanged, false);
  assert.equal(second.profileKvSynced, false);
  assert.equal(second.legacyProfileKvCleared, false, "副本已清空，第二次不应再写");
  assert.equal(JSON.stringify(state), snapshot, "收敛必须是幂等变换");
});

test("K canonicalFieldMap：忽略非档案字段与空值", () => {
  const map = canonicalFieldMap([
    { field: "称呼", value: "王哥" },
    { field: "常用语言", value: "中文" },
    { field: "职业", value: "  " },
    { field: "名字", value: "王铭川" },
  ]);
  assert.deepEqual([...map.entries()], [
    ["称呼", "王哥"],
    ["姓名", "王铭川"],
  ]);
});

/* ─────────────────────────── 画像去重（prompt 渲染层） ─────────────────────────── */

/**
 * 2026-11-13：画像正文的档案字段行只允许在「结构化事实块**确实渲染了同一个
 * 字段**」时剔除。
 *
 * 起因是「称呼：王哥 剔掉了」的质疑——称呼是每轮都要用的字段，一旦在结构化
 * 块按需注入被截断的边界上被误删，这一轮 Agent 就完全不知道该怎么称呼用户。
 * 因此判据从「本轮白名单里有这个字段」改成「另一块真的渲染了这个字段」。
 */
test("L 画像去重：结构化块渲染了同一字段才剔除（称呼不再被误删）", () => {
  const profile = [
    "## 基本信息",
    "",
    "- 称呼：王哥",
    "- 职业：后端开发",
    "- 居住地：兴义",
  ].join("\n");
  const rendered = [
    "【用户档案·结构化事实】",
    "- 称呼：王哥（11/13 记录）",
  ].join("\n");

  const out = stripProfileFactDuplicateLines(profile, rendered);
  assert.equal(out.removed, 1, "只剔除已确认的重复行（称呼）");
  assert.equal(out.staleRemoved, 0);
  assert.ok(!out.text.includes("- 称呼：王哥"), "确认重复的称呼行应剔除");
  assert.ok(out.text.includes("- 职业：后端开发"), "未渲染的字段必须保留");
  assert.ok(out.text.includes("- 居住地：兴义"), "未渲染的字段必须保留");
});

test("M 画像去重：结构化块没渲染该字段时，一个字都不删（称呼不丢）", () => {
  const profile = "## 基本信息\n\n- 称呼：王哥\n- 居住地：兴义";
  // 结构化块里没有称呼（例：字段数超限被截断 / 渲染失败）
  const rendered = "【用户档案·结构化事实】\n- 居住地：兴义（11/13 记录）";

  const out = stripProfileFactDuplicateLines(profile, rendered);
  assert.equal(out.removed, 1, "只剔除确认渲染的居住地");
  assert.ok(out.text.includes("- 称呼：王哥"), "称呼未被结构化块渲染 → 必须保留");
});

test("N 画像去重：结构化块整体缺失时零删除", () => {
  const profile = "## 基本信息\n\n- 称呼：王哥";
  for (const rendered of [undefined, null, "", "【用户档案·结构化事实】\n（无事实）"]) {
    const out = stripProfileFactDuplicateLines(profile, rendered);
    assert.equal(out.removed, 0);
    assert.equal(out.text, profile);
  }
});

test("O 画像去重：画像是陈旧值时按权威值剔除（同一字段不留两个值）", () => {
  const profile = "## 基本信息\n\n- 称呼：老王";
  const rendered = "【用户档案·结构化事实】\n- 称呼：王哥（11/13 记录）";
  const out = stripProfileFactDuplicateLines(profile, rendered);
  assert.equal(out.removed, 1);
  assert.equal(out.staleRemoved, 1, "陈旧副本要单独计数");
  assert.ok(!out.text.includes("老王"), "陈旧称呼不得留在 prompt 里与权威值打架");
});

test("P 画像去重：〔历史〕/〔计划〕形态不算当前值，画像行保留", () => {
  const rendered = [
    "【用户档案·结构化事实】",
    "- 居住地：〔历史〕杭州（2024-05；当前未知）",
    "- 居住地：〔计划〕广州（12/01 起；尚未发生）",
  ].join("\n");
  const parsed = parseRenderedFactBlock(rendered);
  assert.equal(parsed.has("居住地"), false, "历史/计划不是现状，不能当副本判据");

  const profile = "## 基本信息\n\n- 居住地：杭州";
  const out = stripProfileFactDuplicateLines(profile, rendered);
  assert.equal(out.removed, 0, "没有当前值可比对 → 保留");
  assert.ok(out.text.includes("- 居住地：杭州"));
});

test("R 受管行：常去地点写入/更新/删除幂等（落点兴趣与习惯）", () => {
  const base = "# 用户画像\n\n## 兴趣与习惯\n\n- 喜欢黑胶\n\n## 备注\n\n- 其他\n";
  const line = "常去地点：望京科技园、九华苑";

  const added = upsertManagedProfileLine(base, "常去地点", line);
  assert.ok(added.includes("- 常去地点：望京科技园、九华苑"));
  assert.ok(added.indexOf("常去地点") > added.indexOf("喜欢黑胶"), "追加在 section 末尾");
  assert.equal(upsertManagedProfileLine(added, "常去地点", line), added, "重复写入必须幂等");

  const updated = upsertManagedProfileLine(added, "常去地点", "常去地点：望京科技园");
  assert.ok(updated.includes("- 常去地点：望京科技园"));
  assert.ok(!updated.includes("九华苑"), "更新必须整行替换，不残留旧地点");

  const removed = upsertManagedProfileLine(updated, "常去地点", null);
  assert.ok(!removed.includes("常去地点"), "数据清空后画像不留旧地点");
  assert.ok(removed.includes("- 喜欢黑胶"), "其它画像行不受影响");
});

test("S 画像门控：常去地点行只在 query 相关时注入", () => {
  const md = "# 用户画像\n\n## 兴趣与习惯\n\n- 常去地点：望京科技园、九华苑\n";
  const unrelated = gateProfileMarkdownForPrompt(md, {
    injectedFactFields: new Set(["称呼"]),
    query: "帮我写个周报",
  });
  assert.ok(!unrelated?.includes("常去地点"), "无关提问不应带出地点行");

  const related = gateProfileMarkdownForPrompt(md, {
    injectedFactFields: new Set(["称呼"]),
    query: "我常去哪些地方",
  });
  assert.ok(related?.includes("常去地点"), "相关提问应召回地点行");
});

test("Q parseRenderedFactBlock：只认当前值形态，取括号前的值", () => {
  const parsed = parseRenderedFactBlock(
    [
      "【用户档案·结构化事实】",
      "- 称呼：王哥（11/13 记录）（此前：老王，2024-01）",
      "- 职业：后端开发（11/02 记录，事发 11/01）",
      "- 居住地：〔历史〕杭州（2024-05；当前未知）",
      "（以下为用户确定信息的精确记录……）",
    ].join("\n"),
  );
  assert.equal(parsed.get("称呼"), "王哥");
  assert.equal(parsed.get("职业"), "后端开发");
  assert.equal(parsed.has("居住地"), false);
});
