/**
 * 工具分类声明表（阶段优化①：分类从「推断」走向「声明」）。
 *
 * 背景：检索四级分类（域组/域/能力/资源）的 L2/L3 此前完全靠名称模式推断
 * （inferDomains/inferCapabilities），没有任何工具显式声明过自己的分类——
 * 推断错一处，路由就偏一处（实证：hot_rankings 被推成 "hot" 域，落在 general
 * 组外；「今天有什么热搜」意图被路由到 clock/shopping）。
 *
 * 本表是**声明优先**的覆盖层：
 *   - domains / capabilities：声明值与推断值取并集（声明在前），保证路由切片
 *     稳定的同时不丢失推断出的长尾信号；
 *   - recallBoost：2026-11-11 起只允许**负向**权重，作为语义相邻工具的防串台
 *     护栏；正向加权已移除——排序交给 BM25/embedding/rerank，工具与 action 的
 *     选择交给模型（语义写在 schema 描述里），代码不再替模型提权；
 *   - 未出现在表中的工具完全走推断，行为与之前一致。
 *
 * 新增工具时建议在此声明（可选）：推断仍可用，但声明即承诺。
 * 校验：chat-tool-drift 的分类校验会检查本表引用的域/组是否存在于分类体系。
 */

export interface ToolRecallBoostRule {
  /** 正则源串（对原始 query 做大小写不敏感匹配） */
  pattern: string;
  /** 加权值（负=压制；正向已禁用，最终分数钳制在 [-0.25, 0.45]） */
  weight: number;
}

export interface ToolClassificationOverride {
  /** 声明域（与推断值取并集，声明在前） */
  domains?: string[];
  /** 声明能力标签（domain.action 形式，与推断值取并集，声明在前） */
  capabilities?: string[];
  /** 防串台护栏（只允许负向；query 词面命中即压制） */
  recallBoost?: ToolRecallBoostRule[];
  /** 声明缘由（文档性，供 review） */
  reason?: string;
}

export const TOOL_CLASSIFICATION_OVERRIDES: Record<string, ToolClassificationOverride> = {
  // ── 分类修正（推断错的）──
  // 复合 web_search 收编 search_web / hot_rankings / search_images / search_videos：
  // 名称前缀推不出 search 域（"web" 不是登记域），域声明仍必须显式给出；
  // hot_rankings 的 "hot" 误推修正随复合收编一并保留。
  web_search: {
    domains: ["search"],
    capabilities: ["search.query", "search.trending"],
    reason: "复合名推不出 search 域；各 action 语义由 schema 描述承载，不做词面加权",
  },
  web_fetch: {
    recallBoost: [
      { pattern: "\\bsearch\\b|\\bnews\\b|\\blatest\\b|热搜|搜一下|找几张", weight: -0.12 },
    ],
    reason: "搜索类 query 不应抢到页内读取入口（仅负向护栏）",
  },

  // ── 复合 action 覆盖（2026-11-11）：只保留防串台的负向压制 ──
  "world.link": {
    recallBoost: [
      { pattern: "语音消息|发语音|朗读|播报|念给我听", weight: -0.2 },
    ],
    reason: "站内通信入口；压掉 voice 对『消息』二字的字面抢占（仅负向护栏）",
  },
  voice: {
    recallBoost: [
      { pattern: "好友|加好友|好友申请|回复好友消息", weight: -0.2 },
    ],
    reason: "语音输出入口；好友消息不应被 voice 抢走（仅负向护栏）",
  },
  phone: {
    recallBoost: [
      { pattern: "好友消息|语音消息|发条消息", weight: -0.15 },
    ],
    reason: "通话链路入口；与站内消息/语音消息区分（仅负向护栏）",
  },
  agent: {
    recallBoost: [
      // 「Agent 世界/在线状态」说的是世界接入，不是 Agent 自身能力。
      { pattern: "世界状态|在线状态|agent\\s*世界", weight: -0.22 },
    ],
    reason: "Agent 自身/用户档案入口；与 world 的接入状态意图区分（仅负向护栏）",
  },
  device: {
    recallBoost: [
      { pattern: "开灯|关灯|窗帘|空调|插座", weight: -0.15 },
    ],
    reason: "已绑定设备入口；与 smart_home 的家居控制区分（仅负向护栏）",
  },
  aip: {
    recallBoost: [
      // 用户对「提议」拍板属于 proactivity，不是跨 Agent 协议。
      { pattern: "批准|同意这个|拒绝这个|就这么办", weight: -0.22 },
    ],
    reason: "Agent 间协议入口；与 proactivity 的确认动作区分（仅负向护栏）",
  },
  world: {
    recallBoost: [
      { pattern: "好友消息|加好友|发消息", weight: -0.18 },
    ],
    reason: "Agent 世界接入入口；日常通信归 world.link（仅负向护栏）",
  },
};

/** 取某工具的声明（无则 null）。 */
export function getToolClassification(name: string): ToolClassificationOverride | null {
  return TOOL_CLASSIFICATION_OVERRIDES[name] ?? null;
}

interface CompiledBoostRule {
  regex: RegExp;
  weight: number;
}

const compiledBoostCache = new Map<string, CompiledBoostRule[]>();

/** 编译某工具的召回校准规则（模块级缓存；规则随表常驻，无失效需求）。 */
export function getCompiledRecallBoosts(name: string): CompiledBoostRule[] {
  const cached = compiledBoostCache.get(name);
  if (cached) return cached;
  const rules = (TOOL_CLASSIFICATION_OVERRIDES[name]?.recallBoost ?? []).map((rule) => ({
    regex: new RegExp(rule.pattern, "i"),
    weight: rule.weight,
  }));
  compiledBoostCache.set(name, rules);
  return rules;
}

/**
 * 分类声明健康检查（启动/测试用）：声明的域与能力是否落在已知分类体系内。
 * 返回告警列表（空 = 健康）。域白名单取自 DOMAIN_GROUPS 全集的调用方传入。
 */
export function auditClassificationOverrides(knownDomains: Iterable<string>): string[] {
  const domainSet = new Set(knownDomains);
  const warnings: string[] = [];
  for (const [name, override] of Object.entries(TOOL_CLASSIFICATION_OVERRIDES)) {
    for (const domain of override.domains ?? []) {
      if (!domainSet.has(domain)) {
        warnings.push(`${name}: 声明域 "${domain}" 不在已知域集合中`);
      }
    }
    for (const capability of override.capabilities ?? []) {
      if (!capability.includes(".")) {
        warnings.push(`${name}: 声明能力 "${capability}" 缺少 domain. 前缀`);
      }
    }
  }
  return warnings;
}
