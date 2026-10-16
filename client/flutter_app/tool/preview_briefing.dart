// 今日简报浮窗「实际效果」预览生成器（2026-09-25）。
// 非产品代码：从 lib/features/briefing/daily_briefing_window.dart 程序化抽取
// 纯函数段（markdown 拼装/渲染/版式判定/HTML 模板）原样执行，用真实简报
// payload 生成窗口实际加载的 HTML，供浏览器查看。窗口内 TTS 状态由
// Dart→JS 驱动，浏览器里没有 TTS，故在尾部补一条 __setIdle 模拟已播报态。
// dart run tool/preview_briefing.dart <payload.json> <out.html>
import "dart:convert";
import "dart:io";
import "dart:math";

import "../lib/core/services/daily_briefing_card_model.dart";

/// 卡片逻辑宽（= 设计稿宽，Flutter 逻辑像素与 CSS 像素 1:1）。
const double kCardWidth = 400;

/// 简报窗口载荷：口播稿 + 结构化简报 + 用户称呼。
class DailyBriefingWindowPayload {
  const DailyBriefingWindowPayload({
    required this.narrationText,
    required this.briefing,
    this.appellation = "",
  });

  final String narrationText;
  final Map<String, dynamic> briefing;

  /// 用户称呼（账号注册 displayName，如「王先生」）；空表示无称呼。
  final String appellation;

  String encode() => jsonEncode(<String, dynamic>{
        "version": 2,
        "narrationText": narrationText,
        "briefing": briefing,
        "appellation": appellation,
      });

  /// 解码失败（文件损坏/版本不符）时返回 null，宿主展示错误兜底。
  static DailyBriefingWindowPayload? tryDecode(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final Object? rawBriefing = decoded["briefing"];
      if (rawBriefing is! Map) return null;
      return DailyBriefingWindowPayload(
        narrationText: decoded["narrationText"]?.toString() ?? "",
        briefing: rawBriefing.cast<String, dynamic>(),
        appellation: decoded["appellation"]?.toString() ?? "",
      );
    } catch (_) {
      return null;
    }
  }
}



/// 窗口高（逻辑像素）：与 buildBriefingHtml 的 CSS 布局 1:1 对应。
///
/// 2026-09-24 结构化行卡改版后所有行高在 CSS 里钉死（单行省略，不换行），
/// 本函数按同一组常量精确累加——口播稿不再印上卡面，高度与文字长短无关；
/// 唯一可变项是全空兜底时的口播稿块（按 25 字/行估算）。
double briefingWindowHeight(DailyBriefingWindowPayload? payload) {
  const double padTop = 20, padBottom = 18;
  const double greetH = 24, metaGap = 5, metaH = 17;
  const double secGap = 14, secLabelH = 15, rowH = 30;
  const double doneGap = 4, doneH = 18;
  const double statusGap = 14, statusPadTop = 12, statusH = 22;
  const double scriptGap = 15, scriptLineH = 25;

  final Map<String, dynamic>? briefing = payload?.briefing;
  final _BriefingLayout layout = _BriefingLayout.of(briefing);

  double h = padTop + greetH + metaGap + metaH;
  // markdown 文档流（与 .md CSS 一一对应）：板块标题 + 行列表
  int rowsOf(String key) {
    final Object? raw = briefing?[key];
    return raw is List ? raw.length : 0;
  }

  int todoPendingRows() => layout.todoPending.length;
  // 今日日程 / 待办跟进 / 待复习笔记 / 兴趣热搜 / 近期重要日子（全量直出，无展开）
  h += rowsOf("todaySchedule") > 0 ? secGap + secLabelH + rowsOf("todaySchedule") * rowH : 0;
  h += todoPendingRows() > 0 ? secGap + secLabelH + todoPendingRows() * rowH : 0;
  if (todoPendingRows() > 0 && layout.doneTodayCount > 0) h += doneGap + doneH;
  h += rowsOf("pendingNotes") > 0 ? secGap + secLabelH + rowsOf("pendingNotes") * rowH : 0;
  h += rowsOf("interestHits") > 0 ? secGap + secLabelH + rowsOf("interestHits") * rowH : 0;
  h += rowsOf("upcomingImportantDays") > 0
      ? secGap + secLabelH + rowsOf("upcomingImportantDays") * rowH
      : 0;
  // 全空兜底：口播稿印上卡面（正常版式下口播稿只进耳朵不进眼睛）
  final String narration = payload?.narrationText.trim() ?? "";
  final bool scriptFallback =
      briefing != null && !layout.hasAnySection && narration.isNotEmpty;
  if (scriptFallback) {
    final int lines = max(1, (narration.length / 25).ceil());
    h += scriptGap + lines * scriptLineH;
  }
  h += statusGap + statusPadTop + statusH + padBottom;
  return h;
}

/// 版式要素抽取（HTML 生成与高度计算共用同一份判定，防两端不一致）。
class _BriefingLayout {
  const _BriefingLayout({
    required this.todoPending,
    required this.doneTodayCount,
    required this.hasAnySection,
  });

  final List<String> todoPending;
  final int doneTodayCount;
  final bool hasAnySection;

  static _BriefingLayout of(Map<String, dynamic>? briefing) {
    final List<String> pending = <String>[];
    int doneCount = 0;
    final Object? rawTodo = briefing?["todoFollowups"];
    if (rawTodo is Map) {
      final Object? rawPending = rawTodo["pending"];
      if (rawPending is List) {
        pending.addAll(rawPending
            .map((Object? e) => e?.toString() ?? "")
            .where((String s) => s.isNotEmpty));
      }
      final Object? rawDone = rawTodo["doneTodayCount"];
      if (rawDone is num) doneCount = rawDone.round();
    }

    bool hasAnySection() {
      bool nonEmpty(String key) {
        final Object? raw = briefing?[key];
        return raw is List && raw.isNotEmpty;
      }

      return nonEmpty("todaySchedule") ||
          pending.isNotEmpty ||
          nonEmpty("pendingNotes") ||
          nonEmpty("interestHits") ||
          nonEmpty("upcomingImportantDays");
    }

    return _BriefingLayout(
      todoPending: pending,
      doneTodayCount: doneCount,
      hasAnySection: hasAnySection(),
    );
  }
}



String _esc(String text) => text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");

/// 口播稿时间高亮：HH:MM → 白色加粗（设计稿 .hl）。
String _highlightScript(String plainEscaped) {
  return plainEscaped.replaceAllMapped(
    RegExp(r"(\d{1,2}:\d{2})"),
    (Match m) => "<b class=\"hl\">${m.group(1)}</b>",
  );
}

/// 兴趣热搜行文案：「标题 · 平台」。
String _interestHitText(Map<String, dynamic> item) {
  final String title = item["title"]?.toString() ?? "";
  final String platform = item["platform"]?.toString() ?? "";
  return platform.isEmpty ? "**$title**" : "**$title** · $platform";
}

/// 重要日子行文案：「name的生日 · 还有 3 天」。
String _importantDayText(Map<String, dynamic> item) {
  final String name = item["name"]?.toString() ?? "";
  final String type = item["type"]?.toString() ?? "";
  final String typeLabel =
      type == "anniversary" ? "纪念日" : type == "custom" ? "特殊日子" : "生日";
  final Object? rawDays = item["daysUntil"];
  final String when = rawDays is int
      ? (rawDays == 0 ? "就是今天" : rawDays == 1 ? "明天" : "还有 $rawDays 天")
      : "";
  return "$name的$typeLabel${when.isEmpty ? "" : " · **$when**"}";
}

/// 把结构化简报组装成 markdown 文档（2026-09-25：卡面内容层 = markdown，
/// 调内容只动这里，不碰 HTML/CSS）。固定顺序：五板块（## 标题 + - 列表 +
/// 完成数纯文本行）；2026-10-16 天气/穿衣迁往睡前提醒，不再上卡面。
String _composeBriefingMarkdown(
    Map<String, dynamic>? briefing, _BriefingLayout layout) {
  final StringBuffer buf = StringBuffer();
  if (briefing == null) return buf.toString();

  List<Map<String, dynamic>> listOf(String key) {
    final Object? raw = briefing[key];
    if (raw is! List) return const <Map<String, dynamic>>[];
    return raw
        .whereType<Map>()
        .map((Map e) => e.cast<String, dynamic>())
        .toList();
  }

  final List<Map<String, dynamic>> schedule = listOf("todaySchedule");
  if (schedule.isNotEmpty) {
    buf.writeln("## 📅 今日日程");
    for (final Map<String, dynamic> s in schedule) {
      final String time = s["time"]?.toString() ?? "";
      final String title = (s["title"] ?? "").toString();
      buf.writeln(time.isEmpty ? "- $title" : "- **$time** $title");
    }
  }

  if (layout.todoPending.isNotEmpty) {
    buf.writeln("## ✅ 待办跟进");
    for (final String pending in layout.todoPending) {
      buf.writeln("- $pending");
    }
    if (layout.doneTodayCount > 0) {
      buf.writeln("今天已完成 ${layout.doneTodayCount} 件");
    }
  }

  final List<Map<String, dynamic>> notes = listOf("pendingNotes");
  if (notes.isNotEmpty) {
    buf.writeln("## 📝 待复习笔记");
    for (final Map<String, dynamic> n in notes) {
      buf.writeln("- ${(n["title"] ?? "").toString()}");
    }
  }

  final List<Map<String, dynamic>> hits = listOf("interestHits");
  if (hits.isNotEmpty) {
    buf.writeln("## 🔥 兴趣热搜");
    for (final Map<String, dynamic> h in hits) {
      buf.writeln("- ${_interestHitText(h)}");
    }
  }

  final List<Map<String, dynamic>> days = listOf("upcomingImportantDays");
  if (days.isNotEmpty) {
    buf.writeln("## 🎉 近期重要日子");
    for (final Map<String, dynamic> d in days) {
      buf.writeln("- ${_importantDayText(d)}");
    }
  }

  return buf.toString();
}

/// 极小 markdown 渲染器（卡面内容子集，零依赖）：
/// `##` 标题、`- ` 列表、`**加粗**`、空行分隔；其余行为纯文本段落。
/// 先整体 HTML 转义再施加行内标记，杜绝内容注入。
String _markdownToHtml(String md) {
  final StringBuffer html = StringBuffer();
  final List<String> listItems = <String>[];
  // 行首加粗且为 HH:mm = 时间列（tm 蓝色定宽）；其余加粗 = 普通强调（白色），
  // 如热搜标题、重要日子倒计时。
  String renderLi(String item) {
    final Match? m = RegExp(r"^<strong>(.*?)</strong>").firstMatch(item);
    if (m == null) return item;
    final String text = m.group(1) ?? "";
    // 行首加粗且内容为 HH:mm 才算时间列（tm 蓝色定宽）；其余加粗按普通强调
    final bool isTime = RegExp(r"^\d{1,2}:\d{2}$").hasMatch(text);
    return isTime
        ? "<strong class=\"tm\">$text</strong>${item.substring(m.end)}"
        : item;
  }

  void flushList() {
    if (listItems.isEmpty) return;
    html.write("<ul>");
    for (final String item in listItems) {
      html.write("<li>${renderLi(item)}</li>");
    }
    html.write("</ul>");
    listItems.clear();
  }

  for (final String rawLine in md.split("\n")) {
    final String line = rawLine.trim();
    if (line.isEmpty) {
      flushList();
    } else if (line.startsWith("## ")) {
      flushList();
      html.write("<h2>${_inlineMarkdown(_esc(line.substring(3).trim()))}</h2>");
    } else if (line.startsWith("- ")) {
      listItems.add(_inlineMarkdown(_esc(line.substring(2).trim())));
    } else {
      flushList();
      html.write("<p>${_inlineMarkdown(_esc(line))}</p>");
    }
  }
  flushList();
  return html.toString();
}

/// 行内标记：`**bold**` → strong（转义后的文本上做，安全）。
String _inlineMarkdown(String escaped) {
  return escaped.replaceAllMapped(
    RegExp(r"\*\*(.+?)\*\*"),
    (Match m) => "<strong>${m.group(1)}</strong>",
  );
}

/// 生成简报卡片页面（与窗口同尺寸，透明背景 + 圆角卡片）。
///
/// 2026-09-24 结构化行卡版式：无「展开详情」，一眼看全；2026-09-25 起
/// 卡面内容由 markdown 文档驱动（_composeBriefingMarkdown → _markdownToHtml），
/// 口播稿只在全空兜底时上卡（正常路径口播稿只进 TTS 不进眼睛）。
String buildBriefingHtml(DailyBriefingWindowPayload? payload) {
  final DailyBriefingCardContent content = payload == null
      ? const DailyBriefingCardContent(
          greeting: "", meta: "", script: "", stats: <DailyBriefingStat>[])
      : buildDailyBriefingCard(
          briefing: payload.briefing,
          narrationText: payload.narrationText,
          appellation: payload.appellation,
        );
  final Map<String, dynamic>? briefing = payload?.briefing;
  final _BriefingLayout layout = _BriefingLayout.of(briefing);

  // meta 只放日期
  final String metaLine = dailyBriefingDateLabel(DateTime.now());

  final String narration = payload?.narrationText.trim() ?? "";
  final bool scriptFallback =
      payload != null && !layout.hasAnySection && narration.isNotEmpty;
  final String scriptHtml = scriptFallback
      ? "<div class=\"script\">${_highlightScript(_esc(narration))}</div>"
      : "";

  final String mdHtml =
      _markdownToHtml(_composeBriefingMarkdown(briefing, layout));

  return """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    /* 不透明深底：与窗口/WebView 底色一致，圆角残留由原生 DWM 圆角裁掉 */
    background: rgb(10, 11, 14);
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    user-select: none; overflow: hidden;
    color: #eceff4;
  }
  .widget {
    position: relative;
    width: ${kCardWidth}px;
    min-height: 100%;
    background: rgba(10, 11, 14, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), inset 1px 0 0 rgba(255, 255, 255, 0.05);
    padding: 20px 22px 18px;
    overflow: hidden;
    cursor: pointer;
  }
  .close {
    position: absolute; top: 8px; right: 8px; z-index: 5;
    width: 34px; height: 34px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.45); cursor: pointer; transition: all .15s;
  }
  .close:hover { background: rgba(255,255,255,0.12); color: #eceff4; }
  .close svg { width: 16px; height: 16px; }

  /* ── 行高钉死区（briefingWindowHeight 按同一组常量累加，改这里必须同步改 Dart）── */
  .greet .name { font-size: 17px; font-weight: 600; line-height: 24px; letter-spacing: .3px; }
  .greet .meta { margin-top: 5px; font-size: 12px; line-height: 17px; color: #8f97a3; letter-spacing: .2px; }

  /* ── markdown 内容层样式 ── */
  .md p { margin: 12px 0 0; height: 20px; line-height: 20px; font-size: 12.5px; color: #8f97a3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .md p strong { color: #ccd2db; font-weight: 600; margin-right: 6px; }
  .md h2 { margin: 14px 0 0; height: 15px; line-height: 15px; display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: #8f97a3; letter-spacing: 2px; font-weight: 600; }
  .md h2::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,.06); }
  .md ul { margin: 0; padding: 0; list-style: none; }
  .md li { height: 30px; line-height: 30px; padding: 0 6px; border-radius: 10px; font-size: 13px; color: #eceff4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .md li:hover { background: rgba(255,255,255,.04); }
  .md li strong { color: #eceff4; font-weight: 600; }
  .md li strong.tm { color: #a8c8ff; display: inline-block; width: 42px; font-variant-numeric: tabular-nums; }
  .md ul + p { margin: 4px 0 0; height: 18px; line-height: 18px; padding: 0 6px; font-size: 11.5px; color: #5c6370; }

  .script { margin-top: 15px; font-size: 14px; line-height: 25px; color: #ccd2db; letter-spacing: .2px; }
  .script .hl { color: #eceff4; font-weight: 600; }

  /* 播报状态行：wave/idle 同盒同高（34 = 12 padding + 22），切换不跳动 */
  .status {
    margin-top: 14px; padding-top: 12px; height: 34px;
    border-top: 1px solid rgba(255,255,255,.07);
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: #8f97a3; letter-spacing: 2px;
  }
  #row-idle { display: none; }
  .status .ok { width: 5px; height: 5px; border-radius: 50%; background: #88bbff; box-shadow: 0 0 6px rgba(136,187,255,.8); flex-shrink: 0; }
  .status .time { margin-left: auto; font-variant-numeric: tabular-nums; letter-spacing: 0; }
  .wave { display: flex; align-items: center; gap: 3px; height: 16px; }
  .wave i { width: 3px; border-radius: 2px; background: #88bbff; animation: bar 1s ease-in-out infinite; }
  .wave i:nth-child(1) { height: 6px; animation-delay: 0s; }
  .wave i:nth-child(2) { height: 12px; animation-delay: .15s; }
  .wave i:nth-child(3) { height: 16px; animation-delay: .3s; }
  .wave i:nth-child(4) { height: 10px; animation-delay: .45s; }
  .wave i:nth-child(5) { height: 13px; animation-delay: .6s; }
  .wave i:nth-child(6) { height: 7px; animation-delay: .75s; }
  .wave i:nth-child(7) { height: 11px; animation-delay: .9s; }
  @keyframes bar { 0%,100% { transform: scaleY(.4); opacity: .5; } 50% { transform: scaleY(1); opacity: 1; } }
</style>
</head>
<body>
<div class="widget" id="card">
  <div class="close" id="close" title="关闭">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </div>

  <div class="greet" id="dragzone">
    <div>
      <div class="name">${_esc(content.greeting)}</div>
      <div class="meta">${_esc(metaLine)}</div>
    </div>
  </div>

  <div class="md">$mdHtml</div>
  $scriptHtml

  <div class="status" id="row-wave">
    <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div>语音播报中</div>
    <div class="time" id="tprog">00:00 / 00:00</div>
  </div>
  <div class="status" id="row-idle"><span class="ok"></span><span id="idle-label">已播报</span></div>
</div>

<script>
  var pai = function (m) { try { window.chrome.webview.postMessage(m); } catch (e) {} };
  function fmt(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(m) + ":" + p(s);
  }
  document.getElementById("close").addEventListener("click", function (e) {
    e.stopPropagation(); pai({ action: "close" });
  });
  // 整卡点击/拖拽判定（此前只绑 greet 区 pointerdown 直接进原生拖拽，
  // 拖拽循环吞掉 click，导致顶部点击不播报）：
  //   按下后位移 ≤6px 松开 = 点击 → 播报/停止/重播；
  //   位移超阈值 = 拖拽 → startDragging（原生接管，不再回吐 click）。
  var card = document.getElementById("card");
  var downX = 0, downY = 0, pressed = false, dragSent = false;
  function onControl(t) { return !!(t && t.closest && t.closest("#close")); }
  card.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || onControl(e.target)) return;
    pressed = true; dragSent = false; downX = e.clientX; downY = e.clientY;
  });
  card.addEventListener("pointermove", function (e) {
    if (!pressed || dragSent) return;
    if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) {
      dragSent = true;
      pai({ action: "drag" });
    }
  });
  card.addEventListener("pointerup", function (e) {
    if (!pressed) return;
    var wasDrag = dragSent;
    pressed = false; dragSent = false;
    if (!wasDrag && e.button === 0 && !onControl(e.target)) pai({ action: "click" });
  });
  card.addEventListener("pointercancel", function () {
    pressed = false; dragSent = false;
  });
  window.__setPlaying = function (posMs, durMs) {
    document.getElementById("row-wave").style.display = "flex";
    document.getElementById("row-idle").style.display = "none";
    document.getElementById("tprog").textContent = fmt(posMs) + " / " + fmt(durMs || 0);
  };
  window.__setIdle = function (label) {
    document.getElementById("row-wave").style.display = "none";
    document.getElementById("row-idle").style.display = "flex";
    document.getElementById("idle-label").textContent = label;
  };
</script>
</body>
</html>
""";
}


Future<void> main(List<String> args) async {
  final String raw = await File(args[0]).readAsString();
  final DailyBriefingWindowPayload? payload = DailyBriefingWindowPayload.tryDecode(raw);
  final String html = buildBriefingHtml(payload);
  final String preview = html.replaceFirst(
    "</body>",
    '<script>window.__setIdle && window.__setIdle("已播报 · 09:00 · 点击重播");</script>' + String.fromCharCode(10) + "</body>",
  );
  await File(args[1]).writeAsString(preview, flush: true);
  stdout.writeln("written: ${args[1]}");
  stdout.writeln("window height = ${briefingWindowHeight(payload)}");
}
