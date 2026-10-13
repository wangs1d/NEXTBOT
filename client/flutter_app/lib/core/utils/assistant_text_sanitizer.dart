/// 单个时间戳帧单元：`[ts...]]`（容忍残缺——`[ts` 与 `]` 之间可为任意非 `]` 字符，
/// 含换行，如模型复述出的 `[ts\n2026-09-03 21:35:07]`），后接可选的星期与
/// `[now]`/`[3m ago]` 相对时间记号。与服务端 utils/timestamp-frame.ts 保持同构。
final RegExp _frameUnitRe = RegExp(
  r"\[ts[^\]]{0,160}\][ \t]*(?:周[日一二三四五六]?[ \t]*)?(?:\[[^\]]{0,48}\][ \t]*)*",
);
final RegExp _leadingFrameRe = RegExp("^\\s*${_frameUnitRe.pattern}");
/// 整行恰为一个或多个帧 → 连行删除（多行，含行尾换行）。
final RegExp _frameLineRe = RegExp(
  "^[ \t]*${_frameUnitRe.pattern}(?:[ \t]*${_frameUnitRe.pattern})*[ \t]*(?:\n|\$)",
  multiLine: true,
);
/// 行首帧（多行）：帧后即使跟同行正文也剥帧留正文（对齐服务端行为）。
final RegExp _lineStartFrameRe = RegExp(
  "^[ \t]*${_frameUnitRe.pattern}",
  multiLine: true,
);

// 竖线字符类兼容半角 `|` (U+007C) 与全角 `｜` (U+FF5C)：不同 tokenizer 下模型
// 两种形式都会输出（2026-09-11 对齐服务端 DSML_PIPE 的字符类，此前客户端只匹配
// 半角，全角变体整块漏网直透气泡）。第二组竖线可选——服务端实测存在
// `<| | DSML|tool_calls>` 这类无尾竖线的开标签变体。
final RegExp _dsmlToolCallsBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>[\s\S]*?<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>",
  caseSensitive: false,
);
final RegExp _dsmlOpenToolCallsBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*tool_calls\s*>[\s\S]*$",
  caseSensitive: false,
);
final RegExp _dsmlInvokeOrParameterBlockRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*(?:invoke|parameter)\b[^>]*>[\s\S]*?<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*(?:invoke|parameter)\s*>",
  caseSensitive: false,
);
final RegExp _dsmlAnyTagRe = RegExp(
  r"<\s*/?\s*[|｜]\s*[|｜]?\s*DSML\s*[|｜]\s*[|｜]?\s*[^>]*>",
  caseSensitive: false,
);

/// 剥掉文本开头连续的时间戳帧（含残缺帧）及剥离后的首部空白。
/// 流式安全：逐 chunk / 逐消息调用都只动开头，不碰正文。
String stripAssistantTimestampFrames(String text) {
  if (text.isEmpty || !text.contains("[ts")) return text;
  String out = text;
  for (var i = 0; i < 4; i++) {
    final Match? m = _leadingFrameRe.firstMatch(out);
    if (m == null) break;
    out = out.substring(m.end);
  }
  return out.replaceFirst(RegExp(r"^\s+"), "");
}

/// 删除文本中的时间戳帧：先整行删除「纯帧行」（含残缺帧），再剥剩余行首的帧，
/// 最后收敛空行。用于 done finalText / 历史加载的兜底清洗。
String stripAllTimestampFrameLines(String text) {
  if (text.isEmpty || !text.contains("[ts")) return text;
  return text
      .replaceAll(_frameLineRe, "")
      .replaceAll(_lineStartFrameRe, "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n")
      .replaceAll(RegExp(r"[ \t]+\n"), "\n");
}

String stripDsmlToolCallMarkup(String text) {
  if (text.isEmpty || !text.toLowerCase().contains("dsml")) return text;
  return text
      .replaceAll(_dsmlToolCallsBlockRe, "")
      .replaceAll(_dsmlOpenToolCallsBlockRe, "")
      .replaceAll(_dsmlInvokeOrParameterBlockRe, "")
      .replaceAll(_dsmlAnyTagRe, "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n")
      .replaceAll(RegExp(r"[ \t]+\n"), "\n")
      .trim();
}

/// 线程内部帧标签清单（2026-10-08）。
///
/// 与服务端 `server/src/external-model/internal-frames.ts` 的 `INTERNAL_FRAME_TAGS`
/// **逐项对齐**——两边各写一份名单正是此前 [不可信内容围栏] 漏网的根源。
/// 这些帧是写给 LLM 看的线程上下文（回复中断占位 / 摘要区 / 后台任务记录 /
/// 工具结果围栏 / 临时系统指令），被模型原样复读出来时不该出现在气泡里。
const List<String> kInternalFrameTags = <String>[
  "上一轮回复中断",
  "上一轮工具调用已完成但未生成可见回复",
  "session-recap",
  "unsummarized",
  "关键钉",
  "后台任务记录",
  "不可信内容围栏",
  "系统提示",
  "世界状态转移",
  "主动话术",
  "对话时间线",
  "节律提醒",
  "日志固化",
  "多模态消息",
  "已压缩·",
  "本轮用户明确要求不联网",
  "话题切换",
  "话题已切换",
  // 上游 provider harness 的轨迹切分控制帧（2026-10-11 事故：整条回复都是它）
  "trajectory-slicing",
];

final String _internalFrameAlt =
    kInternalFrameTags.map((String t) => RegExp.escape(t)).join("|");

/// XML 形态的上游 harness 注入提醒（2026-10-08 事故根源，与服务端
/// `internal-frames.ts` 的 stripSystemReminderBlocks 同构——两边名单对齐的
/// 教训同 [不可信内容围栏]：只改一边就会漏）。模型把上游 provider 包给它的
/// `<system-reminder>` 原样复读时在此剥掉：闭合块整块删；未闭合块吞无 CJK
/// 的英文提醒行、保留首个含 CJK 的正文行起的内容。
final RegExp _systemReminderBlockRe = RegExp(
  r"<system-reminder>[\s\S]*?</system-reminder>",
  caseSensitive: false,
);
final RegExp _systemReminderOpenRe = RegExp(
  r"<system-reminder>",
  caseSensitive: false,
);
final RegExp _systemReminderOrphanCloseLineRe = RegExp(
  r"^[ \t]*</system-reminder>[ \t]*(?:\n|$)",
  multiLine: true,
  caseSensitive: false,
);
final RegExp _systemReminderAnyTagRe = RegExp(
  r"</?system-reminder>",
  caseSensitive: false,
);
final RegExp _cjkCharRe = RegExp(r"[\u3400-\u4dbf\u4e00-\u9fff]");

// ── XML 形态的 <system> harness 控制帧（2026-10-11 事故根源，与服务端
//    `internal-frames.ts` 的 stripSystemFrames 同构）─────────────────────
//
// 真实事故：旅行规划轮的 assistant 正文**整条**只有 61 字，全部是上游 harness
// 塞进模型上下文的轨迹切分控制帧（本工程从不产生该形态），模型原样复读：
//   <system>
//   [trajectory-slicing]
//   接下来的回复被分到两条轨迹，#1 紧接本段，#2 紧接 #1。
// 与 `<system-reminder>` 的差别：本形态**不闭合**，且帧体说明行带中文，不能照搬
// 「吞无 CJK 行」。判据：opener 后首个非空行是方括号纯拉丁控制标签 → 整个块都是
// 帧体，吞到块尾（空行）或 EOF。
final RegExp _systemFrameOpenRe = RegExp(r"<\s*system\s*>", caseSensitive: false);
final RegExp _systemFrameBlockRe = RegExp(
  r"<system>[\s\S]*?</system>",
  caseSensitive: false,
);
final RegExp _systemFrameAnyRe = RegExp(r"<\s*system\s*>", caseSensitive: false);
final RegExp _harnessTagLineRe =
    RegExp(r"^[ \t]*\[[A-Za-z][A-Za-z0-9._:\-/ ]*\][ \t]*$");

String _stripOneUnclosedSystemFrame(String text) {
  final Match? m = _systemFrameOpenRe.firstMatch(text);
  if (m == null) return text;
  final int start = m.start;
  final List<String> lines = text.substring(m.end).split("\n");
  int firstBody = -1;
  for (int i = 0; i < lines.length; i++) {
    if (lines[i].trim().isNotEmpty) {
      firstBody = i;
      break;
    }
  }
  if (firstBody >= 0 && _harnessTagLineRe.hasMatch(lines[firstBody])) {
    int end = lines.length;
    for (int i = firstBody + 1; i < lines.length; i++) {
      if (lines[i].trim().isEmpty) {
        end = i;
        break;
      }
    }
    return end < lines.length
        ? text.substring(0, start) + lines.sublist(end).join("\n")
        : text.substring(0, start);
  }
  int consumed = 0;
  for (; consumed < lines.length; consumed++) {
    if (_cjkCharRe.hasMatch(lines[consumed])) break;
  }
  if (consumed >= lines.length) return text.substring(0, start);
  return text.substring(0, start) + lines.sublist(consumed).join("\n");
}

/// 剥离 XML 形态的 `<system>` harness 控制帧（闭合整块删 / 未闭合吞到块尾）。
String stripSystemFrames(String text) {
  if (text.isEmpty || !_systemFrameAnyRe.hasMatch(text)) return text;
  String out = text.replaceAll(_systemFrameBlockRe, "");
  for (var i = 0; i < 8; i++) {
    final String next = _stripOneUnclosedSystemFrame(out);
    if (next == out) break;
    out = next;
  }
  out = out.replaceAll(RegExp(r"</?system>", caseSensitive: false), "");
  // 接缝收敛：帧在开头时剥完会留下起首空行（气泡首行空白）。
  return out
      .replaceFirst(RegExp(r"^[ \t]*\n+"), "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n");
}

/// 整条文本是否「只是一个/多个 `<system>` 控制帧」（剥完为空 → 不该显示）。
bool isSystemFrameText(String text) {
  if (text.isEmpty || !_systemFrameAnyRe.hasMatch(text)) return false;
  return stripSystemFrames(text).trim().isEmpty;
}

/// 流式探测：缓冲内容是否为 `<system>` / `<system-reminder>` opener 的**半截前缀**
/// （还没出现 `>`）。命中说明标签可能尚未到齐，调用方应扣住待判——半截标签先吐
/// 给用户就撤不回。
bool _isPartialSystemOpener(String text) {
  final String t = text.trimLeft().toLowerCase();
  if (t.isEmpty || t.contains(">")) return false;
  for (final String target in const <String>["<system-reminder>", "<system>"]) {
    if (target.startsWith(t)) return true;
  }
  return false;
}

/// 缓冲内容里是否有一个「尚未终结」的 `<system>` 控制帧：无 `</system>` 闭合，
/// opener 后首个非空行是方括号控制标签（harness 帧体），且帧体之后还没出现空行
/// 分界。命中即继续扣住整条流（见 AssistantTextSanitizer.ingest）。
bool _hasUnterminatedSystemFrame(String text) {
  final Match? m = _systemFrameOpenRe.firstMatch(text);
  if (m == null) return false;
  if (_systemFrameBlockRe.hasMatch(text)) return false; // 已闭合 → 已终结
  final List<String> lines = text.substring(m.end).split("\n");
  int firstBody = -1;
  for (int i = 0; i < lines.length; i++) {
    if (lines[i].trim().isNotEmpty) {
      firstBody = i;
      break;
    }
  }
  if (firstBody < 0) return true; // 帧体还没到，继续等
  final String body = lines[firstBody].trim();
  if (!_harnessTagLineRe.hasMatch(body)) {
    // 控制标签可能还没收完（`[traj` / `[trajectory-slic`）：继续等，别急着放行
    // ——一旦放行，后续帧体说明行就会从直通分支漏出去（本次事故的泄漏路径）。
    if (body.startsWith("[") && body.length < 40 && !_cjkCharRe.hasMatch(body)) {
      return true;
    }
    return false; // 非控制标签 → 不是 harness 帧体，走常规
  }
  for (int i = firstBody + 1; i < lines.length; i++) {
    // 末位空元素只是「流还在继续」（split 尾部残留），不是空行分界
    if (lines[i].trim().isEmpty && i != lines.length - 1) {
      return false; // 空行分界 → 帧体结束，后面是正文
    }
  }
  return true;
}

String _stripOneUnclosedSystemReminder(String text) {
  final Match? m = _systemReminderOpenRe.firstMatch(text);
  if (m == null) return text;
  final List<String> lines = text.substring(m.end).split("\n");
  int consumed = 0;
  for (; consumed < lines.length; consumed++) {
    if (_cjkCharRe.hasMatch(lines[consumed])) break;
  }
  // 全部行都无 CJK → opener 到 EOF 是纯英文泄漏，全删。
  if (consumed >= lines.length) return text.substring(0, m.start);
  return text.substring(0, m.start) + lines.sublist(consumed).join("\n");
}

String stripSystemReminderBlocks(String text) {
  if (text.isEmpty ||
      !(text.toLowerCase().contains("system-reminder") ||
          _systemFrameAnyRe.hasMatch(text))) {
    return text;
  }
  String out = stripSystemFrames(text).replaceAll(_systemReminderBlockRe, "");
  for (var i = 0; i < 8; i++) {
    final String next = _stripOneUnclosedSystemReminder(out);
    if (next == out) break;
    out = next;
  }
  return out
      .replaceAll(_systemReminderOrphanCloseLineRe, "")
      .replaceAll(_systemReminderAnyTagRe, "");
}

/// 闭口的 `[不可信内容围栏]…[/不可信内容围栏]` 整块（块内是工具原始数据）。
final RegExp _fenceBlockRe =
    RegExp(r"\[不可信内容围栏[^\]]*\][\s\S]*?\[\/不可信内容围栏\]");

/// 孤立的围栏开/闭标签行（模型只复读了一半时兜底）。
final RegExp _fenceTagLineRe = RegExp(
  r"^[ \t]*\[\/?不可信内容围栏[^\]]*\][ \t]*(?:\n|$)",
  multiLine: true,
);

/// 整行就是一个内部帧（帧后即使跟同行内容也整行删）。
final RegExp _internalFrameLineRe = RegExp(
  "^[ \\t]*\\[(?:${_internalFrameAlt})[^\\]]*\\][^\\n]*(?:\\n|\$)",
  multiLine: true,
  caseSensitive: false,
);

// ── recap 回显块（2026-10-12 摘要直出事故，与服务端 isRecapEchoText 同构）──────
// 模型把线程里的 [session-recap] 摘要块整块复述出来时，出口只剥掉标签行，正文
// （"Earlier conversation recap:" 标题 + 「（本块为历史摘要…」视图提示行 + 条目）
// 会照发。判据与服务端一致：提示行「（本块为历史摘要」只存在于 LLM 视图、存储层
// 永远没有 → 正文含它必是回显；无 [session-recap] 标签却以标题行开头同理。
final RegExp _recapEchoTitleLineRe = RegExp(
  "^[ \\t]*Earlier conversation recap:[ \\t]*(?:\\n|\$)",
  multiLine: true,
  caseSensitive: false,
);
final RegExp _recapEchoHintRe = RegExp(
  "（本块为历史摘要[\\s\\S]*?(?:）|\$)",
);

/// 剥离 recap 回显正文；整条就是回显时返回空串（调用方据此不落气泡）。
String stripRecapEchoBlocks(String text) {
  if (text.isEmpty) return text;
  final String trimmed = text.trimLeft();
  final bool tagged = trimmed.startsWith("[session-recap]");
  if (!tagged && trimmed.startsWith("Earlier conversation recap:")) {
    return "";
  }
  if (!text.contains("Earlier conversation recap:") &&
      !text.contains("（本块为历史摘要")) {
    return text;
  }
  return text
      .replaceAll(_recapEchoHintRe, "")
      .replaceAll(_recapEchoTitleLineRe, "")
      .replaceAll(RegExp(r"\n{3,}"), "\n\n");
}

/// 文本开头的连续内部帧（可能连着多个），剥帧留正文。
final RegExp _internalFrameLeadingRe = RegExp(
  "^[ \\t]*(?:\\[(?:${_internalFrameAlt})[^\\]]*\\][ \\t:：—–-]*)+",
  caseSensitive: false,
);

/// 剥离文本中的线程内部帧，返回可以展示的正文；剥完为空返回空串
/// （调用方据此判断本条不该落气泡）。与服务端 `stripInternalFrames` 同构。
String stripInternalFrames(String text) {
  if (text.isEmpty) return text;
  String out = stripSystemReminderBlocks(text)
      .replaceAll(_fenceBlockRe, "")
      .replaceAll(_fenceTagLineRe, "")
      .replaceAll(_internalFrameLineRe, "");
  // 开头连续帧：循环剥，只动开头不碰正文。
  for (var i = 0; i < 8; i++) {
    final String next = out.replaceFirst(_internalFrameLeadingRe, "");
    if (next == out) break;
    out = next;
  }
  out = out.replaceAll(RegExp(r"\n{3,}"), "\n\n");
  if (out.trim().isEmpty) return "";
  return out;
}

/// 文本（去空白后）是否以内部帧标签开头——整条就是内部帧。
bool isInternalFrameText(String text) {
  final String trimmed = text.trim();
  if (!trimmed.startsWith("[")) return false;
  return _internalFrameLeadingRe.hasMatch(trimmed);
}

String stripAssistantProtocolFrames(String text) {
  // 先剥 recap 回显块，再剥线程内部帧（整块围栏 / 帧整行 / 开头连续帧），
  // 再剥行首时间戳帧、删整行时间戳帧，最后剥 DSML 工具调用标记。
  return stripDsmlToolCallMarkup(
    stripAllTimestampFrameLines(
      stripAssistantTimestampFrames(
        stripInternalFrames(stripRecapEchoBlocks(text)),
      ),
    ),
  );
}

class AssistantTextSanitizer {
  AssistantTextSanitizer({this.maxPendingLength = 128});

  final int maxPendingLength;

  StringBuffer _pending = StringBuffer();
  bool _resolvedLeadingFrame = false;

  String ingest(String chunk) {
    if (chunk.isEmpty) return "";
    if (_resolvedLeadingFrame) {
      return stripAssistantProtocolFrames(chunk);
    }

    _pending.write(chunk);
    final String buffered = _pending.toString();
    final String trimmed = buffered.trimLeft();

    if (trimmed.isEmpty) return "";

    // XML 形态 harness 帧（`<system>` / `<system-reminder>`）：
    // 1) 半截 opener（`<sy…`）先扣住——先吐就撤不回；
    // 2) `<system>` 控制帧尚未终结（无 `</system>`，帧体后也没出现空行分界）时
    //    继续扣住整条流——帧体后半段的说明行里没有 opener，逐 chunk 净化认不出来，
    //    会从直通分支漏给用户（真实事故就是这样把「接下来的回复被分到两条轨迹…」
    //    送上了气泡）。流结束时由 drainPending 做最终剥离（整条即帧 → 返回空串）。
    if (trimmed.startsWith("<")) {
      if (_isPartialSystemOpener(buffered) && buffered.length < maxPendingLength) {
        return "";
      }
      if (_hasUnterminatedSystemFrame(buffered)) {
        if (buffered.length < maxPendingLength) return "";
      }
    }

    // 容忍残缺帧：`[ts` 后可能断行/丢冒号（如 "[ts\n2026-09-03 ...]"），
    // 因此只要开头是 "[ts" 就先按住缓冲，等帧闭合（出现 "]"）再一次性剥。
    if (trimmed.startsWith("[ts")) {
      if (!trimmed.contains("]")) {
        if (buffered.length < maxPendingLength) return "";
        _resolvedLeadingFrame = true;
        final String fallback = buffered;
        _pending = StringBuffer();
        return stripAssistantProtocolFrames(fallback);
      }

      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantProtocolFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    if (trimmed.startsWith("[")) {
      if (trimmed.length < 4) return "";
      _resolvedLeadingFrame = true;
      final String cleaned = stripAssistantProtocolFrames(buffered);
      _pending = StringBuffer();
      return cleaned;
    }

    _resolvedLeadingFrame = true;
    final String cleaned = stripAssistantProtocolFrames(buffered);
    _pending = StringBuffer();
    return cleaned;
  }

  String drainPending() {
    final String buffered = _pending.toString();
    _pending = StringBuffer();
    _resolvedLeadingFrame = true;
    if (buffered.trimLeft().startsWith("[ts")) return "";
    return stripAssistantProtocolFrames(buffered);
  }

  void reset() {
    _pending = StringBuffer();
    _resolvedLeadingFrame = false;
  }
}
