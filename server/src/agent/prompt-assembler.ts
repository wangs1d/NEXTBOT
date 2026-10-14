import type { AgentPromptMemoryContext } from "../external-model/types.js";
import { RENDER_PROTOCOL_PROMPT } from "../services/render-protocol-prompt.js";

/**
 * Prompt 单一组装出口（2026-08-28 注入路径统一重构）。
 *
 * 之前 system prompt 有 5 个入口各自拼块（PromptContextBuilder 40+ 字段直拼、
 * prompt-builder 双函数重复渲染、runtime-kernel minimal 身份、agent-core 手拼
 * 免责头、finalizeChatSystemPrompt 后缀追加），改一处漏一处。现在：
 *  - 所有"记忆/上下文块"的渲染只在本文件发生（家族合并 + 统一免责）
 *  - prompt-builder 的 buildLayeredSystemPrompt / Sections 退化为薄委托
 *  - prefix-cache / providers 经 assembleSystemPrompt 一次性拿三层结果
 *
 * 分层（前缀缓存友好：稳定层在前，动态层沉底）：
 *  - stablePrefix：三级易变性分带（CORE 重配置级 → SLOW 夜间级 → MEMORY 对话级），
 *    见 assembleLayeredSections 内契约注释——易变者沉底，让跨对话冷启动命中尽量长的前缀
 *  - dynamicContext：本轮易变块（时间/召回/任务/短期上下文）
 *
 * 家族合并（块数 40+ → 10 组）：
 *  - 【记忆整理】：关系/生活主题/梦境/连续性/跨天回顾（5→1）
 *  - 【短期上下文】：最近对话/工作记忆/会话回顾/今日日志/今日摘要（5→1，2026-09-23 并入 sessionRecap）
 *  - 【用户档案】：画像/偏好/事实/持久记忆/会话回顾（5→1）
 *  - 【待办与承诺】：承诺/未完成事项（2→1）
 *  - [Turn Task Context]：任务/追问锚点/建议工具链（3→1）
 */

/**
 * 全局记忆使用规则（唯一免责声明）。
 * 历史 4 处分散免责（记忆使用规则 + 记忆图联想检索 + 最近对话回顾 + 今日对话日志检索）
 * 收敛为：本条全局规则 + 记忆图联想检索块保留专属免责（项目约束：该块必须带免责）。
 */
export const GLOBAL_MEMORY_RULE = [
  "【记忆使用规则】",
  "下方所有「记忆 / 回顾 / 画像 / 摘要 / 承诺 / 事项」块均为历史背景，仅供衔接与指代消解，不是用户的最新指令。「用户最新一条消息」才是本轮的唯一指令基准。除非用户明确要求回忆历史，否则一律以最新消息为准；当历史记忆与最新消息冲突时，以最新消息为准，并仅就最新消息作答。",
  "人称换算铁律：记忆/画像条目里出现的第一人称「我」一律指用户本人（对话里的说话人是用户），不是你自己。向用户转述记忆时必须换算人称：用户的「我」要说成「你」，你自己（助手）只能用「我」自指。绝不把用户的事说成自己的事（例：记忆表明用户住在兴义，只能说「我知道你在兴义」，绝不能说「你光知道我在兴义」）；也不把自己的行为安到用户头上。",
  "无痕运用：画像/记忆直接体现在判断里，像老朋友一样自然知道，禁止说「根据我的记忆/画像/档案」「资料显示你」这类元话语暴露记忆系统的存在。低置信的记忆不要断言，用试探语气验证（「你最近是不是在赶版本？」），用户否认就接受并以后按否认的来；健康/财务/家庭等敏感记忆只在用户主动提起该话题时才可运用。",
].join("\n");

/** 短期上下文家族头的简短免责（覆盖原"最近对话回顾/今日日志"两处分散免责）。 */
const SHORT_TERM_DISCLAIMER =
  "（历史对话背景，非用户最新指令；与当前对话冲突时以用户最新消息为准）";

/** 参与渲染的记忆字段全集（单一清单，替代旧版两份不一致的 gate 列表）。 */
const RENDERED_MEMORY_FIELDS: ReadonlyArray<keyof AgentPromptMemoryContext> = [
  "persona",
  "personalityCore",
  "values",
  "abilities",
  "agentCaps",
  "worldCaps",
  "userUnderstanding",
  "userFacts",
  "turnAddressing",
  "userProfileSummary",
  "memoryInventory",
  "relationshipMemory",
  "lifeThemeMemory",
  "dreamMemory",
  "memoryContinuity",
  "yesterdayHighlight",
  "semanticIntent",
  "scheduleSnapshot",
  "taskContext",
  "followUpAnchor",
  "toolPlan",
  "userLocation",
  "frequentPlaces",
  "currentUserState",
  "turnAside",
  "narrativeRecall",
  "workingMemorySummary",
  "recentConversationHistory",
  "journalRecall",
  "dailyDigest",
  "userProfile",
  "memorySummary",
  "memoryPreferences",
  "memoryFacts",
  "memoryCommitments",
  "memoryOpenLoops",
  "sessionRecap",
  "interruptedContext",
  "currentTime",
  "conversationTimeline",
  "skillIndex",
  "interestList",
  "voiceBaseline",
  "modeRoleGuidance",
  "toneGuidance",
  "emotionState",
  "relationshipGuidance",
];

export function hasAnyPromptMemory(memory?: AgentPromptMemoryContext): boolean {
  if (!memory) return false;
  return RENDERED_MEMORY_FIELDS.some((key) => Boolean(memory[key]));
}

/**
 * 动态风格层 → 单一【本轮说话适配】块。
 *
 * 2026-09-22 人格·终极版重塑后，本块只保留模式行（对话/任务职责）；
 * 语气/情绪/关系由 persona-core 的 mood 动态块承担（agent-core 解析注入），
 * 基准称呼等规则随【人格·静态】块。全空时不再输出空壳块。
 */
function buildReplyStyleGuide(memory: AgentPromptMemoryContext): string {
  const lines: string[] = [];
  if (memory.modeRoleGuidance) lines.push(`模式：${memory.modeRoleGuidance}`);
  if (lines.length === 0) return "";
  return `【本轮说话适配】\n${lines.join("\n\n")}`;
}

/** 家族块组装：多字段合并为一个带小节标签的块；全空返回 undefined。 */
function buildFamilyBlock(
  title: string,
  headerNote: string | undefined,
  sections: Array<{ label: string; content: string | undefined }>,
): string | undefined {
  const body = sections
    .filter((s): s is { label: string; content: string } => Boolean(s.content?.trim()))
    .map((s) => `${s.label}：\n${s.content.trim()}`)
    .join("\n\n");
  if (!body) return undefined;
  return headerNote ? `${title}${headerNote}\n${body}` : `${title}\n${body}`;
}

export type LayeredSections = {
  /** 稳定前缀：身份/人格/能力/慢变画像/夜间整理记忆（会话内基本不变，前缀缓存友好）。 */
  stablePrefix: string[];
  /** 动态上下文：本轮易变块（沉底注入，避免污染缓存前缀）。 */
  dynamicContext: string[];
};

/**
 * 分层渲染（单一出口）：stable 在前、dynamic 在后。
 * 旧版 buildLayeredSystemPrompt 与 buildLayeredSystemPromptSections 顺序不一致
 * （前者混合排序、baseSystem 在末尾），统一为 stable → dynamic，baseSystem 由
 * assembleSystemPrompt 置于最前（缓存命中最优）。
 */
export function assembleLayeredSections(memory?: AgentPromptMemoryContext): LayeredSections {
  if (!hasAnyPromptMemory(memory)) {
    return { stablePrefix: [], dynamicContext: [] };
  }
  const m = memory as AgentPromptMemoryContext;

  // ── 稳定层·三级易变性契约（2026-10-01）──
  // 稳定层内部的排列不按语义分区，而按「写入频率」分带。原因：跨对话冷启动时，
  // 隐式前缀缓存只能命中到第一个字节分歧点为止——理解档案/事实库/长期画像这些块
  // 在每轮对话收尾都会被后台抽取/画像聚合改写，若坐在稳定层中段，其后所有真正
  // 稳定的内容（人格/技能/夜间记忆）在新对话首轮全部 miss（实测地板命中恒为
  // baseSystem+规则+协议+人格核 ≈1.4K，其后 ~3-4K 白白重发）。因此：
  //  - CORE 重配置级：人格内核/人格/价值观/能力/Agent World/技能索引/兴趣/静态人格
  //    （只在显式重配置时变）
  //  - SLOW 夜间级：记忆目录/记忆整理家族（夜间巩固器写入）
  //  - MEMORY 对话级：理解档案/事实库/长期画像/持久记忆（每轮对话收尾的后台抽取
  //    即可改写）——排在稳定层最末，改写只打断自己及其后内容
  // 层内保持原语义相对顺序；会话冻结（prefix-cache freezeStableForSession）覆盖
  // 会话内一致性，本契约覆盖跨对话命中率。两者合起来才是完整的缓存架构。
  // 契约由 test/prompt-stable-tiering.test.ts 以「字节公共前缀长度」锁定：
  // 任何把易变块插回稳定层中段的改动都会让测试失败。
  const stableCore: string[] = [];
  const stableSlow: string[] = [];
  const stableMemory: string[] = [];

  // CORE：重配置级
  if (m.personalityCore) stableCore.push(`【人格内核】\n${m.personalityCore}`);
  if (m.persona) stableCore.push(`【人格与角色】\n${m.persona}`);
  if (m.values) stableCore.push(`【价值观与原则】\n${m.values}`);
  // 能力合并：KV 能力倾向 + 宿主 Agent 能力说明本就是同一语义（"我能干什么"）
  const abilitiesCombined = [m.abilities, m.agentCaps].filter(Boolean).join("\n");
  if (abilitiesCombined) stableCore.push(`【能力与工具】\n${abilitiesCombined}`);
  if (m.worldCaps) stableCore.push(`【Agent World】\n${m.worldCaps}`);
  if (m.skillIndex) stableCore.push(m.skillIndex);
  if (m.interestList) stableCore.push(m.interestList);
  // 静态人格块常驻（称呼/关系档变化才重算，前缀缓存友好）。动态 mood 块
  // （personaMood，每轮单一状态）在 dynamicContext 声明后沉入动态层。
  // 旧【说话方式·管家底色/伙伴面】两块（含调子菜单 few-shot 与破功禁句表）
  // 已整体废弃，由 agent/persona-core 承担。
  if (m.personaStatic) stableCore.push(m.personaStatic);
  // 【语感基准】few-shot（2026-10-06 活人感治理）：示例按 sessionId 轮换、
  // 会话内字节稳定——放 MEMORY 带（稳定层沉底），跨 session 才变字节。
  if (m.voiceBaseline) stableMemory.push(m.voiceBaseline);

  // SLOW：夜间级
  if (m.memoryInventory) stableSlow.push(`【记忆目录】\n${m.memoryInventory}`);
  // 记忆整理家族（5→1）：夜间整理的跨会话背景记忆。块内保留源标题作小节标签。
  const memoryConsolidated = buildFamilyBlock(
    "【记忆整理】",
    "（夜间整理的跨会话背景记忆）",
    [
      { label: "关系", content: m.relationshipMemory },
      { label: "生活主题", content: m.lifeThemeMemory },
      { label: "梦境整理", content: m.dreamMemory },
      { label: "连续性", content: m.memoryContinuity },
      { label: "跨天回顾", content: m.yesterdayHighlight },
    ],
  );
  if (memoryConsolidated) stableSlow.push(memoryConsolidated);

  // MEMORY：对话级（稳定层沉底带）。查询相关的记忆字段（事实/偏好/待办承诺，
  // 带 minRelevance 按轮过滤）不在此列——它们留动态层。⚠️ sessionRecap 也不在此列
  // （2026-09-23）：滚动 recap 随 thread 裁剪持续追加，会话内几乎每轮都在变，
  // 已在动态层【短期上下文】家族。
  // 用户理解档案（理解档案 store）：agent 对用户理解的结构化沉淀，先于派生画像
  // 注入——块内自带使用指令（用户相关话题以此为准；玩笑/粉丝式称呼不当事实转述）。
  if (m.userUnderstanding) stableMemory.push(m.userUnderstanding);
  // 结构化事实库（事实档案 store）：用户档案字段的确定性记录，紧跟理解档案——
  // 块内自带使用指令（对应字段提问直接引用当前值，确定性高于语义检索来源）。
  if (m.userFacts) stableMemory.push(m.userFacts);
  if (m.userProfileSummary) stableMemory.push(`【用户长期画像】\n${m.userProfileSummary}`);
  const persistentMemoryBlock = buildFamilyBlock(
    "【持久记忆】",
    "（长期沉淀内容，会话内基本不变）",
    [
      { label: "持久记忆", content: m.memorySummary },
    ],
  );
  if (persistentMemoryBlock) stableMemory.push(persistentMemoryBlock);

  const stablePrefix: string[] = [...stableCore, ...stableSlow, ...stableMemory];

  // ── 动态层 ──
  const dynamicContext: string[] = [];
  const personaMoodBlock = m.personaMood;
  if (personaMoodBlock) dynamicContext.push(personaMoodBlock);
  if (m.semanticIntent) dynamicContext.push(`【意图理解】\n${m.semanticIntent}`);
  // 本轮寻址（2026-09-29 P0-1）：用户最新消息命中的理解话题/事实字段清单。
  // 理解档案/事实块本体在稳定层渲染为字节稳定版（不带逐条寻址标记），命中
  // 信息由此块沉底承载——标记位置从稳定层挪到动态层，前缀缓存不再逐轮断裂。
  if (m.turnAddressing) dynamicContext.push(m.turnAddressing);
  if (m.scheduleSnapshot) dynamicContext.push(m.scheduleSnapshot);
  if (m.travelState) dynamicContext.push(m.travelState);
  // 前置检索证据：realtime_lookup 轮的程序化搜索结果，块内自带以证据为准的强约束
  if (m.webEvidence) dynamicContext.push(m.webEvidence);
  // 任务家族（3→1）：任务上下文 / 追问锚点 / 建议工具链
  const taskBlock = buildFamilyBlock("[Turn Task Context]", undefined, [
    { label: "任务", content: m.taskContext },
    { label: "追问锚点", content: m.followUpAnchor },
    { label: "建议工具链", content: m.toolPlan },
  ]);
  if (taskBlock) dynamicContext.push(taskBlock);
  // 当下状态（P0）：贴此刻的屏幕焦点/在线状态，顺嘴与关心的 grounded 依据
  if (m.currentUserState) dynamicContext.push(`【当下状态】\n${m.currentUserState}`);
  if (m.userLocation) dynamicContext.push(`【用户位置】\n${m.userLocation}`);
  if (m.frequentPlaces) dynamicContext.push(`【常去地点】\n${m.frequentPlaces}`);
  // 记忆图联想检索：保留专属免责（项目硬约束：该块必须带免责声明）。
  // 衔接口径（2026-10-06 治啰嗦 P2-6 合并）：旧事只在话题相关时顺着提，
  // 不主动翻旧账、不以承接话开头——与【消息时间戳】的【话题切换】禁令同源。
  if (m.narrativeRecall) {
    dynamicContext.push(
      `【记忆图联想检索】\n（历史记忆检索结果，可能来自更早会话，非用户本轮所述；不确定时如实说明，与当前对话冲突时以用户最新消息为准）\n（仅当与当前话题相关时才引用，可自然带出处如"你之前提过…"；不主动翻旧账，不以"接着上次"开头）\n${m.narrativeRecall}`,
    );
  }
  // 短期上下文家族（4→1）：工作记忆 / 最近对话 / 今日日志 / 今日摘要
  // （2026-09-23 sessionRecap 并入本家族：随对话轮增长的内容必须沉底，
  // 否则每轮打破稳定前缀缓存——见稳定层·慢变记忆处的注释）
  const shortTermBlock = buildFamilyBlock("【短期上下文】", SHORT_TERM_DISCLAIMER, [
    { label: "工作记忆", content: m.workingMemorySummary },
    { label: "最近对话", content: m.recentConversationHistory },
    { label: "会话回顾", content: m.sessionRecap },
    { label: "今日日志", content: m.journalRecall },
    { label: "今日摘要", content: m.dailyDigest },
  ]);
  if (shortTermBlock) dynamicContext.push(shortTermBlock);
  // 用户档案家族（3→1）：画像 / 偏好 / 事实（查询相关的记忆字段留动态层；
  // 持久记忆/会话回顾已上移稳定层）
  const userProfileBlock = buildFamilyBlock("【用户档案】", undefined, [
    { label: "画像", content: m.userProfile },
    { label: "偏好", content: m.memoryPreferences },
    { label: "事实", content: m.memoryFacts },
  ]);
  if (userProfileBlock) dynamicContext.push(userProfileBlock);
  // 待办与承诺家族（2→1）
  const todoBlock = buildFamilyBlock("【待办与承诺】", undefined, [
    { label: "待兑现承诺", content: m.memoryCommitments },
    { label: "未完成事项", content: m.memoryOpenLoops },
  ]);
  if (todoBlock) dynamicContext.push(todoBlock);
  // 顺嘴机会（P1 主动性搭车）：块内自带织入形态指令（括号旁注、不搭不提）
  if (m.turnAside) dynamicContext.push(m.turnAside);
  if (m.onboardingHint) dynamicContext.push(m.onboardingHint);
  if (m.interruptedContext) dynamicContext.push(m.interruptedContext);
  if (m.currentTime) dynamicContext.push(`【当前时间】\n${m.currentTime}`);
  // 运行环境（手机/电脑）：紧贴时间块，同属「此刻事实」动态层
  if (m.deviceEnvironment) dynamicContext.push(m.deviceEnvironment);
  if (m.conversationTimeline) dynamicContext.push(m.conversationTimeline);
  const replyStyleGuide = buildReplyStyleGuide(m);
  if (replyStyleGuide) dynamicContext.push(replyStyleGuide);

  return { stablePrefix, dynamicContext };
}

export type AssembledSystemPrompt = {
  /** 完整 system prompt（stable + dynamic），用于 msgs[0] 直发路径。 */
  fullSystemPrompt: string;
  /** 稳定 system（baseSystem + 全局规则 + 稳定层），用于前缀缓存请求。 */
  stableSystemPrompt: string;
  /** 动态上下文（沉底注入最新 user 消息尾部），无内容时 undefined。 */
  dynamicSystemPrompt?: string;
};

export type AssembleSystemPromptOpts = {
  /**
   * 是否注入展示形式协议（RENDER_PROTOCOL_PROMPT）。默认 true（聊天面，
   * 模型声明的 [RENDER_HINT:xxx] 由聊天管线剥除并消费）。ephemeral 工具调用
   * （简报润色/摘要/改写等，输出由程序消费、无渲染管线）必须关闭——协议一旦
   * 进入这些调用的 system，模型会在输出里声明 [RENDER_HINT:xxx]，而下游没有
   * 剥除层，标记会原样透到用户屏幕（2026-09-24 晨报 [RENDER_HINT:brief] 事故）。
   */
  includeRenderProtocol?: boolean;
};

/**
 * 完整组装（唯一出口）：baseSystem 在最前（缓存最优），全局规则紧随，
 * 然后稳定层、动态层。minimal/fast 的 overrideSys 同样走本函数——
 * 两种模式的记忆注入路径由此统一。
 */
export function assembleSystemPrompt(
  finalizedBaseSystem: string,
  memory?: AgentPromptMemoryContext,
  opts?: AssembleSystemPromptOpts,
): AssembledSystemPrompt {
  const includeRenderProtocol = opts?.includeRenderProtocol !== false;
  const { stablePrefix, dynamicContext } = assembleLayeredSections(memory);
  const base = finalizedBaseSystem.trim();
  if (stablePrefix.length === 0 && dynamicContext.length === 0) {
    // 无记忆上下文（minimal/fast）：聊天面仍必须携带展示形式协议——它是输出
    // 格式约定，与记忆无关（L2 生成时结构化的唯一启用通道）。
    const withProtocol = (
      includeRenderProtocol ? [base, RENDER_PROTOCOL_PROMPT] : [base]
    )
      .join("\n\n")
      .trim();
    return { fullSystemPrompt: withProtocol, stableSystemPrompt: withProtocol };
  }
  // 协议块置于全局规则之后、记忆稳定层之前：内容与轮次无关，前缀缓存友好。
  const stableSystemPrompt = [
    base,
    GLOBAL_MEMORY_RULE,
    ...(includeRenderProtocol ? [RENDER_PROTOCOL_PROMPT] : []),
    ...stablePrefix,
  ]
    .join("\n\n")
    .trim();
  const dynamicSystemPrompt = dynamicContext.join("\n\n").trim() || undefined;
  return {
    fullSystemPrompt: dynamicSystemPrompt
      ? `${stableSystemPrompt}\n\n${dynamicSystemPrompt}`
      : stableSystemPrompt,
    stableSystemPrompt,
    dynamicSystemPrompt,
  };
}
