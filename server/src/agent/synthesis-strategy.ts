import { isDirectFactQuery, isDigestRoundupQuery } from "./direct-fact-query.js";

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

/** 回复策略 */
export type SynthesisStrategy =
  | "framework_attribution" // 高质量数据：结论先行 + 2-4 维度归因
  | "digest_roundup"        // 动态/近况盘点：按主题分组汇总，信息用足
  | "layered_progressive"   // 中等数据：先事实后推断，分层递进
  | "honest_sparse"          // 低质量数据：坦诚说明已知+未知
  | "multi_perspective"      // 矛盾数据：多视角对比
  | "direct_answer"         // 无工具数据：直接回答（纯知识）
  | "photo_delivery"        // 纯图轮：交图即交付，正文一两句话收束
  | "weather_card";          // 天气卡轮：数值由系统卡片展示，正文只给口语建议

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
 * 再复述数据就是双份。真机事故形态：medium 档 layered_progressive 的
 * 「先给出已确认的事实（有数据支撑的部分）」把模型教成
 * 「## 标题 + > 引用 + |项目|数值| 表格」（复述数据当事实层）+ 穿搭建议（推断层）。
 * 与纯图轮同理短路：天气轮不走数据质量分档，正文只保留口语建议。
 */
export const WEATHER_CARD_INSTRUCTION =
  `天气轮：天气/气温/湿度/风速/降水概率这些数值已由系统专用天气卡片展示给用户，正文里不要再出现。` +
  `严禁用 markdown 标题、表格或引用块罗列天气数据，严禁把工具回执的数值抄写成清单。` +
  `严禁向用户展示经纬度坐标数字（如 35.68, 139.77）——坐标仅供工具入参，位置只说城市/区域名，解析不出就不提位置。` +
  `直接用两三句口语给结论和建议（穿什么/要不要带伞/出行提醒），像朋友聊天一样自然收束。`;

/** 有文字检索/抓取结果的工具：出现它们说明本轮是图文混合研究，不按纯图轮处理 */
const TEXT_SEARCH_TOOL_NAMES = new Set([
  "search_web",
  "deep_search",
  "hot_rankings",
  "search_videos",
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
): boolean {
  const okResults = results.filter((r) => r.ok);
  if (!okResults.some((r) => r.toolName === "search_images")) return false;
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
  const isAnalysisQuestion = /为什么|分析|怎么回事|原因|导致|影响|怎么回事|怎么回事|背后|逻辑/i.test(userMessage);
  const directFactQuery = isDirectFactQuery(userMessage);
  const digestRoundup = isDigestRoundupQuery(userMessage);

  /** 动态/近况盘点类：按主题分组、信息用足——对齐「用户要的是一份汇总」的预期 */
  const digestInstruction = (label: string): string =>
    `你${label}检索结果，用户要的是「动态/近况盘点」类汇总。请组织一份信息充分的回答：\n` +
    `1. 开头一两句给出总体印象（如"最近主要围绕X和Y两件事"）\n` +
    `2. 按主题分组展开（如：事件进展 / 新作品 / 日常动态），每组用小标题或自然分段\n` +
    `3. 保留具体细节：日期、数字、人名、作品名、原话——这些是用户最想看的\n` +
    `4. 多条结果讲同一件事时合并为一个条目；不同事件不要遗漏\n` +
    `5. 结尾一句话自然收束；篇幅与信息量匹配，信息多就写充分，不要人为压缩成几句话`;

  let strategy: SynthesisStrategy;
  let instruction: string;

  switch (quality.level) {
    case "empty":
      // 无工具数据：直接回答（纯知识场景）
      strategy = "direct_answer";
      instruction = "";
      break;

    case "high":
      // 高质量数据 + 盘点类问题 → 按主题分组汇总
      if (digestRoundup) {
        strategy = "digest_roundup";
        instruction = digestInstruction(
          `已拿到多来源检索结果（${quality.successCount}个来源，共${quality.totalContentLength}字符），`,
        );
        break;
      }
      // 高质量数据 + 分析类问题 → 框架归因
      if (isAnalysisQuestion) {
        strategy = "framework_attribution";
        instruction =
          `你已通过工具收集到充分的数据（${quality.successCount}个来源，${quality.toolDiversity}种工具）。` +
          `请按以下策略组织回复：\n` +
          `1. 结论先行：第一句话给出核心判断（如"N个因素叠加导致X"），不要先铺事实\n` +
          `2. 归因展开：拆出2-4个原因维度，每个维度用「原因→机制→数据」结构展开\n` +
          `3. 综合改写：用自己的话整合多源信息，不要直接转发任何单一来源的原文\n` +
          `4. 信息密度：合并冗余，只保留最有价值的证据\n` +
          `5. 如果信息有缺口，明确说"已知X未知Y"，不要退缩道歉\n` +
          `6. 禁止把同一结论再换个说法复述一遍`;
      } else {
        // 高质量数据 + 非分析类 → 分层递进
        strategy = "layered_progressive";
        instruction =
          `你已通过工具收集到充分的数据（${quality.successCount}个来源）。` +
          `请按以下策略组织回复：\n` +
          `1. 直接给出核心信息，不要铺垫\n` +
          `2. 如有必要，补充关键细节（数据/时间/来源）\n` +
          `3. 合并多源冗余信息，只保留最有价值的部分\n` +
          `4. 用自然的口语表述，不要罗列工具调用过程\n` +
          `5. ${directFactQuery ? "用户求证的是单一事实：先给明确结论，再给支撑依据，不必展开无关面，也不要做总结性复述" : "信息用足、组织充分（可按主题分节），同一事实不要换句话重复第二遍"}`;
      }
      break;

    case "medium":
      // 中等数据 + 盘点类 → 仍按分组汇总组织，能确认多少整理多少，
      // 不用「推断/待验证」框架把答案写虚
      if (digestRoundup) {
        strategy = "digest_roundup";
        instruction =
          digestInstruction(
            `拿到了部分检索结果（${quality.successCount}个来源，共${quality.totalContentLength}字符），`,
          ) +
          `\n6. 只整理检索结果里能确认的内容，信息不足的部分结尾一句话带过，不要虚构细节填充`;
        break;
      }
      // 中等数据 → 分层递进（先事实后推断）
      strategy = "layered_progressive";
      instruction =
        `你通过工具收集到了部分数据（${quality.successCount}个来源，${quality.totalContentLength}字符）。` +
        `请按以下策略组织回复：\n` +
        `1. 先给出已确认的事实（有数据支撑的部分）\n` +
        `2. 再给出合理推断（基于已有信息的推测，标注是推断）\n` +
        `3. 最后说明待验证点（信息缺口在哪）\n` +
        `4. 不要道歉说"信息不完整"，用"已知X未知Y"替代\n` +
        `5. ${directFactQuery ? "用户求证的是单一事实：先给明确结论，再补关键依据与缺口，不要重复总结" : "禁止把事实层和推断层重复表述两次"}`;
      break;

    case "contradictory":
      // 矛盾数据 → 多视角对比
      strategy = "multi_perspective";
      instruction =
        `你收集到的数据存在矛盾信号（${quality.successCount}个来源）。` +
        `请按以下策略组织回复：\n` +
        `1. 先说明存在哪些不同说法\n` +
        `2. 对比不同来源的观点差异（A说X，B说Y）\n` +
        `3. 分析分歧原因（数据源不同？时间不同？立场不同？）\n` +
        `4. 给出你的判断倾向（如果有足够线索）或标注需要进一步确认`;
      break;

    case "low":
      // 低质量数据 → 坦诚直说
      strategy = "honest_sparse";
      instruction =
        `工具收集到的数据有限（${quality.successCount}个成功，${quality.failureCount}个失败，${quality.totalContentLength}字符）。` +
        `请按以下策略组织回复：\n` +
        `1. 明确说明目前能确定的信息\n` +
        `2. 明确说明未知的信息（用"目前未知X"而非"抱歉搜不到"）\n` +
        `3. 如果能从已有知识给出方向性判断，简述并标注"基于已有知识推断"\n` +
        `4. 不要道歉，不要退缩，不要说"换个角度"\n` +
        `5. 不要为了显得完整而重复同一判断；缺口说明一次就够`; 
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
  // 纯图轮短路（2026-10-06）：搜照片轮的交付是图本身，不走数据质量分档——
  // 否则 medium 档的「先已确认事实/再合理推断/最后待验证点」三段式会教出
  // 「已确认的/能说的/没查到的」盘点正文（真机取证的事故形态）。
  if (isPhotoDeliveryRound(substantiveResults)) {
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
