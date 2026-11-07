/// 「Agent 现在正在干什么」的展示文案裁决。
///
/// 三层优先级，**服务端事实在前、客户端兜底在后**：
///   1. `chat.agent_status.line`：服务端确定性模板（工具名 + 入参拼出来，如
///      「我在查「明天天气」」）或模型自述，带具体名词，信息量最大；必须先过
///      [sanitizeAgentStatusLine]；
///   2. 工具族映射 [friendlyToolLabel]：人写死的进行时短句，零延迟、语气可控，
///      服务端没给参数化文案时兜底；
///   3. 阶段兜底：拆解 / 派活 / 收尾 —— 保证**任何任务**都有一句话可说，
///      不会出现「状态条空着但 agent 在干活」的哑场。
///
/// 动态文案必须过 [sanitizeAgentStatusLine]：服务端心跳兜底串是
/// `正在执行 shopping.order.place…`，直出等于把内部工具名摆到用户脸上。
library;

import "tool_friendly_label.dart";

/// 内部标识形态：`shopping.order.place` / `desktop_uia_query` / `example.com`。
final RegExp _rawIdentifier = RegExp(r"[a-z][a-z0-9]*(?:[._][a-z0-9]+)+");

/// 服务端心跳兜底串的前缀（`正在执行 <工具名>…`）。
const String _heartbeatPrefix = "正在执行";

/// 动态进度句的可信长度上限：超过它说明模型把正文/结果塞进了状态位。
const int _maxDynamicLineLength = 60;

/// 净化服务端下发/模型自述的进度句。
///
/// 返回 `null` 表示这句不能用，调用方退到下一层（阶段兜底）。
String? sanitizeAgentStatusLine(String? raw) {
  final String line = (raw ?? "").trim();
  if (line.isEmpty) return null;
  // 心跳兜底串：哪怕工具名被格式化吃掉，这串也是工程语，不是人话。
  if (line.startsWith(_heartbeatPrefix)) return null;
  // 含内部标识（dotted / snake_case / 域名）一律丢弃，宁可不说。
  if (_rawIdentifier.hasMatch(line)) return null;
  // 过长 = 复述了回答正文或工具结果，状态位装不下。
  if (line.length > _maxDynamicLineLength) return null;
  // 多行 = 正文串进状态位。
  if (line.contains("\n")) return null;
  return line;
}

/// 一轮任务「正在干什么」的文案；**永远非空**。
///
/// - [toolName]：`tool.call` 下发的工具名（可空）
/// - [liveLine]：`chat.agent_status.line`（可空，会先净化）
/// - [planning]：本轮已进入拆解阶段（plan_execute）
/// - [delegating]：本轮派了子 Agent（master_delegate）
/// - [streaming]：首段正文已经开始流式输出
String resolveAgentActivityLabel({
  String? toolName,
  String? liveLine,
  bool planning = false,
  bool delegating = false,
  bool streaming = false,
}) {
  // ① 服务端给的这一句最具体（带工具入参里的名词），优先。
  final String? dynamic = sanitizeAgentStatusLine(liveLine);
  if (dynamic != null) return dynamic;
  // ② 没有就退回工具族映射表（确定性、语气统一）。
  final String tool = (toolName ?? "").trim();
  if (tool.isNotEmpty) {
    final String? byTool = friendlyToolLabel(tool);
    if (byTool != null) return byTool;
  }
  // ③ 阶段兜底，保证任何任务都有话可说。
  if (delegating) return "我叫个帮手一起弄";
  if (planning) return "我把这事拆成几步";
  if (streaming) return "快说完了";
  return "我看看";
}
