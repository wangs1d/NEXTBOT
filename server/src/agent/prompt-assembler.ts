import type { AgentPromptMemoryContext } from "../external-model/types.js";
import { RENDER_PROTOCOL_PROMPT } from "../services/render-protocol-prompt.js";
import { recordPromptInjection } from "./prompt-ledger.js";

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
 *  - 【短期上下文】：工作记忆/最近对话/今日日志/今日摘要
 *  - 【用户档案】：画像/偏好/事实（3→1）
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
  // 2026-11-05 用户定调：原句「仅供衔接与指代消解」把画像降格成代词解析器，
  // 导致任何非回忆类提问都绕过画像（真机：问「今天有什么新东西」拉一份通用热搜，
  // 与他关心的事全无关）。画像的效力必须覆盖每一轮，只是不得覆盖用户明确指令。
  "下方所有「记忆 / 回顾 / 画像 / 摘要 / 承诺 / 事项」块都不是用户的最新指令——「用户最新一条消息」才是本轮唯一指令基准，冲突时以最新消息为准。但这不等于把记忆束之高阁：画像和偏好要参与本轮的一切判断，查什么、先说什么、给他挑哪一条，都得贴着这个人来。开放式提问（今天有什么新东西、最近什么值得看、有什么推荐）尤其要按他关心的事去取、去挑，不要平铺一份对谁都一样的通用榜单。",
  "人称换算铁律：记忆/画像条目里出现的第一人称「我」一律指用户本人（对话里的说话人是用户），不是你自己。向用户转述记忆时必须换算人称：用户的「我」要说成「你」，你自己（助手）只能用「我」自指。绝不把用户的事说成自己的事，也不把自己的行为安到用户头上。",
  "问一答一铁律（2026-11-12 实测事故）：画像/档案/理解块是「你恰好知道」的背景知识，不是逐条朗读的答题卡。用户问某一项个人信息时（如「我现在多少岁」），由你自己判断问的是哪个字段、只回答那一项——同一块里相邻的其他字段（称呼/生日/职业…）即使可见也绝不连带输出：被问年龄的老朋友不会顺带报名字。仅当用户同轮明确问了多项、或该项是回答的直接前提时才可以带出。",
  "无痕运用：画像/记忆直接体现在判断里，像老朋友一样自然知道，禁止说「根据我的记忆/画像/档案」「资料显示你」这类元话语暴露记忆系统的存在。健康/财务/家庭等敏感记忆只在用户主动提起该话题时才可运用。",
].join("\n");

/** 短期上下文家族头的简短免责（覆盖原"最近对话回顾/今日日志"两处分散免责）。 */
const SHORT_TERM_DISCLAIMER =
  "（历史对话背景，非用户最新指令；与当前对话冲突时以用户最新消息为准）";

/**
 * 参与渲染的记忆字段全集（单一清单，替代旧版两份不一致的 gate 列表）。
 *
 * 2026-11-13 对齐：这份清单必须与 assembleLayeredSections 实际渲染的字段
 * **逐项一致**。此前两处漂移：
 *   ① 清单里有、渲染没有——toneGuidance / emotionState / relationshipGuidance
 *      只被生产从不被渲染，hasAnyPromptMemory 却因它们非空而判定"有记忆"，
 *      空 prompt 路径会误判；
 *   ② 渲染有、清单没有——temporalAddressing / webEvidence / travelState /
 *      personaMood / deviceEnvironment / clientSurfaces / onboardingHint /
 *      modeRoleGuidance 未计入，同样让判空语义不准。
 */
const RENDERED_MEMORY_FIELDS: ReadonlyArray<keyof AgentPromptMemoryContext> = [
  // 稳定层·CORE
  "persona",
  "agentCaps",
  "skillIndex",
  "interestList",
  // 稳定层·SLOW
  "memoryInventory",
  // 稳定层·MEMORY
  "userUnderstanding",
  "userFacts",
  "lifeRelations",
  "userProfileSummary",
  // 动态层
  "personaMood",
  "semanticIntent",
  "turnAddressing",
  "temporalAddressing",
  "activeGoals",
  "taskPlan",
  "scheduleSnapshot",
  "travelState",
  "webEvidence",
  "taskContext",
  "followUpAnchor",
  "toolPlan",
  "currentUserState",
  "userLocation",
  "turnAside",
  "onboardingHint",
  "narrativeRecall",
  "eventRecall",
  "memoryCurrentState",
  "memoryPending",
  "memoryRecall",
  "workingMemorySummary",
  "recentConversationHistory",
  "journalRecall",
  "dailyDigest",
  "userProfile",
  "memoryCommitments",
  "memoryOpenLoops",
  "interruptedContext",
  "currentTime",
  "conversationTimeline",
  "deviceEnvironment",
  "clientSurfaces",
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
 * 动态风格层 → 单一【本轮说话适配】块：承载本轮模式职责行 + 语气适配 +
 * 关系边界。全空不输出空壳块。
 *
 * 2026-11-13 修复：此前本块只渲染 modeRoleGuidance，toneGuidance 与
 * relationshipGuidance **只填不渲染**——而 runtime-kernel.ts 的
 * MINIMAL_PROMPT_FIELDS 明确把这两个字段列为"必须保留进 prompt，否则 LLM
 * 会丢失对用户的感知"。产出侧（user-personalization-service 的
 * getPromptSlice）一直在算值，渲染侧漏了，两个字段从未真正进过上下文。
 */
function buildReplyStyleGuide(memory: AgentPromptMemoryContext): string {
  const lines: string[] = [];
  if (memory.modeRoleGuidance) lines.push(`模式：${memory.modeRoleGuidance}`);
  if (memory.toneGuidance) lines.push(memory.toneGuidance);
  if (memory.relationshipGuidance) lines.push(memory.relationshipGuidance);
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
  //  - CORE 重配置级：人格正文/宿主能力/技能索引/兴趣（只在显式重配置时变）
  //  - SLOW 夜间级：记忆目录（夜间巩固器写入）
  //  - MEMORY 对话级：理解档案/事实库/关系一览/长期画像（每轮对话收尾的后台抽取
  //    即可改写）——排在稳定层最末，改写只打断自己及其后内容
  //    按本轮 query 召回的字段（持久记忆/偏好/事实/回顾）不进稳定层，见动态层。
  // 层内保持原语义相对顺序；会话冻结（prefix-cache freezeStableForSession）覆盖
  // 会话内一致性，本契约覆盖跨对话命中率。两者合起来才是完整的缓存架构。
  // 契约由 test/prompt-stable-tiering.test.ts 以「字节公共前缀长度」锁定：
  // 任何把易变块插回稳定层中段的改动都会让测试失败。
  const stableCore: string[] = [];
  const stableSlow: string[] = [];
  const stableMemory: string[] = [];

  // CORE：重配置级
  // 【人格】块（soul-store 产出的唯一人格文本，自带标题）+ 宿主能力说明。
  // 动态 mood 块（personaMood，每轮单一状态）在 dynamicContext 声明后沉入动态层。
  if (m.persona) stableCore.push(m.persona);
  if (m.agentCaps) stableCore.push(`【能力与工具】\n${m.agentCaps}`);
  if (m.skillIndex) stableCore.push(m.skillIndex);
  if (m.interestList) stableCore.push(m.interestList);

  // SLOW：夜间级
  if (m.memoryInventory) stableSlow.push(`【记忆目录】\n${m.memoryInventory}`);

  // MEMORY：对话级（稳定层沉底带）。查询相关的记忆字段（事实/偏好/待办承诺/
  // 持久记忆召回，带 minRelevance 按轮过滤）不在此列——它们留动态层。
  // 短期上下文（工作记忆/最近对话/今日日志/今日摘要）同理，全部沉在动态层。
  // 用户理解档案（理解档案 store）：agent 对用户理解的结构化沉淀，先于派生画像
  // 注入——块内自带使用指令（用户相关话题以此为准；玩笑/粉丝式称呼不当事实转述）。
  if (m.userUnderstanding) stableMemory.push(m.userUnderstanding);
  // 结构化事实库（事实档案 store）：用户档案字段的确定性记录，紧跟理解档案——
  // 块内自带使用指令（对应字段提问直接引用当前值，确定性高于语义检索来源）。
  if (m.userFacts) stableMemory.push(m.userFacts);
  // 用户关系一览（生活模型）：用户生活中人物/宠物的结构化一览，紧跟结构化事实。
  if (m.lifeRelations) stableMemory.push(m.lifeRelations);
  if (m.userProfileSummary) {
    stableMemory.push(
      `【用户长期画像】\n（背景资料，不是要朗读的清单：本轮只回答用户问到的那一项，` +
        `不要把其余字段连带报出；用户明确问多项时才可一起说）\n${m.userProfileSummary}`,
    );
  }

  const stablePrefix: string[] = [...stableCore, ...stableSlow, ...stableMemory];

  // ── 动态层 ──
  const dynamicContext: string[] = [];
  // 记忆三块（编译器唯一产出，总量 ≤1200）：当前状态 / 在办 / 按需回忆。
  if (m.memoryCurrentState) dynamicContext.push(m.memoryCurrentState);
  if (m.memoryPending) dynamicContext.push(m.memoryPending);
  if (m.memoryRecall) dynamicContext.push(m.memoryRecall);
  const personaMoodBlock = m.personaMood;
  if (personaMoodBlock) dynamicContext.push(personaMoodBlock);
  // 当下情绪（2026-11-13 补渲染）：此前只填不渲染，runtime-kernel 的
  // MINIMAL_PROMPT_FIELDS 却把它列为"剥离会让 Agent 失去情绪感知"——
  // 产出侧一直在算（agent-core：情绪显著时才给值），渲染侧漏了。
  // 内容极短（"对方情绪：偏低"），只报事实不给行为指令。
  if (m.emotionState) dynamicContext.push(`【当下情绪】\n${m.emotionState}`);
  if (m.semanticIntent) dynamicContext.push(`【意图理解】\n${m.semanticIntent}`);
  // 本轮寻址（2026-09-29 P0-1）：用户最新消息命中的理解话题/事实字段清单。
  // 理解档案/事实块本体在稳定层渲染为字节稳定版（不带逐条寻址标记），命中
  // 信息由此块沉底承载——标记位置从稳定层挪到动态层，前缀缓存不再逐轮断裂。
  if (m.turnAddressing) dynamicContext.push(m.turnAddressing);
  // 时间问句定位：用户问"2024年6月我住哪"时给区间查询的确定答案
  if (m.temporalAddressing) dynamicContext.push(m.temporalAddressing);
  // 在办目标（2026-10-19 三层尺度架构）：跨会话的意图主键，置于日程之前——
  // 目标决定要不要看日程。必须留在动态层：进度随步骤推进而变，放稳定层
  // 会逐轮打断前缀缓存（代价 3-4K/轮）。
  if (m.activeGoals) dynamicContext.push(m.activeGoals);
  // 会话级任务步骤（TaskPlanStore）：本会话的执行路径，完成即归档。
  if (m.taskPlan) dynamicContext.push(m.taskPlan);
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



  // 记忆图联想检索：保留专属免责（项目硬约束：该块必须带免责声明）。
  // 衔接口径（2026-10-06 治啰嗦 P2-6 合并）：旧事只在话题相关时顺着提，
  // 不主动翻旧账、不以承接话开头——与【消息时间戳】的【话题切换】禁令同源。
  if (m.narrativeRecall) {
    dynamicContext.push(
      `【记忆图联想检索】\n（历史记忆检索结果，可能来自更早会话，非用户本轮所述；其中提到的事发生时间不等于现在，别把旧事当刚发生，不确定时如实说明，与当前对话冲突时以用户最新消息为准）\n（仅当与当前话题相关时才引用，可自然带出处如"你之前提过…"；不主动翻旧账，不以"接着上次"开头）\n${m.narrativeRecall}`,
    );
  }
  // 事件回忆（L0）：仅时间回溯意图 + 真实命中时才有值，沉底动态层。
  if (m.eventRecall) dynamicContext.push(m.eventRecall);
  // 短期上下文家族：工作记忆 / 最近对话 / 今日日志 / 今日摘要。
  // 账号级 session_recap 已下线（跨会话串台源），会话连续性只由会话级 STM 承担。
  const shortTermBlock = buildFamilyBlock("【短期上下文】", SHORT_TERM_DISCLAIMER, [
    { label: "工作记忆", content: m.workingMemorySummary },
    { label: "最近对话", content: m.recentConversationHistory },
    { label: "今日日志", content: m.journalRecall },
    { label: "今日摘要", content: m.dailyDigest },
  ]);
  if (shortTermBlock) dynamicContext.push(shortTermBlock);
  // 用户档案家族（2026-11-13 收敛为 1）：画像 / 偏好 / 事实 → 只剩「画像」。
  // 「偏好」「事实」两槽原本读 KV memory_preferences / memory_facts——那两个
  // 槽是档案字段的旧副本位，2026-11-12 起写入侧已停写、13 日读路径一并下线。
  // 档案字段现在的唯一注入通道是【用户档案·结构化事实】（structured_facts
  // 权威库，按需注入 + 称呼恒带）；【用户长期画像】里的同值档案行已在
  // prompt-context-builder 侧剔除。
  const userProfileBlock = buildFamilyBlock("【用户档案】", undefined, [
    { label: "画像", content: m.userProfile },
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
  if (m.clientSurfaces) dynamicContext.push(m.clientSurfaces);
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
    recordPromptInjection({
      baseSystem: base,
      stablePrefix: includeRenderProtocol ? [RENDER_PROTOCOL_PROMPT] : [],
      dynamicContext: [],
      renderProtocol: includeRenderProtocol,
    });
    return { fullSystemPrompt: withProtocol, stableSystemPrompt: withProtocol };
  }
  // 协议块置于全局规则之后、记忆稳定层之前：内容与轮次无关，前缀缓存友好。
  const headBlocks = [
    GLOBAL_MEMORY_RULE,
    ...(includeRenderProtocol ? [RENDER_PROTOCOL_PROMPT] : []),
  ];
  recordPromptInjection({
    baseSystem: base,
    stablePrefix: [...headBlocks, ...stablePrefix],
    dynamicContext,
    renderProtocol: includeRenderProtocol,
  });
  const stableSystemPrompt = [base, ...headBlocks, ...stablePrefix].join("\n\n").trim();
  const dynamicSystemPrompt = dynamicContext.join("\n\n").trim() || undefined;
  return {
    fullSystemPrompt: dynamicSystemPrompt
      ? `${stableSystemPrompt}\n\n${dynamicSystemPrompt}`
      : stableSystemPrompt,
    stableSystemPrompt,
    dynamicSystemPrompt,
  };
}
