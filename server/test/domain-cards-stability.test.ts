/**
 * 能力域目录字节稳定性契约（2026-10-22）。
 *
 * 病根：域卡每域只展示前 `CARD_TOOLS_PER_DOMAIN` 个（位置截断），而语料顺序
 * 取决于当轮「可见集 / 延迟目录」怎么划分——域预载会把工具从延迟挪进可见，
 * 顺序一变、截断结果就变、system 段字节逐轮不同 → 前缀缓存从 message #0 起全废
 * （实测：域卡进 system 后命中率反而从 59% 掉到 26%，排序后回到 86.8%）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { domainCardsForTurn } from "../src/external-model/turn-domain-cards.js";
import type { ToolSearchPreparedTurn } from "../src/tools/tool-search/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function tool(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description: `${name} 描述`, parameters: { type: "object", properties: {} } },
  };
}

/** 造一份「全量语料」，再按不同划分切成 visible + deferred。 */
function preparedWithSplit(all: ChatCompletionTool[], visibleCount: number): ToolSearchPreparedTurn {
  return {
    visibleTools: all.slice(0, visibleCount),
    deferredCatalog: {
      entries: all.slice(visibleCount).map((t) => ({ tool: t })) as never,
      byName: new Map(),
      byApiName: new Map(),
    } as never,
    toolSearchActive: true,
    coreToolCount: visibleCount,
    deferredToolCount: all.length - visibleCount,
  };
}

const CORPUS = [
  tool("weather.get_local"),
  tool("weather.get_forecast"),
  tool("calendar.create_event"),
  tool("reminder.plan"),
  tool("travel.plan_trip"),
  tool("search_web"),
];

test("域卡：语料相同、可见/延迟划分不同 → 字节完全一致", () => {
  const a = domainCardsForTurn(preparedWithSplit(CORPUS, 1));
  const b = domainCardsForTurn(preparedWithSplit(CORPUS, 4));
  const c = domainCardsForTurn(preparedWithSplit([...CORPUS].reverse(), 2));
  assert.ok(a.length > 0, "应生成域卡");
  assert.equal(b, a, "划分不同但语料相同时字节必须一致（否则 system 段每轮变）");
  assert.equal(c, a, "语料顺序不同也必须一致（按名字排序后与输入顺序无关）");
});

test("域卡：无延迟目录 / 回滚开关 → 空串（退回轮内消息形态）", () => {
  const off = { ...preparedWithSplit(CORPUS, 2), toolSearchActive: false };
  assert.equal(domainCardsForTurn(off), "");
  assert.equal(domainCardsForTurn(null), "");

  const prev = process.env.AGENT_DOMAIN_CARDS_IN_SYSTEM;
  process.env.AGENT_DOMAIN_CARDS_IN_SYSTEM = "0";
  try {
    assert.equal(domainCardsForTurn(preparedWithSplit(CORPUS, 2)), "");
  } finally {
    if (prev === undefined) delete process.env.AGENT_DOMAIN_CARDS_IN_SYSTEM;
    else process.env.AGENT_DOMAIN_CARDS_IN_SYSTEM = prev;
  }
});
