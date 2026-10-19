/// 「分阶段异步对话交互 v2」客户端状态模型。
///
/// 把一轮用户请求的处理过程建模为结构化对象，取代 v1 的两个独立字段
/// （_interimAckText 自由短句 + _agentStatusLine 自由文本）。UI 按
/// TurnState.phase + 各 list 分层渲染：
///   - 顶栏：phase + 计时（基于 t0）
///   - 折叠面板：plan / subAgents / toolCalls
///   - 流式正文：streamBuffer
library;

/// 路由模式（与服务端 ChatIntentMode 同步）。
enum TurnIntentMode {
  fastChat,
  masterOnly,
  masterDelegate,
  planExecute,
  directLlm;

  static TurnIntentMode fromWire(String? raw) {
    switch (raw) {
      case 'fast_chat':
      case 'chat':
        return TurnIntentMode.fastChat;
      case 'master_only':
        return TurnIntentMode.masterOnly;
      case 'master_delegate':
        return TurnIntentMode.masterDelegate;
      case 'plan_execute':
        return TurnIntentMode.planExecute;
      case 'direct_llm':
        return TurnIntentMode.directLlm;
      default:
        return TurnIntentMode.masterOnly;
    }
  }
}

/// 处理阶段（驱动顶栏文案 + 进度条）。
enum TurnPhase {
  /// 阶段 0：用户消息已发出，等待服务端 chat.turn_started。
  /// 客户端应本地立即显示「正在思考…」占位（不等服务端）。
  pendingStart,

  /// 阶段 0.5：服务端已确认收到，路由判断中。
  routing,

  /// 阶段 1：意图已识别，正在拆解计划 / 派子 Agent。
  planning,

  /// 阶段 2：执行中（工具调用 / 子 Agent / thought）。
  executing,

  /// 阶段 3：首条 assistant_chunk 抵达，开始流式正文。
  streaming,

  /// 阶段 4：chat.assistant_done 抵达。
  done,

  /// 阶段 5：被新消息 / 错误 / 用户中断。
  canceled,
}

/// plan_execute 拆解出的步骤。
class TurnPlanStep {
  TurnPlanStep({
    required this.id,
    required this.title,
    required this.status,
    this.instruction,
  });

  final String id;
  final String title;
  TurnStepStatus status;

  /// 交接说明（handoff.instruction）：这一步需要用户自己动手时，服务端下发
  /// 「要他在哪儿做什么」。非等待态为空。
  String? instruction;

  factory TurnPlanStep.fromWire(Map<String, dynamic> json) {
    final String? ins =
        (json['instruction']?.toString().trim().isNotEmpty ?? false)
            ? json['instruction'].toString().trim()
            : null;
    return TurnPlanStep(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      status: _stepStatusFromWire(json['status']?.toString()),
      instruction: ins,
    );
  }
}

enum TurnStepStatus { pending, running, ok, err, waiting }

TurnStepStatus _stepStatusFromWire(String? raw) {
  switch (raw) {
    case 'running':
      return TurnStepStatus.running;
    case 'waiting':
      return TurnStepStatus.waiting;
    case 'ok':
      return TurnStepStatus.ok;
    case 'err':
      return TurnStepStatus.err;
    case 'pending':
    default:
      return TurnStepStatus.pending;
  }
}

/// 把一条 plan_step 事件合并进步骤列表（已存在则更新，否则追加）。
///
/// 抽成顶层函数是为了让「本轮 TurnState」与「跨轮常驻的步骤条」共用同一套
/// 合并语义——turnState 在 done 时会被清空，而步骤条要跨轮常驻（等待用户操作
/// 往往发生在一轮结束之后）。
void applyPlanStepWire(List<TurnPlanStep> plan, Map<String, dynamic> wire) {
  final String stepId = wire['id']?.toString() ?? '';
  if (stepId.isEmpty) return;
  final String stepTitle = wire['title']?.toString() ?? '';
  final TurnStepStatus status = _stepStatusFromWire(wire['status']?.toString());
  final String? instruction =
      (wire['instruction']?.toString().trim().isNotEmpty ?? false)
          ? wire['instruction'].toString().trim()
          : null;
  for (final TurnPlanStep s in plan) {
    if (s.id == stepId) {
      s.status = status;
      // 离开等待态时清掉交接说明（旧说明会一直挂在步骤上误导用户）
      s.instruction = status == TurnStepStatus.waiting ? instruction : null;
      return;
    }
  }
  plan.add(TurnPlanStep(
    id: stepId,
    title: stepTitle,
    status: status,
    instruction: status == TurnStepStatus.waiting ? instruction : null,
  ));
}

/// master_delegate 派出的子 Agent。
class TurnSubAgent {
  TurnSubAgent({
    required this.id,
    required this.role,
    required this.task,
    this.status = TurnSubAgentStatus.planned,
  });

  final String id;
  final String role;
  final String task;
  TurnSubAgentStatus status;
  int? elapsedMs;

  factory TurnSubAgent.fromWire(Map<String, dynamic> json) {
    return TurnSubAgent(
      id: json['id']?.toString() ?? '',
      role: json['role']?.toString() ?? '',
      task: json['task']?.toString() ?? '',
    );
  }
}

enum TurnSubAgentStatus { planned, running, ok, err }

/// 工具调用卡片。
class TurnToolCall {
  TurnToolCall({
    required this.id,
    required this.name,
    this.argsPreview,
  });

  final String id;
  final String name;
  final String? argsPreview;
  TurnToolCallStatus status = TurnToolCallStatus.running;
  String? preview;
  bool ok = true;
  int? elapsedMs;

  factory TurnToolCall.fromCallEvent(Map<String, dynamic> json) {
    return TurnToolCall(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      argsPreview: json['argsPreview']?.toString(),
    );
  }

  void applyResult(Map<String, dynamic> json) {
    preview = json['preview']?.toString();
    ok = json['ok'] == true;
    final dynamic ms = json['elapsedMs'];
    if (ms is num) elapsedMs = ms.toInt();
    status = ok ? TurnToolCallStatus.ok : TurnToolCallStatus.err;
  }
}

enum TurnToolCallStatus { running, ok, err }

/// 模型内部 monologue（豆包/ChatGPT 风格的折叠「思考过程」）。
class TurnThought {
  TurnThought({required this.text, required this.at});
  final String text;
  final DateTime at;
}

/// 一轮对话的结构化状态。
class TurnState {
  TurnState({
    required this.traceId,
    required this.sessionId,
    required this.t0,
    this.phase = TurnPhase.pendingStart,
  });

  final String traceId;
  final String sessionId;
  final DateTime t0;
  TurnPhase phase;
  TurnIntentMode mode = TurnIntentMode.masterOnly;
  List<String> reasons = const [];

  final List<TurnPlanStep> plan = [];
  final List<TurnSubAgent> subAgents = [];
  final List<TurnToolCall> toolCalls = [];
  final List<TurnThought> thoughts = [];

  /// 流式正文缓冲（chat.assistant_chunk 累积）。
  final StringBuffer streamBuffer = StringBuffer();

  /// 折叠面板是否展开（用户可点开/收起）。
  bool panelExpanded = false;

  /// 顶栏距 t0 已经历的毫秒数（UI tick 时调用）。
  int elapsedMs(DateTime now) => now.difference(t0).inMilliseconds;

  // ---- mutators ----

  void applyIntentDetected({
    required TurnIntentMode mode,
    required List<String> reasons,
    List<TurnPlanStep>? plan,
    List<TurnSubAgent>? subAgents,
  }) {
    this.mode = mode;
    this.reasons = reasons;
    if (plan != null) {
      this.plan
        ..clear()
        ..addAll(plan);
    }
    if (subAgents != null) {
      this.subAgents
        ..clear()
        ..addAll(subAgents);
    }
    phase = (mode == TurnIntentMode.planExecute && (plan?.isNotEmpty ?? false)) ||
            (mode == TurnIntentMode.masterDelegate && (subAgents?.isNotEmpty ?? false))
        ? TurnPhase.planning
        : TurnPhase.executing;
  }

  void applyExecutionEvent({
    required String eventId,
    required String kind,
    Map<String, dynamic>? toolCall,
    Map<String, dynamic>? toolResult,
    Map<String, dynamic>? agentStart,
    Map<String, dynamic>? agentDone,
    Map<String, dynamic>? planStep,
    String? thought,
    String? log,
  }) {
    // 重复事件去重（同 eventId）
    // NOTE: 简单起见这里用 O(n) 线性扫描；调用频次低（一次请求 < 50 次）足够
    final List<TurnToolCall> existing = toolCalls;
    switch (kind) {
      case 'tool_call':
        if (toolCall == null) return;
        final String id = toolCall['id']?.toString() ?? '';
        if (existing.any((t) => t.id == id)) return;
        existing.add(TurnToolCall.fromCallEvent(toolCall));
        break;
      case 'tool_result':
        if (toolResult == null) return;
        final String id = toolResult['id']?.toString() ?? '';
        for (final TurnToolCall t in existing) {
          if (t.id == id) {
            t.applyResult(toolResult);
            return;
          }
        }
        // 没找到对应 tool_call 时补一条（v1 兼容）
        final TurnToolCall t = TurnToolCall(
          id: id,
          name: toolResult['name']?.toString() ?? '',
        );
        t.applyResult(toolResult);
        existing.add(t);
        break;
      case 'agent_start':
        if (agentStart == null) return;
        final String id = agentStart['id']?.toString() ?? '';
        for (final TurnSubAgent a in subAgents) {
          if (a.id == id) {
            a.status = TurnSubAgentStatus.running;
            return;
          }
        }
        subAgents.add(TurnSubAgent(
          id: id,
          role: agentStart['role']?.toString() ?? '',
          task: agentStart['task']?.toString() ?? '',
          status: TurnSubAgentStatus.running,
        ));
        break;
      case 'agent_done':
        if (agentDone == null) return;
        final String id = agentDone['id']?.toString() ?? '';
        for (final TurnSubAgent a in subAgents) {
          if (a.id == id) {
            a.status =
                agentDone['ok'] == true ? TurnSubAgentStatus.ok : TurnSubAgentStatus.err;
            final dynamic ms = agentDone['elapsedMs'];
            if (ms is num) a.elapsedMs = ms.toInt();
            return;
          }
        }
        break;
      case 'thought':
        if (thought != null && thought.isNotEmpty) {
          thoughts.add(TurnThought(text: thought, at: DateTime.now()));
        }
        break;
      case 'log':
        // 兜底：v1 过渡期，写到 thoughts 末尾（折叠面板里能看到）
        if (log != null && log.isNotEmpty) {
          thoughts.add(TurnThought(text: log, at: DateTime.now()));
        }
        break;
      case 'plan_step':
        if (planStep == null) return;
        applyPlanStepWire(plan, planStep);
        break;
    }
    // 进入执行阶段
    if (phase == TurnPhase.planning) phase = TurnPhase.executing;
  }

  void appendChunk(String chunk) {
    streamBuffer.write(chunk);
    phase = TurnPhase.streaming;
  }

  void markDone() {
    phase = TurnPhase.done;
  }

  void markCanceled() {
    phase = TurnPhase.canceled;
  }

  // ---- UI 辅助 ----

  /// 顶栏主标题（豆包式「正在思考…」/「正在搜索…」/「正在整理答案…」）。
  String get headerTitle {
    switch (phase) {
      case TurnPhase.pendingStart:
      case TurnPhase.routing:
        return '正在思考…';
      case TurnPhase.planning:
        return '正在整理思路…';
      case TurnPhase.executing:
        if (toolCalls.isNotEmpty) return '正在执行…';
        if (subAgents.any((a) => a.status == TurnSubAgentStatus.running)) {
          return '正在协作…';
        }
        return '正在处理…';
      case TurnPhase.streaming:
        return '正在收尾…';
      case TurnPhase.done:
        return '';
      case TurnPhase.canceled:
        return '已停止';
    }
  }

  /// 整个 TurnState 是否仍处于「进行中」状态。
  bool get isActive {
    return phase != TurnPhase.done && phase != TurnPhase.canceled;
  }
}
