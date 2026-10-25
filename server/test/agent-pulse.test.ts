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
  pulseSignature,
  sanitizePulseMessage,
  type PulseAggregate,
} from "../src/proactivity/agent-pulse.js";

function mkAggregate(overrides: Partial<PulseAggregate> = {}): PulseAggregate {
  return {
    tasks: ["14:00 项目周会"],
    unread: ["妈妈"],
    goals: [],
    interests: [],
    goalLine: null,
    ...overrides,
  };
}

type Harness = {
  svc: AgentPulseService;
  submitted: Array<{ kind: string; title: string; directText: string; dedupKey: string }>;
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
    actorId: () => "u1",
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
      submitted.push({ kind: p.kind, title: p.title, directText: p.directText, dedupKey: p.dedupKey });
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
    h2.setAggregate(mkAggregate({ tasks: ["16:00 新安排"] }));
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
