import { z } from "zod";

// chat turn 相关 schema 已抽到 @nextbot/agent-protocol（外壳/runtime 共用契约），
// 此处 re-export 保持既有引用路径不变。
export {
  visionFrameWireSchema,
  agentProcessingUiSchema,
  userMessageSchema,
  aipDispatchWsSchema,
} from "@nextbot/agent-protocol";

/** WebSocket `agent.embodiment.interact` — 球形 Agent 用户交互 */
export const agentEmbodimentInteractSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  action: z.enum(["focus", "wake", "chat"]),
  text: z.string().max(4000).optional(),
  agentAccessMode: z.enum(["sandbox", "full"]).optional(),
});

export const walletRequestSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  action: z.enum(["freeze", "debit", "refund", "purchase"]),
  amount: z.number().positive(),
  meta: z.record(z.unknown()).optional(),
});

/** Agent World HTTP/WS 校验：实现位于根目录包 `agent-world/schemas.ts` */
export {
  worldLeisureBodySchema,
  worldMarketContractCreateBodySchema,
  worldMarketContractDeliverBodySchema,
  worldMarketContractRejectBodySchema,
  worldMarketContractsQuerySchema,
  worldMarketContractSessionBodySchema,
  worldPurchaseBodySchema,
  worldRegisterAgentQuickBodySchema,
  worldRegisterChallengeBodySchema,
  worldRegisterVerifyBodySchema,
  worldSessionQuerySchema,
  worldSkillUploadBodySchema,
} from "@nextbot/agent-world";

export const agentInboxQuerySchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const agentPairBodySchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1).max(256),
});

export const agentUnpairBodySchema = z.object({
  sessionId: z.string().min(1),
});

export const agentPairStatusQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const agentAipStateQuerySchema = z.object({
  sessionId: z.string().min(1),
});

function accountActorRefine(data: { userId?: string; sessionId?: string }, ctx: z.RefinementCtx): void {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  if (!u && !s) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "userId 或 sessionId 至少填一项",
      path: ["userId"],
    });
  }
}

export const accountRegisterBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    displayName: z.string().min(1).max(120),
    // 注册界面的邮箱（可选）：落在账号名单（后台 /api/admin/users 已展示）。
    // 格式校验在 agentAccountService.register 内做（与邮箱验证码注册同闸）。
    email: z.string().optional(),
    // 邮箱所有权验证码（可选字段；OTP 闸开启时邮箱形态主体必须携带，
    // 见 routes/http/accounts.ts 的 enforcement 说明）。
    otpCode: z.string().max(8).optional(),
  })
  .superRefine(accountActorRefine);

/** 邮箱验证码签发（POST /accounts/email/otp/start）：只收邮箱本体。 */
export const accountEmailOtpStartBodySchema = z.object({
  email: z.string().min(3).max(254),
});

/** 内测候补申请（登录页自助排队）：邮箱必填，备注可选。 */
export const accountBetaApplyBodySchema = z.object({
  email: z.string().min(3).max(254),
  note: z.string().max(200).optional(),
});

/** 内测进度查询（公开 /beta 页）：只读，不做任何状态变更。 */
export const accountBetaStatusQuerySchema = z.object({
  email: z.string().min(3).max(254),
});

export const accountMeQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 发起邮箱验证码注册 */
export const accountEmailRegisterStartBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    displayName: z.string().min(1).max(120),
  })
  .superRefine(accountActorRefine);

/** 查询占位收件箱（拉取验证码） */
export const accountEmailRegisterPendingQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 提交验证码完成注册 */
export const accountEmailRegisterVerifyBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    code: z.string().regex(/^\d{6}$/, "须为 6 位数字验证码"),
  })
  .superRefine(accountActorRefine);

/** 邮件网关 Inbound Webhook（真实收信回调） */
export const accountEmailInboundBodySchema = z.object({
  to: z.string().min(1),
  text: z.string().optional(),
  html: z.string().optional(),
  subject: z.string().optional(),
});

/** 财务入站邮件 Inbound Webhook（账单/支付邮件自动记账回调） */
export const financeIngestInboundBodySchema = z.object({
  to: z.string().min(1),
  from: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  subject: z.string().optional(),
  /** 跳过账单关键词预过滤（网关侧已确认为账单转发时用） */
  force: z.boolean().optional(),
});

/** 财务接入状态查询（引导卡数据源） */
export const financeIngestSetupQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 财务账单邮箱绑定/解绑 */
export const financeIngestBindBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    email: z.string().min(3),
    action: z.enum(["bind", "unbind"]).optional(),
  })
  .superRefine(accountActorRefine);

/* ============================================================
 *  学习笔记（notes）相关 schema
 * ============================================================ */

export const NOTE_CATEGORIES = [
  "study",
  "meeting",
  "video",
  "reading",
  "idea",
  "todo",
  "other",
] as const;

export const notesCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20000),
  category: z.enum(NOTE_CATEGORIES).default("other"),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  source: z.string().max(120).optional(),
});

export const notesUpdateBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(20000).optional(),
    category: z.enum(NOTE_CATEGORIES).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    source: z.string().max(120).nullable().optional(),
    summary: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "至少传入一个可更新字段" });

export const notesListQuerySchema = z.object({
  sessionId: z.string().min(1),
  category: z.enum(NOTE_CATEGORIES).optional(),
  tag: z.string().min(1).max(40).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const notesSearchBodySchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1).max(200),
  topK: z.coerce.number().int().min(1).max(50).default(10),
  category: z.enum(NOTE_CATEGORIES).optional(),
});

export const notesScheduleReviewBodySchema = z.object({
  sessionId: z.string().min(1),
  /** ISO 时间字符串（必填；review 必须有明确的执行时刻） */
  runAt: z.string().min(1),
  timezone: z.string().min(1).optional(),
  recurrence: z.enum(["none", "daily", "weekly"]).default("none"),
  /** 复习提示词；缺省用笔记标题 */
  reminderMessage: z.string().min(1).max(500).optional(),
});

export const scheduleTaskCreateBodySchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(120),
    shortTitle: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(2000),
    kind: z.enum(["reminder", "action", "weather_brief", "agent_task"]),
    category: z.enum(["itinerary", "trivia"]).optional(),
    runAt: z.string().min(1).optional(),
    recurrence: z.enum(["none", "daily", "weekly", "yearly", "cron"]).default("none"),
    timezone: z.string().min(1).optional(),
    cronExpression: z.string().min(1).max(120).optional(),
    webhookToken: z.string().min(1).max(160).optional(),
    reminderMessage: z.string().min(1).max(500).optional(),
    location: z.string().max(200).optional(),
    remindBeforeMinutes: z.array(z.number().positive().max(7 * 24 * 60)).max(5).optional(),
    action: z
      .object({
        url: z.string().url(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      })
      .optional(),
    agentTask: z
      .object({
        prompt: z.string().min(1).max(4000),
        accessMode: z.enum(["sandbox", "full"]).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.runAt && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runAt"],
        message: "runAt or cronExpression is required",
      });
    }
    if (data.cronExpression && data.recurrence !== "cron") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "recurrence must be cron when cronExpression is provided",
      });
    }
    if (data.kind === "reminder" && !data.reminderMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reminderMessage"],
        message: "提醒任务必须提供 reminderMessage",
      });
    }
    if (data.kind === "action" && !data.action?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action", "url"],
        message: "动作任务必须提供 action.url",
      });
    }
    if (data.kind === "agent_task" && !data.agentTask?.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentTask", "prompt"],
        message: "Agent 自动化任务必须提供 agentTask.prompt",
      });
    }
  });

export const scheduleTaskUpdateBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  shortTitle: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(2000).optional(),
  category: z.enum(["itinerary", "trivia"]).optional(),
  runAt: z.string().min(1).optional(),
  recurrence: z.enum(["none", "daily", "weekly", "yearly", "cron"]).optional(),
  timezone: z.string().min(1).optional(),
  cronExpression: z.string().min(1).max(120).nullable().optional(),
  webhookToken: z.string().min(1).max(160).nullable().optional(),
  reminderMessage: z.string().min(1).max(500).optional(),
  location: z.string().max(200).optional(),
  remindBeforeMinutes: z.array(z.number().positive().max(7 * 24 * 60)).max(5).optional(),
  action: z
    .object({
      url: z.string().url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
    })
    .optional(),
  agentTask: z
    .object({
      prompt: z.string().min(1).max(4000),
      accessMode: z.enum(["sandbox", "full"]).optional(),
    })
    .optional(),
  status: z.enum(["active", "paused", "cancelled"]).optional(),
});

export const scheduleTaskListQuerySchema = z.object({
  sessionId: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const scheduleTaskRunsQuerySchema = z.object({
  taskId: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const weatherCurrentQuerySchema = z.object({
  latitude: z.coerce.number().gte(-90).lte(90),
  longitude: z.coerce.number().gte(-180).lte(180),
  timezone: z.string().min(1).optional(),
  label: z.string().max(120).optional(),
});

export const weatherPrefsGetQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const weatherPrefsPutBodySchema = z.object({
  sessionId: z.string().min(1),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  label: z.string().max(120).optional(),
  timezone: z.string().min(1).optional(),
  morningReminderEnabled: z.boolean().optional(),
  /** 开启每日简报且尚无任务时必填：首次触发的 ISO 时间（须为未来） */
  morningFirstRunAt: z.string().optional(),
});

/** 将已创建的 weather_brief 日程任务 id 写入天气偏好（需已保存过经纬度） */
export const weatherLinkTaskBodySchema = z.object({
  sessionId: z.string().min(1),
  taskId: z.string().uuid(),
});

// ── 助手动态台账（右侧面板「助手动态」卡）─────────────────────────

export const agentActivityListQuerySchema = z.object({
  actorId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const agentActivityReadBodySchema = z.object({
  actorId: z.string().min(1).optional(),
  /** 缺省时标记该 actor 全部未读为已读 */
  ids: z.array(z.string().min(1)).max(100).optional(),
});

export const agentActivityRecordBodySchema = z.object({
  actorId: z.string().min(1),
  /** 动作类型，建议 action.purchase / action.payment / action.schedule 前缀 */
  kind: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  status: z.enum(["pending", "done", "failed", "changed"]).optional(),
  statusLabel: z.string().max(40).optional(),
  detail: z.record(z.string().max(200)).optional(),
  dedupKey: z.string().min(1).max(200).optional(),
});

// ── 站内信（平台→用户收件箱）─────────────────────────

export const inboxSendBodySchema = z.object({
  /** 单个目标用户；与 userIds 二选一 */
  userId: z.string().min(1).optional(),
  /** 批量目标（群发）；与 userId 二选一 */
  userIds: z.array(z.string().min(1)).max(100).optional(),
  /** 发送方（平台身份/另一 actor）；系统消息可缺省 */
  fromActorId: z.string().min(1).max(200).optional(),
  /** 消息分类：system / announcement / friend / ... */
  kind: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
  importance: z.enum(["low", "normal", "high", "critical"]).optional(),
  /** 幂等键：同一 messageId 重复投递不会产生第二条 */
  messageId: z.string().min(1).max(120).optional(),
});

export const inboxListQuerySchema = z.object({
  userId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(500).optional(),
  /** "1"/"true" 时只返回未读 */
  unreadOnly: z.string().optional(),
});

export const inboxReadBodySchema = z.object({
  userId: z.string().min(1),
  /** 缺省时标记该用户全部未读为已读 */
  ids: z.array(z.string().min(1)).max(500).optional(),
});

// ── 管理后台「消息发送」（收件人解析在服务端，见 routes/http/admin-inbox.ts）──

export const adminInboxSendBodySchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(4000),
    kind: z.string().min(1).max(80).optional(),
    importance: z.enum(["low", "normal", "high", "critical"]).optional(),
    /** all = 全体用户；users = 指定用户列表；group = 内置分组 */
    targetType: z.enum(["all", "users", "group"]),
    /** targetType=users 时必填 */
    userIds: z.array(z.string().min(1)).max(500).optional(),
    /** targetType=group 时必填（active/disabled/new7d） */
    group: z.enum(["active", "disabled", "new7d"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.targetType === "users" && (!data.userIds || data.userIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userIds"],
        message: "指定用户发送时 userIds 不能为空",
      });
    }
    if (data.targetType === "group" && !data.group) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["group"],
        message: "分组发送时须选择分组",
      });
    }
  });

export const chatScheduleDraftBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

/** 复制消息：客户端把要复制的纯文本一起带上，服务端做审计/回执（实际剪贴板由前端写入） */
export const chatMessageCopyBodySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().optional(),
  messageId: z.string().min(1).max(160),
  text: z.string().min(0).max(20000),
});

/** 编辑消息：替换 user 消息的文本并触发 Agent 重答 */
export const chatMessageEditBodySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().optional(),
  messageId: z.string().min(1).max(160),
  newText: z.string().min(1).max(20000),
  /** 透传到 Agent 上下文；可携带 `agentAccessMode`、`clientLocation` 等 */
  agentAccessMode: z.enum(["sandbox", "full"]).optional(),
});

/** 技能库：列出当前 Actor 可见的 Skill（含已禁用项） */
export const chatSkillsQuerySchema = z.object({
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

/** 技能库：切换启用状态（社区技能需已拥有） */
export const chatSkillEnabledBodySchema = z.object({
  skillName: z.string().min(1),
  enabled: z.boolean(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

export const infoSearchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export const infoNewsQuerySchema = z.object({
  topic: z.string().min(1),
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export const infoReadBodySchema = z.object({
  url: z.string().url(),
});

export const infoTrackCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1)).min(1),
  runAt: z.string().optional(),
  recurrence: z.enum(["none", "daily", "weekly", "yearly"]).optional(),
});

export const infoTrackListQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const infoTrackRunBodySchema = z
  .object({
    topicId: z.string().uuid().optional(),
    sessionId: z.string().min(1).optional(),
    name: z.string().optional(),
    mode: z.enum(["topic", "keywords"]).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .refine((v) => Boolean(v.topicId) || Boolean(v.keywords?.length), {
    message: "topicId 或 keywords 至少提供一个",
  });

export const phoneMeQuerySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

export const wechatClawStatusQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawActorBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawLoginStartBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    force: z.boolean().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawLoginWaitBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    /** 客户端已持有当前二维码时设为 true，避免重复上传巨型 data URL */
    qrKnown: z.boolean().optional(),
    currentQrDataUrl: z.string().max(2_000_000).optional(),
    timeoutMs: z.number().int().min(3000).max(90_000).optional(),
  })
  .superRefine(accountActorRefine);

/** OpenClaw 消息桥：微信入站 → 主服务 AgentCore */
export const wechatClawBridgeChatBodySchema = z.object({
  text: z.string().max(16_000),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  weixinSenderId: z.string().max(256).optional(),
  channel: z.string().max(64).optional(),
  accountId: z.string().max(128).optional(),
  messageId: z.string().max(128).optional(),
});

export const messageBridgeInboundBodySchema = z.object({
  platform: z.enum(["wechat", "qq", "feishu", "sms", "generic"]),
  text: z.string().max(16_000),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  senderId: z.string().max(256).optional(),
  senderName: z.string().max(256).optional(),
  channelId: z.string().max(256).optional(),
  channelName: z.string().max(256).optional(),
  accountId: z.string().max(128).optional(),
  messageId: z.string().max(128).optional(),
  autoReply: z.boolean().optional(),
});

const browserSessionSiteIdSchema = z.enum(["ctrip", "taobao", "jd", "qunar", "fliggy"]);

const browserSessionCookieSchema = z.object({
  name: z.string().min(1).max(512),
  value: z.string().max(16_384),
  domain: z.string().max(256).optional(),
  path: z.string().max(256).optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().max(16).optional(),
});

export const browserSessionStatusQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const browserSessionImportBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
    cookies: z.array(browserSessionCookieSchema).min(1).max(500),
    /** 导入时是否立即授权 Agent；默认 false，建议单独调用 consent */
    agentAllowed: z.boolean().optional(),
  })
  .superRefine(accountActorRefine);

export const browserSessionConsentBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
    agentAllowed: z.boolean(),
  })
  .superRefine(accountActorRefine);

export const browserSessionRevokeBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
  })
  .superRefine(accountActorRefine);

export const browserSessionActorBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const companionSessionQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const companionProfileUpdateBodySchema = z.object({
  sessionId: z.string().min(1),
  preferredTone: z.enum(["warm", "balanced", "formal", "humor"]).optional(),
  greetingEnabled: z.boolean().optional(),
  dailyGreetingHourLocal: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).optional(),
  likes: z.array(z.string().min(1).max(80)).max(50).optional(),
  dislikes: z.array(z.string().min(1).max(80)).max(50).optional(),
});

export const companionOnboardingBodySchema = z.object({
  sessionId: z.string().min(1),
  focusModes: z.array(z.enum(["shopping", "planning", "companion"])).min(1).max(3),
  budgetMin: z.number().nonnegative().optional(),
  budgetMax: z.number().nonnegative().optional(),
  shoppingPlatforms: z.array(z.string().min(1).max(60)).max(10).optional(),
  billReminders: z
    .array(
      z.object({
        billName: z.string().min(1).max(80),
        dueDate: z.string().min(1),
        daysBefore: z.number().int().min(0).max(30).default(3),
      }),
    )
    .max(20)
    .optional(),
});

export const companionPriceWatchBodySchema = z.object({
  sessionId: z.string().min(1),
  item: z.string().min(1).max(120),
  currentPrice: z.number().positive(),
  targetPrice: z.number().positive(),
  currency: z.string().min(1).max(10).default("USD"),
});

export const companionBillReminderBodySchema = z.object({
  sessionId: z.string().min(1),
  billName: z.string().min(1).max(80),
  dueDate: z.string().min(1),
  daysBefore: z.number().int().min(0).max(30).default(3),
  amount: z.number().positive().optional(),
});

export const companionShoppingPlanBodySchema = z.object({
  sessionId: z.string().min(1),
  item: z.string().min(1).max(120),
  budget: z.number().positive(),
  runAt: z.string().min(1),
  timezone: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

export const companionBehaviorSignalUpdateBodySchema = z.object({
  sessionId: z.string().min(1),
  shoppingInterest: z.number().int().min(0).max(1000).optional(),
  planningInterest: z.number().int().min(0).max(1000).optional(),
  companionNeed: z.number().int().min(0).max(1000).optional(),
  privacyConcern: z.number().int().min(0).max(1000).optional(),
});

export const companionContactFeedbackBodySchema = z.object({
  sessionId: z.string().min(1),
  channel: z.enum(["websocket", "voice", "phone_call"]),
  responded: z.boolean(),
  responseTimeMs: z.number().int().min(0).max(86_400_000).optional(),
  feedback: z.enum(["positive", "negative", "neutral"]).optional(),
  quietHours: z.boolean().optional(),
});

// ========== 终端互连平台 device-bus 配对 schema ==========

/** POST /device/pairing/code：用户生成配对码 */
export const devicePairingCodeBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    /** 可选：限定只能配对某种 kind */
    deviceKind: z.string().min(1).max(32).optional(),
  })
  .superRefine(accountActorRefine);

/** POST /device/pair：设备端提交配对码完成绑定 */
export const devicePairBodySchema = z.object({
  code: z.string().min(4).max(64),
  deviceId: z.string().min(1).max(128),
  kind: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  metadata: z.record(z.unknown()).optional(),
});

/** GET /device/list：列出当前用户已绑定设备 */
export const deviceListQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** DELETE /device/:deviceId：解绑设备 */
export const deviceUnbindParamsSchema = z.object({
  deviceId: z.string().min(1).max(128),
});

export const deviceUnbindQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** GET /device/pairing/code/status：查询当前用户未消费的配对码 */
export const devicePairingCodeStatusQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);
