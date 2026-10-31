/**
 * AgentResultCard 标记生成器
 *
 * 把 LLM 的小汇报场景输出（对话 + 列表 + 追问）切成：
 *   [前导对话] [AGENT_RESULT_CARD 标记] [追问/结尾]
 * 三段拼接。卡片在中间，前后的对话正文保留。
 *
 * 前端 parser 见 client/flutter_app/lib/core/utils/agent_result_parser.dart
 * 卡片 UI   见 client/flutter_app/lib/features/chat/agent_result_card.dart
 *
 * 协议输出示例：
 * ```
 * 好的，耳机已下单，预计周六送达。
 *
 * [AGENT_RESULT_CARD_START]
 * {"title":"周末行程已为你规划","items":[{"type":"check","text":"周六上午：...勾...新店探店"}],"footer":"需要调整吗？"}
 * [AGENT_RESULT_CARD_END]
 *
 * 需要调整吗？
 * ```
 *
 * 设计要点：
 *   - 整段 ≤300 字，且列表段（连续列表行）长度符合 3-7 条
 *   - 解析失败（拿不到可切列表段）时返回 null，调用方回退到 plain
 *   - LLM 主动声明锚点的升级点：把 `findExtractableCardSegment` 换成锚点识别即可
 */

import { appendFileSync } from "node:fs";

import { LIST_ITEM_RE } from "./render-hint-service.js";
import {
  hasBlockquote,
  routeDisplayEffect,
  scoreDisplayEffects,
  type DisplayRouteInput,
} from "./display-effect-router.js";
import { travelItineraryStore } from "../skills/travel-planning/travel-itinerary-store.js";

/**
 * 路由决策日志：cardType 与评分明细 top-2 落日志（低频：每次上卡一条），
 * 线上误判/漏判可直接对照 content/tool 分数排查，不必复现文本重跑路由。
 */
function logRoutingDecision(
  where: string,
  toolName: string | undefined,
  cardType: string,
  input: DisplayRouteInput,
): void {
  const ranked = [...scoreDisplayEffects(input)]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const top = ranked
    .map(
      (d) =>
        `${d.type || "(generic)"}=${d.score.toFixed(3)}(content=${d.contentScore.toFixed(2)},tool=${d.toolScore.toFixed(2)})`,
    )
    .join(" | ");
  console.log(
    `[DisplayRoute] ${where}: card=${cardType || "(generic)"} tool=${toolName ?? "-"} top: ${top || "none"}`,
  );
  // 线上采集（可选）：设置 DISPLAY_ROUTE_CAPTURE=<jsonl路径> 后，每次路由把
  // 完整输入/输出落 JSONL。console 日志只有 title/footer 摘要、不含 fullText，
  // 事后无法回放管线；这里补全可回放字段，供 scripts/eval-reply-format.ts
  // 的 --from-capture 把真实流量沉淀为黄金集样本。未设置 env 时零开销。
  const capturePath = process.env.DISPLAY_ROUTE_CAPTURE;
  if (capturePath) {
    try {
      appendFileSync(
        capturePath,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          where,
          toolName,
          cardType,
          top: ranked.map((d) => ({ type: d.type, score: d.score })),
          title: input.title,
          items: input.items.map((i) => i.text),
          footer: input.footer,
          fullText: input.fullText,
        })}\n`,
        "utf8",
      );
    } catch {
      // 采集失败不影响主链路
    }
  }
}

/** 列表项类型推断 */
const CHECK_HINT_RE = /已完成|已为你|已帮你|已设置|已创建|已规划|✓|✔|成功/i;
const WARN_HINT_RE = /警告|注意|失败|异常|未完成|pending|⚠|!/i;

/**
 * 由原文行的前导空白推断列表层级：≥2 空格（或任意 tab）视为子步骤；
 * 深嵌（3+ 层）统一按 1 记，前端只消费「一级 / 子步骤」两档。
 */
function inferItemDepth(raw: string): number {
  const m = raw.match(/^(?:[ \t]+)/);
  if (!m) return 0;
  const spaces = (m[0].match(/ /g)?.length ?? 0) + (m[0].match(/\t/g)?.length ?? 0) * 2;
  return spaces >= 2 ? 1 : 0;
}

/** 卡片最大列表条数（超过不切；长清单由 fold_list 折叠卡承接，见 display-effect-router） */
const MAX_CARD_ITEMS = 12;

/** 卡片最小列表条数 */
const MIN_CARD_ITEMS = 3;

/** 图片地址（图片对窗口判定用，与 display-effect-router 同一识别口径） */
const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:[?#]\S*)?/i;

/**
 * 图片对窗口：恰好 2 条且每条都带图片地址（A/B 前后对比、双机位对比）。
 * 这是 compare 滑杆的标志性载荷——媒体证据是硬信号，2 条即可切卡；
 * 普通 2 条文字清单（散文里极常见）仍不算卡片，避免误切。
 */
function isImagePairItems(items: ReadonlyArray<string>): boolean {
  return items.length === 2 && items.every((t) => IMAGE_URL_RE.test(t));
}

interface AgentResultPayload {
  avatar: string;
  avatarStyle: string;
  title: string;
  /** depth：0=一级条目，1=子步骤（由原文缩进推断，前端 steps 卡渲染二级缩进） */
  items: Array<{ type: string; text: string; depth?: number }>;
  footer: string;
  /**
   * 展示效果类型（由 display-effect-router.ts 纯程序路由决定，无 LLM 参与）：
   * weather / schedule / wallet / order / file / search_result / media /
   * compare / timeline / progress / steps / metric / carousel / chips /
   * fold_list / quote；空串=通用列表卡。
   */
  cardType?: string;
  /** 底部抉择按钮（客户端渲染为 AgentActionChoiceCard，点击经 chat.user_action 回传） */
  actions?: Array<{ id: string; label: string; variant: string; payload: Record<string, unknown> }>;
  /** 卡片唯一 ID（点击按钮回传，便于后端定位上下文） */
  cardId?: string;
  /**
   * 语音播报优先级：high=语音端优先朗读结论，low=可跳过次要内容；空串=默认。
   * 供语音输出端（agent.voice.*）决定取舍。
   */
  speak?: string;
  /**
   * 结构化行程数据（仅 travel_itinerary 卡携带）：前端双面板直读渲染，
   * 无需再从 items 文本正则解析。来自 travel.plan-itinerary 工具的结构化结果。
   */
  travelPlan?: unknown;
  /**
   * 前端自动展开标志（目前仅 travel_itinerary 卡使用）：为 true 时前端在本轮
   * chat.assistant_done 实时收到卡片即直接展开双面板，无需用户点按钮；
   * 卡片仍保留在消息里，历史回看可手动重开。仅在 WS 实时完成事件触发，
   * 历史加载不走 done 路径，不会重复弹开。
   */
  autoOpen?: boolean;
}

export interface CardSegment {
  /** 卡片段（不含 marker 外壳） */
  title: string;
  items: string[];
  /** 每条 item 的层级（0=一级，1=子步骤；按原文缩进推断并归一化） */
  depths: number[];
  footer: string;
  /** 卡片在原文本中的起止行号（含前后空行） */
  startLine: number;
  endLine: number;
  /** 标题行行号（用于在 leadingLines 中跳过，避免与卡片标题重复） */
  titleLine: number;
  /** 结尾行行号（用于在 trailingLines 中跳过，避免与卡片 footer 重复） */
  footerLine: number;
}

/**
 * 探测文本中是否存在可切出的列表汇报段。
 * 要求：连续 3-7 条列表行（中间允许至多 1 行非列表短句作为列表标题/说明）
 */
export function findExtractableCardSegment(text: string): CardSegment | null {
  const lines = text.split(/\r?\n/);
  const listLineIdx: number[] = [];
  lines.forEach((raw, i) => {
    if (LIST_ITEM_RE.test(raw.trim())) listLineIdx.push(i);
  });

  if (listLineIdx.length < 2 || listLineIdx.length > MAX_CARD_ITEMS) {
    return null;
  }

  // 找出最长的"连续列表行窗口"，中间允许 ≤1 行非列表短句（≤20 字）作为过渡
  let bestStart = -1;
  let bestEnd = -1;
  let i = 0;
  while (i < listLineIdx.length) {
    let j = i;
    let lastListLine = listLineIdx[i];
    while (j + 1 < listLineIdx.length) {
      const cur = listLineIdx[j];
      const next = listLineIdx[j + 1];
      const gap = next - cur - 1;
      // 连续（gap=0）必然继续
      if (gap === 0) {
        lastListLine = next;
        j++;
        continue;
      }
      // gap=1 且中间那行是短过渡（≤20 字非列表）→ 跳过
      if (gap === 1) {
        const midLine = lines[cur + 1]?.trim() ?? "";
        if (midLine && midLine.length <= 20 && !LIST_ITEM_RE.test(midLine)) {
          lastListLine = next;
          j++;
          continue;
        }
      }
      break;
    }
    const windowLen = j - i + 1;
    const bestLen = bestEnd - bestStart + 1;
    if (windowLen > bestLen) {
      bestStart = i;
      bestEnd = j;
    }
    i = j + 1;
  }

  if (bestStart === -1) return null;

  const startLine = listLineIdx[bestStart];
  const endLine = listLineIdx[bestEnd];

  // 在列表段之前找 title：向前最多 3 行内的非空、非列表短句
  const titleLines: string[] = [];
  let titleLineIdx = -1;
  for (let k = startLine - 1; k >= Math.max(0, startLine - 3); k--) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    titleLines.unshift(ln);
    if (titleLineIdx === -1) titleLineIdx = k;
  }
  // 标题取「离列表最近的引导行」：titleLines 按扫描顺序 unshift 后末位即最近行。
  // 取 [0]（最远行）会把前导对话误当标题、并让真正的引导行凭空消失——
  // 协议示例（文件头）中前导「耳机已下单…」与标题「周末行程已为你规划」必须各归其位。
  const title = titleLines[titleLines.length - 1] ?? "";

  // 在列表段之后找 footer：向后最多 2 行内的非空、非列表短句
  const footerLines: string[] = [];
  let footerLineIdx = -1;
  for (let k = endLine + 1; k < Math.min(lines.length, endLine + 3); k++) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (LIST_ITEM_RE.test(ln)) break;
    if (ln.length > 40) break;
    footerLines.push(ln);
    if (footerLineIdx === -1) footerLineIdx = k;
  }
  const footer = footerLines[0] ?? "";

  // 提取 items 文本（剥前缀），并按原文缩进推断层级（depths）
  const items: string[] = [];
  const depths: number[] = [];
  for (let k = startLine; k <= endLine; k++) {
    const raw = lines[k] ?? "";
    const m = raw.trim().match(LIST_ITEM_RE);
    if (m) {
      items.push(raw.trim().slice(m[0].length).trim());
      depths.push(inferItemDepth(raw));
    }
  }
  // 归一化：把最浅一级对齐到 0，避免整段都是缩进子项时全部落到 1
  const baseDepth = depths.length ? Math.min(...depths) : 0;
  const normDepths = depths.map((d) => d - baseDepth);

  // 2 条窗口：仅图片对（compare 滑杆载荷）放行；普通 2 条文字清单不切卡
  if (items.length < MIN_CARD_ITEMS && !isImagePairItems(items)) return null;

  return {
    title,
    items,
    depths: normDepths,
    footer,
    startLine,
    endLine,
    titleLine: titleLineIdx,
    footerLine: footerLineIdx,
  };
}

/**
 * 卡片「场景」：title/items/footer 三者综合判断的卡片类型。
 * 决定按钮策略——是二元确认、从 items 里挑一个、还是干脆不出按钮。
 *
 * 设计要点：
 *   - 「场景」是结构化的、可解释的，避免靠单一 footer 关键词硬猜
 *   - 不同场景对应不同按钮形态：confirm/pick_from_items/none
 *   - 「好的/不用了」这种通用确认只在真正二元决策时才会出现，且措辞按场景变
 */
type CardScenario =
  | "recap_pick"        // 复盘/回顾卡：footer 问"续上哪个/继续聊哪个"，从 items 派生选项
  | "task_done_review"  // 任务完成卡：footer 问"需要调整/还要改吗"，用任务化措辞
  | "binary_choice"     // 真正的二元选择："要不要/是否/想不想"——派生具体动词对
  | "rhetorical"        // 修辞/寒暄问句："有空/真巧/改天"——不出按钮
  | "no_action";        // 无 footer/无问句——也不出按钮

/** 复盘类标题的提示词（agent 写 recap 卡时常用的开场白） */
const RECAP_TITLE_HINT_RE = /(捋|回顾|复盘|总结|之前聊|昨天|前天|那天|之前问)/;

/** footer 表达"从 items 里挑一个继续" */
const PICK_FROM_ITEMS_RE = /(续上|继续聊|继续|选哪|挑|要哪个|聊哪个|想看|想听|想聊|先看|先聊)/;

/** 任务已完成的标题或 footer 提示词 */
const TASK_DONE_RE = /(已为你|已帮你|已下单|已设置|已创建|已规划|已搞定|已添加|已加入|完成)/;

/** 修辞/寒暄问句——不该出按钮 */
const RHETORICAL_RE = /(有空|改天|真巧|是吗|有意思|好玩|期待|想想看|下次|回头|记得吗|还记得)/;

/** 真正的二元选择信号 */
const BINARY_CHOICE_RE = /(要不要|是否|想不想|愿不愿意|需要吗)/;

/** 任务完成后的"调整/修改"信号 */
const REVIEW_ADJUST_RE = /(需要(调整|修改|改|变|换))|要不要(调|改)|满意吗|可以(吗|么)/;

/**
 * 推断卡片场景。综合 title + items + footer 三者，避免仅凭 footer 一个问号误判。
 */
function detectCardScenario(
  title: string,
  items: Array<{ type: string; text: string }>,
  footer: string,
): CardScenario {
  const t = title || "";
  const f = footer || "";

  // 0. 没 footer 或 footer 不是问句 → 视作陈述，不出按钮
  const endsWithQuestion = /[？?]\s*$|吗\s*$|呢\s*$/.test(f);
  if (!f || !endsWithQuestion) {
    return "no_action";
  }

  // 1. 复盘卡 + 问"续上哪个" → 让用户从 items 选一个
  if (RECAP_TITLE_HINT_RE.test(t) && PICK_FROM_ITEMS_RE.test(f) && items.length >= 2) {
    return "recap_pick";
  }

  // 2. 任务完成 + 问"需要调整" → 任务化二元
  if (TASK_DONE_RE.test(t) || TASK_DONE_RE.test(f)) {
    if (REVIEW_ADJUST_RE.test(f)) return "task_done_review";
  }

  // 3. 修辞/寒暄问句 → 不出按钮
  if (RHETORICAL_RE.test(f) || RHETORICAL_RE.test(t)) {
    return "rhetorical";
  }

  // 4. 真正的二元选择（不要与 PICK_FROM_ITEMS 混）
  if (BINARY_CHOICE_RE.test(f) && !PICK_FROM_ITEMS_RE.test(f)) {
    return "binary_choice";
  }

  // 5. 兜底：有问号但语义不明 → 保守起见不出按钮（避免硬塞"好的/不用了"）
  //    之前在这里塞通用按钮被吐槽「毫无逻辑」，现在改用宁缺毋滥
  return "no_action";
}

/**
 * 从 item 文本中抽出可作按钮的短标签。
 * 规则：取第一个「：或，」之前的短语；去掉前缀词（旅游/科技/新闻 等类目）；截断到 12 字。
 */
function extractItemShortLabel(text: string): string {
  const t = (text || "").trim();
  if (!t) return "（未命名）";
  // 取「：」或第一个「，」「：」前的短语作为核心主题
  const colonIdx = t.search(/[：:]/);
  let head = colonIdx > 0 ? t.slice(0, colonIdx) : t;
  // 进一步取第一个「，」「、」「；」前的短语（更短）
  const shortIdx = head.search(/[，,、；;]/);
  if (shortIdx > 0 && shortIdx < 8) head = head.slice(0, shortIdx);
  // 去掉常见类目前缀
  head = head.replace(/^(旅游|科技|新闻|财经|体育|娱乐|音乐|电影|游戏|购物|美食|健康|教育)/, "").trim();
  // 截断到 12 字
  if (head.length > 12) head = head.slice(0, 12) + "…";
  return head || "（未命名）";
}

interface InferredAction {
  id: string;
  label: string;
  variant: string;
  payload: Record<string, unknown>;
}

/** footer 表达"勾选/多选/挑几个"——触发可选型按钮（variant=select） */
const SELECT_QUESTION_RE = /选哪|勾选|多选|任选|挑几个|要哪些|哪些合适|想要哪些|选几个/i;

/**
 * LLM 实时声明按钮的标记：`[AGENT_ACTIONS] [{"label":"...","variant":"primary"}, ...]`
 * 由 Agent 在生成内容时按当下场景自行决定是否附带；formatter 解析后直接使用，
 * 未附带的场景才回退到规则推断（见 inferActionsForScenario）。
 */
const AGENT_ACTIONS_MARKER_RE = /^\[AGENT_ACTIONS\]\s*(\[[\s\S]*?\])\s*$/m;

/**
 * 从文本中提取 LLM 声明的按钮，并剥离标记行。
 * @returns 解析出的按钮（可能为空数组）与去除标记行后的文本
 */
function extractLlmActions(text: string): {
  actions: InferredAction[];
  cleaned: string;
} {
  const m = text.match(AGENT_ACTIONS_MARKER_RE);
  if (!m) {
    // 即使 `[AGENT_ACTIONS]` 后面 JSON 损坏（缺闭合），也把该行剥离，
    // 避免残留标记污染卡片切分/前导/追问。
    const cleaned = text.replace(/^\[AGENT_ACTIONS\][^\n]*$/m, "").trim();
    return { actions: [], cleaned };
  }
  let actions: InferredAction[] = [];
  try {
    const raw: unknown = JSON.parse(m[1]);
    if (Array.isArray(raw)) {
      actions = raw
        .filter(
          (x): x is Record<string, unknown> =>
            !!x && typeof x === "object" && typeof (x as Record<string, unknown>).label === "string",
        )
        .map((x, i) => {
          const label = String(x.label).trim();
          const variant = String(x.variant ?? "");
          return {
            id: typeof x.id === "string" && x.id ? x.id : `llm_${i}`,
            label,
            variant: ["primary", "secondary", "ghost"].includes(variant) ? variant : "secondary",
            payload: x.payload && typeof x.payload === "object" ? (x.payload as Record<string, unknown>) : {},
          };
        })
        .filter((a) => a.label.length > 0);
    }
  } catch {
    actions = [];
  }
  const cleaned = text.replace(m[0], "").trim();
  return { actions, cleaned };
}

/**
 * 按场景推断按钮。新逻辑：
 *   - recap_pick：每个 item 一个按钮（最多 4 个，多了会挤），加一个"都不聊"逃生
 *   - task_done_review：场景化"就这样"/"调整一下"
 *   - binary_choice：从 footer 抽出动词生成"动词"/"不动词"
 *   - rhetorical / no_action：返回空数组（**不出按钮**）
 */
function inferActionsForScenario(
  title: string,
  items: Array<{ type: string; text: string }>,
  footer: string,
): InferredAction[] {
  const scenario = detectCardScenario(title, items, footer);

  if (scenario === "rhetorical" || scenario === "no_action") {
    return [];
  }

  if (scenario === "recap_pick") {
    const pickable = items.slice(0, 4);
    const out: InferredAction[] = pickable.map((it, idx) => ({
      id: `pick_${idx}`,
      label: extractItemShortLabel(it.text),
      variant: idx === 0 ? "primary" : "secondary",
      payload: { picked: it.text },
    }));
    // 留一个"都不聊"逃生口，避免被强制选择
    out.push({ id: "skip", label: "都不聊", variant: "ghost", payload: {} });
    return out;
  }

  if (scenario === "task_done_review") {
    return [
      { id: "keep", label: "就这样", variant: "primary", payload: {} },
      { id: "adjust", label: "调整一下", variant: "secondary", payload: {} },
    ];
  }

  if (scenario === "binary_choice") {
    // 从 "要不要X" / "想不想X" 抽出动词 X，生成"X" / "不X"
    const m = footer.match(/(?:要不要|想不想|是否|愿不愿意)\s*([一-龥A-Za-z0-9]{1,8})/);
    if (m && m[1]) {
      const verb = m[1];
      return [
        { id: "yes", label: verb, variant: "primary", payload: {} },
        { id: "no", label: `不${verb}`, variant: "secondary", payload: {} },
      ];
    }
    return [
      { id: "yes", label: "要", variant: "primary", payload: {} },
      { id: "no", label: "不要", variant: "secondary", payload: {} },
    ];
  }

  return [];
}

/**
 * 「多选/勾选」类：仅当 title/footer 明确表达"勾选/多选/挑几个/要哪些"且不是修辞时，
 * 注入可选型按钮（variant=select）。
 * 与 inferActionsForScenario 互斥：多选场景优先级更高。
 *
 * 与单选场景的差别：select 模式靠 items 旁的勾选框完成选择，按钮只承担"确认/再想想"，
 * 因此即便 footer 不带问号（标题里写了"挑几个"等），也应触发。
 */
function inferSelectActions(
  title: string,
  items: Array<{ type: string; text: string }>,
  footer: string,
): InferredAction[] {
  if (!SELECT_QUESTION_RE.test(footer) && !SELECT_QUESTION_RE.test(title)) {
    return [];
  }
  // 修辞/无问号场景下不强行出多选
  if (detectCardScenario(title, items, footer) === "rhetorical") {
    return [];
  }
  return [
    { id: "select_confirm", label: "确认选择", variant: "primary", payload: { multiSelect: true } },
    { id: "select_cancel", label: "再想想", variant: "secondary", payload: { multiSelect: true } },
  ];
}

/**
 * 把小汇报场景文本切成「前导 + 卡片标记 + 追问」三段。
 * @param toolName 最近调用的工具名，用于推断专用卡片类型（cardType）
 * @returns 拼接后的字符串；若无法切出卡片返回 null
 */
export function formatAgentResultForChat(
  text: string,
  toolName?: string,
): string | null {
  // 先剥离 LLM 实时声明的按钮标记，其余文本继续走卡片切分
  const { actions: llmActions, cleaned } = extractLlmActions(text?.trim() ?? "");
  if (!cleaned) return null;

  const segment = findExtractableCardSegment(cleaned);
  if (!segment) {
    // 列表段切不出时，尝试 markdown 引用块（> xxx）→ quote 引用强调卡。
    // 纯程序路由：blockquote 是确定性信号，不依赖 LLM 主动声明。
    return formatQuoteResultForChat(cleaned, llmActions);
  }

  const lines = cleaned.split(/\r?\n/);

  // 1) 前导：startLine 之前的所有非空行
  //    跳过已经被卡片消费的 title 行，避免与卡片标题重复显示
  const leadingLines: string[] = [];
  for (let k = 0; k < segment.startLine; k++) {
    if (k === segment.titleLine) continue;
    const ln = lines[k]?.trim() ?? "";
    if (ln) leadingLines.push(ln);
  }

  // 2) 追问：endLine 之后的所有非空行
  //    跳过已经被卡片消费的 footer 行，避免与卡片 footer 重复显示
  const trailingLines: string[] = [];
  for (let k = segment.endLine + 1; k < lines.length; k++) {
    if (k === segment.footerLine) continue;
    const ln = lines[k]?.trim() ?? "";
    if (ln) trailingLines.push(ln);
  }

  // items 类型推断 + 层级透传（depth 供前端 steps 卡渲染二级子步骤）
  const items = segment.items.map((itemText, idx) => {
    let type = "num";
    if (CHECK_HINT_RE.test(itemText)) {
      type = "check";
    } else if (WARN_HINT_RE.test(itemText)) {
      type = "warn";
    }
    return { type, text: itemText, depth: segment.depths[idx] ?? 0 };
  });

  // 顺序编号占比：`1. ` `2、` 前缀会被剥离导致步骤信号丢失，
  // 在剥离前统计原文编号行比例传给路由器（见 display-effect-router 2.5 规则）。
  const rawListLines = lines.slice(segment.startLine, segment.endLine + 1);
  const numberedCount = rawListLines.filter((l) =>
    /^(?:\d+[.)、]\s+)/u.test(l.trim()),
  ).length;
  const numberedItemRatio =
    rawListLines.length > 0 ? numberedCount / rawListLines.length : 0;

  const cardType = routeDisplayEffect({
    toolName,
    title: segment.title,
    items,
    // 原始全文给内容语义路由：即使正文没用列表语法，也能按语义掐出条目评分
    fullText: cleaned,
    footer: segment.footer,
    numberedItemRatio,
  });
  logRoutingDecision("result-card", toolName, cardType, {
    toolName,
    title: segment.title,
    items,
    fullText: cleaned,
    footer: segment.footer,
    numberedItemRatio,
  });
  // 按钮策略优先级：LLM 实时声明 > 多选/勾选 > 场景推断
  // - LLM 声明：Agent 按当下场景实时给出按钮，最贴合实际
  // - 场景推断：仅作为 LLM 未声明时的兜底（见 detectCardScenario 的注释，不再硬塞"好的/不用了"）
  const selectActions = inferSelectActions(segment.title, items, segment.footer);
  const scenarioActions = inferActionsForScenario(segment.title, items, segment.footer);
  const actions = llmActions.length
    ? llmActions
    : selectActions.length
      ? selectActions
      : scenarioActions;

  // 语音播报优先级：追问/结论句（问句或含"建议/注意/总之"）标记 high，语音端优先朗读
  const speak = /[？?]\s*$|吗\s*$|建议|推荐|注意|警告|总之|结论|提醒/i.test(
    `${segment.title} ${segment.footer}`,
  )
    ? "high"
    : "";

  const payload: AgentResultPayload = {
    avatar: "NB",
    avatarStyle: "default",
    title: segment.title,
    items,
    footer: segment.footer,
    cardType,
    actions,
    speak,
    cardId: actions.length > 0 || cardType ? `card_${Date.now()}_${Math.random().toString(36).substr(2, 6)}` : undefined,
  };

  // travel_itinerary 卡：注入结构化行程数据（前端双面板直读，无则前端回退文本解析）
  if (cardType === "travel_itinerary") {
    // 按卡片文本匹配目的地对应快照（并发规划多个目的地时不再串卡），仍限 2 分钟时效
    const snap = travelItineraryStore.findForText(
      `${segment.title ?? ""} ${segment.footer ?? ""}`,
    );
    if (snap && snap.days.length > 0) {
      payload.travelPlan = snap;
    }
    // 2026-09-17 用户需求：行程以「回复末尾的独立规划卡」呈现，不自动弹出
    // 双面板（与 tool-result-processor 的 attachTravelItineraryCard 同口径）
    payload.autoOpen = false;
  }

  const json = JSON.stringify(payload);
  const cardBlock = `[AGENT_RESULT_CARD_START]\n${json}\n[AGENT_RESULT_CARD_END]`;

  const parts: string[] = [];
  if (leadingLines.length) parts.push(leadingLines.join("\n"));
  parts.push(cardBlock);
  if (trailingLines.length) parts.push(trailingLines.join("\n"));

  return parts.join("\n\n");
}

/** 卡片标题候选行：非列表行、非标题引导行（结尾冒号）、长度适中。 */
function validTitleLine(l: string): boolean {
  if (l.length < 2 || l.length > 40) return false;
  if (/[：:]\s*$/.test(l)) return false;
  if (/^[>\-*]/.test(l)) return false;
  return true;
}

/**
 * 把 markdown 引用块（`> xxx`，1-4 连续行）切成 quote 引用强调卡。
 *
 * 纯程序路由：blockquote 是确定性信号（LLM 无需任何声明），适用于
 * 一句话结论 / 金句 / 提醒强调场景。
 *   - title = 引用块剥掉 `>` 后的合并文本；
 *   - footer = 引用块之后 ≤3 行内的非空短句（≤40 字，作来源/补充）；
 *   - 引用块之前的前导行、之后的其余行原样保留。
 * 无引用块（或内容过短）返回 null。
 */
export function formatQuoteResultForChat(
  text: string,
  llmActions: InferredAction[] = [],
): string | null {
  const lines = text.split(/\r?\n/);

  // 找第一段连续引用块
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith(">")) {
      if (start === -1) start = i;
      end = i;
      // 引用块中间允许一行空行（markdown 惯例）
    } else if (start !== -1 && t !== "") {
      break;
    }
  }
  if (start === -1) return null;

  const quoteText = lines
    .slice(start, end + 1)
    .map((l) => l!.trim().replace(/^>\s*/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ");
  // 剥掉包裹引号（「」/“”），卡片自带引号视觉，避免双重引号
  const unquoted = quoteText
    .replace(/^[“”「『]+/, "")
    .replace(/[“”」』]+$/, "")
    .trim();
  if (unquoted.length < 4) return null;

  // footer：引用块之后 ≤3 行内的非空短句
  let footer = "";
  let footerLineIdx = -1;
  for (let k = end + 1; k < Math.min(lines.length, end + 4); k++) {
    const ln = lines[k]?.trim() ?? "";
    if (!ln) continue;
    if (ln.length > 40 || ln.startsWith(">")) break;
    footer = ln;
    footerLineIdx = k;
    break;
  }

  const payload: AgentResultPayload = {
    avatar: "NB",
    avatarStyle: "default",
    title: unquoted,
    items: [],
    footer,
    cardType: "quote",
    actions: llmActions,
    speak: "high",
    cardId: `card_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
  };
  const cardBlock = `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload)}\n[AGENT_RESULT_CARD_END]`;

  const parts: string[] = [];
  const leading = lines
    .slice(0, start)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (leading.length) parts.push(leading.join("\n"));
  parts.push(cardBlock);
  const trailingSkip = footerLineIdx === -1 ? end : footerLineIdx;
  const trailing = lines
    .slice(trailingSkip + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (trailing.length) parts.push(trailing.join("\n"));

  return parts.join("\n\n");
}
