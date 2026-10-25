/**
 * 记忆污染双向回归（2026-10-23）。
 *
 * 用户现场：「昨天不是对 recap 上下文污染做了处理吗，为什么我的新对话把上次的
 * 对话也算进去了」——排查发现 recap 视图层是干净的，脏的是 **KV 记忆**：
 *
 *   memory_summary =
 *     [11:15] Agent: 提醒已经设好了，一分钟后就会提醒你：该睡觉啦
 *     [15:39] Agent: 你老婆啊，鞠婧祎
 *     [10:10] Agent: [RENDER_HINT:structured] 王哥，照片这次没搜到…
 *
 * 这类行①是逐字对话（不该进 LTM）②带行首时刻但**没有日期**（「锚点只存在
 * 今天」的物理来源）③夹带出口协议残留。本文件锁定两端：
 *   A. 写入侧：ltm-write-gate 必须拦住这类行（新数据不再产生）；
 *   B. 读取侧：注入视图必须剔除存量脏行（老数据即使还在库里也不进上下文）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { gateLtmWrite } from "../src/agentic-memory/ltm-write-gate.js";
import {
  isPollutedMemoryLine,
  sanitizeMemoryLinesForPrompt,
} from "../src/agent/memory-line-hygiene.js";
import { sliceMemoryEntriesToPromptContext } from "../src/agent/prompt-builder.js";

/* ── A. 写入侧：门必须拦住"带时刻的逐字对话"与中文数字提醒回执 ───────── */

test("A1 带行首时刻的角色行一律拒绝（[11:15] Agent: … 事故形态）", () => {
  const cases = [
    "[11:15] Agent: 提醒已经设好了，一分钟后就会提醒你：该睡觉啦",
    "[15:39] Agent: 你老婆啊，鞠婧祎",
    "[17:36] 用户: 四分分钟后提醒我去游泳吧",
    "[10:10] Agent: [RENDER_HINT:structured] > 王哥，照片这次没搜到，图库是空的",
    "[2026/10/08 周四 22:07] 用户: 我好饿",
  ];
  for (const line of cases) {
    const v = gateLtmWrite(line, "kv:summary");
    assert.equal(v.admit, false, `应拒绝：${line}`);
    assert.equal(v.cleaned, "", "拒绝项不得产出清洗文本");
  }
});

test("A2 带 ISO 时间戳 + 角色前缀同样拒绝（摘要块抄回 LTM 的形态）", () => {
  const v = gateLtmWrite(
    "[2026-10-21T02:08:12.663Z] [topic:general] Agent: 知道了，我记一下",
    "kv:summary",
  );
  assert.equal(v.admit, false);
});

test("A3 中文数字的一次性提醒回执拒绝（旧正则只认阿拉伯数字）", () => {
  for (const line of [
    "提醒已经设好了，一分钟后就会提醒你：该睡觉啦",
    "定好了，两分钟后就喊你",
    "半小时后提醒你开会",
  ]) {
    const v = gateLtmWrite(line, "kv:summary");
    assert.equal(v.admit, false, `应拒绝：${line}`);
  }
});

test("A4 真事实行仍放行（带时间标签也放行，标签保留为时间锚）", () => {
  const cases = [
    "[2026-10-20T17:03:29.869Z] [topic:profile] 用户已婚，妻子是刘浩存",
    "[2026-10-21T03:40:48.829Z] [topic:calendar] 用户确认了交付时间为周五下午三点",
    "用户偏好精简直接的回复风格",
  ];
  for (const line of cases) {
    const v = gateLtmWrite(line, "kv:summary");
    assert.equal(v.admit, true, `应放行：${line}`);
    assert.ok(v.cleaned.length > 0);
  }
});

test("A5 用户显式陈述的短事实不被误杀（剥角色前缀后放行）", () => {
  const v = gateLtmWrite("用户: 我住在兴义，做独立开发", "journal");
  assert.equal(v.admit, true);
  assert.equal(v.cleaned, "我住在兴义，做独立开发");
});

/* ── B. 读取侧：注入视图剔除存量脏行 ──────────────────────────────── */

const DIRTY_SUMMARY = [
  "[2026-10-21T02:08:12.663Z] [topic:general] [Agent 承诺/结论] 不知道，我这儿只有你的邮箱，名字真没记过",
  "[11:15] Agent: [RENDER_HINT:structured] 王哥，我这些手段真不少，挑你用得上的说",
  "[15:34] Agent: 提醒已经设好了，一分钟后就会提醒你：**该睡觉啦**",
  "[15:39] Agent: 你老婆啊，鞠婧祎",
  "[17:36] 用户: 四分分钟后提醒我去游泳吧",
  "[2026-10-20T17:03:29.869Z] [topic:profile] 用户已婚，妻子是刘浩存",
].join("\n");

test("B1 单行判定：逐字对话行 / 协议残留命中，事实行不命中", () => {
  assert.equal(isPollutedMemoryLine("[11:15] Agent: 提醒已经设好了"), true);
  assert.equal(isPollutedMemoryLine("[17:36] 用户: 四分分钟后提醒我去游泳吧"), true);
  assert.equal(isPollutedMemoryLine("[10:10] Agent: [RENDER_HINT:structured] x"), true);
  assert.equal(
    isPollutedMemoryLine("[2026-10-20T17:03:29.869Z] [topic:profile] 用户已婚，妻子是刘浩存"),
    false,
  );
  assert.equal(isPollutedMemoryLine("- [2026/10/08 22:07] 用户明说要记住的事"), false, "关键钉行不动");
});

test("B2 块级净化：脏行剔除、事实行原样（含绝对时间标签）", () => {
  const r = sanitizeMemoryLinesForPrompt(DIRTY_SUMMARY);
  assert.ok(r.dropped >= 5, `应剔除 5 行以上，实际 ${r.dropped}`);
  assert.ok(!r.text.includes("该睡觉啦"), "逐字对话不得残留");
  assert.ok(!r.text.includes("鞠婧祎"), "旧对话不得残留");
  assert.ok(!r.text.includes("RENDER_HINT"), "协议残留不得残留");
  assert.ok(r.text.includes("用户已婚，妻子是刘浩存"), "事实行必须保留");
  assert.ok(r.text.includes("2026-10-20T17:03:29.869Z"), "绝对时间标签是锚点，必须保留");
});

test("B3 幂等 + 无命中时字节恒定（护 prefix cache）", () => {
  const clean = "[2026-10-20T17:03:29.869Z] [topic:profile] 用户已婚";
  const first = sanitizeMemoryLinesForPrompt(clean);
  assert.equal(first.text, clean);
  assert.equal(first.dropped, 0);
  assert.equal(first.text === clean, true, "无剔除时应返回同一字符串");

  const once = sanitizeMemoryLinesForPrompt(DIRTY_SUMMARY).text;
  const twice = sanitizeMemoryLinesForPrompt(once).text;
  assert.equal(twice, once, "二次净化字节不变");
});

test("B4 集成：KV memory_summary 注入后不再含旧对话原句", () => {
  const ctx = sliceMemoryEntriesToPromptContext(
    { memory_summary: DIRTY_SUMMARY },
    "帮我看看今天有什么安排",
  );
  const injected = ctx.memorySummary ?? "";
  assert.ok(!injected.includes("该睡觉啦"), `注入视图仍在复述旧对话：\n${injected}`);
  assert.ok(!injected.includes("鞠婧祎"), `注入视图仍在复述旧对话：\n${injected}`);
});

/* ── C. 启动治愈：存量脏行在加载时清掉并落盘 ─────────────────── */

test("C1 AgentMemorySyncService 启动时清理存量污染行并写回", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentMemorySyncService } = await import("../src/services/agent-memory-sync-service.js");

  const dir = mkdtempSync(join(tmpdir(), "memory-heal-"));
  const file = join(dir, "agent-memory-sync.json");
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        "u-1": {
          revision: 3,
          entries: {
            memory_summary: DIRTY_SUMMARY,
            session_recap: "[11:15] Agent: 提醒已经设好了，一分钟后就会提醒你：该睡觉啦",
            memory_facts: "[2026-10-20T17:03:29.869Z] [topic:profile] 用户已婚",
          },
        },
      },
    }),
    "utf8",
  );

  const svc = new AgentMemorySyncService(file);
  await svc.load();
  const snap = svc.getSnapshot("u-1", ["memory_summary", "session_recap", "memory_facts"]);
  const summary = String(snap.entries.memory_summary ?? "");
  assert.ok(!summary.includes("该睡觉啦"), `启动治愈后仍残留逐字对话：\n${summary}`);
  assert.ok(!summary.includes("RENDER_HINT"), "协议残留应清除");
  assert.ok(summary.includes("用户已婚，妻子是刘浩存"), "事实行必须保留");
  assert.equal(String(snap.entries.session_recap ?? ""), "", "全是污染行时应清空");
  assert.ok(String(snap.entries.memory_facts).includes("用户已婚"));

  await svc.flush();
  const onDisk = readFileSync(file, "utf8");
  assert.ok(!onDisk.includes("该睡觉啦"), "治愈结果必须落盘（否则重启又回来）");
  assert.ok(snap.revision > 3, "发生过修复的会话应推进 revision");
});

/* ── D. 客户端同步通道（daily-chat-sync → KV session_recap）────────── */

test("D1 [客户端同步] 角色行（时间标签+标记+角色）被写入门拒绝", () => {
  const cases = [
    "[11:15] [客户端同步] Agent: 提醒已经设好了，一分钟后就会提醒你：该睡觉啦",
    "[21:06] [客户端同步] 用户: 帮我搜几张刘浩存最近的照片",
    "[09:30] [客户端同步] Agent: 来了王哥，图给你捞上来了",
  ];
  for (const line of cases) {
    const v = gateLtmWrite(line, "kv:recap");
    assert.equal(v.admit, false, `应拒绝：${line}`);
  }
});

test("D2 带标记的真实事实行不误伤", () => {
  const v = gateLtmWrite("[2026-10-21T02:08:12.663Z] [topic:profile] 用户在做独立开发", "kv:recap");
  assert.equal(v.admit, true);
  assert.ok(v.cleaned.includes("用户在做独立开发"));
});

/* ── E. 热路径写入（对齐 Mem0 async_mode / LangMem hot path）───────── */

test("E1 热路径只收用户侧原子事实，agent 回执与对话合并行被排除", async () => {
  const { selectHotPathMemoryLines } = await import("../src/agent/memory-signal.js");
  const selected = selectHotPathMemoryLines([
    "[用户事实] 以后叫我王哥",
    "[用户要求记住] 我下周要去成都出差",
    "[Agent 承诺/结论] 不知道，我这儿只有你的邮箱，名字真没记过",
    "用户: 一分钟后提醒我洗漱 | Agent: 定好了",
  ]);
  assert.deepEqual(selected, ["以后叫我王哥", "我下周要去成都出差"]);
});

test("E2 热路径事实行能过写入门且不带内部标记", async () => {
  const { selectHotPathMemoryLines } = await import("../src/agent/memory-signal.js");
  const [fact] = selectHotPathMemoryLines(["[用户事实] 我在做独立开发"]);
  const verdict = gateLtmWrite(fact!, "kv:summary");
  assert.equal(verdict.admit, true);
  assert.equal(verdict.cleaned, "我在做独立开发");
  assert.ok(!verdict.cleaned.includes("用户事实"), "落库行是干净原子事实，不带标记");
});
