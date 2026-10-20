/**
 * Provider 能力档案表（2026-10-07 换模型通用适配）。
 *
 * 根因：小输出结构化旁路调用（意图路由、记忆决策、滚动摘要等）此前把
 * "192 token / 3s 超时" 与 "关思考参数" 硬编码在各自调用点，隐含假设主模型是
 * 无思考链快模型。主模型切到 MiniMax M 系（默认强制思考、思考计入 max_tokens）
 * 后，路由调用被思考链饿死（正文 0 字符）→ 保守降级把闲聊整轮吸进任务面。
 * 同类问题在裸 OpenAI SDK 旁路（bypassChatRequestExtras）已发生过一次，但
 * 修复散落在 resolve-provider 里、路由层没吃到——本质是「每个调用点各自适配
 * 模型特性」的打地鼠模式。
 *
 * 通用机制：模型特性（思考链行为、关思考是否生效、小输出调用该给多少预算/
 * 超时）声明在 provider 档案表里，调用点只消费档案。**换/加模型只需在
 * {@link PROVIDER_MODEL_PROFILES} 登记（或改）一行**，所有旁路调用点自适应，
 * 不再逐点打补丁。
 *
 * 未登记的 provider 走 {@link FALLBACK_PROVIDER_PROFILE}（按最坏情况放大预算
 * 与超时）：预算放大对快模型零成本（只是上限不收紧），超时放大只在失败路径
 * 多等一拍——宁可慢，不可把正文饿死。
 */

export type ProviderModelProfile = {
  /**
   * 旗下模型是否存在默认开思考链的型号（文档性声明：提示"接这个 provider
   * 要注意思考预算"）。
   */
  readonly thinkingProne: boolean;
  /**
   * `thinking: { type: "disabled" }` 是否被真实执行（false = accept 但仍思考，
   * 如 MiniMax M2.x——只能靠 reasoning_split 保证正文干净，预算必须放大）。
   */
  readonly canDisableThinking: boolean;
  /**
   * 裸 OpenAI SDK 旁路请求（无 provider 适配层的直连调用）需显式附加的请求
   * 参数。provider 路径不消费它——各 provider 自带等效默认（如 kimi/minimax
   * 默认关思考、openai 槽位对 deepseek-flash 自动关）。
   */
  readonly bypassRequestExtras: (model: string) => Record<string, unknown>;
  /** 意图路由等小输出结构化调用的 max_tokens 预算。 */
  readonly routeMaxOutputTokens: number;
  /** 意图路由调用超时（ms）；`LLM_ROUTE_TIMEOUT_MS` 显式覆盖优先。 */
  readonly routeTimeoutMs: number;
  /**
   * 端点是否支持 OpenAI 兼容 `response_format`（json_object）。true 时路由调用
   * 走结构化输出契约（JSON 合法性由厂商解码层保证）；未知端点默认 false——
   * 不冒险传参数，退回 prompt 约定 + 解析降级（主流 adapter 的能力声明语义）。
   */
  readonly supportsJsonMode: boolean;
};

/** 无思考链快模型的路由参数（现行验证值：deepseek-flash 实测 658-1159ms 完成判定）。 */
const FAST_ROUTE = { routeMaxOutputTokens: 192, routeTimeoutMs: 3000 } as const;

/**
 * 思考型模型的路由参数：M2.x 思考计入 max_tokens（192 会把正文饿死）；
 * M3 关思考后大多 0.4-2.4s 完成，仍留尾延迟余量。
 */
const THINKING_ROUTE = { routeMaxOutputTokens: 1024, routeTimeoutMs: 5000 } as const;

const disableThinking = () => ({ thinking: { type: "disabled" } as const });

/**
 * M3.1 系（如 MiniMax-M3.1-Flash）已改为「必须 adaptive 思考」：下发
 * `thinking: {type:"disabled"}` 直接 400（error 2013），连 `reasoning.effort=none`
 * 一并拒收——与 M2.x「accept 但仍思考」不同，这是硬拒。
 */
const MINIMAX_ADAPTIVE_ONLY = /^minimax-m3\.1/;

/**
 * MiniMax 系「关思考」意图的请求参数（provider 路径与裸 SDK 旁路共用同一判定，
 * 避免同类适配在两处各写一遍——见本文件头部「换模型只改档案」的机制说明）。
 * - 常规 M 系（M3 / M2.x）：`thinking: {type:"disabled"}`（M3 真生效；M2.x 接受但仍思考）
 * - M3.1 系：改发 `reasoning: {effort:"minimal"}`（实测 reasoning_tokens=0，等价关思考
 *   且不触发 400）
 * `reasoning_split` 恒开：思考分流到 `reasoning_content`，正文不被思考段污染。
 */
export function minimaxThinkingExtras(
  model: string,
  disableThinking: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { reasoning_split: true };
  if (!disableThinking) return body;
  return MINIMAX_ADAPTIVE_ONLY.test((model ?? "").trim().toLowerCase())
    ? { ...body, reasoning: { effort: "minimal" } }
    : { ...body, thinking: { type: "disabled" } };
}

export const PROVIDER_MODEL_PROFILES: Record<string, ProviderModelProfile> = {
  openai: {
    // openai 槽位可能托管 gpt 系（无思考）或 DeepSeek（deepseek-flash 默认带思考，
    // 由 openai-official-provider.buildExtraBody 自动下发 thinking:disabled）。
    thinkingProne: false,
    canDisableThinking: true,
    bypassRequestExtras: (model) =>
      model.toLowerCase().includes("deepseek-flash") ? disableThinking() : {},
    ...FAST_ROUTE,
    supportsJsonMode: true,
  },
  "moonshot-kimi": {
    // k2.5+ 默认开思考；MoonshotKimiProvider 对每次调用默认注入 thinking:disabled
    //（disableThinking !== false），旁路直连需等效声明。
    thinkingProne: true,
    canDisableThinking: true,
    bypassRequestExtras: disableThinking,
    ...FAST_ROUTE,
    supportsJsonMode: true,
  },
  minimax: {
    // M 系默认强制思考：M3 支持 thinking:disabled 真生效；M2.x accept 但仍思考
    //（思考计入 max_tokens，路由预算必须放大，见 THINKING_ROUTE）。M3.1 系（Flash）
    // 硬拒 disabled（400/2013），旁路改发 reasoning.effort=minimal——判定收敛在
    // {@link minimaxThinkingExtras}，provider 路径与本表共用。
    thinkingProne: true,
    canDisableThinking: true,
    bypassRequestExtras: (model) => minimaxThinkingExtras(model, true),
    ...THINKING_ROUTE,
    supportsJsonMode: true,
  },
} as const;

/** 未登记 provider（failover / 新接入）的安全默认：按"可能思考且关不掉"兜底。 */
export const FALLBACK_PROVIDER_PROFILE: ProviderModelProfile = {
  thinkingProne: true,
  canDisableThinking: false,
  bypassRequestExtras: () => ({}),
  ...THINKING_ROUTE,
  supportsJsonMode: false,
};

/** 按 provider id 取能力档案；未登记 id（含 failover、测试替身）回落安全默认。 */
export function resolveProviderProfile(
  providerId: string | null | undefined,
): ProviderModelProfile {
  return (providerId && PROVIDER_MODEL_PROFILES[providerId]) || FALLBACK_PROVIDER_PROFILE;
}

/**
 * 意图路由调用的请求参数（预算 + 超时 + 结构化输出）：按路由 provider 档案自适应。
 * `LLM_ROUTE_TIMEOUT_MS` 仍可显式覆盖超时（对齐所有 provider）。
 */
export function resolveRouteCallParams(
  externalChat: { id?: string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { maxOutputTokens: number; timeoutMs: number; jsonMode: boolean } {
  const profile = resolveProviderProfile(externalChat?.id);
  const raw = env.LLM_ROUTE_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return {
    maxOutputTokens: profile.routeMaxOutputTokens,
    timeoutMs: Number.isFinite(n) && n > 0 ? n : profile.routeTimeoutMs,
    jsonMode: profile.supportsJsonMode,
  };
}
