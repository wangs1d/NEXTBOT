/**
 * 渲染场景（scene）契约 —— 结构化回复的唯一扩展点。
 *
 * 背景（2026-11-05 用户拍板）：
 *   「靠 prompt 去描述版式不现实，但日常回复确实需要按某种结构渲染」。
 *   业界做法（扣子 Coze 卡片绑定 / Vercel AI SDK generative UI）一致：
 *   **结构归渲染层，模型只产出数据与语气**。本项目此前把结构写在
 *   synthesis-strategy 的 prompt 里，模型不照做就没有结构——这是根因。
 *
 * 本模块把「一轮回复长什么样」抽象成可注册的场景（scene）：
 *   - detect：这一轮属于哪个场景（工具回执 / 内容信号 / 数据面）
 *   - plan  ：该场景产出的卡、正文形态、契约（只含 schema，不含版式措辞）
 *   - 新增场景 = 写一个 RenderScene 文件 + 在 scenes/index.ts 注册一行，
 *     不改 decide.ts、不改客户端。
 *
 * 场景之间按 priority 竞争；卡按 topic 去重合并（高优先级场景的卡先占位）。
 */

import type { CardSpec, RenderInput, TextForm } from "../types.js";

/** 场景上下文：渲染决策输入 + 调用方注入的数据面 */
export interface SceneContext extends RenderInput {
  /**
   * 场景数据面。键名即场景约定的数据标识（如 `eveningDigest`），
   * 由持有该数据的服务在调用渲染前注入——场景不需要知道数据从哪来。
   */
  payloads?: Record<string, unknown>;
}

/** detect 命中结果 */
export interface SceneMatch {
  reason: string;
}

/** 一个场景的产出计划 */
export interface ScenePlan {
  sceneId: string;
  label: string;
  /** 该场景要建的卡（可为空：纯正文场景） */
  cards: CardSpec[];
  /**
   * 场景强制的正文形态。undefined = 交给 decideBody 的规则链判断，
   * 场景不越权（避免把「该折叠的长文」强行写成 markdown）。
   */
  bodyForm?: TextForm;
  /** 场景对正文的确定性改写（如结构卡契约不通过时剥掉坏块） */
  text?: string;
  /** 场景持有的 prompt 片段：只允许 schema/字段约束，不允许版式措辞 */
  promptFragment?: string;
  /** 人类可读的硬约束（观测/测试用；不进 prompt） */
  constraints?: string[];
  reason: string;
}

/** 一轮渲染的最终计划 */
export interface ScenePlanResult {
  /** 主场景（优先级最高的命中者，决定正文形态与观测口径） */
  primary: string;
  /** 全部命中场景的计划，按优先级降序 */
  matched: ScenePlan[];
  cards: CardSpec[];
  bodyForm?: TextForm;
  text?: string;
  /** 场景 detect/plan 抛异常的清单（故障隔离；随 reason 进出口日志） */
  failures: string[];
  reason: string;
}

/**
 * 场景的产出声明（P3/P4，2026-11-07）——新增形态只改这一处声明，
 * 启动自检与构建期契约都用它与客户端 case、协议白名单交叉校验。
 */
export interface SceneProduces {
  /** 本场景可能产出的 cardType（必须存在于 DISPLAY_EFFECT_TYPES 或显式豁免） */
  cardTypes?: string[];
  /** 本场景可能产出的 [RENDER_AS:*] 形态名（客户端必须有 case） */
  forms?: string[];
  /** 是否整体重写模型正文（流式定稿链需特别处理，见 renderTurn） */
  rewritesText?: boolean;
  /** 生成前要注入模型的内容边界（只写内容约束，不写版式修辞） */
  promptBoundary?: string;
}

/** 生成前计划：只跑 phase=pre 场景的 detect，产出 prompt 边界与观测信号。 */
export interface ScenePrePlanResult {
  matched: string[];
  boundaries: string[];
  rewritesText: boolean;
  failures: string[];
  reason: string;
}

/** 渲染场景定义。新增结构化形态只实现这个接口。 */
export interface RenderScene {
  /** 稳定标识（snake_case；写进日志与测试断言，不复用） */
  id: string;
  /** 观测用中文名 */
  label: string;
  /** 数值大者先匹配；同值按注册顺序 */
  priority: number;
  /**
   * pre  = detect 可在模型生成前运行（**禁止读取 ctx.text**，由 planPre 强制守卫）；
   * post = detect 依赖模型正文（如解析模型写的卡块），只能在出口运行。
   * 缺省 post（保守：未声明的场景不参与生成前决策）。
   */
  phase?: "pre" | "post";
  /** 产出声明：契约生成与交叉校验的唯一事实源 */
  produces?: SceneProduces;
  /** 判断本轮是否属于该场景；null = 不命中 */
  detect(ctx: SceneContext): SceneMatch | null;
  /** 命中后产出计划；返回 null = 放弃（继续尝试下一个场景） */
  plan(ctx: SceneContext, match: SceneMatch): ScenePlan | null;
  /** 契约说明（prompt 组装与文档用；只写 schema/字段，不写版式修辞） */
  contract?: string;
}
