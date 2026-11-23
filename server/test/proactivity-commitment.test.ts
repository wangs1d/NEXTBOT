// 承诺跟进（PRD §3.5）单测。
//
// 这一节的验收线全部来自 §3.5 的四句话：①「对话里说『我明天下午面试』→ 次日下班或
// 明日预览 slot 出现 1 条跟进」；②「同一事件最多跟进 1 次」；③「用户点了『别跟进这个』，
// 同类事件 30 天内不再跟进」；④「private 类：锁屏 / 通知正文只显示『{管家名}：有句话想跟你说』」。
// 再加一条口径：跟进**不是第二套通知系统**——它只经 submitProposal 进既有管道，
// 靠 deliverAfter 落进触点（§1.3 不新增定时器），所以这里刻意用真的 ProactivePipeline
// + 真的 TouchpointPlanner 跑一遍，而不是只测服务自己。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FollowUpService } from "../src/proactivity/followup-service.js";
import {
  FOLLOWUP_SUPPRESS_MS,
  PRIVATE_LOCK_SCREEN_HINT,
  categorizeFollowUp,
  classifySensitivity,
  computeFollowAt,
  lockScreenBody,
} from "../src/proactivity/followup-service.js";
import type { FollowUpSlotTime } from "../src/proactivity/followup-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { NOTIFY_ACTION, buildNotifyActions } from "../src/proactivity/notification-actions.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivitySuppressionStore } from "../src/proactivity/suppression-store.js";
import { TouchpointPlanner } from "../src/proactivity/touchpoint-planner.js";
import { detectMemorySignals } from "../src/agent/memory-signal.js";
import type { UnifiedFollowUp } from "../src/agentic-memory/unified-extractor.js";
import { listFollowUps } from "../src/services/followup-store.js";

const DAY = 24 * 60 * 60_000;
const MIN = 60_000;

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 2026-11-25 是周三：工作日锚点，与触点计划测试同一天，两边口径能对着读 */
const WED_1300 = new Date(2026, 10, 25, 13, 0, 0).getTime();
/** 明天（周四）下午两点面试 */
const THU_1400_ISO = "2026-11-26T14:00";
const THU_1400 = new Date(2026, 10, 26, 14, 0, 0).getTime();
/** 次天下班触点（18:10）：装了触点计划时 followAt 应当正好落在这一刻 */
const THU_LEAVE_WORK = new Date(2026, 10, 26, 18, 10, 0).getTime();
/** 没装触点计划（冷启动）时的默认下班钟 */
const THU_LEAVE_WORK_DEFAULT = new Date(2026, 10, 26, 18, 30, 0).getTime();

/** 本地钟面的 ISO 片段（parseEventAt 吃的是「YYYY-MM-DDTHH:mm」本地时刻） */
function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 抑制表桩：createdAt 跟着注入时钟走，才测得动「30 天窗口」这种长跨度 */
function fakeSuppression(clock: { now: number }) {
  const rows: Array<{ kind: string; keywords: string[]; createdAt: string }> = [];
  return {
    rows,
    add(actorId: string, kind: string, keywords?: unknown) {
      rows.push({
        kind,
        keywords: Array.isArray(keywords) ? keywords.map((k) => String(k)) : [],
        createdAt: new Date(clock.now).toISOString(),
      });
      return rows;
    },
    list() {
      return [...rows];
    },
  };
}

function makeService(opts: {
  now?: number;
  tier?: "quiet" | "normal" | "chatty";
  butlerName?: string;
  slotTimes?: (actorId: string, atMs: number) => FollowUpSlotTime[];
  suppression?: ReturnType<typeof fakeSuppression>;
} = {}) {
  const clock = { now: opts.now ?? WED_1300 };
  const proposals: ProactiveProposal[] = [];
  const suppression = opts.suppression ?? fakeSuppression(clock);
  const dbPath = join(tmp("-commitments"), "agentic_memory.db");
  const svc = new FollowUpService({
    submit: (p) => {
      proposals.push(p);
      return true;
    },
    governor: new FrequencyGovernor({
      ignoreEnv: true,
      tierOf: () => opts.tier ?? "normal",
      nowFn: () => new Date(clock.now),
    }),
    suppression,
    butlerName: () => opts.butlerName ?? "小管",
    dbPath,
    nowFn: () => clock.now,
    log: () => {},
    ...(opts.slotTimes ? { slotTimes: opts.slotTimes } : {}),
  });
  return { svc, proposals, clock, dbPath, suppression };
}

const interviewTomorrow: UnifiedFollowUp = {
  event: "下午面试",
  eventAt: THU_1400_ISO,
  category: "interview",
  confidence: 0.8,
};

// ─── 抽取 → 一条提案 + 一行台账 ───

test("抽取：一句「我明天下午面试」= 一行 commitments + 一条 social 提案", () => {
  const { svc, proposals, dbPath } = makeService();
  const res = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "chat:s1",
    followUps: [interviewTomorrow],
  });
  assert.equal(res.length, 1);
  assert.equal(res[0]!.reason, "submitted");
  assert.equal(proposals.length, 1);

  const p = proposals[0]!;
  // §3.5 候选源表：承诺跟进默认层级 social —— 必须计入社交日预算，不占必达额度
  assert.equal(p.tier, "social", "跟进是社交行为，不是用户点名事项");
  assert.equal(p.kind, "commitment", "触点计划按 kind 给落点偏好（下班/明日预览）");
  assert.equal(p.source, "follow_up");
  assert.equal(p.dedupKey, `commitment:followup:${res[0]!.id}`);
  assert.equal(
    p.deliverAfter,
    THU_LEAVE_WORK_DEFAULT,
    "开口时刻 = 事件之后的第一个下班触点（这里没装触点计划，走冷启动默认钟 18:30）",
  );
  assert.ok(p.expiresAt! > p.deliverAfter!, "保质期晚于开口时刻，否则一入队就过期");
  assert.equal(p.importance, "low", "事后一句不该弹窗级打扰");
  assert.deepEqual(
    p.notifyOptions?.map((o) => [o.label, o.ref]),
    [
      ["回复", undefined],
      ["别跟进这个", res[0]!.id],
    ],
    "§3.5 两枚按钮：回复（内联输入）+ 别跟进这个；后者带着事件 ref 才可能精确抑制这一类",
  );
  // 「回复」必须是真输入框，不是按下去没反应的执行按钮（§4.3 的 chat.reply）
  const acts = buildNotifyActions(p);
  assert.equal(
    acts.find((a) => a.kind === "input")?.actionId,
    NOTIFY_ACTION.chatReply,
    "「回复」= 通知栏内联输入",
  );
  // 提案侧把事件 id 挂在 ref 上：执行器要靠它区分「别跟进这个」与普通的「不用了」
  assert.equal(p.notifyOptions?.[1]?.ref, res[0]!.id);
  // 通知栏上两枚按钮都在（§3.5 line 295）；ref 能不能透到 payload 由 optionToAction
  // 的 dismiss 分支决定——那一行不在本模块的改动范围内，见交接说明
  assert.equal(acts.length, 2, `通知栏两枚按钮：${JSON.stringify(acts)}`);

  // 落库：复用 commitments 表（不新开表/库），字段按 §3.5 的那一份 schema
  const rows = listFollowUps(dbPath, "u1", { status: "any" });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, res[0]!.id);
  assert.equal(row.event, "下午面试");
  assert.equal(row.eventAt, THU_1400);
  assert.equal(row.followAt, THU_LEAVE_WORK_DEFAULT);
  assert.equal(row.sensitivity, "normal");
  assert.equal(row.category, "interview");
  assert.equal(row.sourceRef, "chat:s1");
  assert.ok(row.submittedAt !== undefined, "提交过 = 同一事件不再第二次提案的依据");
});

test("抽取入口：「我明天下午面试」这一轮必定进抽取（不靠 L1 单点分类）", () => {
  // 低信号轮会被合批进一次抽取，批次判 reject 时 followUps 整批作废：
  // §3.5 的第一环（"对话里说了 → 落一行"）不能押在 L1 记得标 personalFact 上
  const s = detectMemorySignals("我明天下午面试", "好的，加油");
  assert.ok(s.reasons.includes("future_event"), `reasons=${JSON.stringify(s.reasons)}`);
  assert.equal(s.isHighSignal, true);
  assert.match(s.extractLines.join("\n"), /明天下午面试/, "用户原句要出现在抽取文本里");
  // 闲聊轮不因此被误标（否则每条废话都要单独跑一次抽取）
  assert.equal(detectMemorySignals("今天天气不错", "是啊，挺暖和").isHighSignal, false);
});

test("台账是落盘的：换一个服务实例（= 进程重启）仍看得见这件事", () => {
  const { svc, dbPath } = makeService();
  const res = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  const again = new FollowUpService({ submit: () => true, dbPath, log: () => {} });
  const snap = again.snapshot("u1");
  assert.equal(snap.pending.length, 1);
  assert.equal(snap.pending[0]!.id, res[0]!.id);
  assert.equal(snap.pending[0]!.submitted, true);
});

test("同一事件只跟进 1 次：换个措辞再说一遍也不再提案", () => {
  const { svc, proposals } = makeService();
  const first = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  // 同一时刻同一类别 = 同一件事（id 由 actor|category|事件分钟 派生，不含措辞）
  const repeat = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s2",
    followUps: [{ ...interviewTomorrow, event: "有个面试" }],
  });
  assert.equal(first[0]!.submitted, true);
  assert.equal(repeat[0]!.id, first[0]!.id, "重复表述归到同一条跟进事件");
  assert.equal(repeat[0]!.reason, "already_followed");
  assert.equal(proposals.length, 1, "「说过第二遍也不补发」");

  // 同日另一件事（不同类别）不受影响：抑制按类别匹配，不是一刀切静音
  const other = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s3",
    followUps: [{ event: "晚上去复诊", eventAt: "2026-11-26T20:00", category: "medical" }],
  });
  assert.equal(other[0]!.reason, "submitted");
  assert.equal(proposals.length, 2);
});

test("落库闸门：没有时刻锚点 / 事件已经过去很久，就不跟进（误抽 ≤5% 的那一侧）", () => {
  const { svc, proposals, dbPath } = makeService();
  const noAnchor = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s",
    followUps: [{ event: "改天去看牙", category: "medical" }],
  });
  assert.equal(noAnchor[0]!.reason, "no_anchor", "「改天」没有对的时刻，硬排等于随机打扰");
  const stale = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s",
    followUps: [{ event: "上午面试", eventAt: localIso(WED_1300 - 2 * DAY), category: "interview" }],
  });
  assert.equal(stale[0]!.reason, "stale_event", "两天前的面试不该现在被问起");
  assert.equal(proposals.length, 0);
  assert.equal(listFollowUps(dbPath, "u1", { status: "any" }).length, 0, "被闸门挡下的不落脏行");
});

// ─── followAt：事件之后的第一个合适触点 ───

test("followAt：取事件之后的下班触点；下班已过则退到明日预览，再退到次天下班", () => {
  // 周四：下班 18:10、明日预览 21:00
  const slots = (dayStart: number): FollowUpSlotTime[] => [
    { kind: "leave_work", windowStart: dayStart + (18 * 60 + 10) * MIN },
    { kind: "tomorrow_preview", windowStart: dayStart + 21 * 60 * MIN },
  ];
  const thuStart = new Date(2026, 10, 26, 0, 0, 0).getTime();
  /** 按「被问到的那一天」给触点：真实计划层是按日期算的，followAt 要跨天找 */
  const slotsThatDay = (atMs: number): FollowUpSlotTime[] => {
    const d = new Date(atMs);
    return slots(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  };
  // 下午 2 点面试 → 当天 18:10 下班
  assert.equal(
    computeFollowAt({ eventAt: THU_1400, now: WED_1300, slotTimes: () => slots(thuStart) }),
    THU_LEAVE_WORK,
  );
  // 晚上 8 点看完演出 → 当天 21:00 明日预览
  assert.equal(
    computeFollowAt({
      eventAt: thuStart + 20 * 60 * MIN,
      now: WED_1300,
      slotTimes: () => slots(thuStart),
    }),
    thuStart + 21 * 60 * MIN,
  );
  // 夜里 22:30 才结束 → 当天两个触点都过了 → 次天下班
  assert.equal(
    computeFollowAt({
      eventAt: thuStart + 22 * 60 * MIN + 30 * MIN,
      now: WED_1300,
      slotTimes: slotsThatDay,
    }),
    thuStart + DAY + (18 * 60 + 10) * MIN,
  );
  // 没有触点计划（未装配）：按冷启动默认钟 18:30，且绝不在事件之前说
  const at = computeFollowAt({ eventAt: THU_1400, now: WED_1300 });
  assert.equal(at, new Date(2026, 10, 26, 18, 30, 0).getTime());
  assert.ok(at > THU_1400, "开口一定在事件之后——事前说就成了日程提醒（§3.5 分工）");
});

// ─── 频率档（§3.10） ───

test("quiet 档（只在有事时）：事件照记，一条跟进都不发", () => {
  const { svc, proposals, dbPath } = makeService({ tier: "quiet" });
  const res = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  assert.equal(res[0]!.reason, "quiet_tier");
  assert.equal(proposals.length, 0, "这一档的语义是「有事直说，别没事找我」");
  assert.equal(listFollowUps(dbPath, "u1").length, 1, "不开口不等于不记得：用户哪天问起来它还在");
});

test("quiet 档兜底：跟进带 tier=social，社交预算 0 这一关也过不去", () => {
  const dir = tmp("-fu-quiet");
  const now = { value: WED_1300 };
  const quietGovernor = new FrequencyGovernor({
    ignoreEnv: true,
    tierOf: () => "quiet",
    nowFn: () => new Date(now.value),
  });
  assert.equal(quietGovernor.socialBudgetOf("u1"), 0, "§3.10「只在有事时」= 社交预算 0");
  assert.equal(quietGovernor.tierAllows("u1", "followup"), false);

  // 绕过服务那道闸（模拟装配漏接）：把一条真实的跟进提案直接投给管道
  const { svc, dbPath } = makeService({ tier: "quiet" });
  svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  const rec = listFollowUps(dbPath, "u1")[0]!;
  const presence = new PresenceService();
  const delivered: Array<{ json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: quietGovernor,
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    lastConversationAt: () => now.value - 6 * 60 * MIN,
    delivery: new ProactiveDeliveryService({
      trySend: (_a, json) => {
        delivered.push({ json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => now.value,
  });
  presence.markConnected("u1", now.value - MIN);
  // deliverAfter 抹平到当下：排除「因为还没到点所以没发」，只留频控这一条解释
  const d = pipeline.submitProposal({ ...svc.buildProposal(rec, now.value), deliverAfter: now.value - MIN });
  assert.notEqual(d.verdict, "delivered", `quiet 档发出去了：${JSON.stringify(d.reasonChain)}`);
  assert.equal(delivered.length, 0);
  assert.ok(
    d.reasonChain.some((r) => r.includes("social_budget_exhausted")),
    `原因应落在社交预算上，实得 ${JSON.stringify(d.reasonChain)}`,
  );
});

// ─── 「别跟进这个」→ 同类 30 天抑制 ───

test("「别跟进这个」：这件事结掉，同类 30 天内不再提，别的类照常", () => {
  const { svc, proposals, dbPath, suppression, clock } = makeService();
  const res = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  const id = res[0]!.id;
  // 跟进已经说出去了，当晚用户按下「别跟进这个」：抑制窗口从这一刻起算
  const declinedAt = THU_LEAVE_WORK + 10 * MIN;
  clock.now = declinedAt;
  const out = svc.decline("u1", id);
  assert.equal(out.ok, true);
  assert.equal(out.cancelled, 1);
  assert.equal(out.category, "interview");
  assert.match(out.message, /30 天内/);

  // 台账收口：这一行不再是待跟进
  const rows = listFollowUps(dbPath, "u1", { status: "any" });
  assert.equal(rows[0]!.status, "cancelled");

  // 抑制登记在既有负反馈抑制表里（不另立第二本账）
  assert.deepEqual(
    suppression.rows.map((r) => [r.kind, r.keywords]),
    [["follow_up", ["interview"]]],
  );

  // 第 3 天：同类的新事件 → 不再提
  const within = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s2",
    followUps: [
      { event: "另一场面试", eventAt: localIso(declinedAt + 3 * DAY + 20 * MIN), category: "interview" },
    ],
    now: declinedAt + 3 * DAY,
  });
  assert.equal(within[0]!.reason, "suppressed_category");
  assert.equal(proposals.length, 1, "被抑制的这条没有偷偷开口");

  // 另一个类别（考试）不受牵连：抑制是「这一类」不是一刀切静音
  const otherCat = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s3",
    followUps: [{ event: "科目二考试", eventAt: localIso(declinedAt + 6 * DAY), category: "exam" }],
    now: declinedAt + 3 * DAY,
  });
  assert.equal(otherCat[0]!.reason, "submitted");
  assert.equal(proposals.length, 2);

  // 第 29 天仍在窗口内，第 31 天窗口过了，同类可以再说一次
  assert.equal(svc.isCategorySuppressed("u1", "interview", declinedAt + 29 * DAY), true);
  assert.equal(svc.isCategorySuppressed("u1", "interview", declinedAt + 31 * DAY), false);
  assert.equal(FOLLOWUP_SUPPRESS_MS, 30 * DAY, "§3.5「同类事件 30 天内不再跟进」");
  const after = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s4",
    followUps: [
      { event: "年底面试", eventAt: localIso(declinedAt + 31 * DAY + 40 * MIN), category: "interview" },
    ],
    now: declinedAt + 31 * DAY,
  });
  assert.equal(after[0]!.reason, "submitted");
  assert.equal(proposals.length, 3);
});

test("对话里说「别跟进面试这类」：不给 id 也能按类别收口", () => {
  const { svc, dbPath } = makeService();
  svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  const out = svc.decline("u1", "面试");
  assert.equal(out.ok, true);
  assert.equal(out.category, "interview");
  assert.equal(
    listFollowUps(dbPath, "u1", { status: "any" })[0]!.status,
    "cancelled",
    "挂着的那条一起结掉",
  );
  assert.equal(svc.isCategorySuppressed("u1", "interview"), true);
  assert.equal(svc.isCategorySuppressed("u1", "exam"), false);
});

test("抑制真的写进既有抑制表：落盘可查，重启仍在", async () => {
  const dir = tmp("-fu-suppression");
  const store = new ProactivitySuppressionStore({ dirPath: dir });
  await store.load();
  const svc = new FollowUpService({
    submit: () => true,
    suppression: store,
    dbPath: join(tmp("-commitments"), "agentic_memory.db"),
    log: () => {},
  });
  const res = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  const out = svc.decline("u1", res[0]!.id);
  assert.equal(out.ok, true);
  await new Promise((r) => setTimeout(r, 50)); // 落盘是 fire-and-forget，等它写完
  const file = join(dir, "u1.json");
  assert.ok(existsSync(file), "抑制必须持久化，否则重启就忘");
  const persisted = JSON.parse(readFileSync(file, "utf8")) as {
    entries: Array<{ kind: string; keywords: string[]; note?: string }>;
  };
  const entry = persisted.entries.find((e) => e.kind === "follow_up");
  assert.ok(entry, `抑制表里应有 kind=follow_up 的条目，实得 ${JSON.stringify(persisted.entries)}`);
  assert.deepEqual(entry!.keywords, ["interview"]);
  assert.equal(entry!.note, "别跟进这个");
  // 用户明确表过态 → 类别判定用的是同一张表（同一口径，不是两套匹配）
  assert.equal(svc.isCategorySuppressed("u1", "interview"), true);
});

// ─── private：锁屏不泄露（§3.5 表达要求） ───

test("private 事件：通知正文与标题不含事件内容，全文只在点开后的 summary", () => {
  const { svc, proposals } = makeService();
  const res = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s",
    followUps: [{ event: "下午去医院做胃镜", eventAt: THU_1400_ISO, category: "medical" }],
  });
  assert.equal(res[0]!.reason, "submitted");
  const p = proposals[0]!;
  // 模型没给 sensitivity 也要判成 private（健康类兜底闸）
  assert.equal(classifySensitivity("下午去做胃镜"), "private");
  assert.equal(categorizeFollowUp("下午去做胃镜", "medical"), "medical");
  assert.equal(p.directText, `小管：${PRIVATE_LOCK_SCREEN_HINT}`, "锁屏那一句只能是管家名 + 提示");
  assert.equal(p.title, "小管", "标题也不许带事件词");
  for (const leaked of ["胃镜", "胃", "医", "检查", "医院"]) {
    assert.ok(!`${p.title}${p.directText}`.includes(leaked), `锁屏泄露了「${leaked}」`);
  }
  assert.match(p.summary!, /看诊辛苦了/, "点开看到的是陈述句全文");
  assert.ok(!p.summary!.includes("胃镜"), "话术本身不复述用户原话（陈述句 + 无隐性要求）");
  assert.ok(!/[？?]/.test(p.summary!.trim()), "不是问句：「结果出来想聊随时说」而非「结果怎么样了？」");

  // normal 事件正相反：正文就是那句话，锁屏可以直接看
  const normalRes = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s2",
    followUps: [{ event: "下午面试", eventAt: localIso(THU_1400), category: "interview" }],
  });
  assert.equal(normalRes[0]!.reason, "submitted");
  const normal = proposals[proposals.length - 1]!;
  assert.notEqual(normal.dedupKey, p.dedupKey);
  assert.equal(normal.directText, normal.summary, "非敏感事件正文照原样上锁屏");
  assert.equal(lockScreenBody({ sensitivity: "normal" }, "小管", "昨天面试辛苦了。"), "昨天面试辛苦了。");
  // 没起名字时也不该留一个空冒号
  assert.equal(lockScreenBody({ sensitivity: "private" }, "", "正文"), PRIVATE_LOCK_SCREEN_HINT);
});

// ─── 经既有管道：不抢跑、落触点、只说一次 ───

test("管道：跟进不当场弹，到点随下班触点说一次，再 flush 也不重复", () => {
  const dir = tmp("-fu-pipeline");
  const now = { value: WED_1300 };
  const planner = new TouchpointPlanner({
    timing: {
      postWakeMinutes: (_a, opts) => Math.min(11 * 60, Math.max(6 * 60, 7 * 60 + 20 + (opts?.offsetMinutes ?? 30))),
      bedtimeHour: () => 23,
    },
    previewMinutesOf: () => 21 * 60,
    commuteMinutesOf: () => ({ leaveHome: 8 * 60 + 20, leaveWork: 18 * 60 + 10 }),
    middayMinutesOf: () => 12 * 60 + 30,
    rhythmConfidence: () => 0.8,
    frequencyTierOf: () => "normal",
    nowFn: () => now.value,
  });
  const presence = new PresenceService();
  const delivered: Array<{ actorId: string; json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    // 频控器与管道共用同一个可注入时钟：否则「昨天说过一次」在真实墙上时钟里
    // 只隔了几毫秒，kind 冷却会把第二天的跟进误拦成限流
    governor: new FrequencyGovernor({
      ignoreEnv: true,
      dailyBudget: 20,
      nowFn: () => new Date(now.value),
    }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    lastConversationAt: () => now.value - 6 * 60 * MIN,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => now.value,
    planner,
  });
  presence.markConnected("u1", now.value - MIN);

  const svc = new FollowUpService({
    submit: (p) => pipeline.submitProposal(p),
    dbPath: join(tmp("-commitments"), "agentic_memory.db"),
    butlerName: () => "小管",
    nowFn: () => now.value,
    log: () => {},
    slotTimes: (actorId, atMs) =>
      planner.planOf(actorId, atMs).slots.map((s) => ({ kind: s.kind as string, windowStart: s.windowStart })),
  });

  // 「我明天下午面试」：今天 13:00 说，明天 14:00 的事
  const res = svc.ingestFromExtraction({ actorId: "u1", sourceRef: "s", followUps: [interviewTomorrow] });
  assert.equal(res[0]!.reason, "submitted");
  const queued = pipeline.diagnostics().pending.find((p) => p.dedupKey.startsWith("commitment:followup:"));
  assert.ok(queued, "提案挂在待发区，而不是当场就说");
  assert.equal(queued!.deliverAfter, THU_LEAVE_WORK);
  assert.equal(delivered.length, 0, "没到点就不许开口");

  // 到点：明天 18:10 之后的一轮 flush 才说
  now.value = THU_LEAVE_WORK + MIN;
  pipeline.flushDue(now.value);
  assert.equal(delivered.length, 1);
  const text = String(JSON.parse(delivered[0]!.json).payload?.text ?? "");
  // 锚点按「开口那一天」说：面试是今天下午，晚上收尾时说的是「今天」，不是抽取那天的「明天」
  assert.match(text, /今天面试辛苦了/);
  assert.ok(!text.includes("明天"), `话术还带着抽取时的措辞：${text}`);
  assert.ok(!/[？?]/.test(text), `跟进是陈述句，不追要回复：${text}`);
  pipeline.flushDue(now.value + MIN);
  assert.equal(delivered.length, 1, "说过就是说过，第二轮 flush 不再弹一次");

  // 事件当天说的情形：把钟拨到周五，下午面试 → 当天 18:10 的下班触点里一句「今天面试辛苦了」
  now.value = new Date(2026, 10, 27, 13, 0, 0).getTime();
  const sameDay = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s2",
    followUps: [{ event: "下午面试", eventAt: localIso(new Date(2026, 10, 27, 14, 0).getTime()), category: "interview" }],
  });
  assert.equal(sameDay[0]!.reason, "submitted");
  const queued2 = pipeline
    .diagnostics()
    .pending.find((p) => p.dedupKey === `commitment:followup:${sameDay[0]!.id}`);
  assert.ok(queued2, "当天没到点的跟进应挂在待发区");
  assert.equal(
    queued2!.slotId,
    `tp:u1:2026-11-27:leave_work`,
    "落点由触点计划决定（§3.4 下班），本模块只出一个 deliverAfter，没有自己的定时器",
  );
  now.value = new Date(2026, 10, 27, 18, 11, 0).getTime();
  pipeline.flushDue(now.value);
  assert.equal(
    delivered.length,
    2,
    `下班触点该说第二句：${JSON.stringify(
      pipeline
        .diagnostics()
        .recentDecisions.slice(-3)
        .map((d) => [d.proposal?.dedupKey, d.verdict, d.reasonChain, d.deliverAfter]),
    )}`,
  );
  assert.match(String(JSON.parse(delivered[1]!.json).payload?.text), /今天面试辛苦了/);

  // §3.5「限制」拦的是**同一件事说第二遍**（「同一事件最多跟进 1 次；用户点了『别跟进这个』，
  // 同类事件 30 天内不再跟进；计入社交日预算」，docs line 298-299），没有「同类话一天只说
  // 一件」这一条：kind=commitment 覆盖用户所有未来事件，按 kind 记冷却会让 B 事件的跟进
  // 被 A 事件的跟进吞掉（本用例两条只差 2h49m）。跨事件的收口是 §3.4 的 slot 容量与同触点
  // 合并（「同一 slot 内的 3 条候选合并为 1 条投递」，line 276）+ 社交日预算，不是限流。
  now.value = new Date(2026, 10, 27, 19, 30, 0).getTime();
  const party = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s3",
    followUps: [
      { event: "晚上同学聚会", eventAt: localIso(new Date(2026, 10, 27, 19, 0).getTime()), category: "party" },
    ],
  });
  assert.equal(party[0]!.reason, "submitted");
  const queued3 = pipeline
    .diagnostics()
    .pending.find((p) => p.dedupKey === `commitment:followup:${party[0]!.id}`);
  assert.ok(queued3, "聚会这条挂在待发区，不是提交当场被吞");
  assert.equal(
    queued3!.slotId,
    "tp:u1:2026-11-27:tomorrow_preview",
    "下班已过 → 落当晚明日预览（§3.5 followAt 口径），落点仍由触点计划给",
  );
  now.value = new Date(2026, 10, 27, 21, 1, 0).getTime();
  pipeline.flushDue(now.value);
  assert.equal(
    delivered.length,
    3,
    `两件不同的事各自说一句（上一条 18:11 面试、这一条 21:00 聚会，只差 2h49m）：${JSON.stringify(
      pipeline
        .diagnostics()
        .recentDecisions.slice(-2)
        .map((d) => [d.proposal?.dedupKey?.slice(0, 24), d.verdict, d.reasonChain]),
    )}`,
  );
  const thirdText = String(JSON.parse(delivered[2]!.json).payload?.text ?? "");
  assert.match(thirdText, /聚得开心就好/);
  assert.ok(!thirdText.includes("面试"), `说的是聚会这件事，不是把上一条重复一遍：${thirdText}`);
});

test("管道：private 跟进投递出去的正文同样只有那一句提示", () => {
  const dir = tmp("-fu-pipeline");
  const now = { value: WED_1300 };
  const presence = new PresenceService();
  const delivered: Array<{ json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({
      ignoreEnv: true,
      dailyBudget: 20,
      nowFn: () => new Date(now.value),
    }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    lastConversationAt: () => now.value - 6 * 60 * MIN,
    delivery: new ProactiveDeliveryService({
      trySend: (_actorId, json) => {
        delivered.push({ json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => now.value,
    // 不装 planner：跟进带着 deliverAfter 也要到点才发（延迟队列本就有这条路）
  });
  presence.markConnected("u1", now.value - MIN);
  const svc = new FollowUpService({
    submit: (p) => pipeline.submitProposal(p),
    dbPath: join(tmp("-commitments"), "agentic_memory.db"),
    butlerName: () => "小管",
    nowFn: () => now.value,
    log: () => {},
  });
  const res = svc.ingestFromExtraction({
    actorId: "u1",
    sourceRef: "s",
    followUps: [{ event: "去做胃镜复查", eventAt: THU_1400_ISO, category: "medical", sensitivity: "private" }],
  });
  assert.equal(res[0]!.reason, "submitted");
  assert.equal(delivered.length, 0);
  // 没有触点计划可问 → followAt 走冷启动默认钟（当天 18:30 下班）；14:30 就 flush 当然还不该说
  now.value = new Date(2026, 10, 26, 19, 0, 0).getTime();
  pipeline.flushDue(now.value);
  assert.equal(delivered.length, 1);
  const body = String(JSON.parse(delivered[0]!.json).payload?.text ?? "");
  assert.equal(body, `小管：${PRIVATE_LOCK_SCREEN_HINT}`, "落到客户端/推送的那一段就是遮罩后的正文");
  assert.ok(!/胃镜|复查|医院/.test(body), `锁屏正文泄露了内容：${body}`);
});
