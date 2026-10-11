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
  cleanProfileFieldCopiesFromSlot,
  filterUserFactLikeEntries,
  isProfileFieldCopyLine,
  parseFieldLine,
  profileFieldOfLabel,
  projectProfileMarkdown,
  reconcileProfileFactsFromStores,
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
  assert.equal(profileFieldOfLabel("名字"), "称呼");
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

test("G KV 槽位清理：剔除副本 + 归并重复行，其余原样保留", () => {
  const raw = [
    "[t] [topic:profile] 我喜欢被称呼「王哥」",
    "[t] [topic:profile] 我喜欢被称呼为王哥",
    "[t] [topic:profile] 我喜欢刘浩存，把她当老婆",
  ].join("\n");
  const r = cleanProfileFieldCopiesFromSlot(raw, new Set(["称呼"]), new Map([["称呼", ["王哥"]]]));
  assert.equal(r.removed, 2);
  assert.equal(r.value, "[t] [topic:profile] 我喜欢刘浩存，把她当老婆");
  assert.equal(r.changed, true);
  // 无副本时不产生变更
  const clean = cleanProfileFieldCopiesFromSlot(r.value, new Set(["称呼"]), new Map([["称呼", ["王哥"]]]));
  assert.equal(clean.changed, false);
});

test("H 行式事实库清理：剔除称呼副本与重复项", () => {
  const facts = [
    { kind: "preference", subject: "刘浩存", value: "我喜欢刘浩存，把她当老婆" },
    { kind: "fact", subject: "身份", value: "我是王哥" },
    { kind: "preference", subject: "被称呼为王哥", value: "我喜欢被称呼为王哥" },
    { kind: "preference", subject: "被称呼为「王哥」", value: "我喜欢被称呼为「王哥」" },
  ];
  const { kept, removed } = filterUserFactLikeEntries(
    facts,
    new Set(["称呼"]),
    new Map([["称呼", ["王哥"]]]),
  );
  assert.equal(removed, 3);
  assert.deepEqual(
    kept.map((f) => f.value),
    ["我喜欢刘浩存，把她当老婆"],
  );
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

test("I 端到端收敛：画像投影 + 画像 KV 副本同步 + 槽位清理", async () => {
  const { state, deps } = memoryDeps(MD, {
    user_profile: "旧画像全文（未投影）",
    memory_facts: "[t] [topic:profile] 我是王king",
    memory_preferences: "[t] [topic:profile] 我喜欢被称呼为王哥\n[t] [topic:like] 我喜欢刘浩存，把她当老婆",
  });

  const report = await reconcileProfileFactsFromStores("u1", deps);
  assert.equal(report.profileChanged, true, "画像应被投影");
  assert.equal(report.profileKvSynced, true, "画像 KV 副本应同步");
  assert.equal(report.kvRemoved, 2, "应清掉 2 行档案字段副本");
  assert.deepEqual(report.fields, { 称呼: "王哥" });

  assert.ok(state.md.includes("- 称呼：王哥"));
  assert.ok(!state.md.includes("用户称呼"));
  assert.equal(state.entries["user_profile"], state.md, "KV 画像副本必须与磁盘一致");
  assert.equal(state.entries["memory_facts"], "", "陈旧自称行应被清除（槽位置空）");
  assert.equal(state.entries["memory_preferences"], "[t] [topic:like] 我喜欢刘浩存，把她当老婆");
});

test("J 端到端收敛幂等：第二次调用零副作用", async () => {
  const { state, deps } = memoryDeps(MD, {
    user_profile: "旧画像全文",
    memory_facts: "[t] [topic:profile] 我是王king",
    memory_preferences: "",
  });
  await reconcileProfileFactsFromStores("u1", deps);
  const snapshot = JSON.stringify(state);
  const second = await reconcileProfileFactsFromStores("u1", deps);
  assert.equal(second.profileChanged, false);
  assert.equal(second.profileKvSynced, false);
  assert.equal(second.kvRemoved, 0);
  assert.equal(JSON.stringify(state), snapshot, "收敛必须是幂等变换");
});

test("K canonicalFieldMap：忽略非档案字段与空值", () => {
  const map = canonicalFieldMap([
    { field: "称呼", value: "王哥" },
    { field: "常用语言", value: "中文" },
    { field: "职业", value: "  " },
    { field: "名字", value: "王铭川" },
  ]);
  assert.deepEqual([...map.entries()], [["称呼", "王哥"]]);
});
