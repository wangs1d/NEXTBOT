import type { WorldService } from "@nextbot/agent-world";
import { UnifiedErrorCode } from "@nextbot/agent-protocol";
import {
  getToolMetadata as inferToolMetadata,
  type ToolMetadata,
} from "../agent/loop/tool-metadata.js";
import { resolveActorId } from "../agent/actor-id.js";
import {
  isToolAllowedInAccessMode,
  parseAgentAccessMode,
  sandboxDeniedToolMessage,
  type AgentAccessMode,
} from "../agent/agent-access-mode.js";
import type { SkillManager } from "../skills/index.js";

import type { ClientLocationWire } from "../types/client-location.js";

/** 工具执行中途推送给客户端的媒体卡（chat.media_ready cards 项的结构子集）。 */
export type ToolMediaCard = {
  type: "image" | "video";
  title: string;
  thumbnailUrl: string;
  mediaUrl?: string;
  /** 图下说明文字（如「请扫码登录京东」） */
  caption?: string;
};

export type ToolContext = {
  sessionId: string;
  /** 稳定用户标识（优先）；与 `sessionId` 二选一由 {@link resolveActorId} 合并 */
  userId?: string;
  /** 触发本轮工具执行的 `chat.user_message.messageId`（发送方主会话），用于审计与中继关联 */
  chatUserMessageId?: string;
  /** 客户端 IP（仅在前端未上报定位时作兜底） */
  clientIp?: string;
  /** 前端 GPS / 浏览器定位（优先于 IP 地理库） */
  clientLocation?: ClientLocationWire;
  /**
   * 按需向客户端请求实时位置（Agent 需要位置时才调用，返回 null 表示不可用/超时）。
   * 由位置类工具（weather.get_local 等）在缺少经纬度时使用。
   */
  requestLocation?: (reason?: string) => Promise<ClientLocationWire | null>;
  /**
   * 工具执行中途向聊天流推送媒体卡片（如购物登录/支付二维码），
   * 经 chat.media_ready 挂到当前流式回复上。聊天主路径装配；
   * 主动任务等无流式上下文的调用方为空，工具自行降级。
   */
  pushMediaCards?: (cards: ToolMediaCard[]) => void;
  /** 默认沙箱；`full` 时开放高权限工具 */
  agentAccessMode?: AgentAccessMode;
  /** 电脑桥接在线时允许 desktop.visual.* */
  desktopBridgeOnline?: boolean;
  /** 手机桥接在线时允许 phone.* */
  phoneBridgeOnline?: boolean;
  /** 单次调用取消信号（工具循环超时即 abort；子进程/HTTP 类 handler 可消费提前退出） */
  signal?: AbortSignal;
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;

/**
 * 工具执行成功通知（Task 16 消费管家：工具执行统一出口的钩子）。
 * 仅在工具执行成功（ok=true 且非缓存命中）后回调一次；装配层据此向
 * HookBus 发布 tool.executed 事件（消费类工具 → 自动入账等下游消费）。
 */
export type ToolExecutedNotifier = (info: {
  /** 注册表内的规范工具名 */
  tool: string;
  /** 原始入参（消费方自行摘取金额/描述等字段） */
  input: Record<string, unknown>;
  /** 工具返回结果（JSON 安全化后） */
  result: Record<string, unknown>;
  /** 稳定用户标识 */
  actorId: string;
  /** 执行完成时刻（ISO 时间戳） */
  timestamp: string;
}) => void;

export type ToolAvailabilityResult =
  | boolean
  | {
      ok: boolean;
      reason?: string;
    };

export type ToolAvailabilityCheck = (
  context: ToolContext,
) => ToolAvailabilityResult | Promise<ToolAvailabilityResult>;

export type ToolRegistrationMetadata = Partial<Omit<ToolMetadata, "name">> & {
  /** Runtime availability gate, similar to external agent check_fn design. */
  checkFn?: ToolAvailabilityCheck;
};

/** LLM/API 工具名（下划线）→ 注册名（点号），兼容历史会话与未走 prepareToolsForChatApi 的路径。 */
const REGISTRY_TOOL_NAME_ALIASES: Record<string, string> = {
  embodiment_roam: "embodiment.roam",
  embodiment_move: "embodiment.move",
  embodiment_stop: "embodiment.stop",
  embodiment_set_state: "embodiment.set_state",
  embodiment_excite: "embodiment.excite",
  embodiment_window_roam: "embodiment.window_roam",
  embodiment_window_place: "embodiment.window_place",
  embodiment_observe: "embodiment.observe",
  desktop_visual_screenshot: "desktop.visual.screenshot",
  desktop_visual_run_task: "desktop.visual.run_task",
  // 2026-08-30 修复：self.list_custom_skills 只有 chat schema（fast 车道可见），
  // 注册表里没有执行器——模型一调用就报"未知工具"。语义与 skill.list 一致，走别名。
  // 注意键用 LLM 实际传的点号名（underscore 别名表匹配不到它）。
  "self.list_custom_skills": "skill.list",
};

export function resolveRegistryToolName(name: string): string {
  return REGISTRY_TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * 工具结果缓存：相同工具名+参数在 TTL 内复用结果。
 * 适用场景：天气/时间/搜索等查询类工具，短时间内重复调用概率高。
 * 不适用：写操作、桌面操作、购物下单等副作用工具。
 */
interface ToolCacheEntry {
  result: { ok: boolean; result: Record<string, unknown> };
  timestamp: number;
}

const TOOL_CACHE_TTL_MS = 60_000; // 60 秒缓存
const TOOL_CACHE_MAX_SIZE = 100;

/** 需要缓存的工具名（查询类、无副作用） */
const CACHEABLE_TOOLS = new Set([
  "weather.get_local",
  "internet.research",
  "internet.live_check",
  "internet.verify",
  "search_web",
  "search_images",
  "search_videos",
  "fetch_web",
  "info.inspect_webpage",
  "info.navigate_site",
  "info.search",
  "hot_rankings",
  // 注意：用户维度只读工具（wallet.get_*/calendar.list_tasks/brain.recall/
  // perception.overview 等）故意不进——缓存键只有 name+input，跨 actor 复用
  // 会串台；actor 无关的全网热搜才安全。
]);

/** 生成工具缓存键 */
function buildToolCacheKey(name: string, input: Record<string, unknown>): string {
  const sortedInput = Object.keys(input).sort().reduce((acc, key) => {
    acc[key] = input[key];
    return acc;
  }, {} as Record<string, unknown>);
  return `${name}:${JSON.stringify(sortedInput)}`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private readonly metadata = new Map<string, ToolMetadata & { checkFn?: ToolAvailabilityCheck }>();
  private skillManager?: SkillManager;
  private worldService?: WorldService | null;
  private readonly toolCache = new Map<string, ToolCacheEntry>();
  /** 工具执行成功通知器（装配层注入：消费类工具成功 → HookBus tool.executed） */
  private toolExecutedNotifier?: ToolExecutedNotifier;

  /**
   * 注入工具执行成功通知器（Task 16 消费管家事件源）。
   * 通知器异常静默吞掉——事件发布失败不能影响工具执行主链路。
   */
  setToolExecutedNotifier(fn: ToolExecutedNotifier | undefined): void {
    this.toolExecutedNotifier = fn;
  }

  /** 工具执行成功后通知（fire-and-forget，永不抛出） */
  private notifyToolExecuted(
    registryName: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
    context: ToolContext,
  ): void {
    if (!this.toolExecutedNotifier) return;
    try {
      this.toolExecutedNotifier({
        tool: registryName,
        input,
        result,
        actorId: resolveActorId(context),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.log(`[ToolRegistry] tool.executed 通知失败（忽略）tool=${registryName}: ${err}`);
    }
  }

  /**
   * 用于校验社区 Skill 是否已被当前会话购买（个人房 `roomId === sessionId`）。
   */
  setWorldService(service: WorldService | null): void {
    this.worldService = service;
  }

  /**
   * 设置 Skill 管理器（可选）
   */
  setSkillManager(manager: SkillManager): void {
    this.skillManager = manager;
  }

  /**
   * 获取已注入的 SkillManager（可能未注入，返回 undefined）。
   * 用于需要查询 skill schema 的场景（如能力自省带 schema 输出）。
   */
  getSkillManager(): SkillManager | undefined {
    return this.skillManager;
  }

  /**
   * 注册传统工具（代码方式）
   */
  register(name: string, handler: ToolHandler, metadata?: ToolRegistrationMetadata): void {
    this.tools.set(name, handler);
    this.metadata.set(name, this.mergeMetadata(name, metadata));
  }

  list(): string[] {
    const traditionalTools = Array.from(this.tools.keys());
    
    // 如果有 Skill 管理器，合并 Skill 列表
    if (this.skillManager) {
      const skills = this.skillManager.list(true); // 只列出启用的
      const skillNames = skills.map(s => s.name);
      return [...traditionalTools, ...skillNames];
    }
    
    return traditionalTools;
  }

  getMetadata(name: string): ToolMetadata & { checkFn?: ToolAvailabilityCheck } {
    const registryName = resolveRegistryToolName(name);
    return this.metadata.get(registryName) ?? this.mergeMetadata(registryName);
  }

  listMetadata(): Array<ToolMetadata & { checkFn?: ToolAvailabilityCheck }> {
    return this.list().map((name) => this.getMetadata(name));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    // 先别名归一，再 trim + 大小写兜底（LLM 偶尔回传带空格/改写大小写的工具名）
    const registryName = this.normalizeToolName(resolveRegistryToolName(name));
    const accessMode = parseAgentAccessMode(context.agentAccessMode);
    if (!isToolAllowedInAccessMode(registryName, accessMode, {
      desktopBridgeOnline: context.desktopBridgeOnline,
      phoneBridgeOnline: context.phoneBridgeOnline,
    })) {
      return {
        ok: false,
        result: { error: sandboxDeniedToolMessage(registryName), errorCode: UnifiedErrorCode.ToolDenied },
      };
    }

    const availability = await this.checkAvailability(registryName, context);
    if (!availability.ok) {
      return {
        ok: false,
        result: {
          error: availability.reason ?? `工具当前不可用: ${registryName}`,
          errorCode: UnifiedErrorCode.ToolUnavailable,
        },
      };
    }

    // 优先尝试通过 Skill 管理器执行
    if (this.skillManager) {
      const manifest = this.skillManager.get(registryName);
      const actorId = resolveActorId(context);
      if (
        manifest?.kind === "community" &&
        this.worldService &&
        !this.worldService.getOrCreateRoom(actorId, actorId).ownedSkillIds.includes(registryName)
      ) {
        return {
          ok: false,
          result: {
            error: `未拥有该社区技能，无法调用：${registryName}（请在世界商店购买后再试）`,
            errorCode: UnifiedErrorCode.ToolDenied,
          },
        };
      }
      const skillResult = await this.skillManager.execute(registryName, input, context);
      if (skillResult.ok) {
        const safe = jsonSafeResult(skillResult.result || {});
        this.notifyToolExecuted(registryName, input, safe, context);
        return { ok: true, result: safe };
      }
      // 如果 Skill 不存在，继续尝试传统工具
      if (skillResult.error?.code !== "SKILL_NOT_FOUND") {
        return {
          ok: false,
          result: {
            error: skillResult.error?.message || "Skill 执行失败",
            errorCode: UnifiedErrorCode.ToolExecutionFailed,
          },
        };
      }
    }

    // 回退到传统工具执行
    const tool = this.tools.get(registryName);
    if (!tool) {
      return {
        ok: false,
        result: { error: `未知工具: ${registryName}`, errorCode: UnifiedErrorCode.ToolUnknown },
      };
    }

    // 工具结果缓存：查询类工具在 TTL 内复用结果
    if (this.isCacheableTool(registryName)) {
      const ttlMs = this.resolveToolCacheTtlMs(registryName);
      const cacheKey = buildToolCacheKey(registryName, input);
      const cached = this.toolCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < ttlMs) {
        return cached.result;
      }
      // 缓存未命中或过期，执行并缓存
      try {
        const result = await tool(input, context);
        const safeResult = jsonSafeResult(result);
        this.notifyToolExecuted(registryName, input, safeResult, context);
        const entry = { result: { ok: true, result: safeResult }, timestamp: Date.now() };
        // LRU 淘汰：超过最大容量时删除最旧的
        if (this.toolCache.size >= TOOL_CACHE_MAX_SIZE) {
          const oldestKey = this.toolCache.keys().next().value;
          if (oldestKey !== undefined) {
            this.toolCache.delete(oldestKey);
          }
        }
        this.toolCache.set(cacheKey, entry);
        return entry.result;
      } catch (error) {        const message = error instanceof Error ? error.message : "工具执行失败";
        return { ok: false, result: { error: message, errorCode: UnifiedErrorCode.ToolExecutionFailed } };
      }
    }

    try {
      const result = await tool(input, context);
      const safeResult = jsonSafeResult(result);
      this.notifyToolExecuted(registryName, input, safeResult, context);
      return { ok: true, result: safeResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, result: { error: message, errorCode: UnifiedErrorCode.ToolExecutionFailed } };
    }
  }

  /**
   * 工具名归一化：trim 空格 + 大小写不敏感兜底。
   * 精确匹配优先；未命中时再做一次 O(n) 的小写匹配（仅传统工具与 skill 列表），
   * 避免 LLM 回传带空格/改写大小写的工具名时误报"未知工具"。
   */
  private normalizeToolName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return trimmed;
    if (this.tools.has(trimmed)) return trimmed;
    if (this.skillManager?.get(trimmed)) return trimmed;

    const lower = trimmed.toLowerCase();
    for (const key of this.tools.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    if (this.skillManager) {
      for (const manifest of this.skillManager.list()) {
        if (manifest.name.toLowerCase() === lower) return manifest.name;
      }
    }
    return trimmed;
  }

  /**
   * 查询工具缓存（供 tool search 桥接层调用）。
   * 命中时直接返回缓存结果，跳过 executeTool 调用。
   * @returns 缓存结果，未命中返回 null
   */
  getCachedResult(
    name: string,
    input: Record<string, unknown>,
  ): { ok: boolean; result: Record<string, unknown> } | null {
    const registryName = resolveRegistryToolName(name);
    if (!this.isCacheableTool(registryName)) return null;
    const ttlMs = this.resolveToolCacheTtlMs(registryName);
    const cacheKey = buildToolCacheKey(registryName, input);
    const cached = this.toolCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ttlMs) {
      return cached.result;
    }
    return null;
  }

  /** 清理过期缓存（定期调用） */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.toolCache.entries()) {
      const toolName = key.slice(0, key.indexOf(":"));
      if (now - entry.timestamp >= this.resolveToolCacheTtlMs(toolName)) {
        this.toolCache.delete(key);
      }
    }
  }

  private mergeMetadata(
    name: string,
    metadata?: ToolRegistrationMetadata,
  ): ToolMetadata & { checkFn?: ToolAvailabilityCheck } {
    const inferred = inferToolMetadata(name);
    return {
      ...inferred,
      ...metadata,
      name,
      category: metadata?.category ?? inferred.category,
      alternatives: metadata?.alternatives ?? inferred.alternatives,
      requireHonestFailure: metadata?.requireHonestFailure ?? inferred.requireHonestFailure,
    };
  }

  private async checkAvailability(
    name: string,
    context: ToolContext,
  ): Promise<{ ok: boolean; reason?: string }> {
    const checkFn = this.metadata.get(name)?.checkFn;
    if (!checkFn) return { ok: true };
    const result = await checkFn(context);
    if (typeof result === "boolean") return { ok: result };
    return { ok: result.ok, reason: result.reason };
  }

  private isCacheableTool(name: string): boolean {
    const policy = this.getMetadata(name).cachePolicy;
    return policy?.enabled === true || CACHEABLE_TOOLS.has(name);
  }

  private resolveToolCacheTtlMs(name: string): number {
    return this.getMetadata(name).cachePolicy?.ttlMs ?? TOOL_CACHE_TTL_MS;
  }
}

/**
 * 将工具 handler 返回结果递归转换为 JSON 安全值，防止 wire 层序列化崩溃：
 *  - BigInt → 字符串（保精度）
 *  - NaN / ±Infinity → null
 *  - function / symbol / undefined → 对象内跳过、数组内转 null（由 JSON.stringify 处理）
 *  - Date → ISO 字符串
 *  - 循环引用 → "[Circular]"（防御，正常 handler 不应产生）
 */
function jsonSafeResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const seen = new Set<object>();
  return deepJsonSafe(result, seen) as Record<string, unknown>;
}

function deepJsonSafe(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      return Number.isFinite(value) ? value : null;
    case "function":
    case "symbol":
      return undefined;
    case "object": {
      if (seen.has(value)) return "[Circular]";
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) {
        seen.add(value);
        const out = value.map((item) => deepJsonSafe(item, seen));
        seen.delete(value);
        return out;
      }
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const safe = deepJsonSafe(item, seen);
        if (safe !== undefined) out[key] = safe;
      }
      seen.delete(value);
      return out;
    }
    default:
      return value;
  }
}
