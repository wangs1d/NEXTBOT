// 情报链路契约（闸口 → 面板 → 判断 → 成稿 → 投递）：
// 判断只看目录行，成稿才加载详情；说出后从面板删除；失败退避、原文不丢。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJudgeOutput } from "../src/proactivity/intel/intel-judge.js";
import { parseComposeOutput } from "../src/proactivity/intel/intel-compose.js";
import { IntelService } from "../src/proactivity/intel/intel-service.js";
import { IntelStore } from "../src/proactivity/intel/intel-store.js";
import type { PresenceState } from "../src/proactivity/pipeline-types.js";
import type {
  IntelComposeInput,
  IntelComposeResult,
  IntelComposer,
  IntelJudge,
  IntelJudgeInput,
  IntelJudgeResult,
} from "../src/proactivity/intel/intel-types.js";

const T0 = Date.UTC(2026, 9, 28, 1, 0, 0);

// ─── 判断/成稿解析 ───

test("judge-parse：容忍围栏与 {judgments:[]}，later 缺时刻按现在，needDetail 最多 2 条", () => {
  const ids = new Set(["a", "b", "c", "d", "e"]);
  const fenced = parseJudgeOutput(
    '```json\n[{"id":"a","verdict":"now","reason":"急","needDetail":true}]\n```',
    ids,
    T0,
  );
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].verdict, "now");
  assert.equal(fenced[0].needDetail, true);

  const wrapped = parseJudgeOutput(
    '{"judgments":[{"id":"b","verdict":"later","reason":"晚点说"},{"id":"c","verdict":"never","reason":"广告","needDetail":true},{"id":"d","verdict":"now","reason":"x","needDetail":true},{"id":"e","verdict":"now","reason":"y","needDetail":true}]}',
    ids,
    T0,
  );
  assert.equal(wrapped.length, 4);
  assert.equal(wrapped[0].dueAt, T0, "later 缺 dueAt 时不能把事拖没");
  assert.equal(wrapped[1].needDetail, undefined, "never 不需要详情");
  assert.equal(wrapped.filter((r) => r.needDetail).length, 2, "needDetail 有上限");
});

test("judge-parse：非法条目直接丢弃（留待重试）", () => {
  const out = parseJudgeOutput(
    JSON.stringify([
      { id: "a", verdict: "maybe", reason: "非法档位" },
      { id: "zzz", verdict: "now", reason: "不认识的 id" },
    ]),
    new Set(["a"]),
    T0,
  );
  assert.equal(out.length, 0);
});

test("compose-parse：围栏/{messages:[]}、空话丢弃、记忆候选保留", () => {
  const ids = new Set(["a", "b"]);
  const fenced = parseComposeOutput(
    '```json\n[{"id":"a","message":"十点的评审改到十一点了","needsConfirm":true,"memoryCandidate":"周五前给张伟回方案"}]\n```',
    ids,
  );
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].message, "十点的评审改到十一点了");
  assert.equal(fenced[0].needsConfirm, true);
  assert.match(fenced[0].memoryCandidate ?? "", /周五前/);

  const wrapped = parseComposeOutput(
    '{"messages":[{"id":"b","message":"   "},{"id":"a","message":"有件事要说"}]}',
    ids,
  );
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].id, "a");
});

// ─── 服务全链 ───

type Harness = {
  dir: string;
  service: IntelService;
  judgeInputs: IntelJudgeInput[];
  composeInputs: IntelComposeInput[];
  deliveries: Array<{ id: string; message: string }>;
  memories: string[];
  setNow: (ms: number) => void;
  dispose: () => void;
};

function makeHarness(opts: {
  judge?: IntelJudge;
  compose?: IntelComposer;
  deliver?: (call: number) => "delivered" | "retry" | "dropped";
  dataPath?: string;
  voiceCard?: () => string | null;
} = {}): Harness {
  let now = T0;
  let deliverCalls = 0;
  const dir = opts.dataPath ?? mkdtempSync(join(tmpdir(), "intel-panel-"));
  const judgeInputs: IntelJudgeInput[] = [];
  const composeInputs: IntelComposeInput[] = [];
  const deliveries: Harness["deliveries"] = [];
  const memories: string[] = [];

  const judge: IntelJudge =
    opts.judge ??
    (async (input) =>
      input.lines.map((line): IntelJudgeResult => ({ id: line.id, verdict: "now", reason: "要处理" })));
  const compose: IntelComposer =
    opts.compose ??
    (async (input) =>
      input.items.map((it): IntelComposeResult => ({ id: it.id, message: `说一句：${it.brief}` })));

  const service = new IntelService({
    dataPath: dir,
    nowFn: () => now,
    presence: { getPresence: () => "active" as PresenceState },
    inConversation: () => false,
    actors: () => ["u1"],
    judge: async (input) => {
      judgeInputs.push(input);
      return judge(input);
    },
    compose: async (input) => {
      composeInputs.push(input);
      return compose(input);
    },
    deliver: async ({ entry, message }) => {
      deliverCalls += 1;
      deliveries.push({ id: entry.id, message });
      return opts.deliver ? opts.deliver(deliverCalls) : "delivered";
    },
    onMemoryCandidate: (_actorId, candidate) => {
      memories.push(candidate);
    },
    ...(opts.voiceCard ? { voiceCard: opts.voiceCard } : {}),
    batchDelayMs: 60_000,
    autoTicker: false,
  });

  return {
    dir,
    service,
    judgeInputs,
    composeInputs,
    deliveries,
    memories,
    setNow: (ms) => {
      now = ms;
    },
    dispose: () => {
      service.stop();
      if (!opts.dataPath) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const mail = (externalId: string, over: { subject?: string; text?: string; source?: string } = {}) => ({
  actorId: "u1",
  source: over.source ?? "email",
  title: over.subject ?? "主题",
  text: over.text ?? "正文",
  externalId,
});

test("svc：now → 目录行判断 → 懒加载详情成稿 → 投递 → 面板删除", async () => {
  const h = makeHarness();
  try {
    h.service.ingest(
      mail("1", {
        subject: "评审改期",
        text: "评审 10:00 → 11:00，会议室不变。\n\n在 2026年10月27日 写道：\n> 明天十点评审",
      }),
    );
    await h.service.evaluate("u1");

    assert.equal(h.judgeInputs.length, 1);
    assert.equal(h.judgeInputs[0].lines.length, 1);
    assert.equal(h.judgeInputs[0].lines[0].detail, undefined, "判断只看目录行");
    assert.match(h.judgeInputs[0].lines[0].brief, /评审改期/);
    assert.equal(h.composeInputs.length, 1);
    assert.match(h.composeInputs[0].items[0].detail, /11:00/, "成稿才加载详情");
    assert.doesNotMatch(h.composeInputs[0].items[0].detail, /明天十点评审/, "引用历史已削掉");
    assert.equal(h.deliveries.length, 1);
    assert.match(h.deliveries[0].message, /说一句/);

    assert.equal(h.service.query("u1").length, 0, "说出后从面板删除");
    assert.notEqual(h.service.store.findHistory("email:1"), undefined);
    assert.equal(h.service.status().spokenToday, 1);
    assert.equal(h.service.status().gate.blocked, 0);
  } finally {
    h.dispose();
  }
});

test("svc：later 到点才成稿投递，never 不成稿", async () => {
  const h = makeHarness({
    judge: async (input) =>
      input.lines.map((line): IntelJudgeResult =>
        line.id === "email:1"
          ? { id: line.id, verdict: "later", reason: "出发前说", dueAt: T0 + 3600_000 }
          : { id: line.id, verdict: "never", reason: "广告" },
      ),
  });
  try {
    h.service.ingest(mail("1", { subject: "航班", text: "明天 8:30 出发" }));
    h.service.ingest(mail("2", { subject: "限时活动", text: "来看看" }));
    await h.service.evaluate("u1");
    assert.equal(h.composeInputs.length, 0, "未到点不成稿");
    assert.equal(h.deliveries.length, 0);
    const status = h.service.status();
    assert.equal(status.store.held, 1);
    assert.equal(status.store.new, 0);
    assert.equal(h.service.query("u1")[0]?.items[0]?.state, "held");

    h.setNow(T0 + 3600_000);
    await h.service.evaluate("u1");
    assert.equal(h.composeInputs.length, 1);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].id, "email:1");
  } finally {
    h.dispose();
  }
});

test("svc：判断失败原文留面板，退避窗口内不重烧调用，恢复后补说", async () => {
  let fail = true;
  let calls = 0;
  const h = makeHarness({
    judge: async (input) => {
      calls += 1;
      if (fail) throw new Error("upstream 502");
      return input.lines.map((line): IntelJudgeResult => ({ id: line.id, verdict: "now", reason: "要回款" }));
    },
  });
  try {
    h.service.ingest(mail("1", { subject: "催款", text: "请在今日内付款" }));
    await h.service.evaluate("u1");

    const status = h.service.status();
    assert.equal(status.pending, 1, "判断失败不能把原文丢掉");
    assert.equal(h.deliveries.length, 0);
    assert.equal(status.recent[0].attempts, 1, "面板要能看到失败次数");
    assert.match(status.lastJudgeError ?? "", /upstream 502/);

    fail = false;
    await h.service.evaluate("u1");
    assert.equal(calls, 1, "退避未到不重烧调用");
    assert.equal(h.deliveries.length, 0);

    h.setNow(T0 + 60_000);
    await h.service.evaluate("u1");
    assert.equal(h.deliveries.length, 1, "模型恢复后同一原文补说");
    assert.equal(h.service.status().pending, 0);
  } finally {
    h.dispose();
  }
});

test("svc：needDetail 追问带详情，第二遍结论覆盖第一遍", async () => {
  let calls = 0;
  const h = makeHarness({
    judge: async (input) => {
      calls += 1;
      const line = input.lines[0];
      if (line.detail) return [{ id: line.id, verdict: "never", reason: "详情里只是例行通知" }];
      return [{ id: line.id, verdict: "now", reason: "像会议变更", needDetail: true }];
    },
  });
  try {
    h.service.ingest(mail("1", { subject: "会议", text: "会议安排详见内网日历。" }));
    await h.service.evaluate("u1");
    assert.equal(calls, 2, "先看目录，再按需追问详情");
    assert.equal(h.composeInputs.length, 0, "第二遍判 never 就不成稿");
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.service.query("u1").length, 0);
  } finally {
    h.dispose();
  }
});

test("svc：成稿失败留在 to_compose，退避后重新成稿", async () => {
  let fail = true;
  let calls = 0;
  const h = makeHarness({
    compose: async (input) => {
      calls += 1;
      if (fail) throw new Error("compose 502");
      return input.items.map((it): IntelComposeResult => ({ id: it.id, message: `说一句：${it.brief}` }));
    },
  });
  try {
    h.service.ingest(mail("1", { subject: "合同", text: "今天到期" }));
    await h.service.evaluate("u1");
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.service.status().judged, 1, "成稿失败的条目仍在面板");
    assert.match(h.service.status().lastComposeError ?? "", /compose 502/);

    fail = false;
    await h.service.evaluate("u1");
    assert.equal(calls, 1, "退避未到不重烧成稿调用");

    h.setNow(T0 + 60_000);
    await h.service.evaluate("u1");
    assert.equal(calls, 2);
    assert.equal(h.deliveries.length, 1);
  } finally {
    h.dispose();
  }
});

test("svc：投递通道暂不可用 → 下一轮重投同一句，不重新成稿", async () => {
  const h = makeHarness({ deliver: (call) => (call === 1 ? "retry" : "delivered") });
  try {
    h.service.ingest(mail("1", { subject: "会议", text: "提前到九点" }));
    await h.service.evaluate("u1");
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.service.status().store.toCompose, 1, "没送出去保持待投，不重复判断");

    await h.service.evaluate("u1");
    assert.equal(h.deliveries.length, 2);
    assert.equal(h.deliveries[1].message, h.deliveries[0].message, "重投同一句");
    assert.equal(h.composeInputs.length, 1, "成稿只做一次");
  } finally {
    h.dispose();
  }
});

test("svc：入口闸挡住验证码/营销，不进面板也不调用模型", async () => {
  let calls = 0;
  const h = makeHarness({
    judge: async (input) => {
      calls += 1;
      return input.lines.map((line): IntelJudgeResult => ({ id: line.id, verdict: "never", reason: "x" }));
    },
  });
  try {
    const otp = h.service.ingest(mail("1", { subject: "验证码", text: "你的验证码是 614209，15 分钟内有效" }));
    const promo = h.service.ingest(mail("2", { subject: "限时特惠", text: "全场五折" }));
    const normal = h.service.ingest(mail("3", { subject: "开会", text: "九点开会" }));
    assert.equal(otp, null);
    assert.equal(promo, null);
    assert.notEqual(normal, null);
    await h.service.evaluate("u1");
    assert.equal(calls, 1);
    assert.equal(h.service.status().gate.blocked, 2);
    assert.equal(h.service.status().pending, 0, "被挡的消息不占面板");
  } finally {
    h.dispose();
  }
});

test("svc：跨来源同一事件键合并，只判断一次；说出后墓碑挡住重复通知", async () => {
  const h = makeHarness();
  try {
    h.service.ingest({
      actorId: "u1",
      source: "email",
      title: "评审改期",
      text: "改到十一点",
      externalId: "e1",
      eventKey: "meeting-42",
    });
    h.service.ingest({
      actorId: "u1",
      source: "wechat",
      title: "张伟",
      text: "评审改到十一点了",
      externalId: "w1",
      eventKey: "meeting-42",
    });
    const entry = h.service.store.get("event:meeting-42");
    assert.equal(entry?.version, 2);
    assert.deepEqual(entry?.refs, ["email:e1", "wechat:w1"]);

    await h.service.evaluate("u1");
    assert.equal(h.judgeInputs.length, 1);
    assert.equal(h.judgeInputs[0].lines.length, 1, "同一事件只占一行");
    assert.equal(h.deliveries.length, 1);

    const again = h.service.ingest({
      actorId: "u1",
      source: "wechat",
      title: "张伟",
      text: "评审改到十一点了",
      externalId: "w2",
      eventKey: "meeting-42",
    });
    assert.equal(again, null, "已经说过的事件不再入面板");
  } finally {
    h.dispose();
  }
});

test("svc：已发未确认留在面板，确认后关闭", async () => {
  const h = makeHarness({
    compose: async (input) =>
      input.items.map((it): IntelComposeResult => ({ id: it.id, message: "方案今天要给张伟", needsConfirm: true })),
  });
  try {
    h.service.ingest(mail("1", { subject: "方案", text: "今天必须发出去" }));
    await h.service.evaluate("u1");
    const groups = h.service.query("u1");
    assert.equal(groups[0]?.items[0]?.state, "unconfirmed");
    assert.equal(h.service.status().store.unconfirmed, 1);
    const hist = h.service.store.findHistory("email:1");
    assert.equal(hist?.needsConfirm, true);
    assert.equal(hist?.acknowledged, false);

    assert.equal(h.service.acknowledge("email:1"), true);
    assert.equal(h.service.query("u1").length, 0);
    assert.equal(h.service.store.findHistory("email:1")?.acknowledged, true);
  } finally {
    h.dispose();
  }
});

test("svc：记忆候选只在投递成功后交给记忆模块", async () => {
  const h = makeHarness({
    compose: async (input) =>
      input.items.map((it): IntelComposeResult => ({
        id: it.id,
        message: "记得周五前把方案发给张伟",
        memoryCandidate: "答应张伟周五前发方案",
      })),
    deliver: (call) => (call === 1 ? "retry" : "delivered"),
  });
  try {
    h.service.ingest(mail("1", { subject: "方案", text: "周五前发" }));
    await h.service.evaluate("u1");
    assert.equal(h.memories.length, 0, "没送出去不写记忆");
    await h.service.evaluate("u1");
    assert.deepEqual(h.memories, ["答应张伟周五前发方案"]);
  } finally {
    h.dispose();
  }
});

test("svc：落盘后重启面板与历史都在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intel-persist-"));
  try {
    const a = new IntelStore({ dataPath: dir, nowFn: () => T0 });
    a.ingest({
      id: "email:1",
      eventKey: "email:1",
      actorId: "u1",
      source: "email",
      receivedAt: T0,
      updatedAt: T0,
      version: 1,
      refs: ["email:e1"],
      raw: { source: "email", title: "主题", text: "正文" },
      brief: "主题｜正文",
      detail: "主题：主题\n\n正文",
      state: "new",
      attempts: 0,
    });
    a.applyJudgment("email:1", { verdict: "later", reason: "晚点说", dueAt: T0 + 1000 }, T0);

    const b = new IntelStore({ dataPath: dir, nowFn: () => T0 });
    const restored = b.get("email:1");
    assert.ok(restored);
    assert.equal(restored?.state, "held");
    assert.equal(restored?.brief, "主题｜正文");
    assert.equal(restored?.dueAt, T0 + 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("svc：判断输入带最近说过的话（避免重复开口）", async () => {
  const h = makeHarness();
  try {
    h.service.ingest(mail("1", { subject: "第一件", text: "正文" }));
    await h.service.evaluate("u1");
    h.service.ingest(mail("2", { subject: "第二件", text: "正文" }));
    await h.service.evaluate("u1");
    assert.equal(h.judgeInputs.length, 2);
    assert.deepEqual(
      h.judgeInputs[1].feedback.recentSpoken.map((s) => s.message),
      [h.deliveries[0].message],
    );
    assert.equal(h.judgeInputs[1].timezone.length > 0, true);
  } finally {
    h.dispose();
  }
});

// ─── 判断草稿：一次调用成稿，不合格才升级 ───

test("judge-parse：草稿随判断一起产出，never 不带草稿", () => {
  const ids = new Set(["a", "b", "c"]);
  const out = parseJudgeOutput(
    JSON.stringify([
      { id: "a", verdict: "now", reason: "急", draft: "评审改到 11:00 了", needsConfirm: true, memoryCandidate: "记得改日历" },
      { id: "b", verdict: "never", reason: "广告", draft: "不说了", needsConfirm: true, memoryCandidate: "不该留" },
      { id: "c", verdict: "now", reason: "没事", draft: "  " },
    ]),
    ids,
    T0,
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].draft, "评审改到 11:00 了");
  assert.equal(out[0].needsConfirm, true);
  assert.equal(out[0].memoryCandidate, "记得改日历");
  assert.equal(out[1].draft, undefined, "never 不留草稿");
  assert.equal(out[1].needsConfirm, undefined);
  assert.equal(out[1].memoryCandidate, undefined);
  assert.equal(out[2].draft, undefined, "空草稿不算产出");
});

test("svc：判断草稿过了事实校验直接投递，成稿模型一次都不调", async () => {
  const h = makeHarness({
    judge: async (input) =>
      input.lines.map((line): IntelJudgeResult => ({
        id: line.id,
        verdict: "now",
        reason: "要改日程",
        draft: "评审改到 11:00 了，会议室不变",
        needsConfirm: true,
      })),
  });
  try {
    h.service.ingest(mail("1", { subject: "评审改期", text: "评审 10:00 → 11:00，会议室不变。" }));
    await h.service.evaluate("u1");

    assert.equal(h.composeInputs.length, 0, "草稿合格就不再花一次成稿调用");
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].message, "评审改到 11:00 了，会议室不变");
    assert.equal(h.service.status().store.unconfirmed, 1, "needsConfirm 随草稿透传");
  } finally {
    h.dispose();
  }
});

test("svc：草稿编造原文没有的班次/金额 → 升级成稿重写", async () => {
  const h = makeHarness({
    judge: async (input) =>
      input.lines.map((line): IntelJudgeResult => ({
        id: line.id,
        verdict: "now",
        reason: "值得说",
        draft: "你的航班 CA1234 改签到 18:00，退了 580 元",
      })),
  });
  try {
    h.service.ingest(mail("1", { subject: "航班", text: "你的航班有变动，请留意短信。" }));
    await h.service.evaluate("u1");

    assert.equal(h.composeInputs.length, 1, "编造的事实必须退回成稿");
    assert.match(h.composeInputs[0].items[0].detail, /航班/, "升级时才带详情");
    assert.equal(h.deliveries.length, 1, "成稿兜底后照常投递");
    assert.match(h.deliveries[0].message, /说一句/);
  } finally {
    h.dispose();
  }
});

test("svc：later 的草稿到点直接投递，不再成稿", async () => {
  const h = makeHarness({
    judge: async (input) =>
      input.lines.map((line): IntelJudgeResult => ({
        id: line.id,
        verdict: "later",
        reason: "出发前说",
        draft: "10月28日 18:35 的航班 CA1234 起飞，记得提前到",
        dueAt: T0 + 3600_000,
      })),
  });
  try {
    h.service.ingest(mail("1", { subject: "航班", text: "10月28日 18:35 航班 CA1234 从首都机场起飞。" }));
    await h.service.evaluate("u1");
    assert.equal(h.composeInputs.length, 0, "未到点不判断也不成稿");

    h.setNow(T0 + 3600_000);
    await h.service.evaluate("u1");
    assert.equal(h.deliveries.length, 1);
    assert.match(h.deliveries[0].message, /CA1234/);
    assert.equal(h.composeInputs.length, 0, "草稿原样可用，成稿模型不调");
  } finally {
    h.dispose();
  }
});

test("svc：跨天草稿含相对日期 → 升级成稿重写", async () => {
  const h = makeHarness({
    judge: async (input) =>
      input.lines.map((line): IntelJudgeResult => ({
        id: line.id,
        verdict: "later",
        reason: "明早说",
        draft: "明早 8:30 出发，别迟到",
        dueAt: T0 + 26 * 3600_000,
      })),
  });
  try {
    h.service.ingest(mail("1", { subject: "航班", text: "10月29日 8:30 起飞。" }));
    await h.service.evaluate("u1");
    h.setNow(T0 + 26 * 3600_000);
    await h.service.evaluate("u1");
    assert.equal(h.composeInputs.length, 1, "「明早」到第二天已失真，必须重写");
    assert.equal(h.deliveries.length, 1);
  } finally {
    h.dispose();
  }
});

test("svc：风格卡进判断上下文，只影响草稿措辞", async () => {
  const h = makeHarness({ voiceCard: () => "说话风格：短句，少客套。" });
  try {
    h.service.ingest(mail("1", { subject: "会议", text: "提前到九点。" }));
    await h.service.evaluate("u1");
    assert.equal(h.judgeInputs[0].voiceCard, "说话风格：短句，少客套。");
  } finally {
    h.dispose();
  }
});
