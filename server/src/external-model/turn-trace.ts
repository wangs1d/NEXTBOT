/**
 * 轮级结构化 trace（2026-09-19 工具调用架构改造 P0）。
 *
 * 每次工具循环结束输出一行 JSON，把"这轮工具为什么没调/调错"的归因数据
 * 收敛到单一锚点（grep `[turn-trace]`）。此前散落的 console.info（[plan-execute]/
 * [openai-tool-loop]/[tool-search]/[prefix-cache]）保留不动，本 trace 是它们的
 * 结构化汇总视图，用于前后对比验收：
 *   - 工具成功率 = okCalls / totalCalls
 *   - 行为一致性 = 同 query 复测 visibleTools hash diff
 *   - 纠错成本 = exitGate / requestCard 触发次数
 */

export type ToolCallTraceEntry = {
  name: string;
  ok: boolean;
  /** 本调用方 await 落定的耗时（含确定性重试；去重共享调用按各自等待计） */
  ms: number;
  /** 是否经请求卡（tool_request）转正后才可达 */
  viaRequestCard?: boolean;
  /**
   * 工具到达通道（2026-10-01 S2 通道收敛观测；2026-10-09 L3 增幻觉转正）：
   *   visible    = 首波可见（Core/束投影/域信号预载/晋升常驻）
   *   bridge     = 桥自身（tool_discover/tool_call 解析层）
   *   deferred   = 经桥按名/检索/请求卡调回的延迟工具
   *   hallucination_promoted = 模型未检索就直呼的不可见名，registry 放行执行
   *                            （调用即发现转正，等价 discover+call 合一波）
   *   deterministic = 服务端确定性预执行（2026-10-10：媒体意图轮开场真搜，
   *                   不经模型决策，根治搜图轮「时有时无」）
   */
  acquisition?: "visible" | "bridge" | "deferred" | "hallucination_promoted" | "deterministic";
  /**
   * 失败是否为参数级错误（2026-10-10 L3 盲区观测）：arguments 非法 JSON
   * （TOOL_ARGS_MALFORMED）或 schema 校验不过（VALIDATION_ERROR）。L3 错误即
   * 检索只管「名字错了」，参数错了（幻觉字段/类型不对/截断）没有观测——
   * 该指标定位重灾区工具，针对性修 schema 描述。
   */
  paramError?: boolean;
};

export type TurnTraceRecord = {
  ts: number;
  /** LLM 审计 stage（main_chat_tools / task_plane_* / …），近似车道标识 */
  stage: string;
  model?: string;
  /** 路由意图标签（2026-09-23 观测补全）：量化"路由误判率 vs 模型不自觉率" */
  turnIntent?: string;
  /** 本轮是否注入了前置检索证据块（realtime 轮零工具直答的豁免判据） */
  turnEvidenceInjected?: boolean;
  /** 路由置信度（与 turnIntent 同源，观测路由器质量） */
  routeConfidence?: number;
  /** 用户原话（截断 160 字符；2026-10-10 未命中聚类分析的数据源，落日志仅排障用） */
  query?: string;
  /** 暴露给模型的可见工具数（含桥工具，不含请求卡追加） */
  visibleTools: number;
  /** 延迟目录是否激活及目录规模 */
  deferredActive: boolean;
  deferredCount: number;
  /** 预召回注入的工具名（无则空） */
  prerecall?: string;
  /** 召回链注入可见集的工具名（可见集 − 静态 Core − 桥；2026-10-09 L5 观测）。
   *  离线对账：预载转化率 = |注入 ∩ 实际执行| / |注入|；晋升转化率同口径。 */
  recallInjectedNames?: string[];
  /** 实际使用的波次数 */
  waves: number;
  toolCalls: ToolCallTraceEntry[];
  /** 请求卡：是否触发、命中加载了哪些工具、已在可见集的（预召回先注入）、高危拦截（P1-1） */
  requestCard?: {
    fired: boolean;
    loaded: string[];
    alreadyVisible?: string[];
    blockedRisk?: string[];
  };
  /** 出口检查：是否触发续波及原因 */
  exitGate?: { fired: boolean; reason?: string };
  finalTextChars: number;
  durationMs: number;
};

export function recordTurnTrace(record: TurnTraceRecord): void {
  try {
    console.info(`[turn-trace] ${JSON.stringify(record)}`);
  } catch {
    /* 遥测失败静默 */
  }
}

export function summarizeTurnTraces(records: TurnTraceRecord[]): {
  turns: number;
  totalCalls: number;
  okCalls: number;
  okRate: number;
  avgWaves: number;
  requestCardFired: number;
  exitGateFired: number;
  /** 幻觉转正调用数（未检索直呼不可见名且被执行） */
  hallucinationPromotedCalls: number;
  /** 幻觉转正中成功执行的占比（转正通道可用性） */
  hallucinationPromotedOkRate: number;
  /** 召回链注入转化率：注入名中真实被执行的占比（L5 对账） */
  recallInjectedConversion: number;
  /** 参数级失败调用数（args 非法/schema 校验不过；L3 名字纠错管不到的盲区） */
  paramErrorCalls: number;
  /** 参数级失败占全部调用的比例（重灾区定位看分析脚本的按工具聚合） */
  paramErrorRate: number;
} {
  const totalCalls = records.reduce((n, r) => n + r.toolCalls.length, 0);
  const okCalls = records.reduce((n, r) => n + r.toolCalls.filter((c) => c.ok).length, 0);
  const avgWaves = records.length > 0
    ? records.reduce((n, r) => n + r.waves, 0) / records.length
    : 0;
  const promotedCalls = records.flatMap((r) =>
    r.toolCalls.filter((c) => c.acquisition === "hallucination_promoted"),
  );
  // 召回链注入转化率：分轮对账（注入名 ∩ 该轮实际执行名）/ 注入名
  const injectedTurns = records.filter((r) => (r.recallInjectedNames?.length ?? 0) > 0);
  const injectedTotal = injectedTurns.reduce((n, r) => n + r.recallInjectedNames!.length, 0);
  const injectedExecuted = injectedTurns.reduce((n, r) => {
    const executed = new Set(r.toolCalls.map((c) => c.name));
    return n + r.recallInjectedNames!.filter((name) => executed.has(name)).length;
  }, 0);
  return {
    turns: records.length,
    totalCalls,
    okCalls,
    okRate: totalCalls > 0 ? okCalls / totalCalls : 0,
    avgWaves,
    requestCardFired: records.filter((r) => r.requestCard?.fired).length,
    exitGateFired: records.filter((r) => r.exitGate?.fired).length,
    hallucinationPromotedCalls: promotedCalls.length,
    hallucinationPromotedOkRate:
      promotedCalls.length > 0
        ? promotedCalls.filter((c) => c.ok).length / promotedCalls.length
        : 0,
    recallInjectedConversion: injectedTotal > 0 ? injectedExecuted / injectedTotal : 0,
    paramErrorCalls: records.reduce(
      (n, r) => n + r.toolCalls.filter((c) => c.paramError === true).length,
      0,
    ),
    paramErrorRate:
      totalCalls > 0
        ? records.reduce((n, r) => n + r.toolCalls.filter((c) => c.paramError === true).length, 0) /
          totalCalls
        : 0,
  };
}
