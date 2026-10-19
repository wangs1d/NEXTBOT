/**
 * 能力模块总聚合入口。
 *
 * 每新增一个能力域：
 *   1. 在 `capability-modules/<name>/` 下加 chat-tools.ts / handlers.ts / intent.ts / index.ts
 *   2. 在下方 import + 加到 `buildCapabilityModules` 数组
 *   3. 在 `create-app-services.ts` 的 `capabilityModuleDeps` 里传入依赖
 *
 * 不需要改动：
 *   - `getBuiltinAgentChatTools`（自动合并）
 *   - `tool-search/intent-metadata.ts`（自动合并）
 *   - `tool-search/core-tool-library.ts`（默认 deferred，需要进核心时在此处声明）
 *   - `openai-compatible-tool-loop.ts` 的 `TOOL_CATEGORY_MAPPINGS`（在此处声明 category）
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { isOssEdition } from "../../config/env.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { ToolIntentRule } from "../tool-search/intent-metadata.js";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { EmailSmsService } from "../../services/email-sms-service.js";
import type { MediaMusicService } from "../../services/media-music-service.js";
import type { HealthFitnessService } from "../../services/health-fitness-service.js";
import type { FinanceDeepService } from "../../services/finance-deep-service.js";
import type { SubscriptionAuditService } from "../../services/subscription-audit-service.js";
import type { BillManagementService } from "../../services/bill-management-service.js";
import type { SocialOutreachService } from "../../services/social-outreach-service.js";
import type { CodeSandboxService } from "../../services/code-sandbox-service.js";
import type { ShoppingOrderService } from "../../services/shopping-order-service.js";
import type { ShoppingCompareService } from "../../services/shopping-compare-service.js";
import type { AgentBrowserService } from "../../services/agent-browser-service.js";
import type { SharedBrowserCoordinator } from "../../services/shared-browser-coordinator.js";
import type { SharedBrowserCdpGateway } from "../../services/shared-browser/cdp-gateway.js";
import type { PhoneCallCoordinator } from "../../services/phone-call-coordinator.js";
import type { BookingService } from "../../services/booking/booking-service.js";
import type { PeriodCareService } from "../../services/period-care-service.js";
import type { SafetyGuardService } from "../../services/safety-guard-service.js";
import type { ClientPushPort } from "../../ports/client-push-port.js";

import {
  IMAGE_GEN_CHAT_TOOLS,
  IMAGE_GEN_INTENT_RULES,
  registerImageGenTools,
} from "./image-gen/index.js";
import {
  FILE_DOC_CHAT_TOOLS,
  FILE_DOC_INTENT_RULES,
  registerFileDocTools,
} from "./file-doc/index.js";
import {
  EMAIL_SMS_CHAT_TOOLS,
  EMAIL_SMS_INTENT_RULES,
  registerEmailSmsTools,
} from "./email-sms/index.js";
import {
  MEDIA_MUSIC_CHAT_TOOLS,
  MEDIA_MUSIC_INTENT_RULES,
  registerMediaMusicTools,
} from "./media-music/index.js";
import {
  HEALTH_FITNESS_CHAT_TOOLS,
  HEALTH_FITNESS_INTENT_RULES,
  registerHealthFitnessTools,
} from "./health-fitness/index.js";
import {
  PERIOD_CARE_CHAT_TOOLS,
  PERIOD_CARE_INTENT_RULES,
  registerPeriodCareTools,
} from "./period-care/index.js";
import {
  SAFETY_GUARD_CHAT_TOOLS,
  SAFETY_GUARD_INTENT_RULES,
  registerSafetyGuardTools,
} from "./safety-guard/index.js";
import {
  FINANCE_DEEP_CHAT_TOOLS,
  FINANCE_DEEP_INTENT_RULES,
  registerFinanceDeepTools,
} from "./finance-deep/index.js";
import {
  SOCIAL_OUTREACH_CHAT_TOOLS,
  SOCIAL_OUTREACH_INTENT_RULES,
  registerSocialOutreachTools,
} from "./social-outreach/index.js";
import {
  CODE_SANDBOX_CHAT_TOOLS,
  CODE_SANDBOX_INTENT_RULES,
  CODE_SANDBOX_CATEGORY_MAPPING,
  registerCodeSandboxTools,
} from "./code-sandbox/index.js";
import {
  SHOPPING_ORDER_CHAT_TOOLS,
  SHOPPING_ORDER_INTENT_RULES,
  SHOPPING_ORDER_CATEGORY_MAPPING,
  registerShoppingOrderTools,
} from "./shopping-order/index.js";
import {
  SHOPPING_COMPARE_CHAT_TOOLS,
  SHOPPING_COMPARE_INTENT_RULES,
  SHOPPING_COMPARE_CATEGORY_MAPPING,
  registerShoppingCompareTools,
} from "./shopping-compare/index.js";
import {
  AGENT_BROWSER_CHAT_TOOLS,
  AGENT_BROWSER_INTENT_RULES,
  AGENT_BROWSER_CATEGORY_MAPPING,
  registerAgentBrowserTools,
} from "./agent-browser/index.js";
import {
  SHARED_BROWSER_CHAT_TOOLS,
  SHARED_BROWSER_INTENT_RULES,
  SHARED_BROWSER_CATEGORY_MAPPING,
  registerSharedBrowserTools,
} from "./shared-browser/index.js";
import {
  RIDE_HAILING_CHAT_TOOLS,
  RIDE_HAILING_INTENT_RULES,
  RIDE_HAILING_CATEGORY_MAPPING,
  registerRideHailingTools,
} from "./ride-hailing/index.js";
import {
  HOME_SERVICES_CHAT_TOOLS,
  HOME_SERVICES_INTENT_RULES,
  HOME_SERVICES_CATEGORY_MAPPING,
  registerHomeServicesTools,
} from "./home-services/index.js";
import {
  RESTAURANT_BOOKING_CHAT_TOOLS,
  RESTAURANT_BOOKING_INTENT_RULES,
  RESTAURANT_BOOKING_CATEGORY_MAPPING,
  registerRestaurantBookingTools,
} from "./restaurant-booking/index.js";
import {
  TRAVEL_BOOKING_CHAT_TOOLS,
  TRAVEL_BOOKING_INTENT_RULES,
  TRAVEL_BOOKING_CATEGORY_MAPPING,
  registerTravelBookingTools,
} from "./travel-booking/index.js";
import {
  buildPhoneCallModule,
} from "./phone-call/index.js";
import {
  PICTURE_INTENT_RULES,
  registerPictureModuleTools,
} from "./picture/index.js";
import type { PictureKit } from "@private-ai-agent/picture";
import { buildGoalPlanningModule } from "./goal-planning/index.js";
import { buildTaskPlanModule } from "./task-plan/index.js";
import { buildMemoryGovernanceModule } from "./memory-governance/index.js";
import type { GoalPlanner } from "../../proactivity/goal-planner.js";
import type { GoalRunner } from "../../proactivity/goal-runner.js";
import type { AuditTrailService } from "../../proactivity/audit-timeline.js";
import type { InterestWatcher } from "../../proactivity/interest-watcher.js";
import type { CommitmentBoard } from "../../agentic-memory/commitment-board.js";

/**
 * 能力模块描述符：把一个能力域的所有挂载点打包成单一对象，
 * 由 `getCapabilityModuleChatTools` / `getAllCapabilityModuleIntentRules` / `registerAllCapabilityModules`
 * 统一消费。
 */
export interface CapabilityModule {
  /** 域名，与 `agent-capabilities.ts` 的 `CapabilityDomain` 对齐 */
  domain: string;
  /** 模块标签（用于日志 / 调试） */
  label: string;
  /** LLM 工具 schema */
  chatTools: ChatCompletionTool[];
  /** 意图元数据规则，合并到 BM25 调权 */
  intentRules: ToolIntentRule[];
  /** 注册到 ToolRegistry */
  register: (registry: ToolRegistry) => void;
  /**
   * 关键词分类映射（用于 `TOOL_CATEGORY_MAPPINGS`）。
   * 命中关键词时把该模块的全部工具名注入到对应分类。
   */
  category?: {
    name: string;
    keywords: string[];
  };
  /**
   * 版本闸：true = 内测独占家族（NEXTBOT_EDITION=oss 开源版整族剔除）。
   * 模块被剔除后 LLM schema / intent 调权 / 执行器注册 / 关键词路由四处同步收缩。
   */
  internalOnly?: boolean;
}

/**
 * 能力模块依赖：所有模块需要的 service 在此声明。
 *
 * 启动时由 `create-app-services.ts` 构造后传入 `registerAllCapabilityModules`。
 */
export interface CapabilityModuleDeps {
  imageGenerationService: ImageGenerationService;
  fileProcessingService: FileProcessingService;
  emailSmsService: EmailSmsService;
  mediaMusicService: MediaMusicService;
  /** media-music 模块需要 ws 推送播放控制事件给客户端 */
  wsConnectionRegistry: ClientPushPort;
  healthFitnessService: HealthFitnessService;
  financeDeepService: FinanceDeepService;
  /** 订阅盘点服务（finance.list/confirm/update/cancel_subscription 工具与月报订阅段的数据源） */
  subscriptionAuditService: SubscriptionAuditService;
  /** 账单管理服务（finance.add/list/update/pay_bill 工具与账单到期提醒的数据源） */
  billManagementService: BillManagementService;
  socialOutreachService: SocialOutreachService;
  codeSandboxService: CodeSandboxService;
  shoppingOrderService: ShoppingOrderService;
  /** 购物比价服务（跨平台同款比价 + 降价监控 + 调研比价，只读零副作用） */
  shoppingCompareService: ShoppingCompareService;
  agentBrowserService: AgentBrowserService;
  /** 共用浏览器桥（用户与 Agent 共用客户端内嵌浏览器的动作转发通道） */
  sharedBrowserCoordinator: SharedBrowserCoordinator;
  /** 共用浏览器可信输入网关（CDP 桥，可选；未启用时 trusted 工具回退注入路径） */
  sharedBrowserCdpGateway?: SharedBrowserCdpGateway;
  /** 统一预订编排服务（方案 A：网约车/家政/餐厅共用） */
  bookingService: BookingService;
  /** 电话代办协调器（phone_call.*：真实外呼确认门/频控/状态机/结果回填） */
  phoneCallCoordinator: PhoneCallCoordinator;
  /** 生理周期关怀（period.*：经期记录/预测/临近提醒，数据本地加密） */
  periodCareService: PeriodCareService;
  /** 安全守护（safety.*：紧急联系人/一键SOS/借口来电） */
  safetyGuardService: SafetyGuardService;
  /** 图片能力套件(图库/美颜批图),存储根 data/pictures */
  pictureKit: PictureKit;
  /**
   * 计划推进服务（goal.plan.*，2026-09-24）：装配层晚绑定——本对象在
   * GoalBoard/AgentCore 之前构造，字段在服务建成后再赋值（handler 调用时读取）。
   */
  goalPlanner?: GoalPlanner | null;
  /**
   * 目标后台自主循环（GoalRunner，2026-10-10）：晚绑定；goal.runner.status
   * 诊断工具读取其运行状态（是否启用/扫描间隔/跟踪目标数）。
   */
  goalRunner?: GoalRunner | null;
  /** 行为审计时间线（activity.timeline）：同上晚绑定 */
  auditTrailService?: AuditTrailService | null;
  /** 兴趣池（memory.forget 联动清除）：晚绑定 */
  interestWatcher?: InterestWatcher | null;
  /** 承诺板（memory.forget 联动清除）：晚绑定 */
  commitmentBoard?: CommitmentBoard | null;
  /** 目标板（memory.forget 清理 plan/track 目标）：晚绑定 */
  goalBoard?: import("../../proactivity/goal-board.js").GoalBoard | null;
}

/**
 * 全部能力模块。
 *
 * ⚠️ 新增能力域时只改这里，不动其他文件。
 */
export function buildCapabilityModules(deps: CapabilityModuleDeps): CapabilityModule[] {
  const modules: CapabilityModule[] = [
    {
      domain: "image_gen",
      label: "图像生成（text-to-image）",
      chatTools: IMAGE_GEN_CHAT_TOOLS,
      intentRules: IMAGE_GEN_INTENT_RULES,
      register: (registry) => registerImageGenTools(registry, { imageGenerationService: deps.imageGenerationService }),
      category: {
        name: "image",
        keywords: [
          "image", "picture", "photo", "draw", "paint", "generate",
          "txt2img", "diffusion", "kolors", "flux",
          "画", "画图", "画一张", "画个", "做图", "做张图",
          "生成图", "图片", "配图", "插图", "头像", "logo", "icon",
        ],
      },
    },
    {
      domain: "file_doc",
      label: "文件/文档处理（read/write/parse/export）",
      chatTools: FILE_DOC_CHAT_TOOLS,
      intentRules: FILE_DOC_INTENT_RULES,
      register: (registry) => registerFileDocTools(registry, { fileProcessingService: deps.fileProcessingService }),
      category: {
        name: "file_doc",
        keywords: [
          "file", "document", "doc", "pdf", "word", "excel", "spreadsheet",
          "parse", "export", "read file", "write file",
          "文件", "文档", "读取", "写入", "解析", "导出", "转换格式",
          "pdf", "word", "excel", "csv", "json", "markdown",
        ],
      },
    },
    {
      domain: "email_sms",
      label: "邮件/短信主动发送",
      chatTools: EMAIL_SMS_CHAT_TOOLS,
      intentRules: EMAIL_SMS_INTENT_RULES,
      register: (registry) => registerEmailSmsTools(registry, { emailSmsService: deps.emailSmsService }),
      category: {
        name: "email_sms",
        keywords: [
          "email", "mail", "smtp", "sms", "text message", "send email", "send sms",
          "邮件", "邮箱", "发邮件", "短信", "发短信", "验证码",
          "通知", "联系", "写信",
        ],
      },
    },
    {
      domain: "media_music",
      label: "媒体音乐播放控制",
      chatTools: MEDIA_MUSIC_CHAT_TOOLS,
      intentRules: MEDIA_MUSIC_INTENT_RULES,
      register: (registry) => registerMediaMusicTools(registry, {
        mediaMusicService: deps.mediaMusicService,
        wsConnectionRegistry: deps.wsConnectionRegistry,
      }),
      category: {
        name: "media_music",
        keywords: [
          "music", "song", "play", "pause", "resume", "stop", "now playing",
          "playlist", "track", "audio", "media", "player",
          "音乐", "歌曲", "播放", "暂停", "继续", "停止", "现在放",
          "歌单", "曲目", "音频", "媒体", "播放器", "听歌",
        ],
      },
    },
    {
      domain: "health_fitness",
      label: "健康/运动数据接入",
      chatTools: HEALTH_FITNESS_CHAT_TOOLS,
      intentRules: HEALTH_FITNESS_INTENT_RULES,
      register: (registry) => registerHealthFitnessTools(registry, { healthFitnessService: deps.healthFitnessService }),
      category: {
        name: "health_fitness",
        keywords: [
          "health", "fitness", "exercise", "workout", "step", "heart rate",
          "sleep", "calorie", "weight", "metric", "goal",
          "健康", "运动", "锻炼", "健身", "步数", "心率",
          "睡眠", "卡路里", "体重", "指标", "目标",
        ],
      },
    },
    {
      domain: "finance_deep",
      label: "财务深度能力",
      chatTools: FINANCE_DEEP_CHAT_TOOLS,
      intentRules: FINANCE_DEEP_INTENT_RULES,
      register: (registry) =>
        registerFinanceDeepTools(registry, {
          financeDeepService: deps.financeDeepService,
          subscriptionAuditService: deps.subscriptionAuditService,
          billManagementService: deps.billManagementService,
        }),
      category: {
        name: "finance_deep",
        keywords: [
          "finance", "transaction", "budget", "spending", "reconcile",
          "categorize", "report", "import", "money", "expense",
          "subscription", "renewal", "membership", "cancel subscription", "savings", "bill",
          "财务", "交易", "预算", "支出", "对账",
          "分类", "报告", "导入", "钱", "花费", "账单",
          "订阅", "续费", "会员", "退订", "取消订阅", "自动续费", "省钱",
          "缴费", "水电", "房租", "话费", "还款", "到期", "固定支出",
        ],
      },
    },
    {
      domain: "social_outreach",
      label: "社交主动出击（外部平台）",
      internalOnly: true,
      chatTools: SOCIAL_OUTREACH_CHAT_TOOLS,
      intentRules: SOCIAL_OUTREACH_INTENT_RULES,
      register: (registry) => registerSocialOutreachTools(registry, { socialOutreachService: deps.socialOutreachService }),
      category: {
        name: "social_outreach",
        keywords: [
          "twitter", "weibo", "xiaohongshu", "xhs", "moments", "朋友圈",
          "post", "tweet", "comment", "repost", "like", "feed",
          "发帖", "推文", "评论", "转发", "点赞", "动态",
          "社交", "平台", "发布",
        ],
      },
    },
    {
      domain: "code_sandbox",
      label: "代码执行沙盒（python / node）",
      chatTools: CODE_SANDBOX_CHAT_TOOLS,
      intentRules: CODE_SANDBOX_INTENT_RULES,
      register: (registry) => registerCodeSandboxTools(registry, { codeSandboxService: deps.codeSandboxService }),
      category: CODE_SANDBOX_CATEGORY_MAPPING,
    },
    {
      domain: "shopping_order",
      label: "购物/下单（后台无头浏览器代用户下单）",
      chatTools: SHOPPING_ORDER_CHAT_TOOLS,
      intentRules: SHOPPING_ORDER_INTENT_RULES,
      register: (registry) => registerShoppingOrderTools(registry, { shoppingOrderService: deps.shoppingOrderService }),
      category: SHOPPING_ORDER_CATEGORY_MAPPING,
    },
    {
      domain: "shopping_compare",
      label: "购物比价（跨平台同款比价 + 降价监控 + 保险/服务调研对比）",
      internalOnly: true,
      chatTools: SHOPPING_COMPARE_CHAT_TOOLS,
      intentRules: SHOPPING_COMPARE_INTENT_RULES,
      register: (registry) => registerShoppingCompareTools(registry, { shoppingCompareService: deps.shoppingCompareService }),
      category: SHOPPING_COMPARE_CATEGORY_MAPPING,
    },
    {
      domain: "agent_browser",
      label: "Agent 虚拟浏览器（通用网页多步操作）",
      chatTools: AGENT_BROWSER_CHAT_TOOLS,
      intentRules: AGENT_BROWSER_INTENT_RULES,
      register: (registry) => registerAgentBrowserTools(registry, { agentBrowserService: deps.agentBrowserService }),
      category: AGENT_BROWSER_CATEGORY_MAPPING,
    },
    {
      domain: "shared_browser",
      label: "共用浏览器（用户与 Agent 共用客户端浏览器）",
      chatTools: SHARED_BROWSER_CHAT_TOOLS,
      intentRules: SHARED_BROWSER_INTENT_RULES,
      register: (registry) => registerSharedBrowserTools(registry, { sharedBrowserCoordinator: deps.sharedBrowserCoordinator, sharedBrowserCdpGateway: deps.sharedBrowserCdpGateway }),
      category: SHARED_BROWSER_CATEGORY_MAPPING,
    },
    {
      domain: "ride_hailing",
      label: "打车/网约车（统一预订抽象层）",
      chatTools: RIDE_HAILING_CHAT_TOOLS,
      intentRules: RIDE_HAILING_INTENT_RULES,
      register: (registry) => registerRideHailingTools(registry, { bookingService: deps.bookingService }),
      category: RIDE_HAILING_CATEGORY_MAPPING,
    },
    {
      domain: "home_services",
      label: "家政/本地生活预订（统一预订抽象层）",
      chatTools: HOME_SERVICES_CHAT_TOOLS,
      intentRules: HOME_SERVICES_INTENT_RULES,
      register: (registry) => registerHomeServicesTools(registry, { bookingService: deps.bookingService }),
      category: HOME_SERVICES_CATEGORY_MAPPING,
    },
    {
      domain: "restaurant_booking",
      label: "餐厅预订（统一预订抽象层）",
      chatTools: RESTAURANT_BOOKING_CHAT_TOOLS,
      intentRules: RESTAURANT_BOOKING_INTENT_RULES,
      register: (registry) => registerRestaurantBookingTools(registry, { bookingService: deps.bookingService }),
      category: RESTAURANT_BOOKING_CATEGORY_MAPPING,
    },
    {
      domain: "travel_booking",
      label: "机票/火车票/酒店预订（统一预订抽象层 + 多源报价比价）",
      internalOnly: true,
      chatTools: TRAVEL_BOOKING_CHAT_TOOLS,
      intentRules: TRAVEL_BOOKING_INTENT_RULES,
      register: (registry) => registerTravelBookingTools(registry, { bookingService: deps.bookingService }),
      category: TRAVEL_BOOKING_CATEGORY_MAPPING,
    },
    {
      domain: "period_care",
      label: "生理周期关怀（经期记录/预测/临近提醒）",
      chatTools: PERIOD_CARE_CHAT_TOOLS,
      intentRules: PERIOD_CARE_INTENT_RULES,
      register: (registry) => registerPeriodCareTools(registry, { periodCareService: deps.periodCareService }),
      category: {
        name: "period_care",
        keywords: [
          "period", "menstrual", "menstruation", "cycle", "pms", "cramps",
          "月经", "例假", "大姨妈", "姨妈", "生理期", "经期", "痛经",
        ],
      },
    },
    {
      domain: "safety_guard",
      label: "安全守护（紧急联系人/一键SOS/借口来电）",
      chatTools: SAFETY_GUARD_CHAT_TOOLS,
      intentRules: SAFETY_GUARD_INTENT_RULES,
      register: (registry) => registerSafetyGuardTools(registry, { safetyGuardService: deps.safetyGuardService }),
      category: {
        name: "safety_guard",
        keywords: [
          "sos", "emergency", "panic", "safety", "fake call", "call me", "excuse",
          "救命", "求救", "紧急", "紧急联系人", "害怕", "危险",
          "守护", "借口", "脱身", "给我打电话", "打个电话", "来个电话",
        ],
      },
    },
    // 电话代办：模块自带 PHONE_CALL_ENABLED 开关门控（关闭时 schema/执行器/intent 全空，
    // 对 LLM 不可见且无漂移），故直接复用 buildPhoneCallModule；开源版整族剔除（internalOnly）。
    { ...buildPhoneCallModule({ phoneCallCoordinator: deps.phoneCallCoordinator }), internalOnly: true },
    {
      domain: "picture",
      label: "图片图库",
      // 2026-09-06：LLM 工具 schema 已由 builtin skill picture.*（skills/builtin/picture-skills.ts）
      // 接管——同名 schema 会在 chatToolsExtra 合并时与 skill 冲突，故这里置空；
      // intentRules（BM25 调权按名字命中 skill 名）与 ToolRegistry 兜底执行器保留。
      chatTools: [],
      intentRules: PICTURE_INTENT_RULES,
      register: (registry) => registerPictureModuleTools(registry, { pictureKit: deps.pictureKit }),
      category: {
        name: "picture",
        keywords: [
          "gallery", "photo", "photos", "album",
          "照片", "相册", "图库",
        ],
      },
    },
    // 计划推进（2026-09-24，对标 Muse 大目标模式）：goalPlanner 晚绑定，
    // 未装配时 handler 如实返回未装配错误
    buildGoalPlanningModule(deps),
    // 会话级任务计划（2026-10-19）：plan.* 四工具（scope=session/goal 统一入口），
    // store 走进程级单例；goalPlanner 晚绑定，未装配时 scope=goal 如实报错
    buildTaskPlanModule({ goalPlanner: deps.goalPlanner ?? null }),
    // 记忆治理（定向遗忘 + 行为审计）：依赖全部可选，handler 逐项降级
    buildMemoryGovernanceModule(deps),
  ];
  // 版本闸（NEXTBOT_EDITION=oss 开源版）：internalOnly 家族整族剔除，
  // 四个消费口（chatTools/intentRules/register/categoryMappings）共用本出口，自动收缩。
  return isOssEdition() ? modules.filter((m) => !m.internalOnly) : modules;
}

/** 合并所有能力模块的 ChatCompletionTool schema。 */
export function getCapabilityModuleChatTools(deps: CapabilityModuleDeps): ChatCompletionTool[] {
  const modules = buildCapabilityModules(deps);
  const all: ChatCompletionTool[] = [];
  for (const m of modules) all.push(...m.chatTools);
  return all;
}

/** 合并所有能力模块的意图元数据规则。 */
export function getAllCapabilityModuleIntentRules(deps: CapabilityModuleDeps): ToolIntentRule[] {
  const modules = buildCapabilityModules(deps);
  const all: ToolIntentRule[] = [];
  for (const m of modules) all.push(...m.intentRules);
  return all;
}

/** 把所有能力模块的 handler 注册到 ToolRegistry。 */
export function registerAllCapabilityModules(
  registry: ToolRegistry,
  deps: CapabilityModuleDeps,
): void {
  const modules = buildCapabilityModules(deps);
  for (const m of modules) m.register(registry);
}

/**
 * 暴露给 `openai-compatible-tool-loop.ts` 的 `TOOL_CATEGORY_MAPPINGS` 合并入口。
 *
 * 调用方在 `selectRelevantTools` 阶段把这些映射合并进去，
 * 让关键词命中时把对应模块的工具名加入候选。
 */
export function getCapabilityModuleCategoryMappings(
  deps: CapabilityModuleDeps,
): Array<{ category: string; keywords: string[]; toolNames: string[] }> {
  const modules = buildCapabilityModules(deps);
  return modules.flatMap((m) => {
    if (!m.category) return [];
    const toolNames = m.chatTools
      .map((t) => (t.type === "function" && t.function?.name ? t.function.name : null))
      .filter((n): n is string => Boolean(n));
    return [{
      category: m.category.name,
      keywords: m.category.keywords,
      toolNames,
    }];
  });
}
