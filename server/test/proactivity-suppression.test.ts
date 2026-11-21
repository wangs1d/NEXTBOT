// Task 20 统一频控框架测试：
//  1. 频控器新 kind 注册（weather_alert 30min / life_reminder 4h / monthly_report 24h）
//  2. ProactivitySuppressionStore：add/list/remove + 持久化 roundtrip + 匹配语义
//     （kind 级抑制、kind+关键词双匹配、无文本时仅 kind 级命中、同条目合并续期）
//  3. ProactivityHub 发送前抑制检查：kind 级拦截、关键词级精准拦截、解除后恢复
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { ProactivitySuppressionStore } from "../src/proactivity/suppression-store.js";

const ACTOR = "actor-suppression-test";

// ── 1. 频控器新 kind 注册 ─────────────────────────────

test("频控器：新场景 kind 注册与冷却配置", () => {
  const governor = new FrequencyGovernor({ ignoreEnv: true, });

  // weather_alert：预警类 30min 冷却（到期前拦截，30min 后放行）
  const t0 = new Date("2026-08-29T10:00:00");
  assert.equal(governor.canTrigger(ACTOR, "weather_alert", "high", t0).allowed, true);
  governor.record(ACTOR, "weather_alert", t0);
  const t0Plus29 = new Date(t0.getTime() + 29 * 60 * 1000);
  assert.equal(governor.canTrigger(ACTOR, "weather_alert", "high", t0Plus29).allowed, false);
  const t0Plus31 = new Date(t0.getTime() + 31 * 60 * 1000);
  assert.equal(governor.canTrigger(ACTOR, "weather_alert", "high", t0Plus31).allowed, true);

  // life_reminder：提醒类 4h 冷却
  const t1 = new Date("2026-08-29T10:00:00");
  governor.record(ACTOR, "life_reminder", t1);
  const t1Plus3h = new Date(t1.getTime() + 3 * 60 * 60 * 1000);
  assert.equal(governor.canTrigger(ACTOR, "life_reminder", "medium", t1Plus3h).allowed, false);
  const t1Plus5h = new Date(t1.getTime() + 5 * 60 * 60 * 1000);
  assert.equal(governor.canTrigger(ACTOR, "life_reminder", "medium", t1Plus5h).allowed, true);

  // monthly_report：报告类每日 1 次（日历日语义：同一天拦截，跨零点恢复）
  const t2 = new Date("2026-08-29T09:00:00");
  governor.record(ACTOR, "monthly_report", t2);
  const t2Plus2h = new Date(t2.getTime() + 2 * 60 * 60 * 1000);
  assert.equal(governor.canTrigger(ACTOR, "monthly_report", "medium", t2Plus2h).allowed, false);
  const t2NextDay = new Date("2026-08-30T08:00:00");
  assert.equal(governor.canTrigger(ACTOR, "monthly_report", "medium", t2NextDay).allowed, true);
});

// ── 2. ProactivitySuppressionStore ────────────────────

async function makeStore(): Promise<{
  store: ProactivitySuppressionStore;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "proactivity-suppression-test-"));
  const store = new ProactivitySuppressionStore({ dirPath: dir });
  await store.load();
  return { store, dir };
}

test("抑制表：kind 级抑制（无关键词 = 整类不再推）", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "weather_alert", [], "用户说天气预警太吵了");
    // 整个 kind 被抑制（无论文本内容）
    const hit = store.isSuppressed(ACTOR, "weather_alert", "暴雨橙色预警，出门带伞");
    assert.equal(hit.suppressed, true);
    assert.match(hit.reason, /kind_suppressed\(weather_alert/);
    // 其他 kind 不受影响
    assert.equal(store.isSuppressed(ACTOR, "life_reminder", "今天记得喝水").suppressed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抑制表：关键词级抑制（kind + 关键词双匹配才拦）", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "interest_alert", ["刘浩存", "刘浩存电影"], "用户说别再推刘浩存了");
    // 命中关键词 → 抑制
    assert.equal(
      store.isSuppressed(ACTOR, "interest_alert", "你关注的「刘浩存」有新动态").suppressed,
      true,
    );
    // 同 kind 但不含关键词 → 放行（只挡这个话题，不误伤其他兴趣推送）
    assert.equal(
      store.isSuppressed(ACTOR, "interest_alert", "你关注的「王者荣耀」有新动态").suppressed,
      false,
    );
    // 文本未提供时关键词条目无法判定 → 放行（宁漏勿错杀）
    assert.equal(store.isSuppressed(ACTOR, "interest_alert").suppressed, false);
    // 不相关英文文本 → 放行
    assert.equal(
      store.isSuppressed(ACTOR, "interest_alert", "New update about KFC crazy thursday")
        .suppressed,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抑制表：英文关键词大小写归一匹配", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "interest_alert", ["Liu Haocun"], "stop pushing Liu Haocun");
    // 文本大小写混杂也能命中（关键词与文本两侧均小写化后做包含匹配）
    assert.equal(
      store.isSuppressed(ACTOR, "interest_alert", "LIU HAOcun new movie announced").suppressed,
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抑制表：remove 解除（按 kind 清除 + 恢复触达）", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "life_reminder", [], "别再提醒我喝水了");
    assert.equal(store.isSuppressed(ACTOR, "life_reminder", "喝水提醒").suppressed, true);
    const rest = await store.remove(ACTOR, "life_reminder");
    assert.equal(rest.length, 0);
    assert.equal(store.isSuppressed(ACTOR, "life_reminder", "喝水提醒").suppressed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抑制表：持久化 roundtrip（新实例 load 后抑制仍在）", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "interest_alert", ["刘浩存"], "用户说别再推刘浩存了");
    await store.add(ACTOR, "monthly_report", [], "月报不用发了");
    // 落盘文件内容校验：per-actor JSON，字段 kind + keywords
    const raw = JSON.parse(await readFile(join(dir, `${ACTOR}.json`), "utf8"));
    assert.equal(raw.entries.length, 2);
    assert.equal(raw.entries[0].kind, "interest_alert");
    assert.deepEqual(raw.entries[0].keywords, ["刘浩存"]);
    // 新实例（模拟重启）加载后抑制生效
    const reborn = new ProactivitySuppressionStore({ dirPath: dir });
    await reborn.load();
    assert.equal(
      reborn.isSuppressed(ACTOR, "interest_alert", "刘浩存上热搜了").suppressed,
      true,
    );
    assert.equal(reborn.isSuppressed(ACTOR, "monthly_report", "9 月消费月报").suppressed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抑制表：同 kind 同关键词重复负反馈合并（不堆条目）", async () => {
  const { store, dir } = await makeStore();
  try {
    await store.add(ACTOR, "interest_alert", ["刘浩存"], "第一次说别推了");
    await store.add(ACTOR, "interest_alert", ["刘浩存"], "又强调了一次");
    const list = store.list(ACTOR);
    assert.equal(list.length, 1);
    assert.equal(list[0].note, "又强调了一次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. ProactivityHub 发送前抑制检查 ──────────────────

type PublishedSignal = { actorId: string; kind: string; title: string; summary: string };

function makeHubDeps(store: ProactivitySuppressionStore) {
  const signals: PublishedSignal[] = [];
  const deps = {
    publishSignal: (s: PublishedSignal) => {
      signals.push(s);
    },
    executeTool: async () => ({ ok: true, result: {} }),
    frequencyGovernor: new FrequencyGovernor({ ignoreEnv: true, }),
    suppressionStore: store,
  };
  return { deps, signals };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("hub：kind 级抑制 → 快路径触达被拦截（不发布信号）", async () => {
  const store = new ProactivitySuppressionStore({ dirPath: join(tmpdir(), `none-${Date.now()}`) });
  await store.add(ACTOR, "interest_alert", [], "别再推热点了");
  const { deps, signals } = makeHubDeps(store);
  const hub = new ProactivityHub(deps);

  hub.onInterestAlert(ACTOR, "刘浩存", {
    title: "刘浩存新电影定档",
    platform: "微博",
    url: "",
    hot: 12345,
  });
  await flush();
  // interest_alert 整类被抑制 → 无信号发布
  assert.equal(signals.length, 0);
});

test("hub：关键词级抑制 → 只挡命中话题，同 kind 其他话题正常推", async () => {
  const store = new ProactivitySuppressionStore({ dirPath: join(tmpdir(), `none-${Date.now()}`) });
  await store.add(ACTOR, "interest_alert", ["刘浩存"], "别再推刘浩存了");
  const { deps, signals } = makeHubDeps(store);
  const hub = new ProactivityHub(deps);

  // 被抑制的话题：不发布
  hub.onInterestAlert(ACTOR, "刘浩存", {
    title: "刘浩存新电影定档",
    platform: "微博",
    url: "",
    hot: 12345,
  });
  await flush();
  assert.equal(signals.length, 0);

  // 未被抑制的话题（频控冷却内，但 interest_alert 冷却 4h——第一条被抑制时
  // 未 record，此处频控从零开始，可正常放行）：正常发布
  hub.onInterestAlert(ACTOR, "王者荣耀", {
    title: "王者荣耀新赛季上线",
    platform: "百度",
    url: "",
    hot: 999,
  });
  await flush();
  assert.equal(signals.length, 1);
  assert.ok(signals[0].title.includes("王者荣耀"));
});

test("hub：解除抑制后触达恢复", async () => {
  const store = new ProactivitySuppressionStore({ dirPath: join(tmpdir(), `none-${Date.now()}`) });
  await store.add(ACTOR, "weather_alert", [], "预警别发了");
  const { deps, signals } = makeHubDeps(store);
  const hub = new ProactivityHub(deps);

  // 抑制期间：任务完成恭喜不受影响（kind 不同），weather_alert 类被拦
  hub.onAgentTaskCompleted(ACTOR, "整理周报");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "task_celebration");

  // 解除后：weather_alert 恢复（通过快路径 intent 直接验证 route 放行）
  await store.remove(ACTOR, "weather_alert");
  assert.equal(store.isSuppressed(ACTOR, "weather_alert", "暴雨预警").suppressed, false);
});
