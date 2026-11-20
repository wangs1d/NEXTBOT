import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 主动邮件 / 短信能力 —— ChatCompletionTool schema。
 *
 * 工具族：
 *   - email.send  主动发邮件（SMTP）：to / subject / body / html? / attachments?
 *   - sms.send    主动发短信（阿里云 SMS）：to / text
 *
 * 走 deferred（延迟目录）：
 *   1. LLM 不会每轮都发邮件 / 短信，进核心会浪费 token
 *   2. 关键词触发（"发邮件" / "send email" / "发短信" / "text him"）时由 tool_discover 拉出
 *   3. 与 phone.call_user 区分：phone.* 是电话触达（语音），email.send / sms.send 是异步文本触达
 *
 * 失败统一返回 `{ ok: false, error, retryable? }`；
 * 成功返回 `{ ok: true, messageId, summary, ... }`。
 */
export const EMAIL_SMS_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "email.send",
      description:
        "通过 SMTP 主动发送邮件给指定收件人。适用场景：用户说「发邮件给 xxx」「写封信给」「把这段发到邮箱」「mail to」「email him/her」。\n" +
        "正文支持纯文本 body 或 HTML html（至少传一个；同时传时 html 优先作为渲染主体）。\n" +
        "可选 attachments 支持本地路径或 base64 内容。\n" +
        "返回 ok=true 时附带 messageId；失败时 ok=false + error，按 retryable 决定是否可重试。",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "收件人邮箱地址。支持 \"a@b.com\" 或 \"Name <a@b.com>\" 两种格式。多个收件人用逗号分隔。",
          },
          subject: {
            type: "string",
            description: "邮件主题（subject 不能为空）。",
          },
          body: {
            type: "string",
            description: "纯文本正文。与 html 至少传一个；同时传时 html 优先渲染。",
          },
          html: {
            type: "string",
            description: "HTML 正文（可选）。可用于富文本 / 链接 / 表格等。",
          },
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "附件文件名，例如 \"report.pdf\"。" },
                path: { type: "string", description: "本地文件绝对路径（与 content 二选一）。" },
                content: { type: "string", description: "base64 编码内容（不含 data: 前缀，与 path 二选一）。" },
                contentType: { type: "string", description: "MIME 类型，例如 \"application/pdf\"。" },
              },
              required: ["filename"],
              additionalProperties: false,
            },
            description: "附件列表（可选）。",
          },
        },
        required: ["to", "subject"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sms.send",
      description:
        "通过短信网关（阿里云 SMS）主动发送短信给指定手机号。适用场景：用户说「发短信给 xxx」「给他发条短信」「text him/her」「send SMS」。\n" +
        "正文 text 会按模板默认塞入 ${content} 占位符；如需自定义模板变量可传 templateParams（JSON 字符串）。\n" +
        "返回 ok=true 时附带 messageId / bizId；失败时 ok=false + error。\n" +
        "短信通道受服务商限流（同一号码 1 条/分钟、5 条/小时、10 条/天），频繁发送会被拒。",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "手机号，国内 11 位（如 13800138000）或带国家码（如 +8613800138000）。",
          },
          text: {
            type: "string",
            description: "短信正文（建议 ≤ 500 字符，超出会被截断）。",
          },
          templateParams: {
            type: "string",
            description:
              "（可选）阿里云模板变量 JSON 字符串，例如 \"{\\\"code\\\":\\\"123456\\\"}\"。" +
              "未传时默认 {\"content\":\"<text>\"}，需配合模板 ${content} 占位符。",
          },
        },
        required: ["to", "text"],
        additionalProperties: false,
      },
    },
  },
];
