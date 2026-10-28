// Agent Brain Center — 能力皮层（CapabilityCortex）
// 维护 Agent 能力域注册表，提供自省 / 占位扩展能力。

import type {
  CapabilityDescriptor,
} from "./types.js";
import {
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
} from "../agent/agent-capabilities.js";

/**
 * 能力扩展提案：触发 expand() 时传入的最小信息。
 * 实际的 Skill 生成由 SkillGenerator 完成，
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
 * 能力域 → 工具名匹配规则。
 *
 * - 字符串以 `.` 结尾：前缀匹配（如 `phone.` 命中 phone.call_user / phone_bridge.ring）
 * - 字符串不含 `.`：精确匹配（如 `search_web`）
 * - 字符串含 `.` 但不以 `.` 结尾：精确匹配（如 `world.link.send_message`）
 *
 * 用途：bootstrap 阶段调用 {@link CapabilityCortex.attachToolNames}，
 * 把 ToolRegistry 中已注册的真实工具名按 domain 归类填到 descriptor.tools，
 * 让 introspect / 能力域快照里的工具名与 ToolRegistry 一致。
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
 * - expand 仅登记为 planned 状态。
 */
export class CapabilityCortex {
  /** 能力域 → 描述符 */
  private registry = new Map<string, CapabilityDescriptor>();

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
   * 把 ToolRegistry 中已注册的真实工具名按 {@link DOMAIN_TOOL_PATTERNS}
   * 归类填充到对应 domain 的 descriptor.tools。
   *
   * 在 bootstrap 完成所有 registerXxxTools 之后调用一次，确保
   * `introspect` 返回的工具名是真实注册过的。
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
   * 扩展能力（占位实现）。
   *
   * 真正的 Skill 生成通过 SkillGenerator 完成；
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
