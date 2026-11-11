import { isDigestRoundupQuery } from "./direct-fact-query.js";
import { WEATHER_CARD_BOUNDARY } from "../render/scenes/prompts.js";

/**
 * 数据驱动回复策略评估器
 *
 * 核心思路：不靠 prompt 硬编码"必须怎么做"，而是根据工具循环收集到的真实数据质量，
 * 程序化选择最合适的回复策略，动态注入到 LLM 的最终生成步骤。
 *
 * 流程：工具结果 → 评估数据质量 → 选择策略 → 注入策略指令 → LLM 语言化输出
 */

/** 工具收集到的数据片段 */
export interface CollectedToolData {
  toolName: string;
  ok: boolean;
  /** 工具返回的文本内容（从 result 中提取） */
  text: string;
  /** 结果长度（字符数） */
  length: number;
  /** 是否是搜索类工具 */
  isSearch: boolean;
  /** 是否是抓取类工具 */
  isFetch: boolean;
}

/** 数据质量评估结果 */
export interface DataQualityAssessment {
  /** 来源数量（不同工具调用次数） */
  sourceCount: number;
  /** 搜索类工具调用次数 */
  searchCount: number;
  /** 抓取类工具调用次数 */
  fetchCount: number;
  /** 成功的工具调用数 */
  successCount: number;
  /** 失败的工具调用数 */
  failureCount: number;
  /** 总内容长度 */
  totalContentLength: number;
  /** 内容多样性：不同工具名称数 */
  toolDiversity: number;
  /** 综合质量等级 */
  level: "high" | "medium" | "low" | "contradictory" | "empty";
  /** 评估理由（用于日志） */
  reason: string;
}

/**
 * 回复策略标识 —— 现在只是**观测与场景路由信号**（日志 / 看板 / 渲染场景挑选用），
 * 不再对应任何注入到 prompt 的组织方式。版式归 render/scenes：
 * 清单型走 digest_roundup 槽位场景，回执型走卡片场景，散文型本来不需要版式。
 */
export type SynthesisStrategy =
  | "framework_attribution" // 归因分析类轮次（散文，无需版式）
  | "digest_roundup"        // 动态/近况盘点（对应 digest_roundup 槽位场景）
  | "layered_progressive"   // 一般检索轮（散文，无需版式）
  | "multi_perspective"     // 来源矛盾（散文，无需版式）
  | "direct_answer"         // 无工具数据 / 数据稀少
  | "photo_delivery"        // 纯图轮：交图即交付，正文一两句话收束
  | "weather_card"          // 天气卡轮：数值由系统卡片展示，正文只给建议
  | "confirm_receipt";      // 办妥确认轮：提醒/日程写入回执，一两句收口

/**
 * 照片轮专用指令（2026-10-06）：用户搜照片要的是图本身，每张照片下方已由
 * image-caption-service 自动附一句画面解读（Coze 式一图一句），正文再按
 * 「已确认的/能说的/没查到的」分节盘点就是废话。此前 medium/high 档的
 * 「信息用足、按主题分节」指令会把纯图轮教唆成三段式盘点（真机取证）。
 */
export const PHOTO_DELIVERY_INSTRUCTION =
  `照片轮：图片本身就是交付，每张照片下方会自动附一句画面解读（场景、氛围、观感），正文不要重复。` +
  `直接交图，正文最多一两句话自然引入（如来源或场合），然后收束。` +
  `严禁按主题分节盘点，严禁写「已确认的/能说的/没查到的」式小节，不要逐张复述照片内容；没找到的图用一句话带过即可，不要单列缺口清单。`;

/**
 * 天气卡轮专用指令（2026-10-08）：天气数值已由 tool-card-registry 从工具回执
 * 确定性构建成结构化天气卡（城市·日期 / 天气 / 气温 / 降水 / 着装），同屏正文
 * 再复述数据就是双份。
 *
 * 2026-11-05 收敛：文本唯一源迁到 render/scenes/prompts.ts（天气场景持有），
 * 这里只做再导出，防止同一段边界在 prompt 与场景两处各写一份而漂移。
 */
export const WEATHER_CARD_INSTRUCTION = WEATHER_CARD_BOUNDARY;

/**
 * 办妥确认轮专用指令（2026-11-05 五轮收敛后的最终形态：一句话，只划底线）。
 *
 * 演进史（都是真机取证出的教训）：
 * ① 播报分级计划 → ② 口语时间但复述时刻 → ③ 完全不提时间 → ④ 删示例台词
 * → ⑤ 压成一句。教训一致：**凡是服务端描写"该怎么说话"的地方，最后都会变成模板**；
 * 底线之外的措辞权必须归模型。
 *
 * 作用域仅限办妥确认轮。天气/照片两轮的边界同样只划产品边界（别跟卡片重复），
 * 不描述版式；新闻盘点等清单型内容的版式由 render/scenes 的槽位场景负责。
 */
export const CONFIRM_RECEIPT_INSTRUCTION =
  `提醒/日程已写入，这是背景事实不用播报。怎么接这句话你自己定，` +
  `只有三条底线：别重复时间（他刚说过；除非时间不是他说的，那才用 whenSpoken 交代）、` +
  `别提内部编排（系统/后台/分级/生效/多个时间点；advanceReminderKinds 是你知道的事实，要不要提你自己定）、别复述他的原话。`;

/** 有文字检索/抓取结果的工具：出现它们说明本轮是图文混合研究，不按纯图轮处理 */
const TEXT_SEARCH_TOOL_NAMES = new Set([
  "search_web",
  "deep_search",
  "hot_rankings",
  // 注意：search_videos 是**媒体**工具（视频结果同样由媒体卡交付），
  // 不属于文字检索。此前误列在这里，模型顺手搜了视频就会把纯图轮判成
  // 「图文混合」，正文退化成照片清单/视频介绍（2026-10-21 真机取证）。
  "fetch_web",
  "info.inspect_webpage",
  "info.navigate_site",
]);

/**
 * 记账型工具（2026-10-06 治啰嗦 P0-2）：结果是「已写入/已清除」类状态回执，
 * 不是可供组织成回复的外部信息。它们不得参与数据质量评估——否则一句
 * 「以后叫我王哥」（调 profile.update）会被评成 medium/high 数据档，
 * 叠上「信息用足、按主题分节」的展开策略，把称呼确认写成研究报告。
 */
export const BOOKKEEPING_TOOL_NAMES = new Set<string>([
  "profile.update",
  "memory.forget",
  "memory.invalidate",
  "interest.manage",
]);

/**
 * 本轮是否只有记账型工具（无任何真实检索/外部信息）。
 *
 * 这是「过程话是否值得说」的唯一判定入口（2026-10-09 发言模型）：
 * 记账轮回执是「已写入/已清除」类状态，过程话（"好的，记下了"）与结论
 * （"已经记上啦"）必然同义 —— 过程话在这一轮没有任何信息价值，应当裁掉。
 * 判定放这里（策略层）而不是散在工具循环/各工具 handler 里，避免按工具名打补丁。
 */
export function isBookkeepingOnlyToolSet(toolNames: readonly string[]): boolean {
  if (toolNames.length === 0) return false;
  return toolNames.every((name) => BOOKKEEPING_TOOL_NAMES.has(name));
}

/**
 * 办妥确认轮工具（与 services/agent-core 的 CALENDAR_CONFIRM_TOOLS 同源：
 * 提醒/日程创建类，本轮任一成功返回即按「办妥确认轮」收口）。此处不复用该
 * 导出——services→agent 的反向依赖不进策略层，两侧各自维护并以注释互指。
 */
const CALENDAR_CONFIRM_TOOL_NAMES = new Set(["calendar"]);

/**
 * 过程话（工具执行前的过渡话）许可：
 * - allow：检索/生成类轮次，过程话承载「我在查了」的等待价值（TTFT 体感），必须保留；
 * - suppress：记账类轮次，过程话必然与结论同义，抑制。
 */
export type PreamblePolicy = "allow" | "suppress";

/**
 * 是否是「纯图轮」：本轮至少一次 search_images 成功，且没有任何成功的
 * 文字检索/抓取结果（图文混合时仍走常规合成策略）。search_images_batch
 * 是对比出图流，前端按「一段介绍 + 一组对比图」交错渲染，不在此列。
 */
export function isPhotoDeliveryRound(
  results: Array<{ toolName: string; ok: boolean }>,
  turnIntent?: string,
): boolean {
  const okResults = results.filter((r) => r.ok);
  if (!okResults.some((r) => r.toolName === "search_images")) return false;
  // 媒体意图是结构性判据（2026-10-21 根修）：用户这一轮要的就是照片，即便
  // 某次网页检索意外成功（历史事故），正文也不能转成「按主题分节 + 表格」的
  // 资料汇总——交付形态由意图决定，不由工具结果的组合碰运气。
  if (turnIntent === "media_retrieval") return true;
  return !okResults.some((r) => TEXT_SEARCH_TOOL_NAMES.has(r.toolName));
}

/**
 * 是否是「天气卡轮」：本轮至少一次 weather.* 工具成功，且没有任何成功的
 * 文字检索/抓取结果。天气+搜索混合轮（如「查天气顺便查攻略」）仍走常规
 * 合成策略，天气数值此时只是回复的一小部分。
 */
export function isWeatherCardRound(
  results: Array<{ toolName: string; ok: boolean }>,
): boolean {
  const okResults = results.filter((r) => r.ok);
  if (!okResults.some((r) => r.toolName.startsWith("weather."))) return false;
  return !okResults.some((r) => TEXT_SEARCH_TOOL_NAMES.has(r.toolName));
}

/** 策略指令（注入 LLM 的动态指令） */
export interface StrategyDirective {
  strategy: SynthesisStrategy;
  /** 注入给 LLM 的策略指令文本 */
  instruction: string;
  /** 数据质量评估（用于日志/调试） */
  quality: DataQualityAssessment;
  /**
   * 过程话许可（2026-10-09 发言模型）：由策略层统一声明，装配层/工具循环只读不算。
   * 记账轮 suppress —— 过程话与结论必然同义，说了就是重复。
   */
  preamblePolicy: PreamblePolicy;
}

/** 搜索类工具名关键词 */
const SEARCH_TOOL_KEYWORDS = ["search", "web_search", "search_web", "bing", "google"];
/** 抓取类工具名关键词 */
const FETCH_TOOL_KEYWORDS = ["fetch", "web_fetch", "fetch_web", "browse", "get_page"];

function isSearchTool(name: string): boolean {
  const lower = name.toLowerCase();
  return SEARCH_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isFetchTool(name: string): boolean {
  const lower = name.toLowerCase();
  return FETCH_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** 从工具结果中提取文本内容 */
function extractToolText(result: Record<string, unknown>): string {
  // 常见字段优先级：text > content > snippet > answer > summary > body。
  // items 必须在列：search_web / search_images 等搜索工具的结果都挂在 items 数组下，
  // 之前漏掉该字段导致整份搜索结果走 JSON 兜底被截到 500 字符，
  // 质量评估长期误判为「medium/500字符」，策略指令随之退化成求简模式。
  const fields = ["text", "content", "snippet", "answer", "summary", "body", "items", "results", "data"];
  for (const field of fields) {
    const val = result[field];
    if (typeof val === "string" && val.trim()) return val;
    if (Array.isArray(val)) {
      // 搜索结果数组：拼接每条的 snippet/title（含时间/来源，供策略判断信息密度）
      const texts = val
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            const body = String(obj.snippet ?? obj.content ?? obj.text ?? obj.summary ?? "");
            const title = typeof obj.title === "string" ? obj.title : "";
            const when = String(obj.publishedAt ?? obj.time ?? obj.date ?? "");
            const line = [title, body, when].map((s) => s.trim()).filter(Boolean).join(" | ");
            return line;
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  // 兜底：JSON stringify 截断
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return "";
  }
}

/** 评估收集到的工具数据质量 */
export function assessDataQuality(toolData: CollectedToolData[]): DataQualityAssessment {
  if (toolData.length === 0) {
    return {
      sourceCount: 0,
      searchCount: 0,
      fetchCount: 0,
      successCount: 0,
      failureCount: 0,
      totalContentLength: 0,
      toolDiversity: 0,
      level: "empty",
      reason: "无工具调用数据",
    };
  }

  const successCount = toolData.filter((d) => d.ok).length;
  const failureCount = toolData.filter((d) => !d.ok).length;
  const searchCount = toolData.filter((d) => d.isSearch).length;
  const fetchCount = toolData.filter((d) => d.isFetch).length;
  const totalContentLength = toolData.reduce((sum, d) => sum + d.length, 0);
  const uniqueTools = new Set(toolData.map((d) => d.toolName));
  const toolDiversity = uniqueTools.size;

  // 成功的工具结果文本
  const successTexts = toolData.filter((d) => d.ok && d.text.length > 20).map((d) => d.text);

  // 矛盾检测：多个来源内容差异极大（简化：看是否有明显矛盾的标志词）
  const hasContradiction =
    successTexts.length >= 2 &&
    successTexts.some((t) => /但是|然而|不过|相反|actually|however|but/i.test(t)) &&
    successTexts.some((t) => /相反|contra|否定|推翻| refute/i.test(t));

  // 质量等级判定
  let level: DataQualityAssessment["level"];
  let reason: string;

  if (hasContradiction) {
    level = "contradictory";
    reason = `多源数据存在矛盾信号（${successTexts.length}个来源）`;
  } else if (successCount === 0) {
    level = "low";
    reason = `全部工具调用失败（${failureCount}次）`;
  } else if (
    (successCount >= 3 && totalContentLength > 800 && toolDiversity >= 2) ||
    // 单工具也能拿到充分数据：一次搜索返回大量条目（内容总量充足）时按高质量对待，
    // 不能因为「只调了一种工具」就把多来源检索结果压成 medium 去做求简回复
    (successCount >= 1 && totalContentLength > 1500)
  ) {
    level = "high";
    reason = `多源充分（${successCount}个成功结果，${toolDiversity}种工具，${totalContentLength}字符）`;
  } else if (successCount >= 1 && totalContentLength > 200) {
    level = "medium";
    reason = `数据部分充分（${successCount}个成功结果，${totalContentLength}字符）`;
  } else {
    level = "low";
    reason = `数据稀少（${successCount}个成功结果，${totalContentLength}字符）`;
  }

  return {
    sourceCount: toolData.length,
    searchCount,
    fetchCount,
    successCount,
    failureCount,
    totalContentLength,
    toolDiversity,
    level,
    reason,
  };
}

/** 根据数据质量选择回复策略 */
export function selectStrategy(quality: DataQualityAssessment, userMessage: string): StrategyDirective {
  const isAnalysisQuestion = /为什么|分析|怎么回事|原因|导致|影响|背后|逻辑/i.test(userMessage);
  const digestRoundup = isDigestRoundupQuery(userMessage);

  // 2026-11-05 架构收敛（用户拍板第二次）：**版式全部下沉到 render/scenes**。
  // 上一轮曾恢复编号结构模板，本轮的结论是——结构不该由 prompt 教：
  //   · 清单型内容（盘点/近况）→ digest_roundup 场景做槽位契约，
  //     模型只填 {summary, groups[]}，服务端确定性渲染成固定版式；
  //   · 回执型内容（提醒/日程/天气/照片）→ 卡片由 tool-card-registry / 场景建；
  //   · 散文型内容（归因分析/矛盾对比/闲聊）→ 本来就不需要版式，人格管语气即可。
  // 所以此处只给**数据事实**（几个来源、缺不缺），不写任何编号步骤、不写
  // 「按主题分组」「结论先行」这类版式措辞。strategy 名保留作观测与场景路由信号。

  /** 数据事实：够不够、有几个来源、缺多少。只陈述事实，不教组织方式。 */
  const dataFact =
    `（工具结果：${quality.successCount}个成功` +
    (quality.failureCount > 0 ? `，${quality.failureCount}个失败` : "") +
    `，共${quality.totalContentLength}字符）`;

  let strategy: SynthesisStrategy;
  let instruction: string;

  switch (quality.level) {
    case "empty":
      // 无工具数据：直接回答（纯知识场景）
      strategy = "direct_answer";
      instruction = "";
      break;

    case "high":
      // strategy 名保留作观测/场景路由；不再附带任何组织方式（版式在 scenes）
      strategy = digestRoundup
        ? "digest_roundup"
        : isAnalysisQuestion
          ? "framework_attribution"
          : "layered_progressive";
      instruction = `${dataFact}数据够了，直接答。`;
      break;

    case "medium":
      strategy = digestRoundup ? "digest_roundup" : "layered_progressive";
      instruction = `${dataFact}部分结果可用：能确定的直接答，补不上的照实说。`;
      break;

    case "contradictory":
      strategy = "multi_perspective";
      instruction = `${dataFact}几个来源的说法不一致，照实取舍。`;
      break;

    case "low":
      // 低质量数据（2026-11-05 删除 honest_sparse）：数据少时同样不给结构，
      // 只留一条事实底线——怎么说交还模型。
      strategy = "direct_answer";
      instruction = `${dataFact}结果有限：能确定什么就答什么，补不上来的照实说，不要编。`;
      break;
  }

  return { strategy, instruction, quality, preamblePolicy: "allow" };
}

/** 从 ToolExecutedInfo 数组构造 CollectedToolData */
export function collectToolDataFromResults(
  results: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>,
): CollectedToolData[] {
  return results.map((r) => {
    const text = extractToolText(r.result);
    return {
      toolName: r.toolName,
      ok: r.ok,
      text,
      length: text.length,
      isSearch: isSearchTool(r.toolName),
      isFetch: isFetchTool(r.toolName),
    };
  });
}

/** 便捷入口：从工具结果直接得到策略指令 */
export function evaluateAndSelectStrategy(
  toolResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>,
  userMessage: string,
  turnIntent?: string,
): StrategyDirective {
  // 记账轮短路（2026-10-06）：本轮只有档案/记忆写入类回执、没有真实检索内容时，
  // 不做数据质量分档、不注入任何展开策略——回复形态交给车道人格（闲聊轮两三句）。
  const substantiveResults = toolResults.filter((r) => !BOOKKEEPING_TOOL_NAMES.has(r.toolName));
  if (toolResults.length > 0 && substantiveResults.length === 0) {
    return {
      strategy: "direct_answer",
      instruction: "",
      quality: {
        sourceCount: toolResults.length,
        searchCount: 0,
        fetchCount: 0,
        successCount: toolResults.filter((r) => r.ok).length,
        failureCount: toolResults.filter((r) => !r.ok).length,
        totalContentLength: 0,
        toolDiversity: toolResults.length,
        level: "empty",
        reason: "纯记账轮：仅档案/记忆写入类回执，不施加展开策略",
      },
      // 记账轮：过程话与结论必然同义（"好的，记下了" vs "已经记上啦"）→ 抑制
      preamblePolicy: "suppress",
    };
  }
  // 办妥确认轮短路（2026-10-25）：提醒/日程创建回执是「已写入」状态，与记账轮
  // 同理不走数据质量分档——否则 low 档编号模板（honest_sparse，已删）会教出
  // 「已确定/目前未知」
  // 三段式盘点卡（真机：牙医提醒轮）。仅当本轮全部是确认工具且**确实写入成功**
  // 时生效；失败轮与混检索轮照常评估（失败要解释原因、混合轮要组织真实数据）。
  //
  // 2026-11-05 实测补洞：calendar.create 解析失败时返回 ok:true + matched:false
  // （带 hint「未能解析时间或事项」），旧判据只看 ok → 照样短路成 confirm_receipt，
  // 指令让模型说「提醒已写入成功」，实际什么都没写。matched:false 必须排除。
  const confirmWritten = substantiveResults.filter(
    (r) => r.ok && (r.result as { matched?: unknown } | undefined)?.matched !== false,
  );
  if (
    substantiveResults.length > 0 &&
    substantiveResults.every((r) => CALENDAR_CONFIRM_TOOL_NAMES.has(r.toolName)) &&
    confirmWritten.length === substantiveResults.length
  ) {
    return {
      strategy: "confirm_receipt",
      instruction: CONFIRM_RECEIPT_INSTRUCTION,
      quality: {
        sourceCount: toolResults.length,
        searchCount: 0,
        fetchCount: 0,
        successCount: substantiveResults.filter((r) => r.ok).length,
        failureCount: toolResults.filter((r) => !r.ok).length,
        totalContentLength: 0,
        toolDiversity: substantiveResults.length,
        level: "high",
        reason: "办妥确认轮：提醒/日程创建成功回执，一两句收口",
      },
      preamblePolicy: "suppress",
    };
  }
  // 纯图轮短路（2026-10-06）：搜照片轮的交付是图本身，不走数据质量分档——
  // 否则 medium 档的「先已确认事实/再合理推断/最后待验证点」三段式会教出
  // 「已确认的/能说的/没查到的」盘点正文（真机取证的事故形态）。
  if (isPhotoDeliveryRound(substantiveResults, turnIntent)) {
    return {
      strategy: "photo_delivery",
      instruction: PHOTO_DELIVERY_INSTRUCTION,
      quality: {
        sourceCount: substantiveResults.length,
        searchCount: substantiveResults.length,
        fetchCount: 0,
        successCount: substantiveResults.filter((r) => r.ok).length,
        failureCount: substantiveResults.filter((r) => !r.ok).length,
        totalContentLength: 0,
        toolDiversity: 1,
        level: "high",
        reason: "纯图轮：search_images 成功且无文字检索结果，交图为主",
      },
      preamblePolicy: "allow",
    };
  }
  // 天气卡轮短路（2026-10-08）：天气数值已由系统专用卡片展示，不走数据质量分档——
  // 否则 medium 档「先给出已确认的事实（有数据支撑的部分）」会把模型教成
  // 「## 标题 + > 引用 + 表格」复述数据当事实层（真机事故形态，同纯图轮教训）。
  if (isWeatherCardRound(substantiveResults)) {
    return {
      strategy: "weather_card",
      instruction: WEATHER_CARD_INSTRUCTION,
      quality: {
        sourceCount: substantiveResults.length,
        searchCount: 0,
        fetchCount: 0,
        successCount: substantiveResults.filter((r) => r.ok).length,
        failureCount: substantiveResults.filter((r) => !r.ok).length,
        totalContentLength: 0,
        toolDiversity: 1,
        level: "high",
        reason: "天气卡轮：weather.* 成功且无文字检索结果，数值走卡片、正文只写建议",
      },
      preamblePolicy: "allow",
    };
  }
  const toolData = collectToolDataFromResults(substantiveResults);
  const quality = assessDataQuality(toolData);
  return selectStrategy(quality, userMessage);
}
