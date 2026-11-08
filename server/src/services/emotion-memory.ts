// EmotionMemory —— 情感标记统一出入口（P0）
//
// 目标：让「情绪」成为记忆的一等属性，而不是只活在当轮对话状态里。
//   - 写入侧：原文窗口（EpisodicTurn）与长期记忆节点（MemoryNodeRecord.metadata）都打情绪标记；
//   - 检索侧：情绪显著性参与统一排序，情绪相似度作为"触景生情"的检索轴；
//   - 巩固侧：高情绪记忆衰减更慢（见 memory-record-utils.memoryDecayFactor）。
//
// 设计约束：
//   1. 不依赖 MoodInferenceService（2026-11-01 起不再注册），纯规则推断，零 LLM/零 embedding；
//   2. valence 采用 -10..10 的口径（用户可见、可解释），内部打分再归一化到 0..1；
//   3. 所有消费方（gateway / humanLike / memory-cortex / arbitrator）只认本模块的
//      EmotionSignal，避免各处各自维护情绪词表。

/** 统一情绪信号。valence=-10 至暗，0 平静，+10 高光。 */
export type EmotionSignal = {
  /** 情绪效价 -10..10（负=痛苦，正=愉悦） */
  valence: number;
  /** 情绪唤醒度 0..1（越高越强烈/越激动） */
  arousal: number;
  /** 情绪类别标签（含 positive/negative 宽标签 + 具体类别） */
  tags: string[];
  /** 推断置信度 0..1 */
  confidence: number;
  /** 推断来源：lexicon=规则词表；mood=MoodInference；usage=外部写入 */
  source: "lexicon" | "mood" | "usage";
  /** 推断时间（ISO） */
  timestamp?: string;
};

type LexiconEntry = {
  re: RegExp;
  valence: number;
  arousal: number;
  tags: string[];
};

/**
 * 情绪词表。刻意覆盖「高光 / 至暗」而不是只分正负：
 * 里程碑级事件（升职、录取、结婚 / 去世、分手、失业）权重显著高于日常情绪词。
 */
const LEXICON: LexiconEntry[] = [
  // ── 高光 ──
  { re: /升职|加薪|涨薪|录取|拿到offer|offer到手|通过面试|转正|毕业|中奖|结婚|求婚成功|生子|当爸爸|当妈妈/, valence: 8, arousal: 0.85, tags: ["milestone", "positive"] },
  { re: /开心|高兴|快乐|幸福|满足|满意/, valence: 6, arousal: 0.6, tags: ["joy", "positive"] },
  { re: /兴奋|激动|期待|迫不及待|太棒了|太好了/, valence: 7, arousal: 0.85, tags: ["excitement", "positive"] },
  { re: /骄傲|自豪|成就感|被表扬|被认可/, valence: 6, arousal: 0.55, tags: ["pride", "positive"] },
  { re: /喜欢|爱你|爱他|爱她|想念|想他|想她/, valence: 6, arousal: 0.6, tags: ["love", "positive"] },
  { re: /谢谢|感谢|感恩|温暖|安心|放心了|松了一口气/, valence: 4, arousal: 0.35, tags: ["gratitude", "positive"] },
  // ── 至暗 ──
  { re: /去世|离世|走了|葬礼|病逝|分手|离婚|被裁|失业|确诊|重病|住院|手术/, valence: -8, arousal: 0.8, tags: ["milestone", "negative", "grief"] },
  { re: /崩溃|绝望|活不下去|想死|撑不住|彻底失败/, valence: -10, arousal: 0.95, tags: ["crisis", "negative", "sadness"] },
  { re: /难过|伤心|失落|沮丧|委屈|低落|孤独|孤单|哭/, valence: -5, arousal: 0.55, tags: ["sadness", "negative"] },
  { re: /焦虑|担心|紧张|压力|害怕|恐惧|不安|睡不着|失眠/, valence: -6, arousal: 0.75, tags: ["anxiety", "negative"] },
  { re: /生气|愤怒|气死了|烦|烦躁|恼火|讨厌/, valence: -7, arousal: 0.8, tags: ["anger", "negative"] },
  { re: /累|疲惫|心累|精疲力尽|没精神/, valence: -4, arousal: 0.3, tags: ["fatigue", "negative"] },
];

/** 强度修饰词：命中一次即放大情绪幅度。 */
const INTENSIFIER_RE = /非常|特别|超级|十分|极其|太|真的|好|巨|贼/;

/** 否定修饰：把积极词翻转成低落（"不开心""不满意"）。 */
const NEGATED_POSITIVE_RE = /不(?:开心|高兴|快乐|满意|喜欢|想)|没(?:有)?(?:开心|兴趣|精神)/;

/** 单个记忆条目同时出现正负情绪时，极性不确定 → 降低置信度。 */
const MIXED_POLARITY_CONFIDENCE = 0.45;
const SINGLE_POLARITY_CONFIDENCE = 0.7;

function clampValence(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-10, Math.min(10, v));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function uniq(list: string[], max = 8): string[] {
  return [...new Set(list.filter(Boolean))].slice(0, max);
}

/**
 * 规则推断文本情绪（零 LLM）。
 *
 * @param text 用户/记忆原文
 * @param opts.threshold 低于此显著度视为"无明显情绪"（默认 1.5），返回 valence=0 的信号
 */
export function inferEmotionFromText(text: string, opts?: { threshold?: number }): EmotionSignal {
  const raw = typeof text === "string" ? text : "";
  const threshold = opts?.threshold ?? 1.5;
  const timestamp = new Date().toISOString();
  if (!raw.trim()) {
    return { valence: 0, arousal: 0, tags: [], confidence: 0, source: "lexicon", timestamp };
  }

  const intensified = INTENSIFIER_RE.test(raw);
  let valence = 0;
  let arousal = 0;
  const tags: string[] = [];

  for (const entry of LEXICON) {
    if (!entry.re.test(raw)) continue;
    const scale = intensified ? 1.3 : 1.0;
    valence += entry.valence * scale;
    arousal = Math.max(arousal, entry.arousal * (intensified ? 1.1 : 1.0));
    tags.push(...entry.tags);
  }

  // 否定积极词 → 低落（"今天不开心"不能被判成开心）
  if (NEGATED_POSITIVE_RE.test(raw) && valence > 0) {
    valence = -Math.max(3, Math.abs(valence) * 0.7);
    tags.push("sadness", "negative");
  }
  if (/不想活|自伤|结束生命/.test(raw)) {
    valence = -10;
    arousal = 1;
    tags.push("crisis", "negative");
  }

  valence = clampValence(valence);
  arousal = clamp01(arousal);
  const hasPositive = tags.includes("positive");
  const hasNegative = tags.includes("negative");
  const confidentPolarity = hasPositive !== hasNegative;
  const confidence =
    Math.abs(valence) < threshold ? 0.2 : confidentPolarity ? SINGLE_POLARITY_CONFIDENCE : MIXED_POLARITY_CONFIDENCE;

  if (Math.abs(valence) < threshold) {
    return { valence: 0, arousal, tags: uniq(tags), confidence, source: "lexicon", timestamp };
  }

  return {
    valence,
    arousal,
    tags: uniq([...tags, valence >= 0 ? "positive" : "negative"]),
    confidence,
    source: "lexicon",
    timestamp,
  };
}

/** 该信号是否构成"有明显情绪"（用于门控，避免每轮都触发联想/共情）。 */
export function hasEmotionSignal(signal: EmotionSignal | null | undefined, minAbsValence = 3): boolean {
  if (!signal) return false;
  return Math.abs(signal.valence) >= minAbsValence || signal.arousal >= 0.6;
}

/** 情绪显著性 0..1：排序与遗忘衰减共用同一口径。 */
export function emotionalSalience(signal: EmotionSignal | null | undefined): number {
  if (!signal) return 0;
  return clamp01(Math.abs(signal.valence) / 10 * 0.7 + signal.arousal * 0.3);
}

/**
 * 情绪相似度 0..1（"触景生情"检索轴）。
 * - query 无明显情绪 → 恒 0（不改变中性查询的排序）；
 * - 同极性 +0.5，同具体类别 +0.3，效价接近 +0.2。
 */
export function emotionMatchScore(
  query: EmotionSignal | null | undefined,
  item: EmotionSignal | null | undefined,
): number {
  if (!hasEmotionSignal(query, 2) || !item) return 0;
  const qPolarity = query!.valence >= 0 ? "positive" : "negative";
  const iPolarity = item.valence >= 0 ? "positive" : "negative";
  let score = 0;
  if (qPolarity === iPolarity) score += 0.5;
  const qTags = query!.tags.filter((t) => t !== "positive" && t !== "negative");
  const iTags = item.tags.filter((t) => t !== "positive" && t !== "negative");
  if (qTags.length > 0 && iTags.length > 0 && qTags.some((t) => iTags.includes(t))) score += 0.3;
  score += 0.2 * (1 - Math.abs(query!.valence - item.valence) / 20);
  return clamp01(score);
}

/** 情绪徽标（注入 prompt 的稳定前缀）：如「情绪:+8·高光」。 */
export function formatEmotionBadge(signal: EmotionSignal | null | undefined): string | null {
  if (!signal || Math.abs(signal.valence) < 3) return null;
  const label =
    signal.valence >= 9 ? "高光" : signal.valence <= -9 ? "至暗" : signal.valence > 0 ? "积极" : "低落";
  const sign = signal.valence > 0 ? "+" : "";
  return `情绪:${sign}${Math.round(signal.valence)}·${label}`;
}

/**
 * 共情注入行：只有强烈情绪才生成，避免每轮都说教。
 * @param signal 命中的记忆情绪
 * @param opts.scope "memory"=历史记忆（先共情、不主动翻旧伤）；"turn"=用户本轮原话
 */
export function empathyGuidanceLine(
  signal: EmotionSignal | null | undefined,
  opts?: { scope?: "memory" | "turn" },
): string | null {
  if (!hasEmotionSignal(signal, 6)) return null;
  const scope = opts?.scope ?? "memory";
  const negative = signal!.valence < 0;
  const strength = Math.abs(signal!.valence);
  const first =
    scope === "turn"
      ? "用户本轮情绪较强"
      : "本轮关联的历史记忆带有较强情绪";
  const rule = negative
    ? "回应时先共情一句（说出对方的感受即可），不要说教、不要给未经请求的建议；除非用户自己提起，不主动翻旧伤或复述细节。"
    : "回应时可以自然地点出这个好消息/好感受，与用户同频，但不要夸张渲染。";
  const marker = formatEmotionBadge(signal);
  return `记忆情绪提示: ${first}（${marker ?? `情绪:${signal!.valence}`}，强度 ${strength}/10，程序规则推断）。${rule}`;
}

/** 从 MoodInference（sentimentScore -1..1）映射到统一口径。 */
export function emotionFromMoodInference(input: {
  sentimentScore: number;
  confidence?: number;
  emotionTags?: string[];
  agentNote?: string;
  timestamp?: string;
}): EmotionSignal {
  const valence = clampValence((input.sentimentScore ?? 0) * 10);
  return {
    valence,
    arousal: Math.min(1, Math.abs(input.sentimentScore ?? 0)),
    tags: uniq([...(input.emotionTags ?? []), valence >= 0 ? "positive" : "negative"]),
    confidence: clamp01(input.confidence ?? 0.5),
    source: "mood",
    timestamp: input.timestamp,
  };
}

/** 从节点 metadata.emotion 读取（写入侧格式校验；非法返回 null）。 */
export function emotionFromMetadata(metadata: Record<string, unknown> | undefined): EmotionSignal | null {
  const raw = metadata?.emotion;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const valence = typeof obj.valence === "number" ? clampValence(obj.valence) : null;
  if (valence === null) return null;
  return {
    valence,
    arousal: typeof obj.arousal === "number" ? clamp01(obj.arousal) : 0,
    tags: Array.isArray(obj.tags) ? uniq(obj.tags.filter((t): t is string => typeof t === "string")) : [],
    confidence: typeof obj.confidence === "number" ? clamp01(obj.confidence) : 0.5,
    source: "lexicon",
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
  };
}

/** 合并多个情绪信号（同一轮 user+assistant/多条命中）：取绝对值最大者为主，标签并集。 */
export function mergeEmotionSignals(
  signals: Array<EmotionSignal | null | undefined>,
): EmotionSignal | null {
  const valid = signals.filter((s): s is EmotionSignal => !!s && hasEmotionSignal(s, 1));
  if (valid.length === 0) return null;
  const dominant = valid.reduce((a, b) => (Math.abs(b.valence) >= Math.abs(a.valence) ? b : a));
  const avgValence =
    valid.reduce((sum, s) => sum + s.valence, 0) / valid.length;
  return {
    valence: clampValence(Math.abs(dominant.valence) >= Math.abs(avgValence) ? dominant.valence : avgValence),
    arousal: Math.max(...valid.map((s) => s.arousal)),
    tags: uniq(valid.flatMap((s) => s.tags)),
    confidence: Math.max(...valid.map((s) => s.confidence)),
    source: dominant.source,
    timestamp: dominant.timestamp,
  };
}
