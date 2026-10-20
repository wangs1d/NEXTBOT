/**
 * 结构化 LLM 调用契约（2026-10-07 对齐主流网关终态）。
 *
 * 背景：换模型事故（MiniMax M 系思考链挤占路由正文）暴露出"小输出结构化调用"
 * 的三类隐性差异——思考分流行为、JSON 输出保证、单次失败语义——此前散落在
 * 各调用点手工处理。本助手把这三件事统一为契约：
 *
 *   1. 请求参数按 provider 能力档案自适应（预算/超时/json mode 由调用方经
 *      {@link resolveRouteCallParams} 等档案入口给值）；
 *   2. `response_format: json_object` 走协议契约——JSON 合法性由厂商解码层
 *      保证，思考模型的正文不再可能被挤占；端点不支持时自动降参重试；
 *   3. 网关式重试：超时/坏输出按原参重试（瞬态抖动语义），provider 异常时
 *      去掉 response_format 重试（该参数对任何 OpenAI 兼容端点恒安全），
 *      达到最大尝试次数才报失败——失败语义收敛为可判别的 reason 联合类型，
 *      业务层据此决定降级/缓存，不再各自裸写竞速与 catch。
 *
 * 消费方：意图路由（route-llm-call）；后续旁路小输出调用（记忆决策/摘要等）
 * 迁移到同一契约即可获得同等保障。
 */
import type { ExternalChatProvider } from "./types.js";

export type StructuredCallOk<T> = {
  ok: true;
  /** 解析后的结构化结果（parse 回调产出） */
  value: T;
  /** 原始正文（供调用方二次解析，如路由的 aux 情绪分析同体输出） */
  raw: string;
  /** 实际尝试次数（网关重试可观测性） */
  attempts: number;
};

export type StructuredCallFail = {
  ok: false;
  /** provider_disabled=未启用；timeout=逐次超时；call_error=逐次异常；unparseable=逐次坏输出 */
  reason: "provider_disabled" | "timeout" | "call_error" | "unparseable";
  attempts: number;
  lastError?: unknown;
};

export type StructuredCallResult<T> = StructuredCallOk<T> | StructuredCallFail;

export type StructuredCallOptions<T> = {
  /** 单次尝试输出 token 上限（档案值，思考型模型须放大——见 provider-profiles）。 */
  maxOutputTokens: number;
  /** 单次尝试超时 ms（档案值；env 显式覆盖由调用方的档案入口处理）。 */
  timeoutMs: number;
  /** 是否启用 response_format 契约（档案 supportsJsonMode；未登记端点 false 不冒险）。 */
  jsonMode: boolean;
  /**
   * 输出解析/校验回调：返回 null 视为坏输出（触发原参重试）。
   * 注意约定：parse 失败必须返回 null（而非抛错），抛错会被当作调用异常处理。
   */
  parse: (text: string) => T | null;
  /** 日志标识（如 "intent_route"），重试/失败日志带此前缀便于归因。 */
  label: string;
  /** 最大尝试次数，默认 2（网关式语义：首次失败后恰一次补救机会）。 */
  maxAttempts?: number;
  /**
   * 超时是否触发原参重试，默认 true。
   *
   * 置 false 的语义：超时≠坏输出。超时说明请求仍卡在服务端（原参立刻重试几乎
   * 必然再次超时），把单次超时预算翻倍成 2×timeout 纯属空等。调用方若自带
   * 确定性兜底（如意图路由的保守降级），应置 false——用兜底换掉这半程空等。
   * 坏输出/调用异常的重试不受本开关影响（那才是真正的瞬态抖动）。
   */
  retryOnTimeout?: boolean;
  /** 单次自包含调用（不累积线程历史）。结构化调用默认 true。 */
  ephemeralTurn?: boolean;
  /** 剥掉聊天线程的【回复规则】【展示形式】等后缀（省全价输入）。结构化调用默认 true。 */
  suppressRuntimeSuffixes?: boolean;
};

/**
 * 结构化调用唯一入口。永不抛错——所有失败折叠为 reason 联合类型。
 * 会话 id 由调用方拼接前缀（如 `llm-route::`），本层不感知会话语义。
 */
export async function structuredCall<T>(
  provider: ExternalChatProvider,
  sessionId: string,
  prompt: string,
  opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  if (!provider.isEnabled()) {
    return { ok: false, reason: "provider_disabled", attempts: 0 };
  }
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const ephemeralTurn = opts.ephemeralTurn ?? true;
  const suppressRuntimeSuffixes = opts.suppressRuntimeSuffixes ?? true;

  let useJsonMode = opts.jsonMode;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const raw = await Promise.race([
        provider.streamCompletion(
          sessionId,
          { text: prompt },
          () => {}, // 结构化调用无需流式回传
          undefined,
          {
            maxOutputTokens: opts.maxOutputTokens,
            ephemeralTurn,
            suppressRuntimeSuffixes,
            functionalSuffixes: false,
            ...(useJsonMode ? { responseFormat: "json_object" as const } : {}),
          },
        ),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), opts.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));

      if (raw === undefined) {
        if (attempt < maxAttempts && opts.retryOnTimeout !== false) {
          console.warn(
            `[structured-call:${opts.label}] 超时（${opts.timeoutMs}ms），原参重试（${attempt + 1}/${maxAttempts}）`,
          );
          continue;
        }
        console.warn(
          `[structured-call:${opts.label}] 超时（${opts.timeoutMs}ms），` +
            (opts.retryOnTimeout === false ? "按调用方约定不重试" : "已达最大尝试次数") +
            "，交给调用方兜底",
        );
        return { ok: false, reason: "timeout", attempts: attempt };
      }

      const value = opts.parse(raw);
      if (value !== null) {
        return { ok: true, value, raw, attempts: attempt };
      }
      if (attempt < maxAttempts) {
        console.warn(
          `[structured-call:${opts.label}] 输出不可解析（${raw.slice(0, 40)}），重试（${attempt + 1}/${maxAttempts}）`,
        );
        continue;
      }
      return { ok: false, reason: "unparseable", attempts: attempt };
    } catch (err) {
      if (attempt < maxAttempts) {
        // 异常一律补救重试；带 json mode 时顺带去掉 response_format——
        // 不带该参数对任何 OpenAI 兼容端点恒安全（自适应兼容不支持的端点）。
        const dropped = useJsonMode;
        useJsonMode = false;
        console.warn(
          `[structured-call:${opts.label}] 调用异常（${err instanceof Error ? err.message : String(err)}），重试（${attempt + 1}/${maxAttempts}）${dropped ? "，去 response_format" : ""}`,
        );
        continue;
      }
      return { ok: false, reason: "call_error", attempts: attempt, lastError: err };
    }
  }
  // 循环必经 return，此处仅为类型收窄保底。
  return { ok: false, reason: "call_error", attempts: maxAttempts };
}
