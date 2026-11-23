// 承诺跟进（PRD §3.5）单测：抽取产物形状与硬闸、followAt 落点、同一事件只跟进一次、
// 话术是陈述句、private 的锁屏正文遮罩、「别跟进这个」后同类 30 天抑制（第 31 天恢复）、
// 「只在有事时」档一条也不发但事件照记，以及落库复用 commitments 表（不新开库、
// source/kind 满足待办 prompt 的过滤条件）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isFollowUpExtractHint,
  normalize,
  parseFollowUps,
} from "../src/agentic-memory/unified-extractor.js";
import type { UnifiedFollowUp } from "../src/agentic-memory/unified-extractor.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import {
  FOLLOWUP_SUPPRESS_KIND,
  FollowUpService,
  PRIVATE_LOCK_SCREEN_HINT,
  categorizeFollowUp,
  computeFollowAt,
} from "../src/proactivity/followup-service.js";
import type { FollowUpSlotTime } from "../src/proactivity/followup-service.js";
import { getFollowUp, listFollowUps, listFollowUpsByCategory } from "../src/services/followup-store.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-25 是周三；dayOffset 按本地日历推，时刻全用墙钟（followAt 不能用 UTC 算） */
function at(dayOffset: number, h: number, m = 0): number {
  return new Date(2026, 10, 25 + dayOffset, h, m, 0).getTime();
}
/** 本地当天 hh:mm（followAt 断言用，避开时区） */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type SuppEntry = { kind: string; keywords: string[]; createdAt: string };

type Harness = {
  svc: FollowUpService;
  dbPath: string;
  dir: string;
  proposals: ProactiveProposal[];
  suppressions: SuppEntry[];
  featureCalls: string[];
  now(): number;
  setNow(ms: number): void;
  setTier(tier: "quiet" | "normal" | "chatty"): void;
  /** 走 ingestFromExtraction，返回第一条的处置原因 */
  ingest(...followUps: Array<Partial<UnifiedFollowUp> & { event: string }>): string;
  /** 记下跟进 id 便于 decline / 取行 */
  followUpId(p: ProactiveProposal): string;
  snapshotSuppressed(): string[];
  corruptSuppression(): void;
  cleanup(): void;
};

/** 触点计划读侧的替身：每天 08:00 早安 / 18:30 下班 / 22:00 明日预览（与默认钟同口径） */
function fakeSlots(atMs: number): FollowUpSlotTime[] {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  const base = d.getTime();
  return [
    { kind: "morning", windowStart: base + 8 * HOUR },
    { kind: "leave_work", windowStart: base + 18 * HOUR + 30 * MIN },
    { kind: "tomorrow_preview", windowStart: base + 22 * HOUR },
  ];
}

function makeHarness(opts: { tier?: "quiet" | "normal" | "chatty"; butler?: string | null; now?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "followup-"));
  const dbPath = join(dir, "agentic-memory.db");
  let now = opts.now ?? at(0, 10, 0);
  let tier = opts.tier ?? "normal";
  const proposals: ProactiveProposal[] = [];
  const suppressions: SuppEntry[] = [];
  const featureCalls: string[] = [];
  const svc = new FollowUpService({
    dbPath,
    nowFn: () => now,
    log: () => {},
    submit: (p) => {
      proposals.push(p);
      return { verdict: "queued" };
    },
    governor: {
      tierAllows: (_actorId, feature) => {
        featureCalls.push(feature);
        return tier !== "quiet";
      },
    },
    suppression: {
      add: (_actorId, kind, keywords) => {
        suppressions.push({
          kind,
          keywords: Array.isArray(keywords) ? (keywords as string[]).map(String) : [],
          createdAt: new Date(now).toISOString(),
        });
      },
      list: () => suppressions,
    },
    slotTimes: (_actorId, atMs) => fakeSlots(atMs),
    butlerName: () => opts.butler === undefined ? "小舟" : opts.butler,
  });
  return {
    svc,
    dbPath,
    dir,
    proposals,
    suppressions,
    featureCalls,
    now: () => now,
    setNow: (ms) => {
      now = ms;
    },
    setTier: (t) => {
      tier = t;
    },
    ingest: (...items) => {
      const out = svc.ingestFromExtraction({
        actorId: "user-a",
        sourceRef: "conv-1",
        followUps: items.map((i) => i as UnifiedFollowUp),
      });
      return out[0]?.reason ?? "";
    },
    followUpId: (p) => p.dedupKey!.split(":").pop()!,
    snapshotSuppressed: () => svc.snapshot("user-a").suppressedCategories,
    corruptSuppression: () => {
      if (suppressions[0]) suppressions[0].createdAt = "昨天下午";
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── 抽取产物（unified-extractor 侧）─────────────────────────────────────

test("抽取：followUps 与 memories 同批产出，问句/低置信/越界类别各走各的闸", () => {
  const ex = normalize({
    decision: "decay",
    memories: ["用户周三下午有一场面试"],
    followUps: [
      { event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview", sensitivity: "normal", confidence: 0.9 },
      { event: "明天面试穿什么？", eventAt: "2026-11-26T09:00", category: "interview" }, // 问句：不是事件
      { event: "去看牙", eventAt: "改天吧", category: "medical" }, // 时刻换算不出来：省略 eventAt，落库侧按无锚点弃
      { event: "洗车", eventAt: "2026-11-27T10:00", confidence: 0.4 }, // 低置信
      { event: "签租房合同", eventAt: "2026-11-28T10:00", category: "moving" }, // 越界类别 → other
      { event: "第6条", eventAt: "2026-11-29T10:00" },
      { event: "第7条", eventAt: "2026-11-30T10:00" },
    ],
  });
  assert.ok(ex);
  assert.equal(ex.decision, "decay");
  assert.equal(ex.memories.length, 1);
  const list = ex.followUps ?? [];
  assert.equal(list.length, 3, "一轮最多 3 条");
  assert.deepEqual(list[0], {
    event: "下午面试",
    eventAt: "2026-11-25T14:00",
    category: "interview",
    confidence: 0.9,
  });
  assert.equal(list[1]?.event, "去看牙");
  assert.equal(list[1]?.eventAt, undefined, "不可解析的时刻要省略，不能编日期");
  assert.equal(list[2]?.category, "other", "白名单外的类别洗成 other");
  // 判私只认 private 字面值
  assert.deepEqual(parseFollowUps([{ event: "去复诊", sensitivity: "PRIVATE" }])[0], {
    event: "去复诊",
    category: "other",
  });
});

test("抽取：闲聊轮（reject）不留跟进，也不进提示词分支", () => {
  const ex = normalize({ decision: "reject", followUps: [{ event: "下午面试", eventAt: "2026-11-25T14:00" }] });
  assert.ok(ex);
  assert.equal(ex.followUps, undefined, "reject 轮的 followUps 被清空后不占字段");
  assert.equal(isFollowUpExtractHint("我明天下午两点有一场面试"), true);
  assert.equal(isFollowUpExtractHint("周末要去体检，还得去医院"), true);
  assert.equal(isFollowUpExtractHint("今天天气不错，晚上吃点啥"), false);
});

test("类别归一：other 不等于放弃分类，关键词兜底回看病/搬家", () => {
  assert.equal(categorizeFollowUp("去复诊", "other"), "medical");
  assert.equal(categorizeFollowUp("签租房合同", "other"), "move");
  assert.equal(categorizeFollowUp("下午面试", "interview"), "interview");
  assert.equal(categorizeFollowUp("陪老王过个生日", ""), "birthday");
});

// ─── followAt：事件之后第一个合适的触点 ─────────────────────────────────

test("followAt：取 eventAt 之后最近的下班/明日预览触点，跳过早安", () => {
  const cases: Array<[number, number, number]> = [
    [at(0, 10, 0), at(0, 14, 0), at(0, 18, 30)], // 当天下午的面试 → 当天下班
    [at(0, 10, 0), at(0, 20, 0), at(0, 22, 0)], // 晚上 8 点结束 → 当天明日预览
    [at(0, 10, 0), at(1, 9, 0), at(1, 18, 30)], // 明早的考试 → 明天下班
    [at(0, 10, 0), at(0, 23, 30), at(1, 18, 30)], // 午夜前的事件 → 次天下班
  ];
  for (const [now, eventAt, expected] of cases) {
    const got = computeFollowAt({ eventAt, now, slotTimes: fakeSlots });
    assert.equal(got, expected, `now=${hhmm(now)} eventAt=${new Date(eventAt).toLocaleString("zh-CN")}`);
    assert.ok(got > eventAt, "跟进一定在事件之后");
  }
  // 没有触点计划（未装配/该日没排槽）：按冷启动默认钟 18:30 → 22:00 兜底
  assert.equal(computeFollowAt({ eventAt: at(0, 19, 0), now: at(0, 10, 0) }), at(0, 22, 0));
  assert.equal(computeFollowAt({ eventAt: at(0, 14, 0), now: at(0, 10, 0) }), at(0, 18, 30));
});

// ─── 提案形状与投递内容 ────────────────────────────────────────────────

test("提案：kind=commitment / tier=social / deliverAfter=followAt，本模块不自排程", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview", confidence: 0.9 });
    assert.equal(h.proposals.length, 1);
    const p = h.proposals[0]!;
    assert.equal(p.kind, "commitment");
    assert.equal(p.tier, "social", "跟进计入社交日预算（§3.10）");
    assert.equal(p.importance, "low");
    assert.equal(p.source, "follow_up");
    assert.equal(p.subject, "interview");
    assert.equal(p.actorId, "user-a");
    const row = getFollowUp(h.dbPath, p.dedupKey!.split(":").pop()!);
    assert.ok(row, "dedupKey 里带的事件行必须已落库");
    assert.equal(p.deliverAfter, row!.followAt, "只交出「最早可发时刻」，落点交给计划层");
    assert.equal(p.deliverAfter, at(0, 18, 30));
    assert.ok(p.expiresAt! > p.deliverAfter);
    assert.equal(p.firedAt, undefined, "近路跟进不带 firedAt，否则会被当成补推跳过排槽");
    // §4.3：可回答的触点第一条是「回复」，拒绝按钮跟在后头
    assert.deepEqual(
      (p.notifyOptions ?? []).map((o) => o.label),
      ["回复", "别跟进这个"],
    );
    assert.match(p.summary ?? "", /面试/);
  } finally {
    h.cleanup();
  }
});

test("提案：40 小时以上的远期事件补 firedAt，免得被待发区 48h 僵尸清理掉", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "去上海出差", eventAt: "2026-11-28T15:00", category: "travel" });
    assert.equal(h.proposals.length, 1);
    const p = h.proposals[0]!;
    assert.equal(p.deliverAfter, at(3, 18, 30));
    assert.equal(p.firedAt, p.deliverAfter);
  } finally {
    h.cleanup();
  }
});

test("话术：陈述句、不索要回复，句子本身把主动权交出去", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" });
    const p = h.proposals[0]!;
    // PRD §3.5 的正确示例逐字对齐
    assert.equal(p.directText, "今天面试辛苦了，结果出来想聊随时说。");
    // 深夜结束的事件当晚没有落点，顺延到次天下班：日期锚点要跟着变成「昨天」
    h.setNow(at(0, 23, 0));
    h.ingest({ event: "科目三考试", eventAt: "2026-11-25T22:30", category: "exam" });
    assert.equal(h.proposals[1]!.deliverAfter, at(1, 18, 30));
    assert.match(h.proposals[1]!.directText ?? "", /^昨天考完了，/);
    for (const proposal of h.proposals) {
      for (const text of [proposal.directText, proposal.summary]) {
        assert.ok(text && !/[？?]/.test(text), `跟进句不能是问句：${text}`);
        // 「面试怎么样？」式的考核味不要写进来（§3.5 表达要求）
        assert.ok(text && !/怎么样|报告一下|汇报一下|请务必/.test(text), `不能带考核味：${text}`);
      }
    }
  } finally {
    h.cleanup();
  }
});

// ─── private：锁屏遮罩 ─────────────────────────────────────────────────

test("private：通知正文只出「{管家名}：有句话想跟你说」，全文留在 summary", () => {
  const h = makeHarness();
  try {
    // 模型没标 sensitivity，健康词也要判私（确定性兜底）
    h.ingest({ event: "去医院复查", eventAt: "2026-11-25T15:00", category: "medical" });
    assert.equal(h.proposals.length, 1);
    const p = h.proposals[0]!;
    assert.equal(p.directText, `小舟：${PRIVATE_LOCK_SCREEN_HINT}`);
    assert.equal(p.title, "小舟");
    for (const leak of ["医院", "复查", "看诊", "医生"]) {
      assert.ok(!`${p.title}${p.directText}`.includes(leak), `锁屏面不得出现「${leak}」`);
    }
    // 点开（App 内正文用 summary）才看得见真句子
    assert.match(p.summary ?? "", /看诊辛苦了/);
    const row = getFollowUp(h.dbPath, h.followUpId(p))!;
    assert.equal(row.sensitivity, "private");
    assert.equal(row.event, "去医院复查", "落库行保留原文，事后能解释「为什么提这件事」");
  } finally {
    h.cleanup();
  }
});

test("private：管家未命名时正文退化成纯提示语，标题不留空（推送通道强制非空）", () => {
  const h = makeHarness({ butler: "" });
  try {
    h.ingest({ event: "办离婚手续", eventAt: "2026-11-25T15:00", sensitivity: "private" });
    const p = h.proposals[0]!;
    assert.equal(p.directText, PRIVATE_LOCK_SCREEN_HINT);
    assert.equal(p.title, PRIVATE_LOCK_SCREEN_HINT);
    assert.ok(!p.title.includes("离婚"));
  } finally {
    h.cleanup();
  }
});

test("normal：正文就是全文，不套遮罩", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "周末搬家", eventAt: "2026-11-28T09:00", category: "move" });
    const p = h.proposals[0]!;
    assert.equal(p.directText, p.summary);
    assert.equal(p.title, "周末搬家");
    assert.ok(!p.directText!.includes(PRIVATE_LOCK_SCREEN_HINT));
  } finally {
    h.cleanup();
  }
});

// ─── 一次事件只跟进一次 ────────────────────────────────────────────────

test("同一事件最多跟进 1 次：换个措辞再说一遍也不补发", () => {
  const h = makeHarness();
  try {
    const first = h.svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-1",
      followUps: [{ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" }],
    });
    assert.equal(first[0]?.reason, "submitted");
    const id = first[0]!.id;
    // 同一事件（时刻落在同一个 10 分钟桶）、换个措辞再说一遍 → 同一指纹
    const again = h.svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-2",
      followUps: [{ event: "明天有个面试", eventAt: "2026-11-25T14:05", category: "interview" }],
    });
    assert.equal(again[0]?.reason, "already_followed");
    assert.equal(again[0]?.id, id);
    assert.equal(h.proposals.length, 1);
    assert.equal(listFollowUps(h.dbPath, "user-a").length, 1);
    assert.equal(getFollowUp(h.dbPath, id)!.event, "下午面试", "已跟进的事件不再改写");
    assert.ok(getFollowUp(h.dbPath, id)!.submittedAt, "reminder_sent_at 是「已跟进」的落库依据");
    // 不同事件（另一场面试）照常跟进
    h.setNow(at(3, 10, 0));
    h.ingest({ event: "下一家面试", eventAt: "2026-11-28T14:00", category: "interview" });
    assert.equal(h.proposals.length, 2);
  } finally {
    h.cleanup();
  }
});

test("无锚点/过期事件不跟进：宁可不提，也不编一个日子", () => {
  const h = makeHarness();
  try {
    const out = h.svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-1",
      followUps: [
        { event: "改天去看看牙", category: "medical" }, // 无 eventAt
        { event: "上周的体检", eventAt: "2026-11-15T09:00", category: "medical" }, // 三天前
        { event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" },
      ],
    });
    assert.deepEqual(out.map((r) => r.reason), ["no_anchor", "stale_event", "submitted"]);
    assert.equal(h.proposals.length, 1);
    assert.equal(listFollowUps(h.dbPath, "user-a").length, 1);
    const empty = h.svc.ingestFromExtraction({ actorId: "  ", sourceRef: "x", followUps: [{ event: "下午面试" }] });
    assert.equal(empty[0]?.reason, "no_actor");
  } finally {
    h.cleanup();
  }
});

// ─── 「别跟进这个」→ 同类 30 天抑制 ────────────────────────────────────

test("别跟进这个：这件事取消 + 同类 30 天不再提，第 31 天自动恢复", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" });
    const p = h.proposals[0]!;
    const id = p.dedupKey!.split(":").pop()!;
    // 按钮带回的 ref = 跟进 id
    const res = h.svc.decline("user-a", id);
    assert.equal(res.ok, true);
    assert.equal(res.cancelled, 1);
    assert.match(res.message, /30 天内我不再提了/);
    assert.deepEqual(h.suppressions, [
      { kind: FOLLOWUP_SUPPRESS_KIND, keywords: ["interview"], createdAt: new Date(at(0, 10, 0)).toISOString() },
    ]);
    assert.equal(getFollowUp(h.dbPath, id)!.status, "cancelled");
    // 同类新事件：第 10 天仍在抑制期，不开口也不落库
    h.setNow(at(10, 10, 0));
    const blocked = h.ingest({ event: "另一场面试", eventAt: "2026-12-05T14:00", category: "interview" });
    assert.equal(blocked, "suppressed_category");
    assert.equal(h.proposals.length, 1);
    assert.equal(listFollowUpsByCategory(h.dbPath, "user-a", "interview").length, 1);
    // 第 31 天：窗口过了，同类事件照常跟进
    h.setNow(at(31, 10, 0));
    assert.equal(h.snapshotSuppressed().length, 0, "抑制期满自动失效（没有清理定时器，读侧判 TTL）");
    h.ingest({ event: "年后面试", eventAt: "2026-12-26T14:00", category: "interview" });
    assert.equal(h.proposals.length, 2);
    // 别的类别从来不受这次抑制影响
    h.ingest({ event: "科目三考试", eventAt: "2026-12-28T09:00", category: "exam" });
    assert.equal(h.proposals.length, 3);
    // 对话侧说「别跟进面试这类」：没有 id，按类别名收口
    const byCat = h.svc.decline("user-a", "面试");
    assert.equal(byCat.ok, true);
    assert.equal(byCat.category, "interview");
    assert.deepEqual(h.snapshotSuppressed(), ["interview"]);
    assert.equal(h.ingest({ event: "又被面试了", eventAt: "2026-12-30T14:00", category: "interview" }), "suppressed_category");
    assert.equal(h.proposals.length, 3);
  } finally {
    h.cleanup();
  }
});

test("抑制时间戳读不出来时按仍在抑制处理：用户表过态就宁可少说", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" });
    h.svc.decline("user-a", h.followUpId(h.proposals[0]!));
    h.corruptSuppression();
    assert.equal(h.svc.isCategorySuppressed("user-a", "interview", h.now() + 365 * DAY), true);
  } finally {
    h.cleanup();
  }
});

// ─── 频率档（§3.10）──────────────────────────────────────────────────

test("「只在有事时」档：事件照记，一条也不发；换回常规档才补发", () => {
  const h = makeHarness({ tier: "quiet" });
  try {
    const out = h.svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-1",
      followUps: [{ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" }],
    });
    assert.equal(out[0]?.reason, "quiet_tier");
    assert.equal(h.proposals.length, 0);
    assert.deepEqual(h.featureCalls, ["followup"], "问的是 followup 这一档");
    const rows = listFollowUps(h.dbPath, "user-a");
    assert.equal(rows.length, 1, "quiet 档只是不开口，事件得记住");
    assert.equal(rows[0]!.submittedAt, undefined);
    // 用户把频率调回常规：同一件事还能被后续对话再抽到时补上这一次
    h.setTier("normal");
    const again = h.svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-2",
      followUps: [{ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" }],
    });
    assert.equal(again[0]?.reason, "submitted");
    assert.equal(h.proposals.length, 1);
  } finally {
    h.cleanup();
  }
});

test("总开关关闭：整条链不留痕", () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-off-"));
  try {
    const svc = new FollowUpService({
      dbPath: join(dir, "agentic-memory.db"),
      submit: () => {
        throw new Error("关停后不该提交");
      },
      enabled: () => false,
      log: () => {},
    });
    const out = svc.ingestFromExtraction({
      actorId: "user-a",
      sourceRef: "conv-1",
      followUps: [{ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" }],
    });
    assert.deepEqual(out, [{ id: "", submitted: false, reason: "disabled" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 落库位置：复用 commitments 表，不新开库、不污染待办 ───────────────

test("落库：跟进行写在 agentic-memory 的 commitments 里，kind/source 满足待办 prompt 的过滤条件", () => {
  const h = makeHarness();
  try {
    h.ingest({ event: "下午面试", eventAt: "2026-11-25T14:00", category: "interview" });
    const id = h.proposals[0]!.dedupKey!.split(":").pop()!;
    assert.ok(existsSync(h.dbPath));
    assert.deepEqual(
      readdirSync(h.dir).filter((f) => f.endsWith(".db")),
      ["agentic-memory.db"],
      "§3.5 不新开 DB 文件",
    );
    const db = openAgenticSqlite(h.dbPath);
    try {
      const row = db
        .prepare(
          `SELECT kind, source, status, deadline, category, reminder_sent_at, text, actor_id
           FROM commitments WHERE id = ?`,
        )
        .get(id) as Record<string, string | null>;
      assert.ok(row, "行必须落在既有 commitments 表");
      // commitment-prompt-provider 的 query 用 `source <> 'follow_up'` 排除跟进：
      // 跟进不能挤掉【待办与承诺】里真正的用户承诺（§3.5 与日程/待办的分工）
      assert.equal(row.source, "follow_up");
      assert.equal(row.kind, "follow_up");
      assert.equal(row.status, "active");
      assert.equal(row.actor_id, "user-a");
      assert.equal(row.category, "interview");
      assert.equal(row.text, "跟进：下午面试");
      assert.equal(new Date(row.deadline!).getTime(), at(0, 18, 30), "deadline 存 followAt");
      assert.ok(row.reminder_sent_at, "提交过就写 reminder_sent_at");
    } finally {
      db.close();
    }
  } finally {
    h.cleanup();
  }
});
