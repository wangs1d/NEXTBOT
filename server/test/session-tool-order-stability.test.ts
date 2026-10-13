/**
 * 会话级工具列表单调并集回归测试（P0 根修 2026-10-12）。
 *
 * 背景：MiniMax 实盘审计显示主链路缓存命中率仅 22.1%（hit p50=133 tok），受控
 * 探针证明同请求连发命中 ≈100% —— 分叉全在客户端。根源：contextual/light 档
 * 每轮按 userText 重筛工具集，旧 stabilizeToolOrderForSession 快照只存「名字→
 * 序号」，中间工具落选即被剔除，其后工具整体前移 → 请求前缀（tools 序列化在最
 * 前）从该处分叉，stable 层与全部历史缓存作废。
 *
 * 本测试锁定修复后的契约：会话内 tools 数组**只增不减、顺序稳定**——
 * 落选工具保留、新工具只追加尾部、超上限才整表重置。
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  stabilizeToolOrderForSession,
  resetSessionToolOrderForTest,
} from "../src/external-model/openai-compatible-tool-loop.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function fnTool(name: string, description = `desc of ${name}`): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}

function names(tools: ChatCompletionTool[]): string[] {
  return tools.map((t) => (t.type === "function" ? (t.function?.name ?? "") : ""));
}

describe("stabilizeToolOrderForSession 会话级单调并集", () => {
  beforeEach(() => resetSessionToolOrderForTest());

  it("无 sessionId：退化为字母序排序", () => {
    const out = stabilizeToolOrderForSession(
      [fnTool("zeta"), fnTool("alpha"), fnTool("mid")],
      undefined,
    );
    assert.deepEqual(names(out), ["alpha", "mid", "zeta"]);
  });

  it("首轮：建立字母序快照", () => {
    const out = stabilizeToolOrderForSession(
      [fnTool("search_web"), fnTool("alpha"), fnTool("mid")],
      "sess-a",
    );
    assert.deepEqual(names(out), ["alpha", "mid", "search_web"]);
  });

  it("中间工具落选：保留在原位（不剔除、不前移），前缀字节稳定", () => {
    const t1 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("c"), fnTool("d")],
      "sess-b",
    );
    assert.deepEqual(names(t1), ["a", "b", "c", "d"]);
    // 第二轮 contextual 只选中 a、c、d（b 落选）：b 必须保留原位
    const t2 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("c"), fnTool("d")],
      "sess-b",
    );
    assert.deepEqual(names(t2), ["a", "b", "c", "d"], "落选的中间工具必须保留，否则前缀分叉");
  });

  it("新工具只追加尾部：既有前缀一字节不动", () => {
    const t1 = stabilizeToolOrderForSession([fnTool("a"), fnTool("b")], "sess-c");
    assert.deepEqual(names(t1), ["a", "b"]);
    const t2 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("e_new")],
      "sess-c",
    );
    assert.deepEqual(names(t2), ["a", "b", "e_new"]);
    // 既有部分字节级一致（deepEqual 全量校验 schema 而不只是名字）
    assert.deepEqual(t2.slice(0, 2), t1);
  });

  it("落选与新召回混合：并集 = 旧 ∪ 新，顺序稳定", () => {
    stabilizeToolOrderForSession([fnTool("a"), fnTool("b"), fnTool("c")], "sess-d");
    // 第二轮：b 落选，d 新召回
    const t2 = stabilizeToolOrderForSession([fnTool("a"), fnTool("c"), fnTool("d")], "sess-d");
    assert.deepEqual(names(t2), ["a", "b", "c", "d"]);
    // 第三轮：只剩 a —— 并集仍完整保留
    const t3 = stabilizeToolOrderForSession([fnTool("a")], "sess-d");
    assert.deepEqual(names(t3), ["a", "b", "c", "d"]);
  });

  it("并集超过上限：整表重置为本轮集合（一次性 miss，有界）", () => {
    const base = ["a", "b", "c"].map(fnTool);
    stabilizeToolOrderForSession(base, "sess-e");
    // 一轮灌入 48 个新工具（48+3 > SESSION_TOOLS_UNION_MAX=48）
    const flood = Array.from({ length: 48 }, (_, i) => fnTool(`x${String(i).padStart(2, "0")}`));
    const out = stabilizeToolOrderForSession([...base, ...flood], "sess-e");
    assert.equal(out.length, 51, "重置后为本轮完整集合");
    assert.equal(names(out)[0], "a");
    // 重置后新基准生效：再次 subset 不再追加
    const t3 = stabilizeToolOrderForSession([fnTool("a")], "sess-e");
    assert.equal(t3.length, 51, "重置后的基准同样单调不减");
  });

  it("不同会话互不污染", () => {
    const s1 = stabilizeToolOrderForSession([fnTool("a"), fnTool("b")], "sess-1");
    const s2 = stabilizeToolOrderForSession([fnTool("c")], "sess-2");
    assert.deepEqual(names(s1), ["a", "b"]);
    assert.deepEqual(names(s2), ["c"]);
    const s1b = stabilizeToolOrderForSession([fnTool("a")], "sess-1");
    assert.deepEqual(names(s1b), ["a", "b"]);
  });
});
