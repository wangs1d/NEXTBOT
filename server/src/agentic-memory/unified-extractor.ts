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
}

export function isMemoryUnifiedExtractEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}

const SYSTEM_PROMPT = [
  "你是记忆理解处理器，一次完成四件事，输出严格 JSON（不要任何其他文字）：",
  "{",
  '"decision":"remember|decay|reject",  // remember=值得长期记住；decay=临时上下文（近期有用、过期即弃）；reject=无价值/寒暄/日常琐事/重复/敏感',
  '"scores":{"persistence":0到1,"frequency":0到1,"emotion":0到1,"impact":0到1,"certainty":0到1},  // 五维重要性评分，逐维独立打分：',
  "  // persistence 持久性=信息是否长期有效：「用户是全栈开发」≈0.9，「今天天气好」≈0.1；",
  "  // frequency 频率=是否反复出现：多次提到的技术栈/习惯≈0.8，首次随口一提≈0.2；",
  "  // emotion 情感强度=用户是否强烈表达：「我非常讨厌X」≈0.9，中性陈述≈0.3；",
  "  // impact 影响范围=会影响多少未来决策/回答：「项目用React」≈0.8，「我喝了咖啡」≈0.1；",
  "  // certainty 确定性=明确陈述还是随口一说：明确陈述≈0.9，猜测/听说/可能/大概≈0.2",
  '"importance":0到1,  // 你的综合判断（系统会按五维加权重算，并据阈值裁决是否值得植入长期库）',
  '"semanticClass":"事实|偏好|计划|承诺|人物|事件|其他",',
  '"memories":["你对这段对话的理解记录（第三人称、自包含、可长期召回；无则空数组）"],',
  "  // memories 必须保留语气与性质（玩笑/粉丝式称呼/比喻/正式），不要剥掉语境输出字面断言：",
  "  // 例：用户说「我老婆是刘浩存」→「用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼）」，",
  "  // 而不是「用户的老婆是刘浩存」",
  '"understandings":[{"topic":"话题词","note":"你对这条内容的理解（第三人称，保留语气与性质判断）","kind":"literal|joke|fandom|figurative|preference|correction|other","confidence":0到1}]',
  "  // 用户关于自身/关系/偏好的值得记住的表达，逐条写理解；topic 用用户原话里的核心称谓（如：老婆|工作|居住地）",
  "  // kind 判断：公众人物/明星被冠以亲属称谓（老婆/老公/女儿…）默认是粉丝式称呼 kind=fandom，",
  "  // note 必须写明「粉丝式称呼，并非真实关系」——除非用户明确表示是真实关系；",
  "  // 玩笑/调侃 kind=joke；比喻夸张 kind=figurative；改口/更正 kind=correction（note 写明从什么改成什么）；",
  "  // 字面陈述（我叫X/我住在X）kind=literal",
  '"facts":[{"field":"档案字段名","value":"确定值","temporal":"current|past|upcoming","eventTime":"时间线索或省略","validFrom":"YYYY-MM-DD 或 YYYY-MM","validTo":"同上或省略","confidence":0到1}]',
  "  // 用户关于自身的字面为真的确定性字段，只收字面陈述（我叫X→称呼:X；我住在X→居住地:X；",
  "  // 我是做后端的→职业:后端开发；我用 TS 和 Python→技术栈:TS/Python）。",
  "  // 【时态铁律】temporal 必填，三态区分：",
  "  //   现状（住/是/在做）→ temporal:current；",
  "  //   过去时态（以前/之前/原来/曾经/过去/那时候/待过/搬走了/小时候）→ temporal:past，",
  "  //   例：「我以前住浙江」→ 居住地:浙江 temporal:past eventTime:以前；",
  "  //   同一句里既有过去又有现在（「我以前在杭州，现在搬来兴义了」）→ 输出两条：",
  "  //   居住地:杭州(past) + 居住地:兴义(current)；",
  "  //   未来才生效的**长期状态变更**（「我下个月搬去成都」「明年换工作去字节」「毕业后去深圳」）",
  "  //   → temporal:upcoming，validFrom 写计划生效日；**它不会覆盖现状，也不算已经发生**。",
  "  //   ⚠️ 临时行程不算状态变更（「周末去上海玩」「下周出差」）→ 不进 facts（属 plan/decay 域）；",
  "  //   只有「居住/工作/身份这类会持续存在的状态要变」才用 upcoming。",
  "  // 【证据铁律】不得把计划写成已发生：用户说「我要搬去成都」只能记 upcoming，",
  "  //   除非他明确说「我已经搬过来了/我到了」才记 current/past。",
  "  // validFrom/validTo 用 ISO（YYYY-MM-DD 或 YYYY-MM），只写用户明确给出的时间，",
  "  // 把「去年」「上个月」按给定的当前时间换算成绝对时间；「至今/现在」→ validTo 省略。",
  "  // 无法确定就省略字段，**不要编日期**。",
  "  // 疑问、玩笑、粉丝式称呼、比喻、假设一律不进 facts（那些只进 understandings）；",
  "  // 例外：agent 给用户起的昵称/小名，用户接受了（没纠正、自然继续对话）也算称呼事实，",
  "  // 例：agent 叫用户「老王」后用户正常回应 → facts 输出 称呼:老王（confidence≈0.6）；",
  "  // 用户表示不喜欢这个称呼则不输出（按更正处理，字段级覆盖由系统完成）。",
  "  // 拿不准是不是字面为真就不输出。用户更正旧信息时 facts 输出新值（字段级覆盖由系统完成）。",
  "  // field 用短字段名（称呼|职业|居住地|技术栈|生日|公司|学历 或其他 ≤6 字字段）；value 是确定短值（≤20 字）。",
  "  // value 必须语义改写成无主语短值（Mem0/ChatGPT 式口径）：抽取时归一，不照抄原句——",
  "  // 「我在兴义」→ 居住地:兴义；「我是做后端的」→ 职业:后端开发；「我叫王铭川」→ 称呼:王铭川；",
  "  // 禁止以「我/我的/我在」开头（第一人称原话进 prompt 会让模型分不清「我」指谁，主语翻转）",
  "  // 用户明确要求忘掉/清除某字段时输出 forget（如「别记我住哪了」→ forget:[\"居住地\"]），",
  "  // 不确定的遗忘请求不输出（拿不准就不删）；forget 与 facts 同轮冲突时以 forget 为准",
  '"forget":["字段名"]  // 仅当用户明确要求忘掉/清除档案字段时输出，无则省略或空数组',
  '"referents":[{"role":"称谓","name":"人名","confidence":0到1}],',
  "  // 用户用角色/亲属称谓指代具体人物时输出映射：「我老婆是刘浩存」→ role:老婆 name:刘浩存；",
  "  // 粉丝式称呼同样输出（如「我老婆最近在哪」指代某明星）——本字段只记录「用户这么指代」，",
  "  // 不断言真实关系；role 用用户原话里的称谓（老婆|老公|女朋友|偶像|儿子，≤12 字），",
  "  // name 是具体人名/专名（≤40 字，能定位到唯一人物；泛指如「我妈」无名字则不输出）；无则空数组",
  '"commitments":[{"text":"承诺内容（第三人称）","committedBy":"user|agent|third_party","deadline":"ISO 8601 或 null","confidence":0到1,"evidence":"原文片段","category":"报价|交付|会面|转账|其他"}],',
  '"corrections":[{"oldClaim":"被纠正的旧陈述","newClaim":"纠正后的新陈述"}]  // 用户明确否认/更正既有信息时才有',
  "}",
  "规则：memories 合并重复信息、拒绝寒暄；",
  "归属铁律：Assistant 话中的「我」指 Agent 自己——Agent 的自述/建议/行为（订了票/推荐了X）绝不进 facts、memories、understandings，它们只记录用户；"
  + "临时行程与安排（下周去上海玩/周末的安排）不进 facts（属 decay/计划域，不是档案）；"
  + "但会改变长期状态的计划（搬家/换工作/换城市）要用 temporal:upcoming 记下来；",
  "裁决基准：持久性与影响范围双低的日常琐事（天气、吃了什么、喝了咖啡、",
  "寒暄问候、今天的心情）必须 reject，绝不允许 remember；今天的安排/临时",
  "事项 decay；只有长期有效且影响未来回答的信息才 remember；",
  "承诺只收真正的承诺（排除意愿/假设/客套）；对话中转述的第三方承诺",
  "（如「老板说下周三前交付」「他说周五前发货」）也是承诺，committedBy=third_party；",
  "deadline 的相对时间（明天/周五/下周三/晚上8点）必须结合输入给出的当前时间",
  "换算为绝对 ISO 8601 时间，无法确定才用 null；",
  "corrections 仅当文本在否定或更正「旧信息」时输出（如「不对，会议改到周三了」），",
  "无法确定旧陈述原文时用最接近的概括。",
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
        messages: Array<{ role: string; content: string }>;
      }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
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
  opts?: { client?: UnifiedLlmClient; model?: string; now?: Date; actorId?: string; sessionId?: string },
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
    const openai = opts?.client ?? new OpenAI({ apiKey, maxRetries: 1 });
    const response = await openai.chat.completions.create({
      model: opts?.model ?? getAgenticMemoryLlmModel(),
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `当前时间：${nowIso}\n\n对话文本：\n${body.slice(0, 8000)}` },
      ],
    });
    const output = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) return null;

    const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
    recordLlmUsageByChars({
      stage: "memory_unified_extract",
      inputChars: body.length,
      outputChars: output.length,
      model: getAgenticMemoryLlmModel(),
      actorId: opts?.actorId,
      sessionId: opts?.sessionId,
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
