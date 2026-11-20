/**
 * search_images 同轮单次搜索闸回归测试（2026-11-12 用户口径「一轮就搜索一次」）。
 *
 * 事故背景：旧工具 prompt 引导「要同一人物的不同侧面就拆成多次并行调用」，
 * 模型一轮内并行 2 次 search_images（各 4 张）→ 转存层 8 张 PNG 全部落库，
 * 聚合裁剪后前端只渲染 4 张——渲染/资料库数量错位。
 *
 * 修复双层：
 * ① 工具层闸（本文件锁定）：同轮第二次 search_images 直接复用首次执行结果，
 *    不重复搜索、不重复下载、不重复落库；
 * ② prompt 收紧：builtin-chat-tools 不再引导并行拆分（改「一轮最多一次」）。
 *
 * 闸键 = actorId:chatUserMessageId（主对话路径必有）；无消息 id 的主动任务
 * 路径不设闸；空结果/失败摘除备忘，允许按降级策略换词重试一次。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import { registerWebTools, resetImageSearchTurnMemoForTest } from "../src/tools/web-tools.js";
import type { UpstreamSearchService } from "../src/services/upstream-search-service.js";

/** 计数桩：记录 searchImages 执行次数；emptyOnlyFirst=true 时首次返回空、后续正常。 */
function makeSearchService(emptyOnlyFirst = false) {
  const state = { calls: 0 };
  const stub = {
    searchImages: async (query: string) => {
      state.calls += 1;
      const empty = emptyOnlyFirst && state.calls === 1;
      return {
        provider: "test",
        mediaType: "image" as const,
        items: empty
          ? []
          : [{ type: "image" as const, title: query, mediaUrl: `https://img.example.com/${encodeURIComponent(query)}.jpg`, source: "Test" }],
        notes: [],
      };
    },
  };
  return { stub: stub as unknown as UpstreamSearchService, state };
}

function makeRegistry(service: UpstreamSearchService) {
  const registry = new ToolRegistry();
  // infoHubService 仅 inspect/navigate 等工具需要；本文件不调用，传占位
  registerWebTools(registry, {} as never, service);
  return registry;
}

const ctx: ToolContext = { sessionId: "gate-session", userId: "gate-user", chatUserMessageId: "msg-1" };
const ctxNoMsg: ToolContext = { sessionId: "gate-session", userId: "gate-user" };

// 备忘表是模块级状态，每个用例前清空，保证测试间互不污染
test.beforeEach(() => resetImageSearchTurnMemoForTest());

test("同轮两次 search_images：只执行一次搜索，第二次复用首次结果", async () => {
  const { stub, state } = makeSearchService();
  const registry = makeRegistry(stub);
  const [a, b] = await Promise.all([
    registry.execute("search_images", { query: "刘浩存" }, ctx),
    registry.execute("search_images", { query: "刘浩存 写真" }, ctx),
  ]);
  assert.equal(state.calls, 1, "同轮并行两次调用只应真正搜索一次");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const aItems = (a.result as { items: unknown[] }).items.length;
  const bItems = (b.result as { items: unknown[] }).items.length;
  assert.equal(aItems, 1);
  assert.equal(bItems, 1, "复用结果与首次一致（上层 dedupMediaCards 按 URL 收敛）");
});

test("串行第二次调用同样命中闸（换词也不重搜）", async () => {
  const { stub, state } = makeSearchService();
  const registry = makeRegistry(stub);
  await registry.execute("search_images", { query: "灯塔" }, ctx);
  const second = await registry.execute("search_images", { query: "雪山 日落" }, ctx);
  assert.equal(state.calls, 1);
  assert.equal((second.result as { items: unknown[] }).items.length, 1);
});

test("空结果摘除备忘：允许降级策略换词重试", async () => {
  const { stub, state } = makeSearchService(true);
  const registry = makeRegistry(stub);
  const first = await registry.execute("search_images", { query: "卢昱晓 红毯" }, ctx);
  assert.equal((first.result as { items: unknown[] }).items.length, 0);
  const second = await registry.execute("search_images", { query: "卢昱晓" }, ctx);
  assert.equal(state.calls, 2, "首次空结果时第二次应真正重搜");
  assert.equal((second.result as { items: unknown[] }).items.length, 1);
});
test("无 chatUserMessageId 的路径不设闸（主动任务/后台任务不受限）", async () => {
  const { stub, state } = makeSearchService();
  const registry = makeRegistry(stub);
  await registry.execute("search_images", { query: "灯塔" }, ctxNoMsg);
  await registry.execute("search_images", { query: "雪山" }, ctxNoMsg);
  assert.equal(state.calls, 2);
});

test("不同轮次互不影响：新消息 id = 新一轮，可再搜", async () => {
  const { stub, state } = makeSearchService();
  const registry = makeRegistry(stub);
  await registry.execute("search_images", { query: "灯塔" }, ctx);
  await registry.execute("search_images", { query: "灯塔" }, {
    sessionId: "gate-session",
    userId: "gate-user",
    chatUserMessageId: "msg-2",
  });
  assert.equal(state.calls, 2);
});
