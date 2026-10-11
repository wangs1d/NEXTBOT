// 时效准入闸（temporal-admission）单测 + ProactivityHub 集成测（2026-10-09）
//
// 覆盖「旧事被当现事主动提起」的准入侧防线：
//   在途放行（默认无行为变化）→ 超保质期拦截 → 相关闸 → 冷启动/长期静默 → 复活配额
// 以及：延迟投递源（turn_aside_expiry）相关闸豁免、环境开关、hub 沉默日志留痕。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TemporalAdmissionGate,
  formatAdmissionEvidence,
  isTemporalAdmissionEnabled,
  sharesTopic,
  topicTokens,
} from "../src/proactivity/temporal-admission.js";
import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { SilenceLog } from "../src/proactivity/silence-log.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const NOW = Date.parse("2026-10-09T21:40:00+08:00");
const HOUR = 60 * 60_000;

function gate(opts?: { revivalDailyCap?: number; longSilenceMs?: number }) {
  return new TemporalAdmissionGate({
    nowFn: () => NOW,
    ignoreEnv: true,
    revivalDailyCap: opts?.revivalDailyCap ?? 1,
    longSilenceMs: opts?.longSilenceMs ?? 12 * HOUR,
  });
}

function followupIntent(overrides: Partial<ProactiveIntent> = {}): ProactiveIntent {
  return {
    actorId: "u1",
    kind: "followup",
    importance: "medium",
    title: "用户有等待跟进或待办事项，值得主动承接",
    summary: "用户原话：晚上要交周报，还没写完",
    mode: "speak",
    source: "conversation",
    ...overrides,
  };
}

// ── 分词 / 相关度 ─────────────────────────────────────

test("topicTokens：中文 2-gram + 拉丁词，结构停用词被过滤", () => {
  const t = topicTokens("用户表示想订一张去兴义的机票 flight-2026");
  assert.ok(t.has("兴义"), "地名 2-gram 保留");
  assert.ok(t.has("机票"), "名词 2-gram 保留");
  assert.ok(t.has("flight-2026"), "拉丁词保留");
  assert.ok(!t.has("用户"), "停用 bigram 被过滤");
});

test("sharesTopic：命中任一话题词元即相关；无交集即不相关", () => {
  assert.equal(sharesTopic("晚上要交周报", "周报还没写完，得加班"), true);
  assert.equal(sharesTopic("晚上要交周报", "今天天气不错，出去走走"), false);
  assert.equal(sharesTopic("", "今天天气不错"), false, "空文本不算相关");
});

// ── 阶梯 0：在途放行（默认无行为变化）────────────────────

test("准入：未打 originAt 的意图视为新鲜事件，直接放行（既有触发源行为不变）", () => {
  const v = gate().evaluate(followupIntent(), { lastInteractionAt: NOW });
  assert.equal(v.admitted, true);
  assert.match(v.reason, /^in_flight/);
  assert.equal(v.revived, false);
  assert.equal(formatAdmissionEvidence(v), `admission=${v.reason}`);
});

test("准入：年龄在 kind 在途窗口内（followup 2.5h）仍放行", () => {
  const v = gate().evaluate(followupIntent({ originAt: NOW - 1 * HOUR }), { lastInteractionAt: NOW });
  assert.equal(v.admitted, true);
  assert.equal(v.revived, false);
});

// ── 阶梯 1：保质期 ────────────────────────────────────

test("准入：超过 kind 保质期（followup 24h）永不复活", () => {
  const v = gate().evaluate(followupIntent({ originAt: NOW - 25 * HOUR }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: NOW,
  });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /^stale_topic/);
  assert.equal(v.revived, true);
});

// ── 阶梯 2/3：相关闸 ──────────────────────────────────

test("准入：越窗 + 无活跃话题 → no_active_topic（后台扫描不翻旧账）", () => {
  const v = gate().evaluate(followupIntent({ originAt: NOW - 3 * HOUR }), {
    currentUserText: "",
    lastInteractionAt: NOW,
  });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /^no_active_topic/);
});

test("准入：越窗 + 当前话题不搭 → irrelevant_to_active_topic（好饿事故家族）", () => {
  const v = gate().evaluate(
    followupIntent({ originAt: NOW - 3 * HOUR, summary: "用户原话：还没决定今晚吃什么，好饿" }),
    { currentUserText: "周末的事情就先不管了", lastInteractionAt: NOW },
  );
  assert.equal(v.admitted, false);
  assert.match(v.reason, /^irrelevant_to_active_topic/);
});

test("准入：越窗但与当前话题相关 → 放行并记为复活投递", () => {
  const v = gate().evaluate(followupIntent({ originAt: NOW - 3 * HOUR }), {
    currentUserText: "周报还差一点点，今晚得加把劲",
    lastInteractionAt: NOW,
  });
  assert.equal(v.admitted, true);
  assert.match(v.reason, /^revived_admitted/);
  assert.equal(v.revived, true);
});

test("准入：延迟投递源（turn_aside_expiry）豁免相关闸，用户沉默也能升级送达", () => {
  const g = gate();
  const v = g.evaluate(followupIntent({ originAt: NOW - 4 * HOUR, source: "turn_aside_expiry" }), {
    lastInteractionAt: NOW - 1 * HOUR,
  });
  assert.equal(v.admitted, true, "延迟投递源不因无活跃话题被拦");
});

// ── 阶梯 4/5：冷启动与长期静默 ────────────────────────

test("准入：从未交互过的用户不主动复活旧话题", () => {
  const v = gate().evaluate(followupIntent({ originAt: NOW - 3 * HOUR }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: null,
  });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /^cold_start_no_history/);
});

test("准入：久未互动（>12h）时非 high 的旧话题不复活，high 仍可", () => {
  const g = gate();
  const medium = g.evaluate(followupIntent({ originAt: NOW - 3 * HOUR }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: NOW - 13 * HOUR,
  });
  assert.equal(medium.admitted, false);
  assert.match(medium.reason, /^long_silence_guard/);

  const high = g.evaluate(followupIntent({ originAt: NOW - 3 * HOUR, importance: "high" }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: NOW - 13 * HOUR,
  });
  assert.equal(high.admitted, true);
});

// ── 阶梯 6：复活配额 ──────────────────────────────────

test("准入：当日复活旧话题额度（默认 1）用尽后拦截", () => {
  const g = gate({ revivalDailyCap: 1 });
  const first = g.evaluate(followupIntent({ originAt: NOW - 3 * HOUR }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: NOW,
  });
  assert.equal(first.admitted, true);
  assert.equal(g.revivalUsed("u1"), 1);

  const second = g.evaluate(followupIntent({ originAt: NOW - 4 * HOUR }), {
    currentUserText: "周报还没写完",
    lastInteractionAt: NOW,
  });
  assert.equal(second.admitted, false);
  assert.match(second.reason, /^revival_quota_exhausted/);
});

// ── 环境开关 ─────────────────────────────────────────

test("环境开关：PROACTIVITY_TEMPORAL_ADMISSION=0 可回滚", () => {
  const before = process.env.PROACTIVITY_TEMPORAL_ADMISSION;
  try {
    delete process.env.PROACTIVITY_TEMPORAL_ADMISSION;
    assert.equal(isTemporalAdmissionEnabled(), true, "默认开启");
    process.env.PROACTIVITY_TEMPORAL_ADMISSION = "0";
    assert.equal(isTemporalAdmissionEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.PROACTIVITY_TEMPORAL_ADMISSION;
    else process.env.PROACTIVITY_TEMPORAL_ADMISSION = before;
  }
});

// ── hub 集成：准入拦截写沉默日志（可复盘）──────────────

const flush = () => new Promise((r) => setTimeout(r, 20));

type Signal = { actorId: string; kind: string; title: string; summary: string; evidence: string[] };

function makeHub() {
  const signals: Signal[] = [];
  const silenceLog = new SilenceLog();
  const hub = new ProactivityHub({
    publishSignal: (s) => signals.push(s as Signal),
    executeTool: async () => ({ ok: true, result: {} }),
    frequencyGovernor: new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true }),
    silenceLog,
  });
  return { hub, signals, silenceLog };
}

test("hub：越窗旧话题与当前话题不搭 → 不投递且沉默日志留痕 scope=admission", async () => {
  const { hub, signals, silenceLog } = makeHub();
  hub.observeConversationTurn("u1", "今天天气不错，出去走走");
  hub.submitIntent(
    followupIntent({ originAt: Date.now() - 3 * HOUR, summary: "用户原话：还没决定今晚吃什么，好饿" }),
  );
  await flush();
  assert.equal(signals.length, 0, "旧且不搭的话题不投递");
  const admission = silenceLog.search({ actorId: "u1" }).filter((e) => e.scope === "admission");
  assert.equal(admission.length, 1, "准入拦截写入沉默日志（可回答『为什么没提』）");
  assert.match(admission[0]!.reason, /^irrelevant_to_active_topic/);
});

test("hub：新鲜事件与已打 originAt 的即时意图照常投递", async () => {
  const { hub, signals } = makeHub();
  hub.observeConversationTurn("u1", "今天天气不错，出去走走");
  hub.submitIntent(followupIntent({ summary: "用户原话：帮我盯着快递" }));
  await flush();
  assert.equal(signals.length, 1, "未打 originAt → 新鲜事件，行为不变");
});
