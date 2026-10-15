import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 消息聚合中心 tools 的 ChatCompletionTool schema。
 *
 * 与 phone-bridge-chat-tools.ts 不同：这组工具是服务端本地的（聚合中心落在
 * 服务端 SQLite），不依赖手机桥在线，始终暴露给模型。
 *
 * 两级获取约定（写进 description 引导模型省 token）：
 *   1. messages.overview 先看各平台未读统计 + 最新预览（纯计数，便宜）；
 *   2. 需要某个会话的完整消息再用 messages.read_conversation 拉全文。
 * 平台覆盖：friend（站内好友，双向可回信）/ wechat / qq / feishu / sms（手机通知捕捉 +
 * 通用消息桥 webhook 汇聚 + 邮件盯件 IMAP 自动收件；email/alipay 会话只读）。
 */
const toolDefinitions: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "messages.overview",
    description:
      "查看用户消息聚合中心的总体概况：微信/QQ/飞书/短信/邮箱/站内好友等各平台未读条数、会话数与最新一条消息预览。" +
      "新邮件由邮件盯件自动收进这里（平台名 email），所以「有没有新邮件/邮件上说啥」也先调这个。" +
      "用户问「有没有人找我」「看下消息」「有什么未读」时先调这个。返回 platforms[].latest[].conversationId " +
      "可传给 messages.read_conversation 查看完整消息。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: "messages.list_conversations",
    description:
      "按平台列出消息聚合中心的会话列表（含未读数与最新预览）。" +
      "适合「微信上最近和谁聊过」这类跨会话浏览；看单个会话完整内容用 messages.read_conversation。",
    parameters: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["friend", "wechat", "qq", "feishu", "sms", "email", "alipay", "generic"],
          description: "限定平台；缺省返回全部平台",
        },
        limit: { type: "integer", description: "最多返回会话数，默认 50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "messages.read_conversation",
    description:
      "读取某个会话的完整消息记录（按时间正序）。先从 messages.overview / messages.list_conversations " +
      "拿到 conversationId 再调用；返回每条消息的发送人、时间与原文。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID（来自 overview/list_conversations）" },
        limit: { type: "integer", description: "最近 N 条，默认 50，最大 500" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "messages.reply",
    description:
      "代表用户回复某条消息。好友（friend）与短信（sms）支持真实代发：好友消息直达对方收件箱，短信发前手机弹窗确认；" +
      "微信/QQ/飞书/邮件暂不支持代发（只读）——要发邮件用 email.send。调用前先复述接收方与内容并取得同意。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "目标会话 ID" },
        text: { type: "string", description: "要发送的回复内容（简短、口语化）" },
        replyToMessageId: { type: "string", description: "引用的消息 ID（可选）" },
        to: {
          type: "string",
          description: "短信代发的接收号码（会话标识不是号码形态时必须提供）",
        },
      },
      required: ["conversationId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "messages.mark_read",
    description: "把某个会话标记为已读（未读计数清零）。用户表示「这条我看过了/处理完了」时调用。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "messages.suggest_reply",
    description:
      "基于某会话的最近聊天记录，生成一条适合直接发送的中文回复草稿。" +
      "适合「帮我想想怎么回」场景；生成后仍需用户确认，真正发送用 messages.reply（仅短信；邮件用 email.send）。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID" },
        style: { type: "string", description: "回复风格要求，如「正式」「简短抱歉语气」" },
        limit: { type: "integer", description: "参考最近 N 条消息，默认 20" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
];

export const MESSAGE_HUB_CHAT_TOOL_DEFINITIONS: ChatCompletionTool[] = toolDefinitions.map((def) => ({
  type: "function" as const,
  function: {
    name: def.name,
    description: def.description,
    parameters: def.parameters as any,
  },
}));

/** 工具名集合（分类映射等处用） */
export const MESSAGE_HUB_TOOL_NAMES: ReadonlySet<string> = new Set(
  toolDefinitions.map((def) => def.name),
);
