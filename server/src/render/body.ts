/**
 * 正文形态落地（唯一出口）。
 *
 * `decideRender` 只决定「是什么形态」，这里负责把它编码成客户端认识的协议：
 *   plain → 原文；markdown/brief/image_text → [RENDER_AS:*]；
 *   fold → CONTENT_SUMMARY_V2 块（主题必须来自 decision）；
 *   result_card/quote → 文本切卡。
 * data_brief 已退役（2026-11-06）：数字密集正文不再出快报卡。
 *
 * 任何块与它的路由声明都在这里成对生成，所以不存在「有块没路由 → 裸 JSON」。
 */

import {
  createContentSummary,
  formatContentSummaryForChat,
} from "../services/content-summary-service.js";
import { formatAgentResultForChat } from "../services/agent-result-formatter.js";
import type { RenderDecision } from "./types.js";

export interface BodyFormOptions {
  userText?: string;
  toolName?: string;
}

/** 把决策出的正文形态编码成协议文本；plain 原样返回。 */
export function applyBodyForm(
  text: string,
  decision: RenderDecision,
  opts?: BodyFormOptions,
): string {
  switch (decision.body.form) {
    case "plain":
      return text;
    case "markdown":
      return `[RENDER_AS:structured]\n${text}`;
    case "brief":
      return `[RENDER_AS:brief]\n${text}`;
    case "image_text":
      return `[RENDER_AS:image_result]\n${text}`;
    case "fold": {
      const summary = createContentSummary(text, {
        forceSummary: true,
        ...(decision.body.subject ? { subject: decision.body.subject } : {}),
        ...(opts?.userText ? { query: opts.userText } : {}),
      });
      if (summary) return formatContentSummaryForChat(summary);
      // 折叠建不出来（结构不满足）→ 长文排版，不退回类目名空壳卡
      return `[RENDER_AS:structured]\n${text}`;
    }
    case "result_card":
    case "quote": {
      return formatAgentResultForChat(text, opts?.toolName) ?? text;
    }
    default:
      return text;
  }
}
