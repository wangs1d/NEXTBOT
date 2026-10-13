export type AgentReply = {
  text: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** 即时路径已执行工具时附带结果，避免 WebSocket 层重复开桌 */
  toolResult?: Record<string, unknown>;
  /** 为 true 时表示外部模型已通过 onAssistantDelta 推送过增量，WebSocket 层勿再对 text 做 chunkText */
  streamedChunks?: boolean;
  /** 语义意图理解不明确时，向用户发起澄清反问 */
  clarification?: {
    question: string;
    options?: string[];
  };
  /**
   * 本轮实际发起过的工具调用摘要（toolName(参数要点)，onToolExecuteStart 采集，上限 12 条）。
   * 后台任务升级段用它延续快通道的执行轨迹，避免整轮从零重跑（A2）。
   */
  attemptedToolCalls?: string[];
  /**
   * 任务面异步收尾（2026-09-08）：本轮已把任务派发到后台并立即结束（text 为空，
   * 无正文产出）。WS 层据此以 source=task_plane 发送 assistant_done，客户端据此
   * 结清前台处理状态且不落正文气泡（任务回执/结果由任务面事件独立承载）。
   */
  taskDispatched?: boolean;
  /**
   * 答案留存（2026-10-13 根修：工具轮的答案不进流式通道）：工具循环对执行过
   * 实质工具的轮次未直推正文（或前置检索证据轮从第一波留存），text 是随 done
   * 一次性下发的答案本体。WS 层据此把 done 定为整段替换呈现（finalText
   * ReplacesStream），跳过「说话算话」残差裁决——残差不是出口重写分歧，
   * 而是从未流出过的答案。
   */
  answerStreamHeld?: boolean;
};
