/**
 * 统一结构化抽取器（P1-6，用户决策 2026-09-04）。
 *
 * 高信号写入此前的 LLM 链：decideMemoryWrite（决策）→ Mem0 infer（抽取）→
 * commitment-extractor（承诺识别）——最多 3 次调用，且前两次的输入高度重叠。
 * 本模块合并为**一次调用**，同时产出：
 *   - decision：写入决策（remember/decay/reject，替代 decideMemoryWrite）
 *   - scores：五维重要性评分（持久性/频率/情感强度/影响范围/确定性）——代码侧
 *     加权合成综合分并按阈值闸门裁决，无用的消息（低持久+低影响的日常琐事）
 *     不会被植入长期记忆（防 LLM 单一直觉分手松，见 applyPromotionGate）
 *   - memories：独立可召回的陈述条目（替代 Mem0 infer，落库走 infer:false）
 *   - commitments：承诺识别（含 category，替代 commitment-extractor）
 *   - corrections：用户纠正（"不对，是周二"→ oldClaim/newClaim，驱动账本
 *     supersession + 溯源级联作废，见 bootstrap 钩子）
 *   - understandings：对话理解（理解档案 topic 级 upsert）
 *   - facts：结构化事实（事实库字段级 latest-wins upsert，实时更新用户档案）
 *
 * 失败/无 key 返回 null → 调用方整体回退旧三段路径（渐进降级，不阻塞写入）。
 */

import OpenAI from "openai";

import {
  getAgenticMemoryLlmModel,
  getMemoryPersistenceFloor,
  getMemoryPromoteThreshold,
  getMemoryUselessThreshold,
  resolveAgenticMemoryLlmBaseUrl,
  resolveOpenAiApiKey,
} from "./env.js";
import type { ExtractedCommitment } from "./commitment-board.js";

export interface UnifiedCorrection {
  oldClaim: string;
  newClaim: string;
}

/**
 * 对话理解条目（用户理解档案入参）：不是字面事实归一，而是「我对这句话的理解」
 * ——topic 用用户原话里的核心称谓/主题，note 必须保留语气与性质判断。
 * 例：用户说"我的老婆是刘浩存"（刘浩存为明星）→
 *   { topic: "老婆", kind: "fandom",
 *     note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系" }
 */
export interface UnifiedUnderstanding {
  topic: string;
  note: string;
  kind: "literal" | "joke" | "fandom" | "figurative" | "preference" | "correction" | "other";
  confidence?: number;
}

/**
 * 结构化事实条目（结构化事实库入参）：用户关于自身的**字面为真**的确定性
 * 字段值（称呼/职业/居住地/技术栈…）。与 understandings 的分工：玩笑/粉丝式
 * 称呼/比喻只进 understandings（kind≠literal），绝不进 facts；疑问不算事实。
 * 同字段再次出现时由事实库按 latest-wins 覆盖（搬家/换工作天然更新）。
 */
export interface UnifiedFact {
  /** 短字段名（用户档案字段，如：称呼|职业|居住地|技术栈|生日） */
  field: string;
  /** 确定性短值（"张三"/"全栈开发"/"杭州"） */
  value: string;
  confidence?: number;
  /**
   * 时态（2026-10-19 时间锚定 + 证据门）：
   *   - current：现状陈述（"我现在住兴义"）——参与字段级 latest-wins；
   *   - past：历史陈述（"我以前住浙江"）——只登记历史，**永不覆盖现状**；
   *   - upcoming：未来才生效的**长期状态变更**（"我下个月搬去成都"）——
   *     只登记计划，**不改现状、不算已发生**。到期没有证据也只是降级为
   *     "未确认"，绝不会自动改写成"已经搬了"。
   * 缺省按 current 处理（兼容旧输出）。
   */
  temporal?: "current" | "past" | "upcoming";
  /**
   * 事情发生/生效的时间线索，照抄用户给的时间表达（"2023"、"2021年夏天"、
   * "大学毕业前"）。**不是**说话时间——它是模型区分「何时发生」与「何时得知」
   * 的唯一依据。用户没给时间则省略。
   */
  eventTime?: string;
  /** 结构化有效区间起点（ISO：YYYY-MM-DD 或 YYYY-MM），用于 as-of 查询 */
  validFrom?: string;
  /** 结构化有效区间终点；"至今/现在"则省略 */
  validTo?: string;
}

/**
 * 角色指代映射（2026-09-13）：用户用角色/亲属称谓指代具体人物的映射记录
 * （「我老婆是刘浩存」→ role:老婆 name:刘浩存）。写时结构化——落结构化事实库
 * （field=指代·老婆），realtime 轮的代码侧指代消解 O(1) 直查，不再靠原文频次
 * 挖掘（打地鼠模式）。只记录「用户这么指代」，不断言真实关系（粉丝式称呼同样收）。
 */
export interface UnifiedReferent {
  /** 用户使用的称谓（老婆|老公|女朋友|偶像|儿子…，≤12 字） */
  role: string;
  /** 被指代的具体人名（≤40 字） */
  name: string;
  confidence?: number;
}

/**
 * 五维重要性评分（植入裁决「评分」步，2026-09-07）：LLM 对候选逐维打 0-1 分，
 * 代码侧加权合成综合分并按阈值闸门裁决是否植入长期库——不信任单一直觉分，
 * 确保无用的消息（低持久+低影响的日常琐事）不会被植入长期记忆。
 */
export interface UnifiedScoreDimensions {
  /** 持久性：信息是否长期有效（"用户是全栈开发"≈0.9；"今天天气好"≈0.1） */
  persistence: number;
  /** 频率：是否反复出现（多次提到的技术栈/习惯≈0.8；首次随口一提≈0.2） */
  frequency: number;
  /** 情感强度：用户是否强烈表达（"我非常讨厌X"≈0.9；中性陈述≈0.3） */
  emotion: number;
  /** 影响范围：影响多少未来决策/回答（"项目用React"≈0.8；"我喝了咖啡"≈0.1） */
  impact: number;
  /** 确定性：明确陈述还是随口一说（明确陈述≈0.9；猜测/听说/可能≈0.2） */
  certainty: number;
}

export interface UnifiedExtraction {
  decision: "remember" | "decay" | "reject";
  semanticClass?: string;
  /**
   * 连续重要性分（0-1）：记忆值得长期保留的程度。补齐"只有 highSignal 布尔、
   * 没有连续分数"的缺口——落库进 metadata.importance，检索按分数加权、
   * TTL 按分数豁免（见 retrieval.ts / memory-lifecycle.ts）。缺省由 decision 推导。
   * 五维分存在时代码按加权重算（不采信 LLM 自报值）。
   */
  importance?: number;
  /** 五维评分（LLM 缺失任一维则整体缺省，回退旧单分行为） */
  scores?: UnifiedScoreDimensions;
  /** 独立、自包含、可长期召回的陈述条目（第三人称、保留语气/性质/语境） */
  memories: string[];
  commitments: ExtractedCommitment[];
  corrections: UnifiedCorrection[];
  /** 对话理解（理解档案 topic 级 upsert + 演变历史） */
  understandings: UnifiedUnderstanding[];
  /** 结构化事实（事实库字段级 latest-wins upsert，实时生效） */
  facts: UnifiedFact[];
  /** 用户明确要求忘掉的档案字段（事实库字段级 supersede，历史保留可追溯） */
  forget: string[];
  /** 角色→人名指代映射（结构化事实库 指代·role 字段，realtime 消解直查） */
  referents: UnifiedReferent[];
  /**
   * 画像写入操作（仅在调用方传 `profileContext` 时请求）：
   * 与 user-profile-aggregator 的 ProfileOp 同构，由 aggregator 侧确定性落位，
   * 避免同一条用户消息再跑一次独立的画像抽取 LLM。
   */
  profileOps?: UnifiedProfileOp[];
}

/** 画像 section（与 user-profile-aggregator 的 ProfileSectionKey 保持一致） */
export type UnifiedProfileSection = "basic" | "interest" | "communication" | "note";

/** 画像增量操作（ADD/UPDATE/DELETE + 目标 section + 定位关键词） */
export interface UnifiedProfileOp {
  op: "ADD" | "UPDATE" | "DELETE";
  section: UnifiedProfileSection;
  /** ADD/UPDATE 的新内容（一行，不带 "- " 前缀） */
  line: string;
  /** UPDATE/DELETE 的旧条目定位关键词 */
  match?: string;
}

/**
 * 画像抽取信号（与 user-profile-aggregator 原 EXTRACT_HINT_RE 同一份）：
 * 迁移到本模块，供 ingest 侧判断"这轮是否值得在统一抽取里捎带画像操作"，
 * 避免两个模块各自维护一份正则导致漂移。
 */
export const PROFILE_EXTRACT_HINT_RE =
  /我叫|我的(名字|小名|生日|猫|狗|爱好|工作|职业|公司|学校|专业|老婆|老公|男朋友|女朋友|女儿|儿子|家人|爸妈)|我是(一名|做|搞|学)|住在|在.{0,10}上班|喜欢|讨厌|害怕|最近在(学|练|看|读|准备|找)|养了|要考|结婚|订婚|分手|搬家|换工作|辞职|入职|毕业|记错|搞错|其实|直接一?点|绕弯子|现在(在|不|是)|以后(就|在)|长住|定居|转行|改行|搬(到|去|家)|转让|不干了|改(成|开|做)|换成/;

export function isProfileExtractHint(text: string): boolean {
  return PROFILE_EXTRACT_HINT_RE.test(text ?? "");
}

/**
 * 画像操作输出段：只在调用方传了当前画像时拼进 system prompt。
 * 普通轮不拼——不增加日常对话的输入 token。
 */
const PROFILE_OPS_PROMPT = [

  "",
  "【附加任务·用户画像增量】除上面的 JSON 字段外，再输出 profileOps 数组：",
  '"profileOps":[{"op":"ADD|UPDATE|DELETE","section":"basic|interest|communication|note","line":"一行短句（≤40字，不带 - 前缀）","match":"UPDATE/DELETE 时的旧条目定位关键词"}]',
  "  // section：basic=称呼/所在地/职业；interest=兴趣与习惯；communication=沟通偏好；note=其他长期备注",
  "  // op：ADD=画像中不存在该事实；UPDATE=已有同类条目需修正（match 填旧条目定位关键词）；DELETE=旧条目已被否定或过时",
  "  // 只提取用户明确陈述、对未来对话仍有价值的稳定信息；寒暄/一次性任务/当下情绪/临时行程不提取",
  "  // 疑问不是事实；助手话里的猜测、调侃、求证不是用户事实；与现有画像语义重复的不要重复输出",
  "  // 用户纠正旧信息时必须 DELETE 旧条目再 ADD 新值；身份类字段只在用户明确自述时写入",
  "  // 无值得记录的信息时输出空数组",
].join("\n");

export function isMemoryUnifiedExtractEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}

const SYSTEM_PROMPT = [
  "你是记忆理解处理器，一次完成四件事，输出严格 JSON（不要任何其他文字）：",
  "{",
  '"decision":"remember|decay|reject",  // remember=值得长期记住；decay=临时上下文（近期有用、过期即弃）；reject=寒暄/日常琐事/重复/敏感',
  '"scores":{"persistence":0到1,"frequency":0到1,"emotion":0到1,"impact":0到1,"certainty":0到1},  // 五维独立打分：持久性/复现频率/情感强度/影响范围/确定性（明确陈述≈0.9，猜测/听说/可能≈0.2）',
  '"importance":0到1,  // 你的综合判断（系统会按五维加权重算并裁决）',
  '"semanticClass":"事实|偏好|计划|承诺|人物|事件|其他",',
  '"memories":["第三称、自包含、可长期召回的记录；无则空数组"],',
  "  // 保留语气与性质：「我老婆是刘浩存」→「用户半开玩笑地自称老婆是明星刘浩存（粉丝式称呼）」，而不是「用户的老婆是刘浩存」",
  '"understandings":[{"topic":"话题词（用原话核心称谓，如 老婆|工作|居住地）","note":"第三人称理解，保留语气与性质判断","kind":"literal|joke|fandom|figurative|preference|correction|other","confidence":0到1}]',
  "  // 明星/公众人物被冠亲属称谓（老婆/老公/女儿…）默认 kind=fandom，note 写明「粉丝式称呼，并非真实关系」（除非用户明确是真实关系）；玩笑/调侃=joke；比喻夸张=figurative；改口=correction（写明从什么改成什么）；字面陈述=literal",
  '"facts":[{"field":"档案字段名","value":"确定值","temporal":"current|past|upcoming","eventTime":"时间线索或省略","validFrom":"YYYY-MM-DD 或 YYYY-MM","validTo":"同上或省略","confidence":0到1}]',
  "  // 只收用户自身的字面陈述：我叫X→称呼:X；我住X→居住地:X；我是做后端的→职业:后端开发；我用TS和Python→技术栈:TS/Python",
  "  // 【时态铁律】temporal 必填：现状（住/是/在做）→current；以前/之前/曾经/小时候/搬走了→past（「我以前住浙江」→居住地:浙江,past,eventTime:以前）；同一句含过去与现在（「以前在杭州，现在搬来兴义了」）→两条：杭州/past + 兴义/current；未来长期状态变更（下月搬去成都/明年换工作/毕业后去深圳）→upcoming + validFrom，不算已发生、不覆盖现状；临时行程（周末去上海玩/下周出差）不进 facts（属 plan/decay）",
  "  // 【证据铁律】计划不得写成已发生：「我要搬去成都」只能 upcoming，除非「我已经搬过来了/我到了」；validFrom/validTo 只写用户明确给出的时间，把去年/上个月按给定当前时间换算成绝对时间，至今→省略 validTo，无法确定就省略，不要编日期",
  "  // 疑问/玩笑/粉丝式称呼/比喻/假设不进 facts（只进 understandings）；例外：Agent 给用户起昵称且用户接受（没纠正、自然继续）→ 称呼:X，confidence≈0.6，用户表示不喜欢则不输出",
  "  // field 用 ≤6 字短字段名（称呼|职业|居住地|技术栈|生日|公司|学历…），value ≤20 字并改写成无主语短值（我在兴义→居住地:兴义），禁止以「我/我的/我在」开头；用户更正旧信息时输出新值（字段级覆盖由系统完成）",
  '"forget":["字段名"],  // 仅用户明确要求忘掉/清除档案字段时输出（「别记我住哪了」→["居住地"]），拿不准就不删；与 facts 同轮冲突时以 forget 为准',
  '"referents":[{"role":"称谓","name":"人名","confidence":0到1}],',
  "  // 用户用角色/亲属称谓指代具体人物：「我老婆是刘浩存」→ role:老婆 name:刘浩存；粉丝式称呼同样输出——只记录「用户这么指代」，不断言真实关系；role 用原话称谓（≤12 字），name 是能唯一定位的专名/人名（≤40 字，泛指如「我妈」不输出）；无则空数组",
  '"commitments":[{"text":"承诺内容（第三人称）","committedBy":"user|agent|third_party","deadline":"ISO 8601 或 null","confidence":0到1,"evidence":"原文片段","category":"报价|交付|会面|转账|其他"}],',
  '"corrections":[{"oldClaim":"被纠正的旧陈述","newClaim":"纠正后的新陈述"}]  // 用户明确否认/更正既有信息时才有',
  "}",
  "规则：memories 合并重复信息、拒绝寒暄；",
  "归属铁律：Assistant 话中的「我」指 Agent——Agent 的自述/建议/行为（订了票/推荐了X）绝不进 facts、memories、understandings，它们只记录用户；",
  "裁决基准：持久性与影响范围双低的琐事（天气/吃了什么/喝咖啡/寒暄/今天心情）必须 reject；今天的安排/临时事项 decay；只有长期有效且影响未来回答的信息才 remember；",
  "承诺只收真正的承诺（排除意愿/假设/客套）；转述的第三方承诺（「老板说下周三前交付」）也算，committedBy=third_party；deadline 的相对时间（明天/周五/晚上8点）必须结合输入的当前时间换算为绝对 ISO，无法确定才 null；",
  "corrections 仅在否定/更正旧信息时输出（「不对，会议改到周三了」），旧陈述原文不确定时用最接近的概括。",
].join("\n");

interface RawUnified {
  decision?: unknown;
  semanticClass?: unknown;
  importance?: unknown;
  scores?: unknown;
  memories?: unknown;
  commitments?: unknown;
  corrections?: unknown;
  understandings?: unknown;
  facts?: unknown;
  forget?: unknown;
  referents?: unknown;
  profileOps?: unknown;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .slice(0, 8);
}

/** 从 LLM 输出剥 JSON（容忍 ``` 围栏与前后杂文；导出供测试） */
export function parseJsonObject(output: string): RawUnified | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : output;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as RawUnified;
  } catch {
    return null;
  }
}

/** 导出供测试：结构规范化（决策校验/承诺字段/纠正项） */
export function normalize(raw: RawUnified): UnifiedExtraction | null {
  const decision =
    raw.decision === "remember" || raw.decision === "decay" || raw.decision === "reject"
      ? raw.decision
      : null;
  if (!decision) return null;

  const commitments = Array.isArray(raw.commitments)
    ? (raw.commitments as Array<Record<string, unknown>>)
        .map((c) => {
          const text = typeof c.text === "string" ? c.text.trim() : "";
          const committedBy =
            c.committedBy === "user" || c.committedBy === "agent" || c.committedBy === "third_party"
              ? c.committedBy
              : null;
          const evidence = typeof c.evidence === "string" ? c.evidence.trim() : "";
          const conf = Number(c.confidence);
          if (!text || !committedBy || !evidence) return null;
          let deadline: string | null = null;
          if (typeof c.deadline === "string" && c.deadline.trim() && !/^null$/i.test(c.deadline.trim())) {
            const ts = Date.parse(c.deadline);
            if (Number.isFinite(ts)) deadline = new Date(ts).toISOString();
          }
          return {
            text,
            committedBy,
            deadline,
            confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
            evidence,
            ...(typeof c.category === "string" && c.category.trim() ? { category: c.category.trim() } : {}),
          } as ExtractedCommitment;
        })
        .filter((c): c is ExtractedCommitment => c !== null)
        .slice(0, 5)
    : [];

  const corrections = Array.isArray(raw.corrections)
    ? (raw.corrections as Array<Record<string, unknown>>)
        .map((c) => {
          const oldClaim = typeof c.oldClaim === "string" ? c.oldClaim.trim() : "";
          const newClaim = typeof c.newClaim === "string" ? c.newClaim.trim() : "";
          return oldClaim && newClaim ? { oldClaim, newClaim } : null;
        })
        .filter((c): c is UnifiedCorrection => c !== null)
        .slice(0, 3)
    : [];

  const understandings = Array.isArray(raw.understandings)
    ? (raw.understandings as Array<Record<string, unknown>>)
        .map((u) => {
          const topic = typeof u.topic === "string" ? u.topic.trim() : "";
          const note = typeof u.note === "string" ? u.note.trim() : "";
          if (!topic || !note) return null;
          // 落库守卫（2026-10-20）：疑问句不是「理解」，别把用户的提问当事实沉淀。
          if (/[？?]\s*$/.test(note)) return null;
          const conf = Number(u.confidence);
          return {
            topic,
            note,
            kind:
              typeof u.kind === "string" &&
              ["literal", "joke", "fandom", "figurative", "preference", "correction", "other"].includes(u.kind)
                ? u.kind
                : "other",
            ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
          } as UnifiedUnderstanding;
        })
        .filter((u): u is UnifiedUnderstanding => u !== null)
        .slice(0, 6)
    : [];

  const facts = Array.isArray(raw.facts)
    ? (raw.facts as Array<Record<string, unknown>>)
        .map((f) => {
          const field = typeof f.field === "string" ? f.field.trim() : "";
          const value = typeof f.value === "string" ? f.value.trim() : "";
          if (!field || !value) return null;
          // 落库守卫（2026-10-20）：与 prompt「value 必须语义改写成无主语短值」的
          // 约定一致，但从"靠模型自觉"落成确定性兜底——第一人称主语（会让 prompt
          // 分不清「我」指谁）、含问号、超 20 字的都不是确定的档案字段值。
          if (/^(我|我的|我在)/.test(value) || /[？?]/.test(value) || value.length > 20) return null;
          const conf = Number(f.confidence);
          // 时态：只认 past/upcoming/current 三个字面值；其余（含缺失）按现状
          // 处理——兼容旧模型输出，同时不因偶发脏值把现状误判成历史/计划。
          const rawTemporal = typeof f.temporal === "string" ? f.temporal.trim().toLowerCase() : "";
          const temporal =
            rawTemporal === "past"
              ? ("past" as const)
              : rawTemporal === "upcoming"
                ? ("upcoming" as const)
                : ("current" as const);
          const rawEvent = typeof f.eventTime === "string" ? f.eventTime.trim() : "";
          const eventTime =
            rawEvent && !/^(null|undefined|none|未知)$/i.test(rawEvent)
              ? rawEvent.slice(0, 40)
              : "";
          // 结构化区间：只接受能解析成 ISO 前缀的字符串（YYYY / YYYY-MM / YYYY-MM-DD）；
          // 解析不了的丢弃——不把"大学毕业前"塞进一个日期字段里。
          const isoPoint = (v: unknown): string => {
            if (typeof v !== "string") return "";
            const t = v.trim();
            return /^\d{4}(?:[-/.]\d{1,2}){0,2}$/.test(t) ? t.slice(0, 10) : "";
          };
          const validFrom = isoPoint(f.validFrom);
          const validTo = isoPoint(f.validTo);
          return {
            field,
            value,
            temporal,
            ...(eventTime ? { eventTime } : {}),
            ...(validFrom ? { validFrom } : {}),
            ...(validTo ? { validTo } : {}),
            ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
          } as UnifiedFact;
        })
        .filter((f): f is UnifiedFact => f !== null)
        .slice(0, 6)
    : [];

  // 角色→人名指代映射（写时结构化，realtime 消解 O(1) 直查的来源）
  const referents = Array.isArray(raw.referents)
    ? (raw.referents as Array<Record<string, unknown>>)
        .map((r) => {
          const role = typeof r.role === "string" ? r.role.trim() : "";
          const name = typeof r.name === "string" ? r.name.trim() : "";
          if (!role || role.length > 12 || !name || name.length > 40) return null;
          const conf = Number(r.confidence);
          return {
            role,
            name,
            ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
          } as UnifiedReferent;
        })
        .filter((r): r is UnifiedReferent => r !== null)
        .slice(0, 5)
    : [];

  // 字段级遗忘（Mem0 DELETE 语义）：只收用户明确要求的「忘掉X」，字段名限长。
  // 不走 asStringArray（其 ≥4 字过滤会误杀「称呼/生日」等 2-3 字段名）。
  // forget 不随 reject 丢弃——「别记我家在哪了」是动作指令不是记忆，常被判
  // reject（无价值琐事），但遗忘恰恰要在这轮执行
  const forget = !Array.isArray(raw.forget)
    ? []
    : (raw.forget as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim().slice(0, 16))
        .filter(Boolean)
        .slice(0, 6);

  const scores = parseScores(raw.scores);

  // 画像增量操作（仅在请求画像任务时出现）：严格字段校验，非法项丢弃。
  const profileOps: UnifiedProfileOp[] = Array.isArray(raw.profileOps)
    ? (raw.profileOps as unknown[])
        .map((item): UnifiedProfileOp | null => {
          if (!item || typeof item !== "object") return null;
          const o = item as Record<string, unknown>;
          const op = o.op === "ADD" || o.op === "UPDATE" || o.op === "DELETE" ? o.op : null;
          const section =
            o.section === "basic" ||
            o.section === "interest" ||
            o.section === "communication" ||
            o.section === "note"
              ? o.section
              : null;
          const line = typeof o.line === "string" ? o.line.trim().slice(0, 80) : "";
          if (!op || !section) return null;
          if (op !== "DELETE" && !line) return null;
          const match = typeof o.match === "string" ? o.match.trim().slice(0, 60) : "";
          if (op !== "ADD" && !match) return null;
          return { op, section, line, ...(match ? { match } : {}) };
        })
        .filter((o): o is UnifiedProfileOp => o !== null)
        .slice(0, 8)
    : [];

  return applyPromotionGate({
    decision,
    ...(typeof raw.semanticClass === "string" ? { semanticClass: raw.semanticClass } : {}),
    importance: clampImportance(raw.importance, decision),
    ...(scores ? { scores } : {}),
    memories: decision === "reject" ? [] : asStringArray(raw.memories),
    commitments,
    corrections,
    understandings,
    facts,
    forget,
    referents,
    ...(profileOps.length > 0 ? { profileOps } : {}),
  });
}

/** 五维权重：持久性 > 影响范围 > 确定性 > 情感强度 > 频率（频率在单段文本里最不可观测） */
const SCORE_WEIGHTS: Array<{ key: keyof UnifiedScoreDimensions; weight: number }> = [
  { key: "persistence", weight: 0.3 },
  { key: "impact", weight: 0.25 },
  { key: "certainty", weight: 0.2 },
  { key: "emotion", weight: 0.15 },
  { key: "frequency", weight: 0.1 },
];

/** 五维加权综合分（0-1）——植入裁决与落库 importance 的唯一依据 */
export function compositeImportance(scores: UnifiedScoreDimensions): number {
  let total = 0;
  for (const { key, weight } of SCORE_WEIGHTS) {
    total += scores[key] * weight;
  }
  return Math.max(0, Math.min(1, total));
}

/** 解析五维分：任一维缺失/非法即视为整体缺失（回退旧的单分行为，兼容旧输出） */
function parseScores(raw: unknown): UnifiedScoreDimensions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: Partial<UnifiedScoreDimensions> = {};
  for (const { key } of SCORE_WEIGHTS) {
    const num = Number(obj[key]);
    if (!Number.isFinite(num)) return null;
    out[key] = Math.max(0, Math.min(1, num));
  }
  return out as UnifiedScoreDimensions;
}

/**
 * 植入闸门（确定性代码裁决，防 LLM 手松把无用消息写进长期库）：
 *   - remember：综合分 < 无用线 → reject（连短期缓冲都不进）；
 *     综合分 < 植入线 或 持久性 < 下限 → decay（转瞬即逝的内容最多临时保留）；
 *   - decay：综合分 < 无用线 → reject（纯噪声不落库）；
 *   - reject：维持原判（敏感/重复不因高分翻案），仅把分数校准为综合分。
 * 无五维分（旧模型输出/旧测试夹具）时原样返回，行为与旧版完全一致。
 */
function applyPromotionGate(e: UnifiedExtraction): UnifiedExtraction {
  if (!e.scores) return e;
  const composite = compositeImportance(e.scores);
  const useless = getMemoryUselessThreshold();
  if (e.decision === "reject") return { ...e, importance: composite };
  if (composite < useless) {
    return { ...e, decision: "reject", importance: composite, memories: [] };
  }
  if (e.decision === "remember") {
    const durableEnough =
      composite >= getMemoryPromoteThreshold() &&
      e.scores.persistence >= getMemoryPersistenceFloor();
    if (!durableEnough) return { ...e, decision: "decay", importance: composite };
  }
  return { ...e, importance: composite };
}

/**
 * importance 归一：LLM 缺失/非法时按 decision 推导缺省分
 * （remember=0.7 / decay=0.3），保证落库分数连续可比。
 */
function clampImportance(raw: unknown, decision: "remember" | "decay" | "reject"): number {
  const num = Number(raw);
  if (Number.isFinite(num)) return Math.max(0, Math.min(1, num));
  return decision === "remember" ? 0.7 : 0.3;
}

/** 最小 LLM 客户端外观（测试注入 fake；生产传 OpenAI 实例） */
export interface UnifiedLlmClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        temperature: number;
        /** json_object 约束（2026-10-22）；fake 实现可忽略该字段 */
        response_format?: { type: "json_object" };
        messages: Array<{ role: string; content: string }>;
      }): Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

/**
 * 单次 LLM 完成写入决策 + 记忆抽取 + 承诺识别 + 纠正识别。
 * 任何失败返回 null（调用方回退旧路径），绝不抛错、绝不阻塞写入主链路。
 * 4 字下限为纯卫生闸（挡"好的/哈哈"）：口语承诺可以很短（"明天发你"），
 * 路由不看词表——识别交给 LLM。
 */
export async function extractUnified(
  text: string,
  opts?: {
    client?: UnifiedLlmClient;
    model?: string;
    now?: Date;
    actorId?: string;
    sessionId?: string;
    /**
     * 画像上下文：传入后同一次调用捎带 profileOps（当前画像 + 本轮对话交给同一 LLM）。
     * 不传则不拼画像段，普通轮输入体积不变。
     */
    profileContext?: { currentProfile: string };
  },
): Promise<UnifiedExtraction | null> {
  const body = text.trim();
  if (!body || body.length < 4) return null;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey && !opts?.client) return null;
  const now = opts?.now ?? new Date();
  // 本地时区 ISO（+08:00 等）：相对时间换算要按用户墙钟，UTC 会差一天
  const tzMin = -now.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? "+" : "-";
  const tzStr = `${tzSign}${String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, "0")}:${String(Math.abs(tzMin) % 60).padStart(2, "0")}`;
  const nowIso = new Date(now.getTime() - tzMin * 60_000).toISOString().replace("Z", tzStr);

  try {
    const openai =
      opts?.client ??
      new OpenAI({ apiKey, baseURL: resolveAgenticMemoryLlmBaseUrl(), maxRetries: 1 });
    // 画像任务仅在调用方显式提供当前画像时拼接，普通轮 system 不变。
    const profileCtx = opts?.profileContext;
    const systemContent = profileCtx ? `${SYSTEM_PROMPT}\n${PROFILE_OPS_PROMPT}` : SYSTEM_PROMPT;
    const userContent = profileCtx
      ? `当前时间：${nowIso}\n\n【当前用户画像】\n${profileCtx.currentProfile.trim() || "（空）"}\n\n对话文本：\n${body.slice(0, 8000)}`
      : `当前时间：${nowIso}\n\n对话文本：\n${body.slice(0, 8000)}`;
    const model = opts?.model ?? getAgenticMemoryLlmModel();
    // json_object 约束（2026-10-22）：主路径 OpenAI 兼容端普遍支持；个别 provider
    // 不支持时按 400 降级重试一次（只丢格式约束，不丢抽取任务）。
    let response: {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      response = await openai.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
      });
    } catch (fmtErr) {
      const msg = fmtErr instanceof Error ? fmtErr.message : String(fmtErr);
      if (/400|response_format|json_object/i.test(msg)) {
        response = await openai.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
          ],
        });
      } else {
        throw fmtErr;
      }
    }
    const output = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) return null;

    const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
    recordLlmUsageByChars({
      stage: "memory_unified_extract",
      // 口径修复（2026-10-21）：此前只记用户文本（3~23 tok），漏掉 system prompt
      // 与模板，导致"记忆抽取很便宜"的错误判断。这里记录真实发往 API 的全部字符。
      inputChars: systemContent.length + userContent.length,
      outputChars: output.length,
      model: getAgenticMemoryLlmModel(),
      actorId: opts?.actorId,
      sessionId: opts?.sessionId,
      // 真 usage 优先（2026-10-22）：非流式调用天然带 usage，有真值不再按字符估算
      ...(response.usage
        ? {
            apiPromptTokens: response.usage.prompt_tokens,
            apiCompletionTokens: response.usage.completion_tokens,
          }
        : {}),
    });

    return normalize(parseJsonObject(output) ?? {});
  } catch (err) {
    console.warn(
      "[unified-extractor] 抽取失败（回退旧路径）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
