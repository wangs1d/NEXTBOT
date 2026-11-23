/**
 * Hook 总线 — 类型定义
 *
 * Hook 是"业务域事件"的统一抽象。新功能只需 emit 一个 hook，框架会自动：
 * 1. 记录到事件历史（环形缓冲）
 * 2. 推送到已注册的下游订阅者（默认：WebhookService）
 * 3. 推送到所有匹配事件类型白名单的 Webhook 端点
 *
 * 新功能接入零成本：不需要知道 WebhookService 的存在，
 * 也不需要在 bootstrap 里手动 wire 任何东西。
 *
 * ⚠️ 事件类型枚举是项目内单一事实来源，编译时强类型校验。
 * 新增事件类型必须先在此枚举中追加，业务代码才能 emit。
 */

/** Agent 可对外暴露的所有内置事件类型 */
export type WebhookEventType =
  | "agent.online"        // Agent 服务启动完成，准备就绪
  | "agent.offline"       // Agent 服务即将关闭
  | "agent.error"         // Agent 运行时发生未捕获错误
  | "agent.message_sent"  // Agent 向用户发送了消息
  | "agent.message_received" // Agent 收到用户消息
  | "agent.task_started"  // Agent 开始执行任务
  | "agent.task_completed" // Agent 任务执行完成
  | "agent.task_failed"   // Agent 任务执行失败
  | "agent.tool_called"   // Agent 调用了工具
  | "tool.executed"       // 工具执行成功（Task 16 消费管家：消费类工具成功后 emit，payload 含 toolName/args 摘要/result 摘要/actorId/timestamp）
  | "schedule.reminder_fired" // 日程提醒触发
  | "life.signal"         // 生命信号产生
  // ─── 主动触达闭环（2026-11-23 M1）───
  | "proactive.outcome"   // 一次主动触达有了结果（accepted/dismissed/snoozed/replied/ignored/viewed）：
                          // outcome-store 落库后由管道统一发出，节律/槽位/触点计划等下游 subscribeType 接入，
                          // 不再各自监听各自的回调。payload: deliveryId/kind/outcome/channel/tier/topic/surface
  // ─── 监控/价格/数据 信号事件（外部系统接入价格/数据 webhook 后触发）───
  | "market.position_snapshot"   // 持仓快照（价格/盈亏/波动率）
  | "market.anomaly"             // 价格/成交量异动
  | "data.threshold_breach"      // 通用数据阈值突破
  | "data.source_heartbeat"      // 外部数据源心跳/在线状态
  // ─── Brain Center 神经解剖分区事件 ───
  | "sensory.listen"           // 感官皮层：识别到语音输入
  | "sensory.look"             // 感官皮层：视觉感知完成
  | "sensory.speak"            // 感官皮层：TTS 输出
  | "memory.remember"          // 记忆皮层：写入记忆
  | "memory.recall"            // 记忆皮层：检索记忆
  | "memory.consolidate"       // 记忆皮层：睡眠巩固
  | "synapse.agent_message"    // 突触总线：跨 Agent 通信
  | "synapse.user_message"     // 突触总线：推送给用户
  | "limbic.safety_block"      // 边缘皮层：安全熔断
  | "limbic.emotion_shift"     // 边缘皮层：情绪变化
  | "planner.plan_step"        // 规划皮层：规划步骤变化
  | "planner.route_decision"   // 规划皮层：快慢双系统路由决策
  | "custom";                    // 用户自定义事件

/** 复用 WebhookEventType 作为 hook 事件类型枚举，保证两端契约一致 */
export type HookEventType = WebhookEventType;

/** 单次 hook 发射产生的事件 */
export type HookEvent<T = Record<string, unknown>> = {
  id: string;                // uuid v7
  type: HookEventType;
  timestamp: string;         // ISO 8601
  actorId?: string;
  source?: string;           // 业务模块名，便于调试
  data: T;
  metadata?: {
    source?: string;
    version?: string;
    [key: string]: unknown;
  };
};

/** hook 订阅者回调 */
export type HookHandler<T = Record<string, unknown>> = (
  event: HookEvent<T>,
) => Promise<void> | void;

/** emit() 的可选项 */
export type HookEmitOptions = {
  actorId?: string;
  source?: string;
  version?: string;
};

/** Feature 声明式注册：用于新功能批量声明其 hook 触发点 */
export type FeatureHookSpec<T = Record<string, unknown>> = {
  type: HookEventType;
  description: string;
  /** 可选：data 的运行时类型守卫（仅做日志/校验用，不强制） */
  validate?: (data: T) => boolean;
};

/** 声明一个 feature 的全部 hook */
export type FeatureHookManifest = {
  feature: string;
  hooks: FeatureHookSpec[];
};
