// Agent Brain Center — 世界模型类型与接口（World Model）
//
// 职责：定义世界模型的核心抽象，让 Agent 具备"基于当前状态预测未来状态"的能力。
// 这是从 ReAct Agent 升级到 Model-Based Agent 的关键一步，也是"接世界模型自动升级"的接入点。
//
// 核心概念：
//   - WorldState：结构化环境状态（融合 BodyState + body.* 信号历史 + UIA/DOM + 任务上下文）
//   - WorldModel：状态转移函数（predict/update/uncertainty）+ 多步模拟（rollout）+ 反事实（imagine）
//   - TransitionSample：(s, a, s') 转移样本，世界模型的学习数据
//
// 设计原则：
//   1. 接口优先：WorldModel 是接口，默认实现为 RuleBasedWorldModel（纯规则预测），
//      未来接入神经网络世界模型时只需实现此接口
//   2. 与 BodyState 复用而非重复：WorldState 内嵌 BodyState + 扩展时间维度和结构化感知
//   3. 渐进式启用：BRAIN_WORLD_MODEL_ENABLED=0 时不实例化，PlannerCortex 回退到原 LLM 一次性 plan
//   4. 不破坏现有链路：WorldModel 是 PlannerCortex 的可选注入子系统，未注入时零影响

import type { BodyState, BodySignal } from "../body/types.js";

// ============================================================
// WorldState — 结构化环境状态
// ============================================================

/**
 * UIA/DOM 结构化感知槽位。
 *
 * 从 body.eye.frame 信号 + VLM 描述 + UIA 快照 + DOM 提取的结构化状态，
 * 作为世界模型的状态输入。不同于 base64 帧数据，这是"已理解的环境状态"。
 */
export interface PerceptualSlot {
  /** 槽位类型：窗口/控件/文本/图像/布局 */
  type: "window" | "control" | "text" | "image" | "layout" | "other";
  /** 槽位标识（如窗口标题、控件 name） */
  label: string;
  /** 槽位内容（如控件文本、图像描述） */
  content: string;
  /** 几何位置（可选，{x, y, w, h}） */
  bbox?: { x: number; y: number; w: number; h: number };
  /** 是否可交互 */
  interactive?: boolean;
}

/**
 * 世界状态：Agent 对当前环境的结构化理解。
 *
 * 融合多源信息：
 *   - bodyState：身体即时状态（电量/位置/负载/疲劳度/情绪）
 *   - recentSignals：最近 N 条 body.* 信号（带时间戳，可重建状态时间序列）
 *   - perceptualSlots：UIA/DOM/VLM 提取的结构化感知槽位
 *   - taskContext：当前任务上下文（来自 WorkingMemoryCortex）
 *   - timestamp：状态采集时间
 *
 * 与 BodyState 的区别：BodyState 是即时聚合（无时间维度），WorldState 是带时间维度的
 * 结构化环境状态，可作为世界模型 predict(state, action) → nextState 的输入。
 */
export interface WorldState {
  /** 采集时间（ISO8601） */
  timestamp: string;
  /** 关联的 actor id */
  actorId?: string;
  /** 身体即时状态（从 BodyGateway.snapshot().state 获取） */
  bodyState?: BodyState;
  /** 最近 N 条 body.* 信号（按时间正序，用于重建状态变化趋势） */
  recentSignals?: BodySignal[];
  /** UIA/DOM/VLM 提取的结构化感知槽位 */
  perceptualSlots?: PerceptualSlot[];
  /** 当前任务上下文摘要（来自 WorkingMemoryCortex） */
  taskContext?: string;
  /** 用户活动状态摘要（来自 AwarenessCortex） */
  userActivity?: string;
  /**
   * 自由扩展字段：世界模型实现可在此存储任意结构化状态向量，
   * 如潜在状态向量 latent_state（未来神经网络世界模型使用）。
   */
  extra?: Record<string, unknown>;
}

// ============================================================
// WorldAction — 世界模型中的动作表示
// ============================================================

/**
 * 世界模型中的动作表示。
 *
 * 与 BodyAction 对齐（tool + args），但加入 source 和预期效果，
 * 便于世界模型在 predict 时考虑动作上下文。
 */
export interface WorldAction {
  /** 工具名（如 "agent_browser.click" / "agent_browser.navigate"） */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 动作来源（如 "planner" / "proaction" / "cognize"） */
  source?: string;
  /** 预期效果摘要（可选，供世界模型预测时参考） */
  expectedEffect?: string;
}

// ============================================================
// TransitionSample — (s, a, s') 转移样本
// ============================================================

/**
 * 状态转移样本：世界模型的学习数据。
 *
 * 每次动作执行后记录 (state_before, action, state_after) 三元组，
 * 世界模型通过对比 predict(state_before, action) 与实际 state_after 来学习。
 *
 * 持久化到 WorldModelTransitionStore（P0-8），供离线训练或在线更新世界模型。
 */
export interface TransitionSample {
  /** 样本 id */
  id: string;
  /** 动作前状态 */
  stateBefore: WorldState;
  /** 执行的动作 */
  action: WorldAction;
  /** 动作后状态 */
  stateAfter: WorldState;
  /** 预测误差（predict vs actual，0=完全准确，1=完全错误） */
  predictionError?: number;
  /** 动作是否成功 */
  success?: boolean;
  /** 采样时间（ISO8601） */
  timestamp: string;
  /** 关联的 actor id */
  actorId?: string;
}

// ============================================================
// WorldModel — 世界模型接口
// ============================================================

/**
 * 预测结果：世界模型对"执行 action 后环境会变成什么样"的预测。
 */
export interface WorldPrediction {
  /** 预测的下一状态 */
  nextState: WorldState;
  /** 预测置信度 0-1 */
  confidence: number;
  /** 预测依据摘要 */
  reasoning: string;
  /** 预测的关键变化点（如 "窗口切换到浏览器" / "文件已创建"） */
  changes?: string[];
}

/**
 * 模拟轨迹：多步前向模拟的结果。
 *
 * rollout(state, actionSequence) 产出每一步的预测状态，
 * 用于 model-based planning（比较多个动作序列的预测结果选最优）。
 */
export interface SimulationTrajectory {
  /** 起始状态 */
  startState: WorldState;
  /** 动作序列 */
  actions: WorldAction[];
  /** 每一步的预测状态（长度 = actions.length） */
  predictedStates: WorldPrediction[];
  /** 轨迹总置信度（各步置信度的几何平均） */
  overallConfidence: number;
  /** 轨迹评估分数（由 selectOptimal 的评估函数产出，越高越好） */
  score?: number;
}

/**
 * 世界模型接口：状态转移函数 + 学习 + 模拟 + 反事实推理。
 *
 * 这是"接世界模型自动升级"的核心接入点。默认实现 RuleBasedWorldModel
 * 使用纯规则预测（如 click → 焦点变化、navigate → 页面加载），
 * 未来接入神经网络世界模型时只需实现此接口并注册到 PlannerCortex。
 *
 * 生命周期：
 *   1. bootstrap 创建 WorldModel 实例（默认 RuleBasedWorldModel 或环境变量指定）
 *   2. PlannerCortex.registerWorldModel(model) 注入
 *   3. plan() 时若 worldModel 已注入，走 model-based rollout；否则回退 LLM 一次性 plan
 *   4. 每次动作执行后，ActionExecutor 调 worldModel.update(state, action, nextState) 学习
 *   5. DMN 空闲时调 worldModel.imagine() 做反事实模拟
 */
export interface WorldModel {
  /**
   * 前向预测：给定当前状态和动作，预测下一状态。
   *
   * @param currentState 当前世界状态
   * @param action 待执行的动作
   * @returns 预测的下一状态 + 置信度 + 推理依据
   */
  predict(currentState: WorldState, action: WorldAction): Promise<WorldPrediction>;

  /**
   * 在线学习：用实际观测到的 (state, action, nextState) 更新世界模型。
   *
   * 默认 RuleBasedWorldModel 只记录 prediction error 到 TransitionStore，
   * 未来神经网络世界模型在此做梯度更新。
   *
   * @param stateBefore 动作前状态
   * @param action 执行的动作
   * @param stateAfter 实际的动作后状态
   * @returns 预测误差（0=完全准确，1=完全错误）
   */
  update(
    stateBefore: WorldState,
    action: WorldAction,
    stateAfter: WorldState,
  ): Promise<number>;

  /**
   * 不确定性估计：给定状态和动作，返回预测的不确定性。
   *
   * 用于 model-based planning 的探索-利用权衡：
   *   - 低不确定性 → 预测可信，可直接选最优动作
   *   - 高不确定性 → 预测不可信，需要探索或回退到 LLM 规划
   *
   * @returns 不确定性 0-1（0=完全确定，1=完全不确定）
   */
  uncertainty(currentState: WorldState, action: WorldAction): Promise<number>;

  /**
   * 多步前向模拟：从起始状态出发，依次执行动作序列，预测每一步的状态。
   *
   * 用于 model-based planning 的 rollout：
   *   1. 生成多个候选动作序列
   *   2. 对每个序列调 rollout 预测轨迹
   *   3. 用评估函数给每条轨迹打分
   *   4. 选最优轨迹的第一个动作执行
   *
   * @param startState 起始状态
   * @param actions 动作序列
   * @returns 模拟轨迹（含每步预测状态和总置信度）
   */
  rollout(
    startState: WorldState,
    actions: WorldAction[],
  ): Promise<SimulationTrajectory>;

  /**
   * 反事实推理：给定假想状态，预测"如果处于这个状态会怎样"。
   *
   * 用于 DMN 空闲时的反事实模拟：
   *   - "如果用户现在回家，我会做什么？"
   *   - "如果刚才点了那个按钮，结果会怎样？"
   *
   * @param hypotheticalState 假想状态
   * @param hypotheticalAction 假想动作（可选，不传则预测状态自身的演化）
   * @returns 预测结果
   */
  imagine(
    hypotheticalState: WorldState,
    hypotheticalAction?: WorldAction,
  ): Promise<WorldPrediction>;
}

// ============================================================
// RuleBasedWorldModel — 默认规则世界模型
// ============================================================

/**
 * 默认规则世界模型：基于工具语义的纯规则预测。
 *
 * 不调 LLM，不训练神经网络。预测逻辑：
 *   - agent_browser.click → 焦点变化（perceptualSlots 更新）
 *   - agent_browser.type → 文本输入（taskContext 更新）
 *   - file_doc.write → 文件创建（success=true）
 *   - code_sandbox.run_python → 代码执行（success=true，changes=["代码已执行"]）
 *   - 其他工具 → 保守预测（confidence=0.3，changes=["环境可能变化"]）
 *
 * update() 只记录 prediction error 到内存（不持久化，持久化由 TransitionStore 负责）。
 * uncertainty() 基于工具是否已知返回 0.2（已知工具）或 0.8（未知工具）。
 * rollout() 依次调 predict() 累积轨迹。
 * imagine() 调 predict()（反事实=假想状态下的预测）。
 *
 * 这是骨架实现，让 PlannerCortex 的 rollout 路径可用。
 * 未来接入真实世界模型时替换为此接口的神经网络实现。
 */
export class RuleBasedWorldModel implements WorldModel {
  private transitionCount = 0;
  private totalError = 0;

  async predict(currentState: WorldState, action: WorldAction): Promise<WorldPrediction> {
    const tool = action.tool;
    const args = action.args;
    const changes: string[] = [];
    let confidence = 0.3;
    const reasoning: string[] = [];

    // 基于工具语义的规则预测
    if (tool.includes("click") || tool.includes("tap")) {
      changes.push("焦点可能变化");
      confidence = 0.5;
      reasoning.push("点击操作通常改变焦点");
    } else if (tool.includes("type") || tool.includes("input") || tool.includes("fill")) {
      changes.push(`文本输入：${typeof args.text === "string" ? args.text.slice(0, 50) : "(未知)"}`);
      confidence = 0.6;
      reasoning.push("文本输入改变输入框内容");
    } else if (tool.includes("navigate") || tool.includes("open")) {
      changes.push(`页面/窗口导航：${typeof args.url === "string" ? args.url.slice(0, 80) : "(未知)"}`);
      confidence = 0.55;
      reasoning.push("导航操作切换页面/窗口");
    } else if (tool.includes("write") || tool.includes("create") || tool.includes("save")) {
      changes.push("文件/资源创建");
      confidence = 0.7;
      reasoning.push("写入/创建操作产出新资源");
    } else if (tool.includes("run") || tool.includes("execute")) {
      changes.push("代码/命令执行");
      confidence = 0.5;
      reasoning.push("执行操作产出结果，但具体内容不可预测");
    } else if (tool.includes("search") || tool.includes("query")) {
      changes.push("信息检索");
      confidence = 0.4;
      reasoning.push("搜索结果不可预测，但操作本身成功率高");
    } else {
      changes.push("环境可能变化");
      confidence = 0.3;
      reasoning.push("未知工具，保守预测");
    }

    // 构造预测的下一状态（基于当前状态 + 变化）
    const nextState: WorldState = {
      ...currentState,
      timestamp: new Date().toISOString(),
      taskContext: changes.join("; "),
      extra: {
        ...currentState.extra,
        lastAction: tool,
        lastActionChanges: changes,
      },
    };

    return {
      nextState,
      confidence,
      reasoning: reasoning.join("; "),
      changes,
    };
  }

  async update(
    stateBefore: WorldState,
    action: WorldAction,
    stateAfter: WorldState,
  ): Promise<number> {
    // 规则世界模型不做梯度更新，只统计 prediction error
    const prediction = await this.predict(stateBefore, action);
    // 简单误差计算：changes 命中率
    const actualChanges = this.detectChanges(stateBefore, stateAfter);
    const predictedChanges = prediction.changes ?? [];
    let hitCount = 0;
    for (const pc of predictedChanges) {
      if (actualChanges.some((ac) => ac.toLowerCase().includes(pc.toLowerCase().slice(0, 10)))) {
        hitCount++;
      }
    }
    const error = predictedChanges.length > 0
      ? 1 - hitCount / predictedChanges.length
      : 0.5;
    this.transitionCount++;
    this.totalError += error;
    return error;
  }

  async uncertainty(_currentState: WorldState, action: WorldAction): Promise<number> {
    // 已知工具类型 → 低不确定性；未知 → 高不确定性
    const knownPatterns = ["click", "type", "navigate", "open", "write", "create", "save", "run", "execute", "search", "query"];
    const isKnown = knownPatterns.some((p) => action.tool.includes(p));
    return isKnown ? 0.2 : 0.8;
  }

  async rollout(startState: WorldState, actions: WorldAction[]): Promise<SimulationTrajectory> {
    const predictedStates: WorldPrediction[] = [];
    let currentState = startState;
    let logConfidence = 0;

    for (const action of actions) {
      const prediction = await this.predict(currentState, action);
      predictedStates.push(prediction);
      currentState = prediction.nextState;
      logConfidence += Math.log(Math.max(0.01, prediction.confidence));
    }

    const overallConfidence = actions.length > 0
      ? Math.exp(logConfidence / actions.length)
      : 1;

    return {
      startState,
      actions,
      predictedStates,
      overallConfidence,
    };
  }

  async imagine(
    hypotheticalState: WorldState,
    hypotheticalAction?: WorldAction,
  ): Promise<WorldPrediction> {
    if (hypotheticalAction) {
      return this.predict(hypotheticalState, hypotheticalAction);
    }
    // 无动作时预测状态自身演化（保守：状态不变）
    return {
      nextState: { ...hypotheticalState, timestamp: new Date().toISOString() },
      confidence: 0.4,
      reasoning: "无动作输入，预测状态保持不变",
      changes: [],
    };
  }

  /** 检测两个状态之间的变化点 */
  private detectChanges(before: WorldState, after: WorldState): string[] {
    const changes: string[] = [];
    if (before.taskContext !== after.taskContext && after.taskContext) {
      changes.push(after.taskContext);
    }
    if (before.bodyState?.currentDevice !== after.bodyState?.currentDevice) {
      changes.push(`设备切换：${before.bodyState?.currentDevice ?? "?"} → ${after.bodyState?.currentDevice ?? "?"}`);
    }
    const beforeSlots = before.perceptualSlots ?? [];
    const afterSlots = after.perceptualSlots ?? [];
    if (beforeSlots.length !== afterSlots.length) {
      changes.push(`感知槽位数变化：${beforeSlots.length} → ${afterSlots.length}`);
    }
    return changes;
  }

  /** 获取统计信息 */
  getStats(): { transitionCount: number; averageError: number } {
    return {
      transitionCount: this.transitionCount,
      averageError: this.transitionCount > 0 ? this.totalError / this.transitionCount : 0,
    };
  }
}

// ============================================================
// 世界模型工厂（配置驱动）
// ============================================================

/**
 * 根据环境变量创建世界模型实例。
 *
 * - BRAIN_WORLD_MODEL_ENABLED=0 → 返回 null（不启用世界模型，PlannerCortex 回退 LLM plan）
 * - BRAIN_WORLD_MODEL_IMPL=rule-based（默认）→ RuleBasedWorldModel
 * - BRAIN_WORLD_MODEL_IMPL=neural → 未来神经网络世界模型（当前未实现，回退 rule-based）
 *
 * bootstrap 装配处：
 *   const worldModel = createWorldModelFromEnv();
 *   if (worldModel) plannerCortex.registerWorldModel(worldModel);
 */
export function createWorldModelFromEnv(): WorldModel | null {
  const enabled = process.env.BRAIN_WORLD_MODEL_ENABLED;
  if (enabled === "0" || enabled === "false" || enabled === "off") {
    return null;
  }
  const impl = (process.env.BRAIN_WORLD_MODEL_IMPL ?? "rule-based").trim().toLowerCase();
  if (impl === "rule-based" || impl === "rule") {
    console.log("[WorldModel] 使用 RuleBasedWorldModel（规则世界模型）");
    return new RuleBasedWorldModel();
  }
  // 未来：neural / world-model 等实现
  console.warn(`[WorldModel] 未识别的 BRAIN_WORLD_MODEL_IMPL="${impl}"，回退 RuleBasedWorldModel`);
  return new RuleBasedWorldModel();
}
