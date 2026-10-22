/**
 * 域卡（Domain Cards）——延迟工具目录的能力面展示（2026-10-01 S1）。
 *
 * 根修目标：元认知盲区。检索（无论 BM25 多准）只能回应"模型已经想找"的查询，
 * "不知道有这个能力所以不搜"的漏召结构性无法治愈。域卡把全部能力域+工具名
 * 以 ~1.2k token 常驻在指导语位置（消息尾部动态区，前缀缓存不受影响），模型
 * 每轮都知道"我有什么"，简单参数工具可按名直呼 tool_call（零往返），复杂参数
 * 工具用 tool_discover({domain}) 确定性拉取全族 schema。
 *
 * 卡片从语料派生（不手工维护，MCP/技能注册即自动刷新），同语料签名恒同字节。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { DOMAIN_REGISTRY, domainsForTool, resolveDomainDef, type DomainDef } from "./tool-category.js";
import { firstSentence } from "./schema-slim.js";

/** 卡片工具清单每域上限（仅详版使用；超出的长尾域截断并标注） */
export const CARD_TOOLS_PER_DOMAIN = 14;

/**
 * 紧凑模式（2026-10-22 定稿，架构文档 5.2 环 2）：域卡只保留「域名｜一句话」，
 * 不再列举工具名。依据：①Tool Search 实测按需发现省 95% 上下文且选择准确率
 * 反升（49%→74%）；②域名→tool_discover({domain}) 一跳可达，工具名清单的
 * 引导价值低于体量代价（14 名×N 域 ≈3.4k tokens）。回滚开关：
 * AGENT_DOMAIN_CARDS_COMPACT=0 恢复详版（列工具名）。
 */
const isDomainCardsCompact = (): boolean => process.env.AGENT_DOMAIN_CARDS_COMPACT !== "0";

function nameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? tool.function?.name ?? "" : "";
}

/**
 * 生成域卡文本（确定性：registry 顺序 + 域内按语料序，同签名恒同输出）。
 * @param corpus 全量可检索语料（含当轮可见工具——卡片覆盖完整能力面，
 *               不随当轮可见集抖动，换取跨轮字节稳定）
 */
export function buildDomainCards(corpus: ChatCompletionTool[]): string {
  const byDomain = new Map<string, string[]>();
  for (const tool of corpus) {
    const name = nameOf(tool);
    if (!name) continue;
    for (const domain of domainsForTool(name)) {
      const list = byDomain.get(domain) ?? [];
      if (!list.includes(name)) list.push(name);
      byDomain.set(domain, list);
    }
  }

  const compact = isDomainCardsCompact();
  const lines: string[] = [];
  const line = (def: DomainDef, names: string[]): string => {
    if (compact) return `- ${def.name}｜${def.summary}`;
    const shown = names.slice(0, CARD_TOOLS_PER_DOMAIN);
    const more = names.length - shown.length;
    return `- ${def.name}｜${def.summary}：${shown.join("·")}` + (more > 0 ? `（+${more}）` : "");
  };

  // ① 显式域（DOMAIN_REGISTRY 顺序；misc 兜底行留到最末）。
  const emitted = new Set<string>();
  for (const def of DOMAIN_REGISTRY) {
    if (def.name === "misc") continue;
    const names = byDomain.get(def.name);
    if (!names || names.length === 0) continue; // 语料无此域（edition/模块裁剪）→ 卡片不出现
    emitted.add(def.name);
    lines.push(line(def, names));
  }
  // ② 派生域（2026-10-10 根修）：未登记进注册表、由注册名前缀派生的域
  //（技能族 habit/booking/picture/finance/virtual-phone/agentworld 等）。
  // 按域名排序保证确定性；同样受 CARD_TOOLS_PER_DOMAIN 截断。
  for (const domain of [...byDomain.keys()].filter((d) => !emitted.has(d) && d !== "misc").sort()) {
    lines.push(line(resolveDomainDef(domain), byDomain.get(domain) ?? []));
  }
  // ③ misc 兜底行（无点号的无名工具），永远排在最后。
  const misc = byDomain.get("misc");
  if (misc && misc.length > 0) {
    lines.push(line(resolveDomainDef("misc"), misc));
  }
  if (lines.length === 0) return "";

  const header = compact
    ? [
        "【能力域目录】以下是延迟目录按域组织的全部能力（当轮可见工具之外的都在这里）：",
        "需要某域能力时用 tool_discover({domain:\"域名\"}) 拉取该域的工具名与参数 schema，再按 schema 调用；",
        "不确定该用哪个域时可用 tool_discover({query:\"...\"}) 按语义检索。动手类任务先查此目录，不要凭常识断言做不到。",
      ]
    : [
        "【能力域目录】以下是延迟目录按域组织的全部能力（当轮可见工具之外的都在这里）：",
        "简单参数的工具可直接 tool_call 按名调用；参数复杂的先用 tool_discover({domain:\"域名\"}) 拉取该域工具的参数 schema 再调用；",
        "不确定该用哪个域时可用 tool_discover({query:\"...\"}) 按语义检索。动手类任务先查此目录，不要凭常识断言做不到。",
      ];
  return [...header, ...lines].join("\n");
}
