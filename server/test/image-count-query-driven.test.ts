/**
 * 图片搜索张数「用户原话驱动」契约（2026-11-22，与天气/日历/行情同构）。
 *
 * 背景：张数此前只看模型转填的 limit（缺省 4）——用户原话明确说「来 6 张」
 * 而模型没转填时就丢成 4 张。根治：权威意图源 = context.userText，服务端
 * 直接解析张数；模型 limit 降级兜底；泛问默认 4 张。
 * 产品口径：默认 4、上限 8。跨轮结果缓存已整层拆除（同日），不存在缓存串味。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseImageCountIntent, registerWebTools, resetImageSearchTurnMemoForTest } from "../src/tools/web-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

// ---------- 1. 意图解析纯函数 ----------

test("parseImageCountIntent：阿拉伯数字 + 中文数字 + 常见动词前缀", () => {
  assert.equal(parseImageCountIntent("来6张图"), 6);
  assert.equal(parseImageCountIntent("给我八张照片"), 8);
  assert.equal(parseImageCountIntent("搜一下他的照片 来三张"), 3);
  assert.equal(parseImageCountIntent("两2张混淆词"), 2, "首个命中按出现顺序");
  assert.equal(parseImageCountIntent("要 4 张"), 4);
});

test("parseImageCountIntent：泛问/无关量词/超上限返回 null（默认 4 张）", () => {
  assert.equal(parseImageCountIntent("找一下这位明星的照片"), null, "没说张数");
  assert.equal(parseImageCountIntent("对比4家酒店"), null, "「家」不是张，不误伤");
  assert.equal(parseImageCountIntent("他今年8岁"), null, "「岁」不误伤");
  assert.equal(parseImageCountIntent("来100张"), null, "超产品上限 8 不认");
  assert.equal(parseImageCountIntent(""), null);
  assert.equal(parseImageCountIntent(undefined), null);
});

// ---------- 2. 工具执行：原话张数优先 ----------

/** 桩：记录 searchImages 收到的 limit，返回最小可用回执。 */
function fakeUpstreamWithSpy() {
  const limitsSeen: number[] = [];
  const svc = {
    searchImages: async (_query: string, limit: number) => {
      limitsSeen.push(limit);
      return { provider: "stub", mediaType: "image" as const, items: [], notes: [] };
    },
  } as never;
  return { svc, limitsSeen };
}

function makeRegistry(svc: never) {
  const registry = new ToolRegistry();
  registerWebTools(registry, {} as never, svc, undefined);
  resetImageSearchTurnMemoForTest();
  return registry;
}

const BASE_CONTEXT: ToolContext = {
  sessionId: "s-image-count",
  getLastKnownLocation: () => null,
};

async function exec(userText: string | undefined, modelInput: Record<string, unknown> = {}) {
  const { svc, limitsSeen } = fakeUpstreamWithSpy();
  const registry = makeRegistry(svc);
  const { result } = await registry.execute("search_images", { query: "风景", ...modelInput }, {
    ...BASE_CONTEXT,
    userText,
  } as ToolContext);
  return { result, limitsSeen };
}

test("原话「来6张」：模型没传 limit 也按原话查 6 张", async () => {
  const { result, limitsSeen } = await exec("来6张风景图");
  assert.equal(limitsSeen[0], 6, "原话张数覆盖缺省 4");
  assert.equal(result.countFromUserText, true, "回执标注来源");
  assert.equal(result.requestedCount, 6);
});

test("原话张数覆盖模型乱传：用户说三张，模型填 8 也以原话为准", async () => {
  const { limitsSeen } = await exec("三张照片", { limit: 8 });
  assert.equal(limitsSeen[0], 3);
});

test("泛问没说张数：默认 4 张（模型没传也不升级）", async () => {
  const { result, limitsSeen } = await exec("找一下风景照片");
  assert.equal(limitsSeen[0], 4, "缺省 4");
  assert.equal(result.countFromUserText, undefined, "无来源标注");
});

test("原话没说张数时模型 limit 仍被尊重（兜底路径不回退）", async () => {
  const { limitsSeen } = await exec("找一些风景照", { limit: 5 });
  assert.equal(limitsSeen[0], 5);
});
