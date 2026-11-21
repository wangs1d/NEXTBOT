/**
 * 2026-09-08 优化批次回归测试。
 *
 * 覆盖：
 *   - B2 波次折叠前缀稳定：foldOldWaveToolChains 逐链独立折叠，旧链折叠消息
 *     一旦生成就逐字节冻结（append-only），replan 请求前缀缓存可命中到上一波边界；
 *   - B1 token 审计：API 真实 usage（apiPromptTokens/apiCompletionTokens）聚合
 *     与落盘、task_plane_* 新 stage；
 *   - A3 并发闸：desktop/浏览器等具身域工具分域单飞（全局=1）、
 *     backgroundTaskLimiter 后台任务全局并发上限。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "opt-2026-09-08-"));
process.env.PA_DATA_DIR = DATA_DIR;

const { foldOldWaveToolChains } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  recordLlmUsageByChars,
  getLlmUsageSummary,
  getLlmUsageSummaryFromDisk,
  resetLlmUsageAuditForTest,
} = await import("../src/services/llm-token-audit.js");
const { executeWithToolLimit, backgroundTaskLimiter } = await import(
  "../src/services/concurrency-limiter.js"
);

/* ---------------- B2：波次折叠前缀稳定 ---------------- */

type Msg = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string };

function assistantWithToolCall(name: string, args: string): Msg {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id: string, body: string): Msg {
  return { role: "tool", content: body, tool_call_id: id };
}

const chain1 = [assistantWithToolCall("search_web", '{"query":"上海天气"}'), toolResult("call-search_web", "上海今天晴，28 度。https://example.com/weather/shanghai")];
const chain2 = [assistantWithToolCall("fetch_web", '{"url":"https://example.com/weather/shanghai"}'), toolResult("call-fetch_web", "未来三天上海多云转晴，气温 26-30 度，风力 3 级。")];
const chain3 = [assistantWithToolCall("search_web", '{"query":"上海 穿衣建议"}'), toolResult("call-search_web-2", "建议短袖+薄外套。")];
const base: Msg[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "上海明天适合穿什么？" },
];

test("B2：旧波折叠消息跨波次逐字节冻结（append-only 前缀稳定）", () => {
  const asAny = foldOldWaveToolChains as unknown as (
    msgs: unknown[],
    digestChars?: number,
  ) => unknown[];

  // 波次2调用：历史 = [base, chain1]，chain1 为当前波 → 全保留，无折叠
  const wave2 = asAny([...base, ...chain1]) as Msg[];
  assert.equal(wave2.length, base.length + chain1.length, "只有一条工具链时不折叠");

  // 波次3调用：历史 = [base, chain1, chain2] → chain1 折叠为一条独立消息，chain2 全保留
  const wave3 = asAny([...base, ...chain1, ...chain2]) as Msg[];
  assert.equal(wave3.length, base.length + 1 + chain2.length);
  const fold1InWave3 = wave3[base.length] as Msg;
  assert.match(String(fold1InWave3.content), /历史工具结果摘要/);
  assert.match(String(fold1InWave3.content), /search_web/);

  // 波次4调用：历史 = [base, chain1, chain2, chain3] → chain1/chain2 各自折叠，
  // chain1 的折叠消息必须与波次3调用中的逐字节一致（前缀缓存命中到该边界）
  const wave4 = asAny([...base, ...chain1, ...chain2, ...chain3]) as Msg[];
  const fold1InWave4 = wave4[base.length] as Msg;
  assert.equal(
    String(fold1InWave3.content),
    String(fold1InWave4.content),
    "旧链折叠消息跨波次重写时内容必须冻结（append-only）",
  );
  // chain2 的折叠消息出现在 fold1 之后，且当前波 chain3 完整保留
  const fold2InWave4 = wave4[base.length + 1] as Msg;
  assert.match(String(fold2InWave4.content), /fetch_web/);
  assert.match(String(wave4[wave4.length - 1].content ?? ""), /穿衣建议|短袖/);
});

test("B2：同输入重复折叠输出确定（利于缓存与快照测试）", () => {
  const asAny = foldOldWaveToolChains as unknown as (msgs: unknown[]) => unknown[];
  const input = [...base, ...chain1, ...chain2];
  assert.deepEqual(asAny(input), asAny(input));
});

/* ---------------- B1：token 审计真实 usage ---------------- */

test("B1：API 真实 usage 进入聚合与落盘，task_plane_* stage 正确分类", async () => {
  resetLlmUsageAuditForTest();
  const auditPath = join(DATA_DIR, "llm-token-audit.ndjson");

  recordLlmUsageByChars({
    stage: "task_plane_light",
    inputChars: 1000,
    outputChars: 200,
    model: "deepseek-chat",
    sessionId: "s-b1",
    apiPromptTokens: 1500,
    apiCompletionTokens: 300,
    promptCacheHitTokens: 1200,
    promptCacheMissTokens: 300,
  });
  recordLlmUsageByChars({
    stage: "task_plane_full",
    inputChars: 2000,
    outputChars: 400,
    model: "deepseek-reasoner",
    sessionId: "s-b1",
    apiPromptTokens: 2800,
    apiCompletionTokens: 500,
  });
  // 旁路估算调用（无 usage）
  recordLlmUsageByChars({ stage: "mood_inference", inputChars: 100, outputChars: 20 });

  const rows = getLlmUsageSummary();
  const lightRow = rows.find((r) => r.stage === "task_plane_light");
  const fullRow = rows.find((r) => r.stage === "task_plane_full");
  const moodRow = rows.find((r) => r.stage === "mood_inference");

  assert.ok(lightRow && fullRow && moodRow, "新 stage 必须被聚合");
  assert.equal(lightRow.apiCalls, 1);
  assert.equal(lightRow.apiInputTokens, 1500);
  assert.equal(lightRow.apiOutputTokens, 300);
  assert.equal(fullRow.apiInputTokens, 2800);
  assert.equal(moodRow.apiCalls, 0, "无 usage 的旁路调用不计入真实值聚合");

  // 落盘记录携带真实 usage 字段（取最后一行校验）
  const lines = readFileSync(auditPath, "utf8").trim().split("\n");
  const complexRec = JSON.parse(lines[lines.length - 2] ?? "{}") as Record<string, unknown>;
  assert.equal(complexRec.apiPromptTokens, 2800);
  assert.equal(complexRec.apiCompletionTokens, 500);

  // 跨重启聚合（磁盘路径）
  const diskRows = getLlmUsageSummaryFromDisk();
  const diskLight = diskRows.find((r) => r.stage === "task_plane_light");
  assert.ok(diskLight);
  assert.equal(diskLight.apiInputTokens, 1500);

  resetLlmUsageAuditForTest();
});

/* ---------------- A3：分域单飞 + 后台任务全局并发闸 ---------------- */

test("A3：browser.* 具身域工具全局单飞（第二个并发调用必须等待）", async () => {
  let running = 0;
  let maxObserved = 0;
  const job = async (ms: number) => {
    running += 1;
    maxObserved = Math.max(maxObserved, running);
    await new Promise((r) => setTimeout(r, ms));
    running -= 1;
  };

  await Promise.all([
    executeWithToolLimit("browser.click", () => job(60)),
    executeWithToolLimit("browser.click", () => job(60)),
    executeWithToolLimit("browser.navigate", () => job(60)),
  ]);

  assert.equal(maxObserved, 1, "browser 域内任意工具同时只能有一个在执行");
});

test("A3：名单外工具不受限流影响（零开销直通）", async () => {
  let running = 0;
  let maxObserved = 0;
  const job = async () => {
    running += 1;
    maxObserved = Math.max(maxObserved, running);
    await new Promise((r) => setTimeout(r, 30));
    running -= 1;
  };
  await Promise.all([executeWithToolLimit("memory.write", job), executeWithToolLimit("memory.write", job)]);
  assert.equal(maxObserved, 2, "非具身域/非重型工具不排队");
});

test("A3：backgroundTaskLimiter 按上限并发（超出者排队）", async () => {
  const max = backgroundTaskLimiter.max;
  assert.ok(max >= 1, "并发上限必须为正");

  let running = 0;
  let maxObserved = 0;
  const runOne = async () => {
    const release = await backgroundTaskLimiter.acquire(0);
    try {
      running += 1;
      maxObserved = Math.max(maxObserved, running);
      await new Promise((r) => setTimeout(r, 40));
      running -= 1;
    } finally {
      release();
    }
  };

  const tasks = Array.from({ length: max + 2 }, () => runOne());
  await Promise.all(tasks);
  assert.equal(maxObserved, max, "同时执行数不得超过信号量上限");
  assert.equal(backgroundTaskLimiter.activeCount, 0, "全部释放后归零");
});
