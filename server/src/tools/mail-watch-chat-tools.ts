import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 邮箱读取工具定义（2026-11-25）。
 *
 * 背景：授权码填完、IMAP 接通之后，邮件只进了「盯梢 → 主动提醒 → 动态页」这条
 * 链路，Agent 本身没有任何读邮件的入口——用户问「我最近收到什么邮件」时答不上来。
 * 这里补一个只读工具，数据源是 [MailWatchRegistry.fetchNewSince] 的最近邮件缓冲，
 * 与动态页同源，不额外新建 IMAP 连接。
 */
const MAIL_RECENT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "mail.recent",
    description:
      "读取用户已接入邮箱的最近邮件（发件人、主题、时间、正文摘要）。" +
      "用于用户问「最近有什么邮件」「有没有账单/行程/验证码相关的邮件」等场景。" +
      "邮箱未接入时返回明确错误，不要编造邮件内容。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回封数，默认 10，上限 30" },
        query: {
          type: "string",
          description: "可选关键词，按发件人 / 主题 / 正文摘要过滤",
        },
      },
      additionalProperties: false,
      required: [],
    },
  },
};

export const MAIL_WATCH_CHAT_TOOLS: ChatCompletionTool[] = [MAIL_RECENT_TOOL];
