import { createHash } from "node:crypto";

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { finalizeChatSystemPrompt, type FinalizeChatSystemPromptOpts } from "../agent/prompt-builder.js";
import { assembleSystemPrompt } from "../agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "./types.js";

export type PrefixCacheRequest = {
  prompt_cache_key: string;
  prompt_cache_retention?: "24h";
};

export type PromptCacheMode = "none" | "explicit-key" | "explicit-breakpoint" | "implicit-prefix";

export type PromptCacheProfile = {
  mode: PromptCacheMode;
  namespace: string;
  supportsRetention24h?: boolean;
};

export type PreparePromptCachePlanArgs = {
  providerId: string;
  model: string;
  baseSystemPrompt: string;
  memory?: AgentPromptMemoryContext;
  finalizeOptions?: FinalizeChatSystemPromptOpts;
  tools?: ChatCompletionTool[];
  variant?: string;
  /**
   * 会话级稳定层冻结（2026-09-29 P0-1②）：传入 sessionId 时，同一会话+
   * 同一签名（model/variant/baseSystem/includeRenderProtocol）的 stableSystemPrompt
   * 以首轮为快照冻结——后续轮稳定层字节完全一致，DeepSeek 隐式前缀缓存可
   * 命中 system+历史 前缀。稳定层记忆中途写入（画像抽取/理解修订）下一会话
   * 生效，本会话内动态层不受影响。STABLE_PROMPT_SESSION_FREEZE=0 关闭。
   */
  sessionId?: string;
  /**
   * 是否注入展示形式协议（默认 true）。ephemeral 工具调用（简报润色/摘要/改写
   * 等，输出由程序消费、无聊天渲染管线）传 false——协议进入这些调用只会诱导
   * 模型输出 [RENDER_HINT:xxx]，而下游无剥除层，标记直透用户屏幕。
   */
  includeRenderProtocol?: boolean;
};

export type PreparedPromptCachePlan = {
  profile: PromptCacheProfile;
  fullSystemPrompt: string;
  requestSystemMessages: ChatCompletionMessageParam[];
  /** 需要沉底注入到「最新 user 消息尾部」的 volatile 动态上下文（记忆/时间/意图等）。 */
  tailDynamicContext?: string;
  promptCache?: PrefixCacheRequest;
};

const DEFAULT_NAMESPACE = "nextbot-system-prompt-v1";

function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function includeToolsInPromptCacheKey(): boolean {
  // 默认 true：contextual/delegate 档的工具集合跨轮会变，key 不含工具签名时，
  // 不同工具集的请求被路由到同一 OpenAI cache 分片却无法前缀复用，命中率反而
  // 被稀释。含签名后同工具集请求精确聚簇（DeepSeek/Kimi 隐式前缀缓存不走此 key，
  // 不受影响）。
  return envEnabled("OPENAI_PROMPT_CACHE_KEY_INCLUDE_TOOLS", true);
}

function stableToolSignature(tools?: ChatCompletionTool[]): string {
  if (!tools?.length || !includeToolsInPromptCacheKey()) return "";
  return JSON.stringify(
    tools.map((tool) => {
      if (tool.type !== "function") return tool;
      return {
        type: tool.type,
        function: {
          name: tool.function?.name ?? "",
          description: tool.function?.description ?? "",
          parameters: tool.function?.parameters ?? null,
        },
      };
    }),
  );
}

function supportsOpenAiPromptCacheRetention(model: string): boolean {
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("gpt-4.1") ||
    model === "gpt-5.1-chat-latest"
  );
}

function resolvePromptCacheProfile(providerId: string, model: string): PromptCacheProfile {
  const normalized = providerId.trim().toLowerCase();

  if (normalized === "openai") {
    return {
      mode: envEnabled("OPENAI_PREFIX_CACHE_ENABLED", true) ? "explicit-key" : "none",
      namespace: process.env.OPENAI_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
      supportsRetention24h: supportsOpenAiPromptCacheRetention(model),
    };
  }

  if (normalized === "moonshot-kimi" || normalized === "moonshot" || normalized === "kimi") {
    return {
      mode: envEnabled("MOONSHOT_PREFIX_CACHE_ENABLED", true) ? "implicit-prefix" : "none",
      namespace: process.env.MOONSHOT_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    };
  }

  if (normalized === "deepseek") {
    // DeepSeek 官方端点是**服务端隐式前缀缓存**：无显式 key、无断点标记，按
    // 64 token 块自动命中并在 usage 回传 `prompt_cache_hit_tokens`（2026-10-22
    // 实测：1222 token 的 system+首轮，第二轮命中 1024 = 块对齐后的全部前缀）。
    // 因此不能走 openai 槽的 explicit-key（白算 key 不说，还会让请求体与
    // 「纯前缀字节相等即命中」的服务端语义错位）。
    return {
      mode: envEnabled("DEEPSEEK_PREFIX_CACHE_ENABLED", true) ? "implicit-prefix" : "none",
      namespace: process.env.DEEPSEEK_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    };
  }

  if (normalized === "minimax") {
    // MiniMax 实测（2026-10-07 受控探针）：服务端多副本缓存不一致，被动缓存对
    // 字节级相同请求也会随机 128↔全量命中。显式断点（anthropic 风格块状
    // system + cache_control）经 OpenAI 兼容端点实测被接受（200 正常返回），
    // 5 分钟滚动 TTL + 命中续期 + 断点计费口径是白捡的；MINIMAX_EXPLICIT_CACHE_ENABLED=0
    // 回退隐式前缀模式。
    return {
      mode: envEnabled("MINIMAX_EXPLICIT_CACHE_ENABLED", true)
        ? "explicit-breakpoint"
        : "implicit-prefix",
      namespace: process.env.MINIMAX_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    };
  }

  return {
    mode: envEnabled("EXTERNAL_MODEL_PREFIX_CACHE_ENABLED", true) ? "implicit-prefix" : "none",
    namespace: process.env.EXTERNAL_MODEL_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
  };
}

/**
 * 显式缓存断点（anthropic 风格）：把 system 消息转为块状 content 并在块尾打
 * `cache_control: {type:"ephemeral"}`，断点覆盖其前全部前缀（tools → system →
 * messages 顺序中的 system 段）。OpenAI Node SDK 类型不含 cache_control 字段，
 * 运行时按 JSON 原样透传，端点不识别该字段时也只是多余 key（实测 MiniMax、
 * Anthropic 兼容端点均接受）。
 */
function markCacheBreakpoint(msg: ChatCompletionMessageParam): ChatCompletionMessageParam {
  if (typeof msg.content !== "string" || !msg.content) return msg;
  const block = {
    role: msg.role,
    content: [
      { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
    ],
  };
  // OpenAI SDK 类型不含 cache_control 字段；运行时 JSON 原样透传（MiniMax/Anthropic 兼容端点实测均接受）
  return block as unknown as ChatCompletionMessageParam;
}

function resolvePromptCacheRetention(profile: PromptCacheProfile): "24h" | undefined {
  const raw = process.env.OPENAI_PROMPT_CACHE_RETENTION?.trim();
  if (!raw) return undefined;
  if (raw !== "24h") {
    console.warn(
      `[prefix-cache] Ignoring unsupported OPENAI_PROMPT_CACHE_RETENTION=${raw}. Expected "24h".`,
    );
    return undefined;
  }
  return profile.supportsRetention24h ? "24h" : undefined;
}

function buildStableSystemPrompt(
  baseSystemPrompt: string,
  memory: AgentPromptMemoryContext | undefined,
  finalizeOptions: FinalizeChatSystemPromptOpts | undefined,
  includeRenderProtocol: boolean,
): { fullSystemPrompt: string; stableSystemPrompt: string; dynamicSystemPrompt?: string } {
  // 单一出口：finalize（规则后缀）→ assemble（全局规则 + stable/dynamic 分层）一次完成。
  // 旧版在此处连调 finalize + Sections + buildLayeredSystemPrompt 三次重复渲染。
  const finalizedBaseSystem = finalizeChatSystemPrompt(baseSystemPrompt, finalizeOptions);
  return assembleSystemPrompt(finalizedBaseSystem, memory, { includeRenderProtocol });
}

function buildPromptCacheKey(args: {
  profile: PromptCacheProfile;
  model: string;
  stableSystemPrompt: string;
  tools?: ChatCompletionTool[];
  variant?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(args.profile.namespace);
  hash.update("\nprovider-mode:");
  hash.update(args.profile.mode);
  hash.update("\nmodel:");
  hash.update(args.model);
  hash.update("\nvariant:");
  hash.update(args.variant ?? "chat");
  hash.update("\nstable-system:");
  hash.update(args.stableSystemPrompt);
  hash.update("\ntools:");
  hash.update(stableToolSignature(args.tools));
  return `${args.profile.namespace}:${hash.digest("hex").slice(0, 32)}`;
}

export function preparePromptCachePlan(
  args: PreparePromptCachePlanArgs,
): PreparedPromptCachePlan {
  const profile = resolvePromptCacheProfile(args.providerId, args.model);
  const { fullSystemPrompt, stableSystemPrompt, dynamicSystemPrompt } = buildStableSystemPrompt(
    args.baseSystemPrompt,
    args.memory,
    args.finalizeOptions,
    args.includeRenderProtocol !== false,
  );

  // P0-1② 会话级冻结：同会话+同签名沿用首轮 stable 快照（字节稳定 → 前缀
  // 缓存可命中）。冻结只覆盖 requestSystemMessages/promptCache key 的 stable
  // 部分；fullSystemPrompt 的动态段与 tailDynamicContext 每轮照常新鲜。
  const frozenStable = freezeStableForSession(args, stableSystemPrompt);
  const stableToUse = frozenStable;
  const fullToUse =
    dynamicSystemPrompt && frozenStable !== stableSystemPrompt
      ? `${frozenStable}\n\n${dynamicSystemPrompt}`
      : fullSystemPrompt;

  // P0-2 前缀稳定化：requestSystemMessages 只保留静态 system（stable）——
  // volatile 动态上下文（记忆图联想检索/当前时间/意图理解等）不再作为独立 system
  // 放在请求头部（任何记忆变化都会使整段前缀缓存失效），改经 tailDynamicContext
  // 沉底注入到「最新 user 消息尾部」。DeepSeek 等 provider 的自动 prefix cache
  // 因此能命中稳定的 system+历史对话前缀，只有尾部动态增量产生新的缓存放量。
  // explicit-breakpoint：在 stable system 尾打显式缓存断点（工具循环与纯文本
  // 分支都经 applyPromptCacheMessages 以此替换头部 system，单一出口两路生效）。
  const requestSystemMessages: ChatCompletionMessageParam[] = [
    profile.mode === "explicit-breakpoint"
      ? markCacheBreakpoint({ role: "system", content: stableToUse })
      : { role: "system", content: stableToUse },
  ];

  const promptCache =
    profile.mode === "explicit-key"
      ? {
          prompt_cache_key: buildPromptCacheKey({
            profile,
            model: args.model,
            stableSystemPrompt: stableToUse,
            tools: args.tools,
            variant: args.variant,
          }),
          ...(resolvePromptCacheRetention(profile)
            ? { prompt_cache_retention: resolvePromptCacheRetention(profile) }
            : {}),
        }
      : undefined;

  return {
    profile,
    fullSystemPrompt: fullToUse,
    requestSystemMessages,
    tailDynamicContext: dynamicSystemPrompt,
    promptCache,
  };
}

/**
 * 会话级稳定层快照（P0-1②，2026-09-29）：key = sessionId|model|variant|baseHash|renderFlag。
 * 首轮写入快照；后续轮无论稳定层记忆是否中途更新（画像抽取每轮写、理解档案
 * 修订等），都沿用首轮字节——更新下个会话自然生效。无 sessionId / 开关关闭 /
 * LRU 淘汰后重开新快照：行为退回逐轮渲染（正确性不受影响，只是缓存差）。
 */
const SESSION_STABLE_SNAPSHOT = new Map<string, string>();
const SESSION_STABLE_SNAPSHOT_MAX = 256;

function stableFreezeEnabled(): boolean {
  return envEnabled("STABLE_PROMPT_SESSION_FREEZE", true);
}

function freezeStableForSession(
  args: PreparePromptCachePlanArgs,
  stableSystemPrompt: string,
): string {
  if (!args.sessionId || !stableFreezeEnabled()) return stableSystemPrompt;
  const key = [
    args.sessionId,
    args.model,
    args.variant ?? "chat",
    createHash("sha256").update(args.baseSystemPrompt).digest("hex").slice(0, 16),
    args.includeRenderProtocol !== false ? "r1" : "r0",
  ].join("|");
  const existing = SESSION_STABLE_SNAPSHOT.get(key);
  if (existing !== undefined) {
    // LRU touch
    SESSION_STABLE_SNAPSHOT.delete(key);
    SESSION_STABLE_SNAPSHOT.set(key, existing);
    return existing;
  }
  if (SESSION_STABLE_SNAPSHOT.size >= SESSION_STABLE_SNAPSHOT_MAX) {
    const oldest = SESSION_STABLE_SNAPSHOT.keys().next().value as string | undefined;
    if (oldest !== undefined) SESSION_STABLE_SNAPSHOT.delete(oldest);
  }
  SESSION_STABLE_SNAPSHOT.set(key, stableSystemPrompt);
  return stableSystemPrompt;
}

/** 仅供测试使用：清空会话稳定层快照 */
export function resetStablePromptSnapshotForTest(): void {
  SESSION_STABLE_SNAPSHOT.clear();
}

/** 沉底块的包裹标签：让 LLM 明确这是本轮系统注入的上下文，而非用户消息正文。 */
const DYNAMIC_CONTEXT_WRAP_BEGIN = "[system-context]";
const DYNAMIC_CONTEXT_WRAP_END = "[/system-context]";
const DYNAMIC_CONTEXT_NOTE =
  "（本轮系统注入的上下文：记忆/时间/任务等，非用户消息正文，按 system 指令同等遵循）";

function wrapTailDynamicContext(tail: string): string {
  return (
    `\n\n${DYNAMIC_CONTEXT_WRAP_BEGIN}\n` +
    `${DYNAMIC_CONTEXT_NOTE}\n` +
    `${tail}\n${DYNAMIC_CONTEXT_WRAP_END}`
  );
}

/** 独立消息形态的包裹（无前导空行，块头即标签）。 */
function standaloneTailDynamicContext(tail: string): string {
  return `${DYNAMIC_CONTEXT_WRAP_BEGIN}\n${DYNAMIC_CONTEXT_NOTE}\n${tail}\n${DYNAMIC_CONTEXT_WRAP_END}`;
}

/**
 * 沉底注入形态（2026-10-22，prefix cache 根治）：
 * - `append`（默认）：作为**最后一条独立 system 消息**追加，历史消息字节一个不动；
 * - `inline`（旧行为，回滚通道）：拼进最后一条 user 消息尾部。
 *
 * 为什么必须 append：inline 形态会**改写一条已落库的历史消息**——本轮请求里最后
 * 那条 user 带尾巴，落库的是干净版，下一轮它作为历史出现时字节就变了。实测
 * （2026-10-22，DeepSeek 隐式缓存）命中量恰好等于「system + tools」而历史段 0 命中，
 * 正是从最后一条 user 起整段作废。改成独立尾消息后，历史前缀逐字节稳定，尾巴
 * 每轮重新生成只影响它自己（本来也没被缓存过）。
 */
function tailContextMode(): "append" | "inline" {
  const raw = (process.env.AGENT_TAIL_CONTEXT_MODE ?? "append").trim().toLowerCase();
  return raw === "inline" ? "inline" : "append";
}

/** 找到最新一条 user 消息（从尾部向前扫）；无 user 消息返回 null。 */
function findLastUserMessage(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "user") return msg;
  }
  return null;
}

/**
 * 把 volatile 动态上下文沉底注入，返回克隆后的消息数组（绝不改写调用方持有的
 * thread 消息对象——防污染会话历史）。
 *
 * - `append`（默认）：`[...messages, {role:"system", content: 包裹块}]`，末尾独立消息。
 *   历史逐字节不变 → 隐式前缀缓存的命中边界从「最后一条 user」推到「整段历史之后」。
 * - `inline`（回滚）：拼到最后一条 user 消息尾部（string 追加 / content parts 追加 text）。
 * - 空 messages 或 inline 找不到 user 消息：回退为追加末尾 system，不丢语义。
 */
export function applyTailDynamicContext(
  messages: ChatCompletionMessageParam[],
  tailDynamicContext: string,
): ChatCompletionMessageParam[] {
  if (!tailDynamicContext) return messages;
  if (tailContextMode() === "append") {
    return [...messages, { role: "system", content: standaloneTailDynamicContext(tailDynamicContext) }];
  }
  const lastUser = findLastUserMessage(messages);
  if (!lastUser) {
    return [...messages, { role: "system", content: tailDynamicContext }];
  }
  // 只克隆被修改的 user 消息，绝不改写调用方持有的 thread 消息对象（防污染会话历史）。
  return messages.map(
    // TS 断言返回值：openai v6 的 content part 类型组合在 spread 后会被 TS 展成
    // 带 refusal/developer 的过宽并集，运行时内容本身仍是合法 text part。
    (msg): ChatCompletionMessageParam => {
      if (msg !== lastUser) return msg;
      const wrapped = wrapTailDynamicContext(tailDynamicContext);
      if (typeof msg.content === "string") {
        return { ...msg, content: `${msg.content}${wrapped}` };
      }
      if (Array.isArray(msg.content)) {
        const parts = msg.content as Array<
          Record<string, unknown> & { type?: string; text?: string; refusal?: string }
        >;
        return {
          ...msg,
          content: [...parts, { type: "text", text: wrapped }],
        } as ChatCompletionMessageParam;
      }
      return msg;
    },
  ) as ChatCompletionMessageParam[];
}

export function applyPromptCacheMessages(
  messages: ChatCompletionMessageParam[],
  requestSystemMessages: ChatCompletionMessageParam[],
  tailDynamicContext?: string,
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [...requestSystemMessages];
  if (messages[0]?.role !== "system") {
    const base = [...requestSystemMessages, ...messages];
    return tailDynamicContext ? applyTailDynamicContext(base, tailDynamicContext) : base;
  }
  const base = [...requestSystemMessages, ...messages.slice(1)];
  return tailDynamicContext ? applyTailDynamicContext(base, tailDynamicContext) : base;
}
