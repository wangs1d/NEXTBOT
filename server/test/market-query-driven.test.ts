/**
 * market.quote「用户原话驱动」标的提取契约（2026-11-21 根治 P2）。
 *
 * 背景：旧 handler 只读模型填的 symbols，模型漏填/少填（「特斯拉和英伟达只查了一个」）
 * 就少查标的。根治：服务端从 context.userText 扫描全部标的，覆盖模型参数；模型降级兜底。
 *
 * 本文件锁死：别名+代码提取、按出现顺序去重、原话覆盖模型 symbols、无原话兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { extractSymbolsFromUserText, registerMarketQuoteTools } from "../src/tools/market-quote-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

// ---------- 1. 纯函数：原话提取 ----------

test("extractSymbolsFromUserText：多别名按出现顺序取出", () => {
  assert.deepEqual(extractSymbolsFromUserText("特斯拉和英伟达现在多少"), ["usTSLA", "usNVDA"]);
  assert.deepEqual(extractSymbolsFromUserText("大盘、纳指和恒指怎么样"), [
    "sh000001",
    "usIXIC",
    "hkHSI",
  ]);
});

test("extractSymbolsFromUserText：交易所代码与别名混排", () => {
  assert.deepEqual(extractSymbolsFromUserText("sh000001 和 纳斯达克"), ["sh000001", "usIXIC"]);
  assert.deepEqual(extractSymbolsFromUserText("美元汇率多少"), ["whUSDCNY"]);
});

test("extractSymbolsFromUserText：去重、大小写不敏感、不误判普通英文词", () => {
  assert.deepEqual(extractSymbolsFromUserText("上证指数和上证"), ["sh000001"], "同码去重");
  assert.deepEqual(extractSymbolsFromUserText("usAAPL、USaapl 和 苹果"), ["usAAPL"], "代码大小写去重+别名同码");
  assert.deepEqual(extractSymbolsFromUserText("what about this thing"), [], "普通英文词不当代码");
  assert.deepEqual(extractSymbolsFromUserText("你好呀"), [], "无关原话为空");
});

test("extractSymbolsFromUserText：最多 8 个", () => {
  const many = extractSymbolsFromUserText(
    "上证 深成指 创业板 沪深300 科创50 恒指 道指 纳指 标普 特斯拉 苹果 英伟达 微软 亚马逊",
  );
  assert.equal(many.length, 8);
});

// ---------- 2. 工具执行：原话覆盖模型 symbols ----------

/** 用 spy fetch 捕获请求 URL 里的 codes，返回一条最小可用行情文本（避免真实网络）。 */
function withSpyFetch() {
  let capturedUrl = "";
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    const codes = String(url).match(/q=([^&]+)/)?.[1]?.split(",") ?? ["sh000001"];
    // 每个请求 code 返回一行最小可用报价；字段 [1]=名称 [3]=最新价 [4]=昨收。
    const body = codes.map((c) => `v_${c}="1~TEST~${c}~100.00~99.00~";`).join("\n");
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return {
    url: () => capturedUrl,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

const ctx = (userText?: string): ToolContext => ({
  sessionId: "market-query-session",
  userId: "market-query-user",
  userText,
});

async function exec(userText: string | undefined, modelInput: Record<string, unknown>) {
  const spy = withSpyFetch();
  try {
    const registry = new ToolRegistry();
    registerMarketQuoteTools(registry);
    const { result } = await registry.execute("market.quote", modelInput, ctx(userText));
    return { result, codes: spy.url().match(/q=([^&]+)/)?.[1]?.split(",") ?? [] };
  } finally {
    spy.restore();
  }
}

test("问「特斯拉和英伟达」：模型只填一个也按原话查全两个", async () => {
  const { result, codes } = await exec("特斯拉和英伟达涨多少", { symbols: ["usTSLA"] });
  assert.equal(result.ok, true);
  assert.deepEqual(codes, ["usTSLA", "usNVDA"], "原话覆盖模型 symbols，两个都查");
  assert.equal(result.symbolsFromUserText, true);
  assert.equal(result.quoteCount, 2);
});

test("问「大盘、纳指和恒指」：多标的混排一次查全，顺序同原话", async () => {
  const { codes } = await exec("大盘、纳指和恒指怎么样", {});
  assert.deepEqual(codes, ["sh000001", "usIXIC", "hkHSI"]);
});

test("无原话：退回模型 symbols（主动任务/无 userText 场景不被改坏）", async () => {
  const { result, codes } = await exec(undefined, { symbols: ["usAAPL", "sh000001"] });
  assert.deepEqual(codes, ["usAAPL", "sh000001"], "无原话时模型参数生效");
  assert.equal(result.symbolsFromUserText, false);
});

test("原话无明确标的：退回模型 symbols", async () => {
  const { codes } = await exec("现在行情怎么样", { symbols: ["usMSFT"] });
  assert.deepEqual(codes, ["usMSFT"]);
});
