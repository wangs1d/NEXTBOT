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
 *   - recallBoost：召回校准迁移自 applyAdaptiveIntentBoost 的硬编码 switch——
 *     校准词条跟着工具走，而不是堆在一个无限生长的函数里；
 *   - 未出现在表中的工具完全走推断，行为与之前一致。
 *
 * 新增工具时建议在此声明（可选）：推断仍可用，但声明即承诺。
 * 校验：chat-tool-drift 的分类校验会检查本表引用的域/组是否存在于分类体系。
 */

export interface ToolRecallBoostRule {
  /** 正则源串（对原始 query 做大小写不敏感匹配） */
  pattern: string;
  /** 加权值（正=晋升，负=压制；最终分数钳制在 [-0.25, 0.45]） */
  weight: number;
}

export interface ToolClassificationOverride {
  /** 声明域（与推断值取并集，声明在前） */
  domains?: string[];
  /** 声明能力标签（domain.action 形式，与推断值取并集，声明在前） */
  capabilities?: string[];
  /** 召回校准规则（query 词面命中即加权） */
  recallBoost?: ToolRecallBoostRule[];
  /** 声明缘由（文档性，供 review） */
  reason?: string;
}

export const TOOL_CLASSIFICATION_OVERRIDES: Record<string, ToolClassificationOverride> = {
  // ── 分类修正（推断错的）──
  hot_rankings: {
    domains: ["search"],
    capabilities: ["search.query", "search.trending"],
    recallBoost: [
      { pattern: "热搜|热点|热榜|榜单|大家都在看|都在看什么|trending", weight: 0.42 },
    ],
    reason: "推断成 'hot' 域（不在任何域组），检索路由时落 general 组外",
  },

  // ── 召回校准迁移（原 applyAdaptiveIntentBoost specialBoost 硬编码 switch）──
  "calendar.list_tasks": {
    recallBoost: [{ pattern: "\\btasks?\\b|\\btodo\\b", weight: 0.32 }],
  },
  search_web: {
    recallBoost: [
      {
        pattern: "\\bsearch\\b|\\bnews\\b|\\blatest\\b|搜(?:索|一下|一搜)|查一下|查询|行情|价格|新闻|最新",
        weight: 0.42,
      },
    ],
  },
  fetch_web: {
    recallBoost: [
      {
        pattern: "\\bread\\b|\\bfetch\\b|\\bpage\\b|\\bcontent\\b|\\burl\\b|网页|网址|链接|读一下|说了什么|读了什么",
        weight: 0.42,
      },
    ],
  },
  search_videos: {
    recallBoost: [{ pattern: "视频|影片|录像", weight: 0.35 }],
  },
  search_images: {
    recallBoost: [{ pattern: "照片|图片|壁纸|表情包|头像|找图", weight: 0.35 }],
  },
  "clock.get_current_time": {
    recallBoost: [{ pattern: "几点|现在时间|什么时间|当前时间", weight: 0.3 }],
  },
  "smart_home.control_device": {
    recallBoost: [
      { pattern: "开灯|关灯|灯打开|打开灯|灯光|调亮|调暗|空调|窗帘|插座", weight: 0.35 },
    ],
  },
  "vision.see_device": {
    recallBoost: [{ pattern: "摄像头|监控|看家|门口", weight: 0.35 }],
  },
  "geofence.create": {
    recallBoost: [
      { pattern: "到家|回到家|离家|出门|离开公司|到达.*提醒|位置提醒", weight: 0.35 },
    ],
  },
  "care.rhythm_reminder": {
    recallBoost: [{ pattern: "每天提醒|定期提醒|天天提醒|周期提醒|规律", weight: 0.3 }],
  },
  "info.inspect_webpage": {
    recallBoost: [
      { pattern: "\\bsearch\\b|\\bnews\\b|\\blatest\\b", weight: -0.1 },
      { pattern: "\\bread\\b|\\bfetch\\b|\\bcontent\\b", weight: -0.08 },
    ],
  },
  "agent.query_capabilities": {
    recallBoost: [{ pattern: "\\bcapabilit(?:y|ies)\\b|\\btools?\\b|\\bcan you\\b", weight: 0.3 }],
  },
  "self.list_custom_skills": {
    recallBoost: [{ pattern: "\\bcustom\\b|\\bskills?\\b", weight: 0.34 }],
  },
  "wallet.get_transactions": {
    recallBoost: [
      { pattern: "\\btransactions?\\b|\\brecent\\b|\\bhistory\\b", weight: 0.32 },
    ],
  },
  "desktop.run_automation": {
    recallBoost: [{ pattern: "\\bautomation\\b|\\bscript\\b|\\btask\\b", weight: 0.22 }],
  },
  "desktop.visual.run_task": {
    recallBoost: [{ pattern: "\\bautomation\\b|\\bscript\\b", weight: -0.12 }],
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
