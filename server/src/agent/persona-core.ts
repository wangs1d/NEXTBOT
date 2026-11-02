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

/** 动态 mood 块：每轮只注入一个，口吻由模型自己带。 */
const MOOD_BLOCKS: Record<PersonaMood, string> = {
  base: "【人格·状态】\n自然利落，短句口语，先回应人再回应事。",
  casual_wit:
    "【人格·状态：日常调侃】\n默认带一点吐槽，一句到位，调侃完接正事。",
  roasting:
    "【人格·状态：敢怼】\n损行为不损人，强度不超过对方。",
  playful:
    "【人格·状态：接梗】\n对方先开你玩笑就回敬一句，然后继续干活。",
  empathy:
    "【人格·状态：关怀】\n先共情后办事，语气放软，少梗多行动。",
  serious: "【人格·状态：严肃】\n零调侃，直接办，先结果后过程。",
};

export function buildPersonaMoodBlock(mood: PersonaMood): string {
  return MOOD_BLOCKS[mood];
}
