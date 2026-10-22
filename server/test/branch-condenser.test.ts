// 树枝精简器（L3）+ 注册表三段式编排单测（2026-10-22 Phase 2/3）：
//   模板兜底 / kill switch / 每日熔断 / JSON 宽容解析 / 超时回退；
//   registry.ingest：停用拒 / L1 噪声挡 / L2 指纹去重 / condense 开关两条路 / 配置写穿。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach } from "node:test";

import { BranchCondenser } from "../src/proactivity/branches/branch-condenser.js";
import { BranchRegistry } from "../src/proactivity/branches/branch-registry.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();

/** 假 provider：吐一段固定 JSON（结构对齐 streamCompletion(threadKey, msg, onDelta, ...)） */
function fakeChat(output: string, opts: { hang?: boolean } = {}): ExternalChatProvider {
  return {
    isEnabled: () => true,
    streamCompletion: async (_k: string, _m: unknown, onDelta: (d: string) => void) => {
      if (opts.hang) return new Promise<void>(() => {}); // 永不落定 → 触发超时
      onDelta(output);
    },
  } as unknown as ExternalChatProvider;
}

function makeCondenser(chat: ExternalChatProvider | null, timeoutMs = 8_000): BranchCondenser {
  return new BranchCondenser({ chat: () => chat, nowFn: () => NOW, timeoutMs });
}

function makeRegistry(): BranchRegistry {
  const dir = mkdtempSync(join(tmpdir(), "branch-reg-"));
  return new BranchRegistry({
    configPath: join(dir, "branches.json"),
    cursorPath: join(dir, "cursors.json"),
  });
}

beforeEach(() => {
  delete process.env.BRANCH_CONDENSE_LLM;
  delete process.env.BRANCH_MAX_CONDENSE_PER_DAY;
});

test("condenser: kill switch（BRANCH_CONDENSE_LLM=0）→ 全模板模式，不花 LLM", async () => {
  process.env.BRANCH_CONDENSE_LLM = "0";
  const c = makeCondenser(fakeChat('{"delta":"x","salience":"high","entities":[]}'));
  const s = await c.condense({
    stream: "mail", branchId: "mail", sessionId: "u", fingerprint: "fp1",
    text: "老师说明天八点集合", at: NOW,
  });
  assert.equal(c.isEnabled(), false);
  assert.equal(s.delta.includes("老师说明天八点集合"), true, "模板兜底 = 正文截断");
  assert.equal(c.stats().lastFallback, "kill_switch");
});

test("condenser: LLM 正常路 → 解析 JSON 产出压缩视图（delta/salience/entities）", async () => {
  const c = makeCondenser(fakeChat('```json\n{"delta":"明天八点集合","salience":"high","entities":["集合"]}\n```'));
  const s = await c.condense({
    stream: "mail", branchId: "mail", sessionId: "u", fingerprint: "fp2",
    text: "【教务处】各位同学：原定周三的集合活动改到明早八点，请准时到场，具体地点另行通知……（长文省略）",
    at: NOW,
  });
  assert.equal(s.delta, "明天八点集合");
  assert.equal(s.salience, "high");
  assert.deepEqual(s.entities, ["集合"]);
  assert.equal(c.stats().callsToday, 1);
});

test("condenser: 输出坏 JSON → 模板兜底（上报不中断）", async () => {
  const c = makeCondenser(fakeChat("我觉得这段内容挺重要的，你自己看着办"));
  const s = await c.condense({
    stream: "mail", branchId: "mail", sessionId: "u", fingerprint: "fp3",
    text: "一段正常内容", at: NOW,
  });
  assert.equal(s.delta.includes("一段正常内容"), true);
  assert.equal(c.stats().lastFallback, "bad_output");
});

test("condenser: 每日熔断（cap=2）→ 超额回模板", async () => {
  process.env.BRANCH_MAX_CONDENSE_PER_DAY = "2";
  const c = makeCondenser(fakeChat('{"delta":"摘要","salience":"low","entities":[]}'));
  for (let i = 0; i < 2; i++) {
    await c.condense({ stream: "mail", branchId: "mail", sessionId: "u", fingerprint: `fp-a${i}`, text: `内容${i}`, at: NOW });
  }
  assert.equal(c.isEnabled(), false, "两笔用满即熔断");
  const s = await c.condense({ stream: "mail", branchId: "mail", sessionId: "u", fingerprint: "fp-a9", text: "第三条内容", at: NOW });
  assert.equal(s.delta.includes("第三条内容"), true, "超额走模板");
  assert.equal(c.stats().lastFallback, "cap_or_no_provider");
});

test("condenser: LLM 挂起 → 超时回模板（timeoutMs=30ms）", async () => {
  const c = makeCondenser(fakeChat("", { hang: true }), 30);
  const s = await c.condense({
    stream: "mail", branchId: "mail", sessionId: "u", fingerprint: "fp-t",
    text: "超时场景的内容", at: NOW,
  });
  assert.equal(s.delta.includes("超时场景的内容"), true);
  assert.ok(String(c.stats().lastFallback).includes("condense_timeout"));
});

test("registry.ingest: 树枝停用 → 拒（branch_disabled），配置写穿落盘", async () => {
  const reg = makeRegistry();
  reg.setConfig("mail", { enabled: false });
  const r1 = await reg.ingest("mail", { text: "随便什么内容", fingerprint: "f1" });
  assert.deepEqual(r1, { allowed: false, stage: "L1", reason: "branch_disabled" });
  // 写穿：新实例（同盘）恢复停用态
  const cfgPath = (reg as unknown as { deps: { configPath: string } }).deps.configPath;
  const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, { enabled?: boolean }>;
  assert.equal(persisted.mail?.enabled, false);
});

test("registry.ingest: L1 强噪声挡下 + L2 指纹去重（mail 树枝内置策略）", async () => {
  const reg = makeRegistry();
  const blocked = await reg.ingest("mail", { text: "你的验证码是 882311，请勿泄露", fingerprint: "f-noise" });
  assert.equal(blocked?.allowed, false);
  assert.equal(blocked && "reason" in blocked ? blocked.reason : "", "strong_noise");
  const ok1 = await reg.ingest("mail", { text: "老师说明天八点集合", fingerprint: "f-dup" });
  assert.equal(ok1?.allowed, true);
  const ok2 = await reg.ingest("mail", { text: "老师说明天八点集合（重发）", fingerprint: "f-dup" });
  assert.equal(ok2?.allowed, false);
  assert.equal(ok2 && "reason" in ok2 ? ok2.reason : "", "already_reported");
});

test("registry.ingest: condense 关（缺省）→ 模板信号；开 + 假 LLM → 压缩视图", async () => {
  const reg = makeRegistry();
  const r1 = await reg.ingest("mail", { text: "未开精简的原始内容原文照录", fingerprint: "f-c1" });
  assert.equal(r1?.allowed, true);
  assert.equal(r1 && "condensed" in r1 ? r1.condensed : true, false, "缺省不花 LLM");
  assert.ok(r1 && "signal" in r1 ? r1.signal.delta.includes("未开精简的原始内容") : false);

  reg.setConfig("mail", { condense: true });
  reg.attachCondenser(makeCondenser(fakeChat('{"delta":"八点集合","salience":"high","entities":[]}')));
  const r2 = await reg.ingest("mail", { text: "【教务处】明早八点集合，地点另行通知，请勿迟到", fingerprint: "f-c2", sessionId: "u" });
  assert.equal(r2?.allowed, true);
  assert.equal(r2 && "condensed" in r2 ? r2.condensed : false, true);
  assert.equal(r2 && "signal" in r2 ? r2.signal.delta : "", "八点集合");
  assert.equal(r2 && "signal" in r2 ? r2.signal.salience : "", "high");
});

test("registry.ingest: 未知树枝 → null（不 throw）；getConfig 缺省开/关/20", async () => {
  const reg = makeRegistry();
  assert.equal(await reg.ingest("not_exist", { text: "x", fingerprint: "f" }), null);
  const cfg = reg.getConfig("mail");
  assert.deepEqual(cfg, { enabled: true, condense: false, dailyBudget: 20 });
});

test("registry.setConfig: dailyBudget 收敛为正整数，坏值忽略", () => {
  const reg = makeRegistry();
  reg.setConfig("mail", { dailyBudget: 7.6 });
  assert.equal(reg.getConfig("mail").dailyBudget, 8);
  reg.setConfig("mail", { dailyBudget: Number.NaN });
  assert.equal(reg.getConfig("mail").dailyBudget, 8);
});

// 清理临时目录（mkdtemp 的目录留给系统 tmp 清理即可；显式清更卫生）
test("cleanup", () => { rmSync(join(tmpdir(), "branch-reg-"), { recursive: true, force: true }); });
