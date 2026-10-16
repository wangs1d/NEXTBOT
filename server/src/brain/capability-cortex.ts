// Agent Brain Center — 能力皮层（CapabilityCortex）
// 维护 Agent 能力域注册表，提供自省 / 缺口识别 / 占位扩展能力。
// identifyGap 支持 LLM 语义分析（注入 GapAnalyzer 时），规则兜底（SCENARIO_KEYWORD_MAP）。

import type {
  CapabilityDescriptor,
  CapabilityGapReport,
} from "./types.js";
import {
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
} from "../agent/agent-capabilities.js";

/**
 * 能力扩展提案：触发 expand() 时传入的最小信息。
 * 实际的 Skill 生成由 EvolutionCortex + SkillGenerator 完成，
 * 这里仅把它登记为 planned 状态的 descriptor。
 */
export type CapabilityExpansionProposal = {
  domain: string;
  label?: string;
  description?: string;
  tools?: string[];
  source?: "builtin" | "skill" | "dynamic";
  rationale?: string;
};

/**
 * LLM 能力缺口分析结果（结构化）。
 * 替代原 SCENARIO_KEYWORD_MAP 硬编码的关键词匹配，做语义级分析。
 */
export interface GapAnalysisResult {
  /** 识别到的能力缺口列表 */
  gaps: Array<{
    /** 场景描述 */
    scenario: string;
    /** 缺失的能力域标识，如 "travel_planning" / "code_sandbox" */
    missingCapability: string;
    /** 建议的补救动作，如 "走 self-programming 生成" / "接入第三方工具" */
    suggestedAction: string;
  }>;
  /** 整体分析理由（可选） */
  rationale?: string;
}

/**
 * 能力缺口分析器（LLM 驱动）。
 *
 * 替代原 SCENARIO_KEYWORD_MAP 硬编码场景匹配，做语义级分析：
 * LLM 分析最近的工具失败记录和用户请求，识别能力缺口。
 * 未注册时 identifyGap 回退到 SCENARIO_KEYWORD_MAP 关键词匹配。
 */
export interface GapAnalyzer {
  analyze(params: {
    /** 场景描述 / 用户请求文本 */
    scenario: string;
    /** 最近的工具失败记录（可选，由调用方提供或实现方自行拉取） */
    recentFailures?: Array<{
      tool: string;
      errorMessage?: string;
      userRequest?: string;
    }>;
    /** 当前已注册的能力域列表，供 LLM 判断哪些已就绪、哪些缺失 */
    existingDomains: string[];
  }): Promise<GapAnalysisResult>;
}

/**
 * 检查是否启用 identifyGap 的 LLM 化（语义分析）。
 * - "0" / "false" / "off"（不区分大小写）→ 返回 false（关闭 LLM 化，回退到 SCENARIO_KEYWORD_MAP 规则匹配）
 * - 其他（含未设置）→ 返回 true（启用 LLM 化，优先用 GapAnalyzer 语义分析）
 */
function isIdentifyGapLlmEnabled(): boolean {
  const raw = process.env.BRAIN_LLM_IDENTIFYGAP_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

/**
 * 场景关键词 → 期望能力域映射。
 * 用于 identifyGap 的规则匹配：当用户场景文本命中关键词时，
 * 认为该场景期望对应能力域已就绪。
 */
const SCENARIO_KEYWORD_MAP: Array<{
  keywords: string[];
  domains: string[];
}> = [
  {
    keywords: ["旅游", "出行", "出去玩", "行程", "旅游攻略"],
    domains: ["travel_planning"],
  },
  {
    keywords: ["记账", "财务", "支出", "预算"],
    domains: ["finance_deep"],
  },
  {
    keywords: ["代码", "编程", "写脚本", "自动化"],
    domains: ["code_sandbox", "self_programming"],
  },
  {
    keywords: ["天气", "下雨", "气温"],
    domains: ["weather"],
  },
  {
    keywords: ["购物", "下单", "买东西", "淘宝", "京东"],
    domains: ["shopping_order"],
  },
  {
    keywords: ["提醒", "日程", "开会"],
    domains: ["calendar"],
  },
  {
    keywords: ["健康", "运动", "步数", "睡眠"],
    domains: ["health_fitness"],
  },
  {
    keywords: ["邮件", "短信", "发送消息"],
    domains: ["email_sms"],
  },
  {
    keywords: ["图片", "生成图", "画一张"],
    domains: ["image_gen"],
  },
  {
    keywords: ["智能家居", "开灯", "关灯", "空调"],
    domains: ["smart_home"],
  },
];

/**
 * 已知可走 self-programming 扩展的能力域集合。
 * travel_planning / 学习类(notes) / 自动化类(code_sandbox, self_programming)
 * 缺失这些域时，gap 报告会标记 expandable=true。
 */
const EXPANDABLE_DOMAINS = new Set<string>([
  "travel_planning",
  "notes",
  "code_sandbox",
  "self_programming",
]);

/**
 * 能力域 → 工具名匹配规则。
 *
 * - 字符串以 `.` 结尾：前缀匹配（如 `phone.` 命中 phone.call_user / phone_bridge.ring）
 * - 字符串不含 `.`：精确匹配（如 `search_web`）
 * - 字符串含 `.` 但不以 `.` 结尾：精确匹配（如 `world.link.send_message`）
 *
 * 用途：bootstrap 阶段调用 {@link CapabilityCortex.attachToolNames}，
 * 把 ToolRegistry 中已注册的真实工具名按 domain 归类填到 descriptor.tools，
 * 让 brain.list_capabilities 返回的工具名对 LLM 可见。
 *
 * 注意 social_feed / social_outreach 工具名前缀相同（`social.`），靠精确名区分：
 *   - social_feed 走 `world.social.*`（前缀 `world.social.`）
 *   - social_outreach 走无 `world.` 前缀的 `social.post / social.comment / ...`
 */
const DOMAIN_TOOL_PATTERNS: Record<string, string[]> = {
  wallet: ["wallet.", "payment.", "alipay."],
  agent_link: ["world.link."],
  calendar: ["calendar.", "reminder."],
  weather: ["weather."],
  sub_agent: ["master."],
  aip: ["aip."],
  vision: ["vision."],
  desktop: ["desktop.", "browser.session.", "browser.fetch_page"],
  web: ["search_web", "search_images", "search_videos", "fetch_web", "info."],
  life_assistant: ["budget.", "shopping.suggest", "payment.", "alipay."],
  voice: ["voice."],
  phone: ["phone.", "phone_bridge."],
  // entertainment 暂无对应工具
  social_feed: ["world.social."],
  self_programming: ["self."],
  world: ["world."],
  embodiment: ["embodiment."],
  smart_home: ["smart_home."],
  notes: ["notes."],
  image_gen: ["image."],
  file_doc: ["file."],
  email_sms: ["email.", "sms."],
  media_music: ["media."],
  health_fitness: ["health."],
  finance_deep: ["finance."],
  // 外部社交平台：精确匹配 6 个工具名（不带 world. 前缀，避免与 social_feed 冲突）
  social_outreach: [
    "social.post",
    "social.comment",
    "social.repost",
    "social.like",
    "social.get_feed",
    "social.search_posts",
  ],
  code_sandbox: ["code."],
  shopping_order: ["shopping.order."],
  agent_browser: ["agent_browser."],
  shared_browser: ["shared_browser."],
};

/** 判断工具名是否被某个 pattern 命中 */
function matchToolName(toolName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith(".")) {
      if (toolName.startsWith(p)) return true;
    } else if (toolName === p) {
      return true;
    }
  }
  return false;
}

/**
 * 能力皮层 —— 维护 Agent 能力域注册表。
 *
 * - 启动时把 agent-capabilities.ts 的 CAPABILITY_DOMAINS / DOMAIN_LABELS
 *   作为初始种子载入内存 registry；
 * - 支持运行时 register / unregister；
 * - identifyGap 基于关键词规则识别场景缺失能力，不依赖 LLM；
 * - expand 仅登记为 planned 状态，真正的 Skill 生成交给 EvolutionCortex。
 */
export class CapabilityCortex {
  /** 能力域 → 描述符 */
  private registry = new Map<string, CapabilityDescriptor>();
  /** 能力缺口分析器（LLM 驱动）：替代 SCENARIO_KEYWORD_MAP 硬编码做语义级分析 */
  private gapAnalyzer: GapAnalyzer | null = null;

  private started = false;

  constructor() {
    this.loadSeed();
  }

  // ---- 生命周期 ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    console.log(
      `[CapabilityCortex] 已启动，已注册能力域数: ${this.registry.size}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    console.log("[CapabilityCortex] 已停止");
  }

  /**
   * 注册能力缺口分析器（LLM 驱动）。
   *
   * 注入后 identifyGap 优先用 LLM 语义分析场景文本 + 工具失败记录，
   * 替代原 SCENARIO_KEYWORD_MAP 硬编码关键词匹配。
   * 未注入或 LLM 失败时回退到 identifyGapByRule 规则匹配。
   */
  registerGapAnalyzer(analyzer: GapAnalyzer): void {
    this.gapAnalyzer = analyzer;
    console.log("[CapabilityCortex] 已注册 GapAnalyzer（LLM 能力缺口分析）");
  }

  /**
   * 把 ToolRegistry 中已注册的真实工具名按 {@link DOMAIN_TOOL_PATTERNS}
   * 归类填充到对应 domain 的 descriptor.tools。
   *
   * 在 bootstrap 完成所有 registerXxxTools 之后调用一次，确保
   * `brain.list_capabilities` / `introspect` 返回的工具名是真实可调用的。
   *
   * 副作用：覆盖 registry 中已注册的 descriptor.tools 字段；
   * 未匹配到任何工具的 domain 仍保持空数组（不会创建新 domain）。
   *
   * @param allToolNames ToolRegistry.list() 返回的全部工具名
   */
  attachToolNames(allToolNames: string[]): void {
    let touched = 0;
    // 先处理静态 DOMAIN_TOOL_PATTERNS（核心域）
    for (const [domain, patterns] of Object.entries(DOMAIN_TOOL_PATTERNS)) {
      const existing = this.registry.get(domain);
      if (!existing) continue;
      const matched = allToolNames.filter((name) => matchToolName(name, patterns));
      this.registry.set(domain, {
        ...existing,
        tools: matched,
      });
      if (matched.length > 0) touched++;
    }
    // 再处理动态注册的 domain → toolNames（capability-modules 等通过 registerDomainToolNames 注入）
    for (const [domain, toolNames] of this._dynamicDomainTools) {
      const existing = this.registry.get(domain);
      if (!existing) continue;
      // 与 allToolNames 取交集，确保只填入实际已注册的工具
      const allSet = new Set(allToolNames);
      const matched = toolNames.filter((n) => allSet.has(n));
      this.registry.set(domain, {
        ...existing,
        tools: matched,
      });
      if (matched.length > 0) touched++;
    }
    console.log(
      `[CapabilityCortex] attachToolNames 完成：${touched} 个 domain 已填充工具名，共 ${allToolNames.length} 个工具名参与匹配`,
    );
  }

  /**
   * 动态注册 domain → 工具名映射。
   *
   * 用于 capability-modules 等动态能力源：bootstrap 遍历 buildCapabilityModules 结果，
   * 把每个 module 的 chatTools 工具名按 domain 注入。
   *
   * 与 {@link attachToolNames} 配合：attachToolNames 会把这些工具名与
   * ToolRegistry 实际已注册的工具取交集后填入 descriptor.tools。
   *
   * 新增 capability-module 时只需在 buildCapabilityModules 加 entry，
   * 不需要改 DOMAIN_TOOL_PATTERNS。
   */
  registerDomainToolNames(domain: string, toolNames: string[]): void {
    this._dynamicDomainTools.set(domain, toolNames);
  }
  private _dynamicDomainTools = new Map<string, string[]>();

  // ---- CapabilityCortexLike 契约 ----------------------------------------

  /**
   * 自省：返回当前 actor 已注册的能力描述符列表。
   * 当前实现不区分 actor（能力域全局共享），直接返回全量快照。
   */
  introspect(actorId: string): CapabilityDescriptor[] {
    // actorId 暂未用于能力过滤，预留以匹配接口契约
    void actorId;
    return this.snapshot();
  }

  // ---- 扩展 API（供 BrainCenter 之外的工具/路由调用） -------------------

  /** 返回所有已注册能力描述符 */
  list(): CapabilityDescriptor[] {
    return Array.from(this.registry.values());
  }

  /** 判断指定能力域是否已注册 */
  has(domain: string): boolean {
    return this.registry.has(domain);
  }

  /** 运行时注册新能力 */
  register(desc: CapabilityDescriptor): void {
    this.registry.set(desc.domain, desc);
  }

  /** 注销能力域，返回是否成功移除 */
  unregister(domain: string): boolean {
    return this.registry.delete(domain);
  }

  /**
   * 快照：给 prompt builder / 工具查询用。
   * 与 list() 等价，可传 actorId（当前全局共享，预留参数）。
   */
  snapshot(actorId?: string): CapabilityDescriptor[] {
    void actorId;
    return this.list();
  }

  /**
   * 识别能力缺口（LLM 语义分析 + 规则兜底）。
   *
   * LLM 化策略：
   *  - 启用且 GapAnalyzer 已注册 → 调 LLM 分析场景文本 + 工具失败记录，
   *    识别能力缺口，返回结构化 {gaps: [{scenario, missingCapability, suggestedAction}]}
   *  - LLM 不可用/超时/降级开关关闭/未注入 GapAnalyzer → 回退到 identifyGapByRule 规则匹配
   *
   * 注意：identifyGap 不是热路径（由 EvolutionCortex 周期触发），可承受 LLM 调用成本。
   */
  async identifyGap(scenario: string): Promise<CapabilityGapReport> {
    // 降级开关关闭 / GapAnalyzer 未注册 → 走规则兜底
    if (!isIdentifyGapLlmEnabled() || !this.gapAnalyzer) {
      return this.identifyGapByRule(scenario);
    }

    try {
      const result = await this.gapAnalyzer.analyze({
        scenario,
        existingDomains: Array.from(this.registry.keys()),
      });

      // 把 LLM 结构化结果映射到 CapabilityGapReport（向后兼容）
      const allDomains = result.gaps.map((g) => g.missingCapability);
      const missingDomains = allDomains.filter((d) => !this.registry.has(d));
      const relatedExisting = allDomains.filter((d) => this.registry.has(d));
      const expandable = missingDomains.some((d) => EXPANDABLE_DOMAINS.has(d));

      const rationaleParts: string[] = [];
      if (result.rationale) {
        rationaleParts.push(result.rationale);
      }
      if (result.gaps.length === 0) {
        rationaleParts.push("LLM 分析未识别到能力缺口。");
      } else {
        for (const g of result.gaps) {
          rationaleParts.push(`${g.scenario}: 缺 ${g.missingCapability}（${g.suggestedAction}）；`);
        }
        if (missingDomains.length > 0) {
          rationaleParts.push(`缺失：${missingDomains.join("、")}。`);
        }
        if (relatedExisting.length > 0) {
          rationaleParts.push(`已就绪可复用：${relatedExisting.join("、")}。`);
        }
        if (expandable) {
          rationaleParts.push("缺失域属可扩展场景，可走 self-programming 流程生成。");
        }
      }

      return {
        scenario,
        missingDomains,
        relatedExisting,
        expandable,
        rationale: rationaleParts.join(""),
        detectedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.log(
        `[CapabilityCortex] identifyGap LLM 失败，回退规则: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.identifyGapByRule(scenario);
    }
  }

  /**
   * 规则驱动的能力缺口识别（规则兜底）。
   *
   * 策略：把 scenario 与 SCENARIO_KEYWORD_MAP 逐条匹配，
   * 命中则收集期望能力域，再与现有 registry 对比，
   * 缺失的进 missingDomains，已存在的进 relatedExisting。
   *
   * LLM 不可用/超时/降级开关关闭时由 identifyGap 回退调用。
   */
  private identifyGapByRule(scenario: string): CapabilityGapReport {
    const text = scenario.toLowerCase();
    const expected = new Set<string>();

    for (const entry of SCENARIO_KEYWORD_MAP) {
      const hit = entry.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (hit) {
        for (const d of entry.domains) expected.add(d);
      }
    }

    const missingDomains: string[] = [];
    const relatedExisting: string[] = [];
    for (const d of expected) {
      if (this.registry.has(d)) {
        relatedExisting.push(d);
      } else {
        missingDomains.push(d);
      }
    }

    const expandable = missingDomains.some((d) => EXPANDABLE_DOMAINS.has(d));

    const rationaleParts: string[] = [];
    if (expected.size === 0) {
      rationaleParts.push("未命中任何已知场景关键词，无法判定期望能力域。");
    } else {
      rationaleParts.push(
        `场景命中期望能力域：${Array.from(expected).join("、")}。`,
      );
      if (missingDomains.length > 0) {
        rationaleParts.push(`缺失：${missingDomains.join("、")}。`);
      }
      if (relatedExisting.length > 0) {
        rationaleParts.push(`已就绪可复用：${relatedExisting.join("、")}。`);
      }
      if (expandable) {
        rationaleParts.push(
          "缺失域属可扩展场景，可走 self-programming 流程生成。",
        );
      }
    }

    return {
      scenario,
      missingDomains,
      relatedExisting,
      expandable,
      rationale: rationaleParts.join(""),
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * 扩展能力（占位实现）。
   *
   * 真正的 Skill 生成在 EvolutionCortex 里通过 SkillGenerator 完成；
   * 这里只把提案登记为 planned 状态的 descriptor 并返回，
   * 使其出现在后续 list / snapshot 中，便于 prompt 与工具查询感知到「规划中」能力。
   */
  expand(proposal: CapabilityExpansionProposal): CapabilityDescriptor {
    const now = new Date().toISOString();
    const descriptor: CapabilityDescriptor = {
      domain: proposal.domain,
      label: proposal.label ?? proposal.domain,
      description: proposal.description,
      tools: proposal.tools ?? [],
      status: "planned",
      source: proposal.source ?? "dynamic",
      registeredAt: now,
    };
    this.register(descriptor);
    return descriptor;
  }

  // ---- 内部工具 ----------------------------------------------------------

  /** 把 agent-capabilities.ts 的种子常量载入 registry */
  private loadSeed(): void {
    const now = new Date().toISOString();
    for (const domain of CAPABILITY_DOMAINS) {
      const label = DOMAIN_LABELS[domain] ?? domain;
      this.registry.set(domain, {
        domain,
        label,
        tools: [],
        status: "active",
        source: "builtin",
        registeredAt: now,
      });
    }
  }
}
