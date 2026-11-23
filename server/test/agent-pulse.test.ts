// AgentPulseService（Muse 式聚合 → agent 审阅 → 统一语气层 → 主动开口）单测。
// 覆盖：delta 闸（同材料不重复评审）、NOP 沉默、LLM 输出清洗、统一语气层接入
// （初稿 → polish 终稿）、完整留痕返回、状态落盘重启不重评。
// 注：确定性防打扰闸（静默时段/最小间隔/每日上限）已于 2026-10-25 按用户拍板
// 删除——打扰控制收敛为 agent 自律（NOP）+ 管道 social 层仲裁。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentPulseService,
  buildPulsePrompt,
  extractRapport,
  isPriceNews,
  parsePulseOutput,
  pulseSignature,
  resolvePulseNotifyOptions,
  sanitizePulseMessage,
  type PulseAggregate,
} from "../src/proactivity/agent-pulse.js";

function mkAggregate(overrides: Partial<PulseAggregate> = {}): PulseAggregate {
  return {
    tasks: [{ at: "14:00", title: "项目周会" }],
    unread: ["妈妈"],
    goals: [],
    interests: [],
    goalLine: null,
    ...overrides,
  };
}

type Harness = {
  svc: AgentPulseService;
  submitted: Array<{
    kind: string;
    tier: string;
    title: string;
    directText: string;
    dedupKey: string;
    notifyOptions?: Array<{ action: string; label: string; ref?: string }>;
    suppressDefaultActions?: boolean;
  }>;
  llmCalls: string[];
  polishCalls: Array<{ kind: string; facts: Record<string, unknown> }>;
  setAggregate: (a: PulseAggregate | null) => void;
  setLlm: (out: string | Error) => void;
  setPolish: (out: string | null) => void;
  setNow: (d: Date) => void;
};

function mkHarness(opts: { statePath?: string; now?: Date; polish?: boolean } = {}): Harness {
  const submitted: Harness["submitted"] = [];
  const llmCalls: string[] = [];
  const polishCalls: Harness["polishCalls"] = [];
  let aggregate: PulseAggregate | null = mkAggregate();
  let llmOut: string | Error = "你下午有个项目周会，材料我看了下，要不要提前过一眼？";
  let polishOut: string | null = "你下午的项目周会，我看了下材料，要不要提前过一眼？";
  let now = opts.now ?? new Date("2026-10-25T14:00:00");
  const svc = new AgentPulseService({
    actors: () => ["u1"],
    aggregate: () => aggregate,
    llmComplete: async (prompt) => {
      llmCalls.push(prompt);
      if (llmOut instanceof Error) throw llmOut;
      return llmOut;
    },
    ...(opts.polish
      ? {
          polish: async (input) => {
            polishCalls.push({ kind: input.kind, facts: input.facts });
            return polishOut ?? input.fallback;
          },
        }
      : {}),
    submitProposal: (p) => {
      submitted.push({
        kind: p.kind,
        tier: p.tier,
        title: p.title,
        directText: p.directText,
        dedupKey: p.dedupKey,
        ...(p.notifyOptions?.length ? { notifyOptions: p.notifyOptions } : {}),
        ...(p.suppressDefaultActions ? { suppressDefaultActions: true } : {}),
      });
      return { verdict: "delivered" };
    },
    statePath: opts.statePath,
    nowFn: () => now.getTime(),
  });
  return {
    svc,
    submitted,
    llmCalls,
    polishCalls,
    setAggregate: (a) => {
      aggregate = a;
    },
    setLlm: (out) => {
      llmOut = out;
    },
    setPolish: (out) => {
      polishOut = out;
    },
    setNow: (d) => {
      now = d;
    },
  };
}

test("agent pulse: LLM 判断值得说 → 产出无标题普通消息（无「心跳回顾」牌子）", async () => {
  const h = mkHarness();
  const result = await h.svc.check();
  assert.equal(result.reason, "sent");
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].kind, "agent_pulse");
  assert.equal(h.submitted[0].title, "", "不再有「心跳回顾」标题");
  assert.ok(h.submitted[0].directText.includes("周会"));
  assert.ok(h.llmCalls[0].includes("14:00 项目周会"), "日程进 prompt");
  assert.ok(h.llmCalls[0].includes("妈妈"), "未读进 prompt");
  assert.ok(!h.llmCalls[0].includes("天气"), "天气不进 prompt（归明日预告）");
});

test("agent pulse: 日程行去重，且提示词禁止从对话摘录编造冲突/取整时间", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-01T17:35:00"),
    mkAggregate({
      tasks: [
        { at: "18:00", title: "去游泳" },
        { at: "18:00", title: "去游泳" },
        { at: "18:00", title: "  " },
        { at: "17:30", title: "去健身" },
      ],
      recentTurns: ["一分钟后提醒我去健身"],
    }),
  );
  assert.equal((prompt.match(/- \[\d+\] 18:00 去游泳/g) ?? []).length, 1, "重复安排只保留一行");
  assert.ok(!/^- \[\d+\] 18:00\s*$/m.test(prompt), "空事项行不进材料");
  assert.ok(prompt.includes("两个不同事项同一时刻才算冲突"), "禁止无中生有冲突");
  assert.ok(prompt.includes("不要取整"), "时间必须照抄 HH:mm");
});

test("agent pulse: 统一语气层——初稿经 polish 出终稿，提交与留痕都是终稿", async () => {
  const h = mkHarness({ polish: true });
  const result = await h.svc.check();
  assert.equal(h.polishCalls.length, 1);
  assert.equal(h.polishCalls[0].kind, "agent_pulse");
  assert.ok(String(h.polishCalls[0].facts.draft).includes("周会"), "初稿进语气层");
  assert.equal(h.submitted[0].directText, "你下午的项目周会，我看了下材料，要不要提前过一眼？", "提交的是语气层终稿");
  assert.equal(result.finalText, h.submitted[0].directText);
  assert.notEqual(result.finalText, result.message, "终稿与初稿不同（语气层生效）");
});

test("agent pulse: 未接语气层时直接用初稿；polish 异常/空回退初稿", async () => {
  const h1 = mkHarness();
  const r1 = await h1.svc.check();
  assert.equal(r1.finalText, r1.message, "无语气层 = 终稿即初稿");

  const h2 = mkHarness({ polish: true });
  h2.setPolish(null);
  const r2 = await h2.svc.check();
  assert.equal(r2.finalText, r2.message, "polish 返回空 → 回退初稿");
});

test("agent pulse: NOP → 沉默且同材料不重复评审", async () => {
  const h = mkHarness();
  h.setLlm("NOP");
  const r1 = await h.svc.check();
  assert.equal(r1.reason, "nop");
  assert.equal(h.submitted.length, 0);
  assert.equal(h.llmCalls.length, 1, "评审过一次");
  const r2 = await h.svc.check();
  assert.equal(r2.reason, "unchanged");
  assert.equal(h.llmCalls.length, 1, "同材料 delta 闸拦住，不烧第二次 token");
});

test("agent pulse: 材料有新增才再次评审", async () => {
  const h = mkHarness();
  h.setLlm("NOP");
  await h.svc.check();
  h.setAggregate(mkAggregate({ unread: ["妈妈", "Qoder"] }));
  h.setNow(new Date("2026-10-25T14:20:00"));
  const r = await h.svc.check();
  assert.equal(r.reason, "nop");
  assert.equal(h.llmCalls.length, 2, "新未读 → 新材料 → 再评审");
});

test("agent pulse: 无材料重置指纹，之后有材料重新评审", async () => {
  const h = mkHarness();
  h.setLlm("NOP");
  await h.svc.check();
  h.setAggregate(null);
  const r1 = await h.svc.check();
  assert.equal(r1.reason, "no_material");
  h.setAggregate(mkAggregate());
  const r2 = await h.svc.check();
  assert.equal(r2.ran, true, "材料回来了 → 再评审（不被旧指纹挡住）");
  assert.equal(h.llmCalls.length, 2);
});

test("agent pulse: LLM 异常按本批已评审处理且不重试", async () => {
  const h = mkHarness();
  h.setLlm(new Error("provider down"));
  const r = await h.svc.check();
  assert.equal(r.reason, "llm_error");
  assert.equal(h.submitted.length, 0);
  await h.svc.check();
  assert.equal(h.llmCalls.length, 1, "异常也记指纹，不反复重试");
});

test("agent pulse: 状态落盘——重启后同材料不重评", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-pulse-"));
  try {
    const statePath = join(dir, "pulse.json");
    const h1 = mkHarness({ statePath });
    await h1.svc.check();
    assert.equal(h1.submitted.length, 1);

    const h2 = mkHarness({ statePath });
    const r2 = await h2.svc.check();
    assert.equal(r2.reason, "unchanged", "重启后同材料指纹命中，不重评");
    assert.equal(h2.llmCalls.length, 0);
    h2.setAggregate(mkAggregate({ tasks: [{ at: "16:00", title: "新安排" }] }));
    await h2.svc.check();
    assert.equal(h2.llmCalls.length, 1, "新材料正常评审（无闸门）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent pulse: 输出清洗——剥引号/围栏、NOP 变体、折行限长", () => {
  assert.equal(sanitizePulseMessage("NOP"), null);
  assert.equal(sanitizePulseMessage("nop。"), null);
  assert.equal(sanitizePulseMessage(""), null);
  assert.equal(sanitizePulseMessage("  「下午三点有个会」 "), "下午三点有个会");
  assert.equal(sanitizePulseMessage("```\n记得交周报\n```"), "记得交周报");
  assert.equal(sanitizePulseMessage("第一句\n第二句"), "第一句 第二句", "折行折叠成一句");
  assert.ok(sanitizePulseMessage("x".repeat(300))!.length <= 220, "超长截断");
});

test("agent pulse: 结构化输出——JSON 带动作，纯文本仍兼容", () => {
  const parsed = parsePulseOutput(
    '```json\n{"speak":true,"text":"11 点的游泳还去吗？","options":[{"action":"schedule_complete","label":"去过了","target":1},{"action":"schedule_snooze","label":"改天再说","target":1}]}\n```',
  );
  assert.equal(parsed.message, "11 点的游泳还去吗？");
  assert.deepEqual(parsed.options.map((o) => o.action), ["schedule_complete", "schedule_snooze"]);
  // 旧协议纯文本：照常开口，只是没有按钮
  const legacy = parsePulseOutput("你下午有个项目周会，要不要提前过一眼？");
  assert.equal(legacy.message, "你下午有个项目周会，要不要提前过一眼？");
  assert.equal(legacy.options.length, 0);
  // speak=false → 不说
  assert.equal(parsePulseOutput('{"speak":false,"text":"不该说"}').message, null);
  // 看起来像 JSON 却解析失败 → 不说，不把半个 JSON 当消息发出去
  assert.equal(parsePulseOutput('{"speak":true,"text":').message, null);
});

test("agent pulse: 选项落成真动作——target 必须解析到带 ref 的单次日程", () => {
  const tasks = [
    { at: "11:00", title: "游泳", ref: "task-swim", overdue: true },
    { at: "15:00", title: "周会" }, // 周期日程：没有 ref
  ];
  const opts = resolvePulseNotifyOptions(
    [
      { action: "schedule_complete", label: "去过了。", target: 1 },
      { action: "schedule_snooze", label: "改天再说", target: 2 }, // 没有 ref → 丢弃
      { action: "schedule_snooze", label: "改天", target: 1 },
      { action: "acknowledge", label: "知道了" }, // 超过两项上限 → 丢弃
    ],
    tasks,
  );
  assert.equal(opts.length, 2, "最多两项，且无落点的按钮被丢弃");
  assert.deepEqual(opts[0], { action: "schedule_complete", label: "去过了", ref: "task-swim" });
  assert.deepEqual(opts[1], { action: "schedule_snooze", label: "改天", ref: "task-swim" });
  // 越界 target → 丢弃（不放按了不知道改哪条日程的按钮）
  assert.deepEqual(
    resolvePulseNotifyOptions([{ action: "schedule_complete", label: "完成", target: 9 }], tasks),
    [],
  );
  // 通用动作不需要 target
  assert.deepEqual(resolvePulseNotifyOptions([{ action: "dismiss", label: "不用提" }], tasks), [
    { action: "dismiss", label: "不用提" },
  ]);
});

test("agent pulse: LLM 按内容给按钮 → 提案带领域动作，且禁止默认双按钮兜底", async () => {
  const h = mkHarness({ now: new Date("2026-11-23T17:30:00") });
  h.setAggregate(
    mkAggregate({
      tasks: [{ at: "11:00", title: "游泳", ref: "task-swim", overdue: true }],
    }),
  );
  h.setLlm(
    '{"speak":true,"text":"11 点那场游泳都过六个多小时了，还去吗？","options":[{"action":"schedule_complete","label":"去过了","target":1},{"action":"schedule_snooze","label":"改天再说","target":1}]}',
  );
  const r = await h.svc.check();
  assert.equal(r.reason, "sent");
  assert.equal(h.submitted[0].directText, "11 点那场游泳都过六个多小时了，还去吗？");
  assert.equal(h.submitted[0].suppressDefaultActions, true, "没有真动作时也不回退假按钮");
  assert.deepEqual(h.submitted[0].notifyOptions, [
    { action: "schedule_complete", label: "去过了", ref: "task-swim" },
    { action: "schedule_snooze", label: "改天再说", ref: "task-swim" },
  ]);
  // 材料里带编号与「可拍板 / 已过点」标记，模型才有东西可引用
  assert.ok(h.llmCalls[0].includes("[1] 11:00 游泳（可拍板，已过点）"));

  // 纯闲聊（没有可执行的事）→ 不给按钮，但仍不回退默认双按钮
  const h2 = mkHarness({ now: new Date("2026-11-23T17:30:00") });
  h2.setLlm("在外面呢？这是去哪儿");
  await h2.svc.check();
  assert.equal(h2.submitted[0].notifyOptions, undefined);
  assert.equal(h2.submitted[0].suppressDefaultActions, true);
});

test("agent pulse: 发现层材料进 prompt、计入指纹与有料判定", () => {
  // 发现段进 prompt
  const prompt = buildPulsePrompt(new Date("2026-10-25T14:00:00"), mkAggregate({
    findings: ["mail_watch：房东提到搬家时间定了"],
  }));
  assert.ok(prompt.includes("房东提到搬家时间定了"), "发现进 prompt");
  assert.ok(prompt.includes("还没跟用户说过的发现"), "发现段标头在 prompt");
  // 指纹对发现变化敏感
  assert.notEqual(
    pulseSignature({ tasks: [], unread: [], goals: [], interests: [], findings: ["a"] }),
    pulseSignature({ tasks: [], unread: [], goals: [], interests: [], findings: ["b"] }),
  );
});

test("agent pulse: 只有发现层材料也触发评审", async () => {
  const h = mkHarness();
  h.setAggregate({ tasks: [], unread: [], goals: [], interests: [], goalLine: null, findings: ["calendar：承诺到期"] });
  h.setLlm("NOP");
  const r = await h.svc.check();
  assert.equal(r.ran, true, "只有发现也算有材料");
  assert.equal(r.reason, "nop");
});

test("agent pulse: 降价类消息走 must 层随到随送（agent_pulse_price），普通消息保持 social", async () => {
  const h = mkHarness({ polish: true });
  h.setLlm("你让我盯的机械键盘降价了，要看一眼吗？");
  h.setPolish("王哥，你让我盯的那款机械键盘降价了，要不要看一眼？");
  await h.svc.check();
  assert.equal(h.submitted[0].kind, "agent_pulse_price");
  assert.equal(h.submitted[0].tier, "must", "用户点名盯的结果 = must 层随到随送");

  const h2 = mkHarness();
  h2.setLlm("你下午有个项目周会，要不要提前过一眼材料？");
  await h2.svc.check();
  assert.equal(h2.submitted[0].kind, "agent_pulse");
  assert.equal(h2.submitted[0].tier, "social", "非降价消息保持 social 层");
});

test("agent pulse: isPriceNews 关键词边界", () => {
  assert.ok(isPriceNews("机械键盘降价了"));
  assert.ok(isPriceNews("价格降到 200 以内了"));
  assert.ok(isPriceNews("你让我盯的快递有动静了"));
  assert.ok(isPriceNews("双十一打折了"));
  assert.ok(!isPriceNews("你下午有个项目周会"));
  assert.ok(!isPriceNews("妈妈发消息来了"));
});

test("agent pulse: 指纹对材料变化敏感", () => {
  const a = mkAggregate();
  const b = mkAggregate({ unread: ["妈妈", "老师"] });
  assert.notEqual(pulseSignature(a), pulseSignature(b));
  assert.equal(pulseSignature(a), pulseSignature(mkAggregate()), "同材料同指纹");
});

test("agent pulse: prompt 带判断标准与现在时间", () => {
  const prompt = buildPulsePrompt(new Date("2026-10-25T14:00:00"), mkAggregate());
  assert.ok(prompt.includes("宁可沉默，不可打扰"));
  assert.ok(prompt.includes("2026-10-25"));
  assert.ok(prompt.includes("NOP"));
  assert.ok(prompt.includes("14:00 项目周会"));
});

test("agent pulse: 此刻状态与最近对话进 prompt（状态段 + 已知勿重复段）", () => {
  const prompt = buildPulsePrompt(new Date("2026-10-25T14:00:00"), mkAggregate({
    presence: "active（已持续 8 分钟）",
    screenFocus: "写代码（已持续 52 分钟）",
    recentTurns: ["帮我盯着这个 bug", "好的正在改"],
  }));
  assert.ok(prompt.includes("【用户此刻状态】"), "状态段标头");
  assert.ok(prompt.includes("在线：active（已持续 8 分钟）"));
  assert.ok(prompt.includes("屏幕：写代码（已持续 52 分钟）"));
  assert.ok(prompt.includes("【最近对话摘录"), "最近对话段标头");
  assert.ok(prompt.includes("帮我盯着这个 bug"));
  assert.ok(prompt.includes("开口时机参考用户此刻状态"), "时机判断标准");
  // 空状态不出空段
  const bare = buildPulsePrompt(new Date("2026-10-25T14:00:00"), mkAggregate());
  assert.ok(!bare.includes("【用户此刻状态】"));
  assert.ok(!bare.includes("【最近对话摘录"));
});

// ─── 关系时钟（2026-11-19 主动性重构 P0）──────────────────────────
// 旧行为：材料全空就 no_material，等于「没事发生就永不开口」。
// 新行为：隔得够久 + 时段合适，给一次「想想要不要说句话」的机会（NOP 仍合法）。

function emptyAggregate(overrides: Partial<PulseAggregate> = {}): PulseAggregate {
  return { tasks: [], unread: [], goals: [], interests: [], goalLine: null, ...overrides };
}

test("关系时钟：无材料但 6h+ 没聊、白天 → 仍然评审并开口", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T14:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: 7 * 60 }));
  h.setLlm("你昨天说想找的那本书我看到了，要不要发你？");
  const r = await h.svc.check();
  assert.equal(r.ran, true, "空材料也要走到 LLM");
  assert.equal(r.reason, "sent");
  assert.equal(h.submitted.length, 1);
  assert.ok(h.llmCalls[0].includes("【距上次对话】7 小时"), "距上次对话是社交开口的事实依据");
  assert.equal(h.submitted[0].tier, "social");
});

test("关系时钟：材料为空且没聊够 6h → 不评审（不打扰）", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T14:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: 2 * 60 }));
  const r = await h.svc.check();
  assert.equal(r.reason, "no_material");
  assert.equal(h.llmCalls.length, 0);
});

test("关系时钟：时段外（凌晨 3 点）→ 不评审", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T03:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: 9 * 60 }));
  const r = await h.svc.check();
  assert.equal(r.reason, "no_material");
  assert.equal(h.llmCalls.length, 0);
});

test("关系时钟：从没聊过（idle=null）→ 不主动冷启动", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T14:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: null }));
  const r = await h.svc.check();
  assert.equal(r.reason, "no_material");
  assert.equal(h.llmCalls.length, 0);
});

test("关系时钟：4h 内第二次无材料评审被节流，4h 后恢复", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T09:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: 8 * 60 }));
  h.setLlm("NOP");
  const r1 = await h.svc.check();
  assert.equal(r1.ran, true, "第一次放行（NOP 也算评审过）");

  h.setNow(new Date("2026-11-19T10:00:00"));
  const r2 = await h.svc.check();
  assert.equal(r2.reason, "no_material", "1h 内不重复烧 token");

  h.setNow(new Date("2026-11-19T13:30:00"));
  const r3 = await h.svc.check();
  assert.equal(r3.ran, true, "满 4h 后再次给机会");
  assert.equal(h.llmCalls.length, 2);
});

test("关系时钟：有材料且刚聊过 → 仍按材料指纹去重（不额外打扰）", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T14:00:00") });
  h.setAggregate(mkAggregate({ idleMinutes: 2 * 60 }));
  h.setLlm("NOP");
  await h.svc.check();
  const r2 = await h.svc.check();
  assert.equal(r2.reason, "unchanged", "刚聊过时，材料没变就不重评");
});

test("关系时钟：有材料但恒久没变、又 7h 没聊 → 社交补位评审一次", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T10:00:00") });
  h.setAggregate(mkAggregate({ idleMinutes: 7 * 60 }));
  h.setLlm("NOP");
  await h.svc.check();
  h.setNow(new Date("2026-11-19T14:30:00"));
  const r2 = await h.svc.check();
  assert.equal(r2.reason, "nop", "材料没变但关系时钟到了，给一次机会");
  assert.ok(h.llmCalls[1]?.includes("这次没有新材料"), "社交补位有专门的提示");
});

test("关系时钟：社交路径的 dedupKey 带时间桶，不被空材料恒定指纹吞掉", async () => {
  const h = mkHarness({ now: new Date("2026-11-19T09:00:00") });
  h.setAggregate(emptyAggregate({ idleMinutes: 8 * 60 }));
  h.setLlm("早，今天想干点什么？");
  await h.svc.check();
  const first = h.submitted[0].dedupKey;

  h.setNow(new Date("2026-11-19T14:00:00"));
  await h.svc.check();
  const second = h.submitted[1]?.dedupKey;
  assert.ok(second, "第二次也能提交");
  assert.notEqual(second, first, "不同时间桶 → 不同去重键");
  assert.ok(second!.includes("social"));
});

test("关系时钟：prompt 明确三档开口理由与锚点硬要求", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-19T14:00:00"),
    emptyAggregate({ idleMinutes: 7 * 60 }),
  );
  assert.ok(prompt.includes("A 有事"));
  assert.ok(prompt.includes("B 接话"));
  assert.ok(prompt.includes("C 观察"));
  assert.ok(prompt.includes("禁止「在吗」"), "空泛问候被明确禁止");
  assert.ok(prompt.includes("【距上次对话】"));
});

// ─── 观察素材：位置 / 活动 / 情绪（2026-11-19）────────────────────
// 用户定调：闲聊不该是「降温了记得穿衣服」这种叮嘱，而是「你在外面？去哪儿」
// 这种基于真实观测的搭话。

test("观察素材进 prompt：位置 + 活动 + 情绪各自成段", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-19T16:00:00"),
    emptyAggregate({
      idleMinutes: 400,
      place: { kind: "other", label: "健身房", city: "兴义", updatedMinutesAgo: 8 },
      activity: "walking",
      mood: "stressed",
    }),
  );
  assert.ok(prompt.includes("【他此刻在哪】健身房 · 兴义 · 8 分钟前的位置"));
  assert.ok(prompt.includes("【他在动吗】在走路"));
  assert.ok(prompt.includes("【他最近的状态】压力大"));
  assert.ok(prompt.includes("「你在外面呢？这是去哪儿」"), "给出观察式示范");
  assert.ok(prompt.includes("不是叮嘱"), "明确排除叮嘱式");
  assert.ok(prompt.includes("不是播报"), "明确排除播报式");
});

test("观察素材：unknown 地点 / neutral 情绪不出空段", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-19T16:00:00"),
    emptyAggregate({
      idleMinutes: 400,
      place: { kind: "unknown" },
      activity: "unknown",
      mood: null,
    }),
  );
  assert.ok(!prompt.includes("【他此刻在哪】"));
  assert.ok(!prompt.includes("【他在动吗】"));
  // 固定指令里出现「【他最近的状态】情绪低…」这句，所以断言具体取值不在材料段
  assert.ok(!prompt.includes("【他最近的状态】情绪偏低"));
  assert.ok(!prompt.includes("【他最近的状态】状态不错"));
});

test("观察素材：在家/在公司用兜底称谓，没有 label 也能说人话", () => {
  const home = buildPulsePrompt(
    new Date("2026-11-19T16:00:00"),
    emptyAggregate({ idleMinutes: 400, place: { kind: "home" }, activity: "still" }),
  );
  assert.ok(home.includes("【他此刻在哪】家"));
  assert.ok(home.includes("【他在动吗】待着没动"));
});

test("观察素材：情绪低时要求收着说，不自顾自唠", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-19T16:00:00"),
    emptyAggregate({ idleMinutes: 400, mood: "negative" }),
  );
  assert.ok(prompt.includes("【他最近的状态】情绪偏低"));
  assert.ok(prompt.includes("C 类收着说"), "低情绪时闲聊不硬聊");
});

// ─── 画像素材：闲聊的锚点（2026-11-19）────────────────────────────

test("extractRapport: 只取头像短事实，过滤敏感字段与长段落", () => {
  const profile = [
    "# 用户画像",
    "## 基本信息",
    "- 称呼：王哥",
    "- 城市：黔西南兴义",
    "- 职业：前端工程师",
    "- 手机号：13800000000",
    "- 备注：这是一个非常长的描述".repeat(1) + "，".repeat(0) + "x".repeat(60),
    "## 闲聊",
    "他最近在弄一个球形机器人项目，还提到过想学做饭。",
  ].join("\n");
  const out = extractRapport(profile);
  assert.ok(out.some((l) => l.includes("称呼：王哥")), "基础事实保留");
  assert.ok(out.some((l) => l.includes("城市")), "地理锚点保留");
  assert.ok(!out.some((l) => l.includes("手机号")), "敏感字段必须过滤");
  assert.ok(out.every((l) => l.length <= 44), "每行有长度上限");
  assert.ok(out.length <= 4, "最多 4 条");
});

test("extractRapport: 无画像/空画像 → 空数组（不占 prompt）", () => {
  assert.deepEqual(extractRapport(undefined), []);
  assert.deepEqual(extractRapport(""), []);
  assert.deepEqual(extractRapport("# 空画像\n没有任何字段"), []);
});

test("画像进 prompt：闲聊素材有独立段落，且 C 类指明从画像找话头", () => {
  const prompt = buildPulsePrompt(
    new Date("2026-11-19T14:00:00"),
    emptyAggregate({
      idleMinutes: 7 * 60,
      rapport: ["称呼：王哥", "城市：黔西南兴义", "职业：前端工程师"],
    }),
  );
  assert.ok(prompt.includes("【你记得的他（闲聊时从这里找话头）】"), "画像段标头");
  assert.ok(prompt.includes("称呼：王哥"));
  assert.ok(prompt.includes("黔西南兴义"));
  assert.ok(prompt.includes("改从【你记得的他】里找个具体话头"), "没有观测时用画像兜底话头");
  // 空画像不出空段（注意：固定指令里也提到该段名，所以断言完整标头）
  const bare = buildPulsePrompt(new Date("2026-11-19T14:00:00"), emptyAggregate({ idleMinutes: 7 * 60 }));
  assert.ok(!bare.includes("【你记得的他（闲聊时从这里找话头）】"));
});
