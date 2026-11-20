/**
 * 能力 Skill 包（2026-11-20）：把「一个用户意图 = 多个能力域」的域族打包成
 * 一个可一句描述的单元，模型用 `tool_discover({ domain: "<skillId>" })`
 * 一次拉全族——Coze 插件 / Claude Code Skill 的两级层次模式：
 *   一级：这一句话（见下方 oneLiner，进系统提示能力目录）
 *   二级：命中后整族工具 schema 加载
 *
 * 为什么需要：延迟目录按「域」切分时，用户意图常横跨多个域
 * （「帮我订个餐厅」→ restaurant_booking；「叫个车去机场」→ ride_hailing；
 * 「周末去成都」→ travel_booking + 天气）。逐域拉取要 2-3 次往返，且模型
 * 需要先知道域切法。Skill 用意图粒度兜住这层认知成本。
 *
 * 约束：skill 只是「域的命名组合」，不复制工具定义、不改变可见面语义——
 * 未命中的工具仍在延迟目录，命中后走同一套 schema 加载。
 */

export interface SkillBundle {
  /** Skill 标识（同时作为 tool_discover 的 domain 值） */
  id: string;
  /** 展示名 */
  label: string;
  /** 一句描述：做什么、什么时候用（进系统提示能力目录） */
  oneLiner: string;
  /** 组合的能力域（domain 名，须与 capability-modules 一致） */
  domains: string[];
}

export const SKILL_BUNDLES: readonly SkillBundle[] = [
  {
    id: "ride",
    label: "打车出行",
    oneLiner: "叫车/打车报价与下单（含上下车点选择、两阶段确认、行程追踪/取消）",
    domains: ["ride_hailing"],
  },
  {
    id: "travel",
    label: "城际出行",
    oneLiner: "机票/火车票/酒店搜索、比价、下单与行程售后",
    domains: ["travel_booking"],
  },
  {
    id: "local_life",
    label: "本地生活下单",
    oneLiner: "餐厅订座、家政上门、电商购物下单与跨平台比价（含降价监控）",
    domains: ["restaurant_booking", "home_services", "shopping_order", "shopping_compare"],
  },
  {
    id: "finance",
    label: "财务记账",
    oneLiner: "导入流水、消费分析、预算设定与账单管理（只读优先，写操作两阶段确认）",
    domains: ["finance_deep"],
  },
  {
    id: "phone_call",
    label: "电话代办",
    oneLiner: "代拨真实电话：预约、确认、回电（两阶段确认后拨出）",
    domains: ["phone_call"],
  },
  {
    id: "media",
    label: "影音娱乐",
    oneLiner: "音乐搜索与播放控制、AI 图像生成",
    domains: ["media_music", "image_gen"],
  },
  {
    id: "docs",
    label: "文档与消息",
    oneLiner: "本地文件读写/PDF·Office 解析/导出，邮件与短信发送",
    domains: ["file_doc", "email_sms"],
  },
  {
    id: "web_ops",
    label: "网页操作",
    oneLiner: "Agent 虚拟浏览器多步操作、与用户共用浏览器（点击/输入/读页）",
    domains: ["agent_browser", "shared_browser"],
  },
  {
    id: "code",
    label: "代码执行",
    oneLiner: "沙盒内跑 Python/Node、读写工程文件（任务面执行主力）",
    domains: ["code_sandbox"],
  },
  {
    id: "planning",
    label: "目标与计划",
    oneLiner: "长期目标拆步与自主推进、会话内多步计划（写/改/重排）",
    domains: ["goal_planning", "task_plan"],
  },
  {
    id: "social",
    label: "社交发布",
    oneLiner: "在外部平台发布/评论/转发/点赞（对外动作需明确授权）",
    domains: ["social_outreach"],
  },
  {
    id: "memory",
    label: "记忆治理",
    oneLiner: "定向遗忘、行为时间线回查、事件回忆与画像校正",
    domains: ["memory_governance"],
  },
];

const BY_ID = new Map(SKILL_BUNDLES.map((s) => [s.id, s]));
/** 域 → 所属 skill（一个域可属多个 skill，取第一个用于展示） */
const BY_DOMAIN = new Map<string, SkillBundle>();
for (const skill of SKILL_BUNDLES) {
  for (const domain of skill.domains) {
    if (!BY_DOMAIN.has(domain)) BY_DOMAIN.set(domain, skill);
  }
}

/** skill id → 包定义；也允许直接传域名的场景（返回 domain 所属 skill）。 */
export function findSkillBundle(idOrDomain: string): SkillBundle | undefined {
  const key = idOrDomain.trim();
  return BY_ID.get(key) ?? BY_DOMAIN.get(key);
}

/** 是否是可展开的 skill id（区别于普通域名的判定，供 bridge 分流）。 */
export function isSkillBundleId(id: string): boolean {
  return BY_ID.has(id.trim());
}

/**
 * 系统提示里的能力目录片段：一行一 skill（模型据此选 domain 值）。
 * 只列 skill，不再列 22 个原始域——域是内部实现细节。
 */
export function skillCatalogLines(): string[] {
  return SKILL_BUNDLES.map((s) => `- ${s.id}（${s.label}）：${s.oneLiner}`);
}
