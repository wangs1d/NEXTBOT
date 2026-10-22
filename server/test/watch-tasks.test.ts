// 盯梢任务 + 截止时间推理单测（2026-10-22 Muse 对齐件）：
//   extractDeadline 确定性抽取 / store CRUD 与匹配 / watcher 触发与冷却 /
//   截止×日历缺口 → 行动提案升级。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach } from "node:test";

import {
  WatchTaskStore,
  WatchTaskWatcher,
  extractDeadline,
} from "../src/proactivity/branches/watch-tasks.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime(); // 2026-10-22（周四）正午

beforeEach(() => {});

// ─── extractDeadline ───

test("deadline: 周五下午5点前报名 → 本周五 17:00", () => {
  const hit = extractDeadline("游泳队选拔这周五下午5点前报名，逾期不候", NOW);
  assert.ok(hit);
  const d = new Date(hit.deadlineAt);
  assert.equal(d.getDay(), 5);
  assert.equal(d.getHours(), 17);
  assert.equal(hit.verb, "报名");
});

test("deadline: 明天上午10点提交 → 明天 10:00", () => {
  const hit = extractDeadline("材料明天上午10点前提交到教务处", NOW);
  assert.ok(hit);
  const d = new Date(hit.deadlineAt);
  assert.equal(d.getDate(), 23); // 10-23
  assert.equal(d.getHours(), 10);
});

test("deadline: X月X日无钟点 → 当天 23:59（截止日末语义）", () => {
  const hit = extractDeadline("10月30日前完成注册", NOW);
  assert.ok(hit);
  const d = new Date(hit.deadlineAt);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test("deadline: 有动词没时间 → null（不猜）", () => {
  assert.equal(extractDeadline("尽快报名，错过等一年", NOW), null);
});

test("deadline: 有时间没动词 → null", () => {
  assert.equal(extractDeadline("周五下午5点开会", NOW), null);
});

test("deadline: 远超 14 天 → null（过期窗口）", () => {
  assert.equal(extractDeadline("12月30日前提交申请", NOW), null);
});

test("deadline: 下周X 加 7 天", () => {
  const hit = extractDeadline("下周日前缴费", NOW);
  assert.ok(hit);
  const days = Math.round((hit.deadlineAt - NOW) / 86400_000);
  assert.equal(new Date(hit.deadlineAt).getDay(), 0);
  assert.ok(days > 7 && days <= 14, `下周日应在 7-14 天内，实际 ${days}`);
});

// ─── store ───

function makeStore(): WatchTaskStore {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  return new WatchTaskStore({ persistPath: join(dir, "w.json"), nowFn: () => NOW });
}

test("store: 关键词清洗去重 / 同 label 幂等 / 空关键词拒绝", () => {
  const s = makeStore();
  const t = s.create("u", "学校邮件里的选拔信息", ["选拔", "报名", "选拔", "x", "这个关键词太长了不合适"]);
  assert.deepEqual(t.keywords, ["选拔", "报名"]);
  const dup = s.create("u", "学校邮件里的选拔信息", ["别的"]);
  assert.equal(dup.id, t.id, "同 label 幂等");
  assert.throws(() => s.create("u", "空关键词", ["a", ""]), /keywords 不能为空/);
});

test("store: match 最长关键词优先；暂停/删除退出匹配", () => {
  const s = makeStore();
  const a = s.create("u", "泛盯", ["选拔"]);
  const b = s.create("u", "专盯游泳", ["游泳队选拔"]);
  const hit = s.match("u", "游泳队选拔周五报名");
  assert.equal(hit?.id, b.id, "更具体的关键词赢");
  assert.equal(s.match("u", "今天天气不错"), null);
  s.setActive("u", b.id, false);
  assert.equal(s.match("u", "游泳队选拔周五报名")?.id, a.id);
  s.remove("u", a.id);
  assert.equal(s.match("u", "选拔"), null);
  assert.equal(s.remove("u", "not_exist"), false);
  assert.equal(s.remove("other-actor", "x"), false);
});

// ─── watcher ───

function makeWatcher(store: WatchTaskStore, opts: { entries?: Array<{ hay: string; at: number }>; cooldownMs?: number } = {}) {
  const proposals: ProactiveProposal[] = [];
  const watcher = new WatchTaskWatcher({
    store,
    submitProposal: (p) => proposals.push(p),
    now: () => NOW,
    ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
    ...(opts.entries
      ? {
          hasRelatedEntry: (_actor: string, keywords: string[], startMs: number, endMs: number) =>
            opts.entries!.some((e) => e.at >= startMs && e.at <= endMs && keywords.some((k) => e.hay.includes(k))),
        }
      : {}),
  });
  return { proposals, watcher };
}

test("watcher: 没有盯梢任务 → 完全沉默（主动性音量由用户控制）", () => {
  const { proposals, watcher } = makeWatcher(makeStore());
  watcher.handleInbound({ actorId: "u", text: "游泳队选拔周五下午5点前报名，逾期不候" });
  assert.equal(proposals.length, 0);
});

test("watcher: 任务命中 → must 层提案；无截止 → 通用报告话术", () => {
  const s = makeStore();
  s.create("u", "学校邮件里的选拔信息", ["选拔"]);
  const { proposals, watcher } = makeWatcher(s, { cooldownMs: 0 });
  watcher.handleInbound({ actorId: "u", text: "校交响乐团选拔开始招新了，欢迎报名", platform: "wechat" });
  assert.equal(proposals.length, 1);
  const p = proposals[0]!;
  assert.equal(p.kind, "watch_task_hit");
  assert.equal(p.tier, "must", "用户自己下的单绕过社交预算");
  assert.ok(p.directText?.includes("你让我盯着"), "报告话术带任务名");
  assert.equal(p.confirmAction, undefined, "无截止缺口不升级行动提案");
});

test("watcher: 截止 × 日历缺口 → 「设提醒」行动提案（Muse 体育选拔案例）", () => {
  const s = makeStore();
  s.create("u", "学校邮件里的选拔信息", ["选拔"]);
  const { proposals, watcher } = makeWatcher(s, { entries: [], cooldownMs: 0 });
  watcher.handleInbound({ actorId: "u", text: "游泳队选拔这周五下午5点前报名，逾期不候" });
  assert.equal(proposals.length, 1);
  const p = proposals[0]!;
  assert.ok(p.evidence.includes("calendar_gap"), "缺口证据入链");
  assert.ok(p.directText?.includes("日程里还没有这一项"), "缺口话术");
  assert.ok(p.directText?.includes("要我帮你设个提醒吗"), "行动问句");
  assert.equal(p.confirmAction?.label, "设提醒");
});

test("watcher: 截止但日历已有 → 只报告不催办（缺口才升级）", () => {
  const s = makeStore();
  s.create("u", "学校邮件里的选拔信息", ["选拔"]);
  const { proposals, watcher } = makeWatcher(s, {
    // 条目在截止窗内（这周五 17:00 = NOW+1d+5h；NOW+12h 落在窗内）
    entries: [{ hay: "游泳队选拔报名", at: NOW + 12 * 3600_000 }],
    cooldownMs: 0,
  });
  watcher.handleInbound({ actorId: "u", text: "游泳队选拔这周五下午5点前报名，逾期不候" });
  assert.equal(proposals.length, 1);
  assert.ok(!proposals[0]!.evidence.includes("calendar_gap"));
  assert.ok(!proposals[0]!.directText?.includes("要我帮你设个提醒吗"));
});

test("watcher: 同任务 1 小时冷却（缺省），异任务不受影响", () => {
  const s = makeStore();
  s.create("u", "盯选拔", ["选拔"]);
  const { proposals, watcher } = makeWatcher(s);
  const text = "游泳队选拔这周五下午5点前报名";
  watcher.handleInbound({ actorId: "u", text });
  watcher.handleInbound({ actorId: "u", text: `${text}（补充说明）` });
  assert.equal(proposals.length, 1, "同任务 1h 内只报一次");
});

test("watcher: 噪声不触发（验证码/超长文本）", () => {
  const s = makeStore();
  s.create("u", "盯数字", ["882"]);
  const { proposals, watcher } = makeWatcher(s, { cooldownMs: 0 });
  watcher.handleInbound({ actorId: "u", text: "882" });
  assert.equal(proposals.length, 0, "<4 字不理");
});

// 清理
test("cleanup", () => { rmSync(join(tmpdir(), "watch-"), { recursive: true, force: true }); });
