/**
 * visible 工具集数量预算（2026-11-05 首字延迟治理）。
 *
 * 分工说明（重要）：
 *   顺序稳定化**已经由** `stabilizeToolOrderForSession` 在 tool-loop 内部做了
 *   （2026-10-12 P0 + 2026-10-22 lock 模式修正，见 test/session-tool-order-stability.test.ts
 *   的历史契约）。本模块不再重复实现那一层，只补它没有的一件：**数量上限**。
 *
 * 为什么需要数量上限：
 *   lock 模式为保证前缀逐字节复用，契约是「只增不减」——首轮若解析出 25 个可见
 *   工具，整场会话都保持 25 个。而 prefill 成本与工具数近似线性（实测 GLM-5.3-flash：
 *   0 工具 1.6s、25 工具 4.7-7.1s）。顺序稳定解决了「缓存打不中」，但没解决
 *   「缓存命中的内容本身就太大」。
 *
 * 裁谁（安全边界，比省 token 更重要）：
 *   - `CHAT_LANE_CORE_NAMES` 常驻集合**永不裁剪**：这些是「模型看不到就会嘴硬
 *     没权限」的工具（clock/weather/messages/profile.update 等），历史上裁掉它们
 *     引发过事故，不能为了延迟再犯。
 *   - 其余按传入顺序填充剩余额度。传入顺序即相关性排序，尾部是 BM25 弱命中。
 *   - 被裁掉≠不可达：它们仍在 searchableTools 里，模型可经 tool_discover 召回。
 *
 * 回滚：AGENT_TOOL_VISIBLE_BUDGET=off；上限用 AGENT_TOOL_VISIBLE_CAP 调（默认 18）。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { CHAT_LANE_CORE_NAMES } from "./lane-tool-sets.js";

/**
 * 默认额度余量：core 之外允许多带几个「本轮 BM25 命中」的工具。
 *
 * 为什么不写死一个绝对数：`CHAT_LANE_CORE_NAMES` 当前就有 17 个，写死 18 等于只给
 * 域预载留 1 个位置，会把本轮真正相关的工具挤掉——召回损失远大于省下的 prefill。
 * 用「core + 余量」保证这条护栏永远是「防膨胀」，而不是「坎召回」。
 */
const DEFAULT_EXTRA_BUDGET = 6;

const CORE_NAMES: ReadonlySet<string> = new Set(CHAT_LANE_CORE_NAMES);

function isEnabled(): boolean {
  return process.env.AGENT_TOOL_VISIBLE_BUDGET?.trim().toLowerCase() !== "off";
}

/** visible 数量上限；AGENT_TOOL_VISIBLE_CAP 正整数覆盖，0/非法回落 core+余量。 */
export function resolveVisibleToolCap(): number {
  const raw = process.env.AGENT_TOOL_VISIBLE_CAP?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 4) return n;
  return CORE_NAMES.size + DEFAULT_EXTRA_BUDGET;
}

function toolNameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? (tool.function?.name ?? "") : "";
}

/**
 * 按数量预算裁剪 visible 工具集。不改变相对顺序（顺序由 tool-loop 冻结），
 * 只决定「留下哪些」。
 *
 * @param visible 本轮解析出的可见工具，顺序即相关性排序。
 */
export function applyVisibleToolBudget(visible: ChatCompletionTool[]): ChatCompletionTool[] {
  if (!isEnabled()) return visible;
  const cap = resolveVisibleToolCap();
  if (visible.length <= cap) return visible;

  const kept: ChatCompletionTool[] = [];
  const deferred: ChatCompletionTool[] = [];
  const seen = new Set<string>();
  for (const tool of visible) {
    const name = toolNameOf(tool);
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    if (name && CORE_NAMES.has(name)) kept.push(tool);
    else deferred.push(tool);
  }
  // core 超预算（极端情况：core 自身 > cap）时按 core 原顺序截断，不越界。
  const out = kept.slice(0, cap);
  for (const tool of deferred) {
    if (out.length >= cap) break;
    out.push(tool);
  }
  if (out.length === kept.length) return out; // 全是 core，无需保序处理
  // 保序输出：按原始 visible 顺序过滤，避免 core 被提到队首打乱前缀。
  const keepNames = new Set(out.map(toolNameOf).filter(Boolean));
  return visible.filter((tool) => keepNames.has(toolNameOf(tool)));
}
