/**
 * 会话级工具面稳定性回归测试。
 *
 * ## 两代契约（历史不能删，否则会重复踩坑）
 *
 * - **2026-10-12 P0**：旧快照只存「名字→序号」，中间工具落选即被剔除、其后整体
 *   前移 → 请求前缀从该处分叉（跨轮 hit ~2.2K 或 0，同循环内秒级连发 76-99%）。
 *   解：会话级**单调并集**（只增不减）。
 * - **2026-10-22 修正**：并集把「每轮域预载」也吸收进来 → 工具面会话内持续膨胀
 *   （实测 33→38→45，schema 13,860→19,480 字符），而数组**每轮都在变**，前缀
 *   仍然每轮作废。分段埋点实测 tools 占进入输入 51.5%、缓存命中仅 29.8%（工具集
 *   稳定的会话 98.5%）。
 *
 * ## 现行契约（lock，默认）
 *
 * 首轮冻结为基准，此后**逐字节复用**：本轮集合变少不收缩、变多不吸收；只有
 * growNames（请求卡转正 / 晋升常驻）能追加尾部；isHidden 只影响本次返回、
 * 不改快照。union 模式保留为回滚通道（AGENT_TOOL_FACE=union）。
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

describe("stabilizeToolOrderForSession：lock（首轮冻结，默认）", () => {
  beforeEach(() => resetSessionToolOrderForTest());

  it("无 sessionId：退化为字母序排序", () => {
    const out = stabilizeToolOrderForSession(
      [fnTool("zeta"), fnTool("alpha"), fnTool("mid")],
      undefined,
      { mode: "lock" },
    );
    assert.deepEqual(names(out), ["alpha", "mid", "zeta"]);
  });

  it("首轮：按字母序建立冻结基准", () => {
    const out = stabilizeToolOrderForSession(
      [fnTool("search_web"), fnTool("alpha"), fnTool("mid")],
      "sess-a",
      { mode: "lock" },
    );
    assert.deepEqual(names(out), ["alpha", "mid", "search_web"]);
  });

  it("本轮集合变少：不收缩（落选工具保留原位）——前缀不分叉", () => {
    const t1 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("c"), fnTool("d")],
      "sess-b",
      { mode: "lock" },
    );
    assert.deepEqual(names(t1), ["a", "b", "c", "d"]);
    const t2 = stabilizeToolOrderForSession([fnTool("a"), fnTool("c")], "sess-b", {
      mode: "lock",
    });
    assert.deepEqual(names(t2), ["a", "b", "c", "d"], "冻结基准不因本轮落选而收缩");
    assert.deepEqual(t2, t1, "返回对象与首轮字节一致（内容 + 顺序）");
  });

  it("本轮集合变多：不吸收（新工具留在延迟目录，走 tool_request）", () => {
    const t1 = stabilizeToolOrderForSession([fnTool("a"), fnTool("b")], "sess-c", {
      mode: "lock",
    });
    const t2 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("e_preload")],
      "sess-c",
      { mode: "lock" },
    );
    assert.deepEqual(names(t2), ["a", "b"], "域预载新召回不得改变 tools 数组");
    assert.deepEqual(t2, t1);
    // 本轮缺、下轮有：同样不改变基准
    const t3 = stabilizeToolOrderForSession([fnTool("b"), fnTool("z_other")], "sess-c", {
      mode: "lock",
    });
    assert.deepEqual(names(t3), ["a", "b"]);
  });

  it("growNames：显式转正 → 追加尾部并吸收进基准", () => {
    stabilizeToolOrderForSession([fnTool("a"), fnTool("b")], "sess-d", { mode: "lock" });
    const grown = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("c_card")],
      "sess-d",
      { mode: "lock", growNames: new Set(["c_card"]) },
    );
    assert.deepEqual(names(grown), ["a", "b", "c_card"], "转正工具追加在尾部");
    // 吸收后即使本轮不再出现在候选里，也保持可见
    const next = stabilizeToolOrderForSession([fnTool("a")], "sess-d", { mode: "lock" });
    assert.deepEqual(names(next), ["a", "b", "c_card"]);
  });

  it("isHidden：只影响本次返回，不改快照（下一轮自动复原）", () => {
    const base = stabilizeToolOrderForSession(
      [fnTool("pay.now"), fnTool("a")],
      "sess-e",
      { mode: "lock" },
    );
    assert.deepEqual(names(base), ["a", "pay.now"]);
    const hidden = stabilizeToolOrderForSession([fnTool("pay.now"), fnTool("a")], "sess-e", {
      mode: "lock",
      isHidden: (n) => n === "pay.now",
    });
    assert.deepEqual(names(hidden), ["a"], "安全闸生效：外部动作族不可见");
    const restored = stabilizeToolOrderForSession([fnTool("a")], "sess-e", { mode: "lock" });
    assert.deepEqual(names(restored), ["a", "pay.now"], "隐藏不得写回基准（等待步结束即复原）");
  });

  it("allowFreeze=false：被裁剪过的轮次不建基准", () => {
    const t1 = stabilizeToolOrderForSession([fnTool("a")], "sess-f", {
      mode: "lock",
      allowFreeze: false,
    });
    assert.deepEqual(names(t1), ["a"]);
    // 基准仍是空的：下一轮正常轮次才建立
    const t2 = stabilizeToolOrderForSession(
      [fnTool("m"), fnTool("n"), fnTool("o")],
      "sess-f",
      { mode: "lock" },
    );
    assert.deepEqual(names(t2), ["m", "n", "o"], "首次可建基准时才冻结");
  });

  it("增长超上限：不追加（列表有界），不整表重置", () => {
    const base = Array.from({ length: 46 }, (_, i) => fnTool(`a${String(i).padStart(2, "0")}`));
    stabilizeToolOrderForSession(base, "sess-g", { mode: "lock" });
    const growNames = new Set(["x1", "x2", "x3", "x4"]);
    const out = stabilizeToolOrderForSession(
      [...base, fnTool("x1"), fnTool("x2"), fnTool("x3"), fnTool("x4")],
      "sess-g",
      { mode: "lock", growNames },
    );
    assert.equal(out.length, 46, "46+4 > 48 → 本次不追加，基准保持");
    assert.ok(!names(out).includes("x1"));
  });

  it("不同会话互不污染", () => {
    const s1 = stabilizeToolOrderForSession([fnTool("a"), fnTool("b")], "sess-1", {
      mode: "lock",
    });
    const s2 = stabilizeToolOrderForSession([fnTool("c")], "sess-2", { mode: "lock" });
    assert.deepEqual(names(s1), ["a", "b"]);
    assert.deepEqual(names(s2), ["c"]);
    const s1b = stabilizeToolOrderForSession([fnTool("q")], "sess-1", { mode: "lock" });
    assert.deepEqual(names(s1b), ["a", "b"]);
  });
});

describe("stabilizeToolOrderForSession：union（回滚通道，AGENT_TOOL_FACE=union）", () => {
  beforeEach(() => resetSessionToolOrderForTest());

  it("单调并集：只增不减、新工具追加尾部", () => {
    const t1 = stabilizeToolOrderForSession(
      [fnTool("a"), fnTool("b"), fnTool("c")],
      "u1",
      { mode: "union" },
    );
    assert.deepEqual(names(t1), ["a", "b", "c"]);
    const t2 = stabilizeToolOrderForSession([fnTool("a"), fnTool("c"), fnTool("d")], "u1", {
      mode: "union",
    });
    assert.deepEqual(names(t2), ["a", "b", "c", "d"]);
    const t3 = stabilizeToolOrderForSession([fnTool("a")], "u1", { mode: "union" });
    assert.deepEqual(names(t3), ["a", "b", "c", "d"]);
  });
});
