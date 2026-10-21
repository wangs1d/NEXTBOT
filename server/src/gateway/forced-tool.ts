import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";
import { isActionableTaskRequest } from "../agent/task-intent.js";

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

/**
 * 短口语提醒/闹钟请求的高精度补充信号（isActionableTaskRequest 覆盖不到
 * 「明天早上9点提醒我开会」这类无「帮我」前缀、动作动词不在枚举里的句子）。
 * 仅匹配「提醒我/叫我」开头，或时间词 + 提醒/闹钟同句；确认式反问
 * （「你会提醒我吗」）明确排除。
 */
const REMINDER_REQUEST_RE =
  /^(?:记得)?(?:提醒我|叫我)|(?:明天|后天|今天|今晚|明早|每天|每晚|周[一二三四五六日天]).{0,16}(?:提醒|叫我|闹钟)/;
const CONFIRMATION_QUESTION_RE = /^(?:你|您)(?:会|能|可以|要不要|是不是)/;

export function needsToolChoiceRequired(userText: string): boolean {
  if (isActionableTaskRequest(userText)) return true;
  if (CONFIRMATION_QUESTION_RE.test(userText.trim())) return false;
  return REMINDER_REQUEST_RE.test(userText.trim());
}

export type ForcedToolChoice =
  | { type: "function"; function: { name: string } }
  | "auto"
  | "required";

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

  // 3. 明确动作/取料请求 → tool_choice="required"（2026-10-21 去后置闸的架构替代）
  //    判据复用 isActionableTaskRequest：祈使结构 + 动作动词，且已排除寒暄、
  //    纯提问、知识问答、时间/天气式单一查询。命中时由 API 层强制本轮至少
  //    调用一个工具——不指定具体工具，模型在可见集里自选。
  //    这是请求层约束，不是事后扫描文本重跑：零额外 LLM 调用、零延迟。
  //    fastProfile（轻量对话档）跳过：该档 system 已注入 currentTime/location，
  //    强制调用只会多一次 round trip。
  if (!fastProfile && apiTools.length > 0 && needsToolChoiceRequired(userText)) {
    return "required";
  }

  return "auto";
}
