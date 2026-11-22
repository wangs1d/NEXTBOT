/**
 * 能力 prompt 工具名断链巡检（2026-11-21 根治复合工具收编遗漏）。
 *
 * 背景：prompt（agent-capabilities）若点名一个「被复合收编、又不在可见白名单」的
 * 独立工具名（如 weather.get_local / market.quote / world.link.list_friends），
 * 模型在工具面上找不到这个名字，会凭训练数据作答/选错复合分支/干脆不调——
 * 表现为「天气卡只剩文字」「股价是旧数据」（与 11-21 天气卡事故同构）。
 *
 * 不变量（与主流 tool folding 对齐）：
 *   - 复合工具用「入口名 + action」暴露子能力，schema 的 buildSchema 已把每个
 *     分支写进 description；prompt 必须指向**模型真实可见的名字**。
 *   - 可见名字 = 直接暴露的全部工具名 ∪ 复合入口名。
 *   - 被收编（COMPOSITE_ABSORBED）且未进白名单（DIRECTLY_EXPOSED）的细分工具体名，
 *     禁止出现在能力 prompt 里。
 *
 * 这条测试让「新增复合收编却忘记同步 prompt / 忘记加白名单」在 CI 直接失败，
 * 不再等用户报 bug。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import { test } from "node:test";

const { buildCoreCapabilitySections } = await import("../src/agent/agent-capabilities.js");
const {
  COMPOSITE_ABSORBED_TOOL_NAMES,
  COMPOSITE_ACTION_SPECS,
  DIRECTLY_EXPOSED_COMPOSITE_TOOLS,
} = await import("../src/external-model/composite-chat-tools.js");
const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

/** 能力 prompt 的全部静态行（不依赖 skillManager / 虚拟电话）。 */
const promptLines = buildCoreCapabilitySections(null as never, undefined, undefined)
  .flatMap((s) => s.lines)
  .join("\n");

/** 模型可见的工具名：直接暴露集 ∪ 复合入口集。 */
const visibleNames = new Set(
  getBuiltinAgentChatTools()
    .filter((t) => t.type === "function")
    .map((t) => t.function.name),
);

test("能力 prompt 点名的工具名必须是模型可见的（断链巡检）", () => {
  const broken: string[] = [];
  for (const absorbed of COMPOSITE_ABSORBED_TOOL_NAMES) {
    // 白名单里的细分工具被重新暴露，prompt 点名它们不算断链。
    if (DIRECTLY_EXPOSED_COMPOSITE_TOOLS.has(absorbed)) continue;
    if (!promptLines.includes(absorbed)) continue;
    // 名字出现在 prompt 里，但模型工具面上没有它 → 断链。
    if (!visibleNames.has(absorbed)) broken.push(absorbed);
  }
  assert.deepEqual(
    broken,
    [],
    `能力 prompt 点名了模型看不见的被收编工具：${broken.join(", ")}。` +
      `改为「复合入口名(action=分支)」表述，或加入 DIRECTLY_EXPOSED_COMPOSITE_TOOLS 白名单。`,
  );
});

test("prompt 提到的每个复合入口名后若带 action，action 必须真实存在", () => {
  // 防止 prompt 写 action=forecast 这类 schema 里没有的分支（模型会拿到 unknown action 错误）。
  // 只扫紧跟在入口名后那个括号内的 action=xxx，避免把同一行另一个工具的 action 误算进来。
  const missing: string[] = [];
  for (const spec of COMPOSITE_ACTION_SPECS) {
    const actions = new Set(spec.actions.map((a) => a.action));
    const re = new RegExp(`${spec.name.replace(/\./g, "\\.")}（([^（）]*)）`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptLines))) {
      const inner = m[1];
      const aRe = /action\s*=\s*"?([a-z_]+)"?/g;
      let a: RegExpExecArray | null;
      while ((a = aRe.exec(inner))) {
        if (!actions.has(a[1])) missing.push(`${spec.name}.action=${a[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `能力 prompt 引用了不存在的复合 action：${missing.join(", ")}`);
});

test("prompt 不再点名已知的四个历史断链工具名（回归锁）", () => {
  for (const legacy of [
    "weather.get_local",
    "market.quote",
    "world.link.list_friends",
    "aip.dispatch",
  ]) {
    assert.ok(
      !promptLines.includes(legacy),
      `prompt 又点名了独立工具 ${legacy}——它已被复合收编，应写复合入口+action 表述`,
    );
  }
});
