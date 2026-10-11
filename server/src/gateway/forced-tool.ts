import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";

/**
 * 强制工具路由（forced tool choice）——只保留高精度结构信号（2026-09-05 根源化）：
 * 对显式电话、明确的位置问题强制指定 tool_choice，避免 LLM 编造。
 *
 * 规则：
 * 1. 显式电话请求 → 强制 phone.call_user（结构化意图，非话题词）
 * 2. 明确的「我在哪/当前位置」问题 → 强制 clock.get_user_location
 *
 * 2026-10-11 口径统一（「问时间」把模型自述当正文输出的事故根修）：
 * **直接时间问题不再强制 clock.get_current_time**。此前这里强制 tool_choice，而
 * system 侧（runtime-kernel minimal session system / 【消息时间戳】块）写的是
 * 「【当前时间】块每轮注入，不要调用工具查当前时间」——两条互斥硬规则同时压给模型，
 * 模型只能先自述一遍权衡（「系统已注入当前时间提示……但强制规则要求必须调用工具」）再
 * 执行，而那段自述随工具波前导话直穿气泡（真机截图 4 泡）。时间统一以【当前时间】块
 * 为准（2026-10-07 用户拍板：每轮注入、工具查时间又慢又费 token），故此处撤销时间强制。
 *
 * 旧的「时效性事实 → 强制 search_web」分支（FRESH_WEB_LOOKUP_RE /
 * FRESH_FACT_ENTITY_HINT_RE 话题词表）已删除——"需不需要外部信息"由路由层
 * 语义分类承担，"有没有真的查"由工具循环的出口自检（风格判定）承担，
 * 不再用话题关键词在执行层预判。
 *
 * 注：weather_get_local 不强制路由，由进程内延迟目录检索召回。
 */

const DIRECT_LOCATION_RE = /我.*在哪|当前位置|所在城市|where am i/i;

export type ForcedToolChoice =
  | { type: "function"; function: { name: string } }
  | "auto";

export function resolveForcedToolChoice(
  userText: string,
  apiTools: ChatCompletionTool[],
  fastProfile?: boolean,
): ForcedToolChoice {
  // 1. 显式电话请求 → 强制 phone.call_user
  //    ⚠️ 工具名以注册名为准（点号分族，见 agent-phone-tools.ts）；
  //    旧实现写成下划线 phone_call_user，与注册名永不匹配，等于死分支。
  if (isExplicitPhoneCallRequest(userText)) {
    const hasPhoneCallTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "phone.call_user",
    );
    if (hasPhoneCallTool) {
      return { type: "function", function: { name: "phone.call_user" } };
    }
  }

  // 2. 「我在哪/当前位置」问题 → 强制 clock.get_user_location
  //    位置没有别的权威来源（【当前时间】块只带时区，不带城市），必须真调工具。
  //    时间问题不在此列（2026-10-11）：见文件顶部注释。
  if (!fastProfile && DIRECT_LOCATION_RE.test(userText)) {
    const hasLocationTool = apiTools.some(
      (tool) => tool.type === "function" && tool.function?.name === "clock.get_user_location",
    );
    if (hasLocationTool) {
      return { type: "function", function: { name: "clock.get_user_location" } };
    }
  }

  return "auto";
}
