/**
 * 渲染决策层的数据契约。
 *
 * 一轮回复的「长什么样」只有一个决定者：`decideRender`。
 * 所有信号（业务工具回执、媒体卡、模型自声明、正文结构）都只是它的输入，
 * 不再各自决定形态、也不再互相让位。
 */

/** 一次工具执行的结果状态：成功 / 成功但无可用数据 / 失败 */
export type EffectStatus = "ok" | "empty" | "error";

/** 本轮真实发生过的一次工具执行（直跑回执与 tool-loop 捕获等价） */
export interface TurnEffect {
  tool: string;
  status: EffectStatus;
  result?: Record<string, unknown>;
}

/**
 * 工具载荷自报业务失败（`{ ok: false }`）的判据。
 * 全项目工具用返回 `{ok:false,error}` 表达「跑通了但没拿到数据」，
 * 执行层只报「有没有抛异常」——效果表必须按载荷真话归类。
 */
export function isBusinessFailurePayload(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).ok === false
  );
}

/** 回执 → 效果状态：抛异常或载荷自报失败都算 error，其余 ok。 */
export function effectStatusOf(
  result: unknown,
  threw = false,
): EffectStatus {
  return threw || isBusinessFailurePayload(result) ? "error" : "ok";
}

/**
 * 结构化卡规格。
 *   - card  业务卡（行程/天气/搜索/注册工具/视频），由 apply 建块
 *   - media 照片/视频流（mediaCards 字段承载，文本通道不出块）
 *
 * empty（失败空态警示卡）已整体退役（2026-11-06 用户定稿）：工具失败不再
 * 出「没拿到数据」的孤立警示卡，失败说明一律由正文承担。
 */
export type CardSpec =
  | { kind: "card"; topic: string; payload?: Record<string, unknown> }
  | { kind: "media"; topic: "media" };

/**
 * 正文形态。fold 是唯一的「文档缩略」形态；markdown 即 [RENDER_AS:structured]。
 * 其余为文本派生的结构化形态（列表切卡/引用等）。data_brief 已退役（2026-11-06）。
 */
export type TextForm =
  | "plain"
  | "markdown"
  | "fold"
  | "brief"
  | "result_card"
  | "image_text"
  | "quote";

export interface BodyDecision {
  form: TextForm;
  /** form=fold 时的主题（卡面标题）；判不出主题就不会是 fold */
  subject?: string;
  reason: string;
}

export interface RenderDecision {
  cards: CardSpec[];
  body: BodyDecision;
  reason: string;
  /**
   * 场景对正文的确定性改写（明日预览渲染结果 / 结构卡坏块剥离）。
   * 缺省 = 正文原样；出口必须优先使用它，否则场景改写等于白算。
   */
  text?: string;
  /** 命中的主场景（观测口径：日志/测试断言用） */
  scene?: { id: string; label: string; reason: string };
  /** 场景 detect/plan 故障隔离清单（P1：进出口信封 meta，供恒返回门与告警用） */
  failures?: string[];
}

export interface RenderInput {
  /** 模型正文（已剥内部帧与协议残留） */
  text: string;
  userText?: string;
  /** 最近一次直跑工具名（单工具直跑路径的输入） */
  toolName?: string;
  /** 本轮全部工具执行（直跑 + loop 捕获；含失败/空结果） */
  effects?: TurnEffect[];
  /** 模型自己声明的形态（[RENDER_HINT:]）；是输入之一，不是独立出口 */
  modelHint?: string | null;
  plainTextMode?: boolean;
  /** 本轮已组装的媒体卡数量：>0 时照片是本轮主形态 */
  mediaCardCount?: number;
  /** 会话当前话题；fold 主题的首选来源 */
  activeTopic?: string;
  /** 场景数据面（如 eveningDigest）：由持有数据的服务注入，场景不自己去找 */
  payloads?: Record<string, unknown>;
}
