/**
 * 把「能力域目录」从**轮内消息**挪进 **system 段**（2026-10-22）。
 *
 * 事实链：
 * - 域卡（8,266 字符 ≈3,200 real tokens）原本作为一条 system 消息挂在请求尾部
 *   （见 openai-compatible-tool-loop 的域卡注入），问「有哪些能力」用；
 * - 它的位置每轮随历史增长而后移（前面多了 assistant/user 消息），而隐式前缀
 *   缓存是**按前缀字节**命中的 → 同一份域卡在每轮都是「新位置的旧内容」，
 *   永远命中不了，等于每轮全价重发 3,200 token；
 * - 而 system 段是会话级冻结的（`STABLE_PROMPT_SESSION_FREEZE`），工具面本身也
 *   已按会话冻结（`stabilizeToolOrderForSession`），因此**域卡在会话内字节稳定**，
 *   放进 system 就能跟着 system 一起命中缓存。
 *
 * 稳定性前提：域卡语料 = 可见工具 ∪ 延迟目录 = 全量工具语料。前后两者每轮的
 * 划分会变（BM25 域预载/晋升），但**并集不变**，所以卡片内容（域+工具名）稳定。
 *
 * 回滚：`AGENT_DOMAIN_CARDS_IN_SYSTEM=0` → 返回空串，域卡退回轮内消息形态。
 */
import { buildDomainCards } from "../tools/tool-search/domain-cards.js";
import type { ToolSearchPreparedTurn } from "../tools/tool-search/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function enabled(): boolean {
  const raw = process.env.AGENT_DOMAIN_CARDS_IN_SYSTEM?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function dedupeByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const t of tools) {
    const n = t.type === "function" ? t.function?.name : "";
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

/**
 * 按工具名排序。**必须排序**：域卡每域只展示前 `CARD_TOOLS_PER_DOMAIN` 个
 * （位置截断），而 `visible ∪ deferred` 的先后顺序逐轮变化（域预载会把工具从
 * 延迟目录挪进可见集）→ 不排序则同一份语料生成不同字节的卡片，system 段每轮
 * 变化，前缀缓存从 message #0 起全废（实测就是这么翻的车）。排序后卡片只依赖
 * **工具集合**，与当轮怎么划分无关。
 */
function sortByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return [...tools].sort((a, b) => {
    const an = a.type === "function" ? a.function?.name ?? "" : "";
    const bn = b.type === "function" ? b.function?.name ?? "" : "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** 本轮应并入 system 的域卡文本；无延迟目录 / 开关关闭时返回空串。 */
export function domainCardsForTurn(prepared: ToolSearchPreparedTurn | null | undefined): string {
  if (!prepared?.toolSearchActive) return "";
  if (!enabled()) return "";
  const corpus = sortByName(
    dedupeByName([
      ...prepared.visibleTools,
      ...prepared.deferredCatalog.entries.map((e) => e.tool),
    ]),
  );
  return corpus.length > 0 ? buildDomainCards(corpus) : "";
}
