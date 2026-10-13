import type { HandleUserMessageOptions } from "../services/agent-core.js";
import type { AgentReply } from "../agent/types.js";
import type { RouteDecision } from "../agent/task-router.js";
import type { AgentCore } from "../services/agent-core.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { AgentAccessMode } from "../agent/agent-access-mode.js";

export type { HandleUserMessageOptions, AgentReply, RouteDecision };

/** runToolIfNeeded 的返回形状（工具已执行 / 校验拒绝 / 无需执行）。 */
export type ToolIfNeededResult = { ok: boolean; result?: Record<string, unknown> };

/** runToolIfNeeded 的可选上下文（与 ToolContext 字段对齐）。 */
export type ToolIfNeededOptions = {
  sessionId?: string;
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: ClientLocationWire;
  agentAccessMode?: AgentAccessMode;
};

/**
 * Gateway / 外壳侧可见的 Agent Runtime 统一入口（进程无关契约）。
 *
 * 分层约束：WS 处理器、HTTP 路由、微信桥、日程任务、视觉调度器等一切
 * 「想跑一轮 Agent」的调用方只允许依赖本接口，不得 import AgentCore
 * 具体类。实现有两种：
 *   - 同进程：DirectRuntimeAdapter 直接包裹 AgentCore（RUNTIME_MODE=embedded）
 *   - 跨进程：WsRuntimeClient 经 WS 链路转发到独立 runtime 进程
 *
 * 流式输出沿用 {@link HandleUserMessageOptions} 的回调契约（传输无关）；
 * 跨进程实现负责把回调序列化为链路事件、把 signal.abort 翻译为 abort 帧。
 */
export interface RuntimeFacade {
  /** 执行一轮用户消息（LLM 编排 + 工具循环 + 记忆写入），流式增量经 opts 回调推送。 */
  handleUserMessage(actorId: string, text: string, opts?: HandleUserMessageOptions): Promise<AgentReply>;

  /** 补跑 reply 上未执行的工具调用（AgentReply 携带 toolName/toolInput 时）。 */
  runToolIfNeeded(actorId: string, reply: AgentReply, opts?: ToolIfNeededOptions): Promise<ToolIfNeededResult>;

  /**
   * 语义 LLM 路由（fast/complex 判定），供展示层在分阶段交互决策前取得
   * 与 runtime 一致的判定；同轮内缓存保证不重复计费。
   */
  routeTurnForWs(sessionId: string, text: string, recentUserTurns?: string[], entityContextLines?: string[], dialogStateLines?: string[]): Promise<RouteDecision>;

  /**
   * 服务重启后恢复未完成的自主任务（状态机任务断点续跑），返回恢复数量。
   * 契约上允许异步：跨进程实现（WsRuntimeClient）经链路 RPC 完成。
   */
  resumeAutonomousTasks(): Promise<number>;

  /**
   * 中断/异常轮次的最小化兜底记账（2026-09-08）：以已流式送达用户的部分回复
   * 完成 STM 挂起项结清、WAL/日志记账。可选契约——跨进程实现可暂缓；
   * WS 层以可选调用兜底（文本为空时实现侧为无操作）。
   */
  settleInterruptedTurn?(
    actorId: string,
    userText: string,
    partialAssistantText: string,
    meta?: { sessionId?: string; messageId?: string },
  ): void;

  /**
   * 取消一个后台任务（TaskHub 记录标记 cancelled 并停止结果投递）。
   * 可选契约——同进程实现直接委托 AgentCore；跨进程实现经链路转发。
   * @returns 任务存在、会话相符且原本非终态时 true。
   */
  cancelBackgroundTask?(actorId: string, taskId: string): boolean;
}

/**
 * 同进程直连适配器：gateway 与 runtime 同进程时（embedded 模式 /
 * 拆进程改造前的过渡态）直接委托 AgentCore。
 */
export class DirectRuntimeAdapter implements RuntimeFacade {
  constructor(private readonly core: AgentCore) {}

  handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    return this.core.handleUserMessage(actorId, text, opts);
  }

  runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: ToolIfNeededOptions,
  ): Promise<ToolIfNeededResult> {
    return this.core.runToolIfNeeded(actorId, reply, opts);
  }

  routeTurnForWs(
    sessionId: string,
    text: string,
    recentUserTurns?: string[],
    entityContextLines?: string[],
    dialogStateLines?: string[],
  ): Promise<RouteDecision> {
    return this.core.routeTurnForWs(sessionId, text, recentUserTurns, entityContextLines, dialogStateLines);
  }

  async resumeAutonomousTasks(): Promise<number> {
    return this.core.resumeAutonomousTasks();
  }

  settleInterruptedTurn(
    actorId: string,
    userText: string,
    partialAssistantText: string,
    meta?: { sessionId?: string; messageId?: string },
  ): void {
    this.core.settleInterruptedTurn(actorId, userText, partialAssistantText, meta);
  }

  cancelBackgroundTask(actorId: string, taskId: string): boolean {
    return this.core.cancelBackgroundTask(actorId, taskId);
  }
}
