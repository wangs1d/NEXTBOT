/**
 * 人格动态层（mood）：每轮按关系档 + 情绪向量 + 车道只解析一个 mood 段，沉动态层。
 * 静态人格正文只有一个来源——agent/SOUL.md（见 soul-store.buildPersonaPrompt）。
 * 这里不再产出任何规则行：引导交给模型本身，程序层只做每轮一次的状态切换。
 */

export type RelationshipTier = 0 | 1 | 2;

export type PersonaMood =
  | "base"
  | "casual_wit"
  | "roasting"
  | "playful"
  | "empathy"
  | "serious";

/** rapport（0~1，UserPersonalizationService.RelationshipState）→ 关系档位 */
export function resolveRelationshipTier(rapport: number | undefined | null): RelationshipTier {
  if (typeof rapport !== "number" || !Number.isFinite(rapport)) return 1;
  if (rapport < 0.3) return 0;
  if (rapport <= 0.6) return 1;
  return 2;
}

/** 对方拿 agent 打趣的轻 cue（回敬一句然后干活，不上升） */
const TEASE_CUE_RE = /(你是不是|就这水平|不行啊|又卡了|翻车了|搞砸了|靠不靠谱|咋回事|离谱)/;

export type PersonaMoodInput = {
  tier: RelationshipTier;
  /** 本轮用户情绪向量（cognitiveEmotion，缺省视为中性） */
  valence?: number;
  arousal?: number;
  /** 任务面交付一律 serious */
  isTaskPlane?: boolean;
  userText?: string;
  /** 学到的调侃容忍度（0~1，UserPersonalizationService），缺省按中性 0.5 */
  humorTolerance?: number;
};

/**
 * 单一 mood 解析（每轮只出一个，互斥不堆砌）：
 * 任务面 > 情绪低落（关怀） > R0（礼貌底色） > 被打趣（接梗） > R2 起劲（敢怼） > 日常调侃。
 * 敢怼档额外受学到的调侃容忍度约束：R2 但对方实际不吃损 → 降回日常调侃。
 */
export function resolvePersonaMood(input: PersonaMoodInput): PersonaMood {
  if (input.isTaskPlane) return "serious";
  if (typeof input.valence === "number" && input.valence < -0.3) return "empathy";
  if (input.tier === 0) return "base";
  if (input.userText && TEASE_CUE_RE.test(input.userText)) return "playful";
  if (
    input.tier === 2 &&
    (input.humorTolerance ?? 0.5) >= 0.5 &&
    (input.arousal ?? 0) > 0.45 &&
    (input.valence ?? 0) > 0
  ) {
    return "roasting";
  }
  return "casual_wit";
}

/**
 * 动态状态块（2026-11-05 用户定调：只给事实，不给行为规则）。
 *
 * 旧版每档都是一条写作指令（「默认带一点吐槽」「零调侃，直接办」）——与 SOUL.md
 * 的说话风格直接打架，且任务面强制 serious 把所有工具轮压成机器人腔。
 * 现在只报**语境事实**（车道/对方情绪/是否被调侃），怎么回应由 soul + 模型自己定。
 */
const MOOD_BLOCKS: Record<PersonaMood, string> = {
  base: "【状态】这轮是普通闲聊。",
  casual_wit: "【状态】这轮是日常闲聊，气氛轻松。",
  roasting: "【状态】气氛热络，对方话里带调侃空间，你们关系熟到可以互损。",
  playful: "【状态】对方在拿你打趣。",
  empathy: "【状态】对方情绪明显偏低。",
  serious: "【状态】这轮是办事/交付语境。",
};

export function buildPersonaMoodBlock(mood: PersonaMood): string {
  return MOOD_BLOCKS[mood];
}
