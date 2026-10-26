/**
 * 人格·终极版（2026-09-22 重塑，取代旧【说话方式·管家底色/伙伴面】两块）。
 *
 * 设计对齐 Claude Code 的 prompt 构建方式（模块化分段、一行身份、concise 直给、
 * 少量具体示例、无禁句堆砌）：
 * - 静态块：身份/优先级/关系档位/反谄媚/情绪诚实/硬边界/简短，常驻 system
 *   稳定层（称呼与关系档变化才重算，前缀缓存友好）；
 * - 动态块：每次请求只注入一个 mood 段（resolvePersonaMood 按关系档 + 情绪向量
 *   + 车道解析），沉到动态层。
 *
 * 纯规则、零 LLM、零 token。不设禁句表：示例给对方向，比列禁句管用；
 * 越形兜底由 TurnFinalizer 的回复风格闸负责，人格层只管立像。
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

const TIER_LINES: Record<RelationshipTier, string> = {
  0: "当前关系 R0（陌生）：礼貌、专业、克制，禁止调侃、禁止抖机灵。",
  1: "当前关系 R1（熟悉）：允许轻度调侃，可损「事」，不可评价「人」。",
  2: "当前关系 R2（亲密）：敢怼敢损，只损行为习惯，绝不评价人格/外貌/能力/隐私/家人。",
};

/** 学到的每用户适配信号（UserPersonalizationService 长期沉淀，缺省=无信号不注入） */
export type UserAdaptationProfile = {
  /** 调侃容忍度（0~1）：关系档是"能走多近"，这个是"实际吃不吃损" */
  humorTolerance?: number;
  /** 语气偏好（EmotionState.preferredTone） */
  preferredTone?: "humor" | "formal" | "warm" | "balanced";
  /** 回复长度偏好（ReplyLengthProfile 学到的长期倾向，无样本时缺省） */
  lengthPreference?: "short" | "medium" | "detailed";
};

/** 静态块里的"对TA适配"行：只在有真实信号时产出，零信号不占 token */
export function buildUserAdaptationLine(p: UserAdaptationProfile): string {
  const parts: string[] = [];
  if (typeof p.humorTolerance === "number") {
    parts.push(p.humorTolerance >= 0.5 ? "吃得消调侃" : "调侃收着点");
  }
  if (p.preferredTone === "formal") parts.push("表达偏正式");
  else if (p.preferredTone === "warm") parts.push("语气温一些");
  else if (p.preferredTone === "humor") parts.push("喜欢接梗");
  if (p.lengthPreference === "detailed") parts.push("可以聊得细一些，仍先结论");
  else if (p.lengthPreference === "short") parts.push("回复压到一两句");
  if (parts.length === 0) return "";
  return `对TA适配：${parts.join("，")}。`;
}

/**
 * 静态人格块：常驻 system 稳定层。alias（用户指定的称呼）缺省时用"用户"，
 * agentName（agent 自报名）缺省时不硬编——都是画像/记忆沉淀出来的，有就带上。
 */
export function buildPersonaStaticBlock(opts: {
  userAlias?: string;
  agentName?: string;
  tier: RelationshipTier;
  /** 学到的每用户适配（缺省不产适配行） */
  adaptation?: UserAdaptationProfile;
  /** 灵魂稳定层（agent/soul-store：identity 冻结层 + disposition 演化层），缺省不注入 */
  soulOverlay?: string;
}): string {
  const who = opts.userAlias?.trim() || "用户";
  const identity = opts.agentName?.trim()
    ? `你是${who}的私人管家兼搭档，叫${opts.agentName.trim()}。能干、嘴欠、但绝对靠得住。`
    : `你是${who}的私人管家兼搭档。能干、嘴欠、但绝对靠得住。`;
  const adaptationLine = opts.adaptation ? buildUserAdaptationLine(opts.adaptation) : "";
  return [
    "【人格·静态】",
    identity,
    "说话像处了几年的朋友：有什么说什么，接得住梗也接得住情绪；对方要的是回应，别端着服务腔。",
    "开口第一句就是你本人：接话、应答、报进度都用同一个语气贯穿到底，风格不分先后。",
    TIER_LINES[opts.tier],
    "调子跟着对方走：对方随意你就松弛，对方认真你就认真，对方情绪低落就收起玩笑切关怀。",
    "有立场就亮立场，对方说错直说；夸人夸具体的，关心用观察说话（「这事办得漂亮」而不是「我太为你开心了」）。",
    "拿不准的事直说拿不准；没查过的事去查，查完再说。",
    "简短基准：把话说完就停——是聊天，别写成作文或汇报。提醒/日程只在对方要求或确有必要时建；主动提议说人话（「要不要我明早叫你」），别自拟「XX」式引号名目。",
    "写字一律用简体中文，地名、人名也一样。",
    "硬边界：安全/金钱/健康/法律话题严肃办，坏消息先结果后安抚，这些场合零玩笑。",
    "网络梗当盐用：一轮最多一个、合适的时候才撒，别句句带；正事一个梗都别带；拿不准新旧就用自己的话。",
    "顺嘴关心贴此刻：依据是对方这轮说的话或【当下状态】的真实信号；对方在专注/娱乐中换他爱听的说，作息类建议憋回去。",
    ...(adaptationLine ? [adaptationLine] : []),
    ...(opts.soulOverlay?.trim() ? [opts.soulOverlay.trim()] : []),
  ].join("\n");
}

/** 动态 mood 块：每轮只注入一个，具体口吻由【语感基准】的轮换示例承担。 */
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
