// 今日简报卡面渲染层（纯 Dart，零 Flutter 依赖）。
//
// 拆出原因（2026-10-20）：卡面 HTML / 高度估算 / 内容拼装此前与窗口宿主同文件，
// 而 tool/preview_briefing.dart 只能整份复制一遍才能预览——一处改动要同步两处
// （TTS 断线时就已经踩过一次）。这里集中所有纯函数，窗口宿主与预览工具共用：
//   - kCardWidth           卡片逻辑宽（与 CSS 像素 1:1）
//   - briefingWindowHeight 首帧窗口高估算（真实高度由页面 JS 上报后校正）
//   - buildBriefingHtml    卡面 HTML（抬头 + 摘要带 + 分组面板）
//
// 依赖 daily_briefing_card_model（同为纯 Dart），故 `dart run` 的预览工具可直接
// 引用本文件，不再复制代码。
import "daily_briefing_card_model.dart";

/// 卡片逻辑宽（= 设计稿宽，Flutter 逻辑像素与 CSS 像素 1:1）。
const double kCardWidth = 400;

/// 首帧窗口高（逻辑像素）：仅作初始估算，页面加载后由 JS 上报真实内容高
/// （postMessage {action:"height"}）再由宿主 setSize 精确校正——新版行标题允许
/// 两行换行，纯常量累加已无法钉死高度；本函数按「每行一行」估，误差由校正兜底。
double briefingWindowHeight({
  Map<String, dynamic>? briefing,
  String narrationText = "",
}) {
  const double padTop = 20, padBottom = 18;
  const double greetH = 24, metaGap = 4, metaH = 17;
  const double heroGap = 14, heroPad = 22, heroLineH = 21;
  const double firstPanelGap = 14, panelGap = 10;
  const double panelPad = 23, panelHeadH = 18, rowH = 24, footGap = 27;

  final _BriefingData data = _BriefingData.of(briefing);

  double h = padTop + greetH + metaGap + metaH + padBottom;
  if (narrationText.trim().isNotEmpty) {
    h += heroGap + heroPad + heroLineH;
  }

  // 逐面板累加（rows=行数，foot=是否有脚注行）；无数据的面板不进列表。
  final List<(int rows, bool foot)> panels = <(int rows, bool foot)>[
    if (data.schedule.isNotEmpty) (data.schedule.length, false),
    if (data.todoPending.isNotEmpty)
      (data.todoPending.length, data.doneTodayCount > 0),
    if (data.notes.isNotEmpty) (data.notes.length, false),
    if (data.hits.isNotEmpty) (data.hits.length, false),
    if (data.days.isNotEmpty) (data.days.length, false),
  ];
  for (int i = 0; i < panels.length; i++) {
    final (int rows, bool foot) = panels[i];
    h += (i == 0 ? firstPanelGap : panelGap) +
        panelPad +
        panelHeadH +
        rows * rowH +
        (foot ? footGap : 0);
  }
  return h;
}

/// 卡面数据抽取（内容拼装与高度估算共用同一份，防两端不一致）。
class _BriefingData {
  const _BriefingData({
    required this.schedule,
    required this.todoPending,
    required this.doneTodayCount,
    required this.notes,
    required this.hits,
    required this.days,
  });

  final List<Map<String, dynamic>> schedule;
  final List<String> todoPending;
  final int doneTodayCount;
  final List<Map<String, dynamic>> notes;
  final List<Map<String, dynamic>> hits;
  final List<Map<String, dynamic>> days;

  static _BriefingData of(Map<String, dynamic>? briefing) {
    List<Map<String, dynamic>> listOf(String key) {
      final Object? raw = briefing?[key];
      if (raw is! List) return const <Map<String, dynamic>>[];
      return raw
          .whereType<Map>()
          .map((Map e) => e.cast<String, dynamic>())
          .toList();
    }

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

    return _BriefingData(
      schedule: listOf("todaySchedule"),
      todoPending: pending,
      doneTodayCount: doneCount,
      notes: listOf("pendingNotes"),
      hits: listOf("interestHits"),
      days: listOf("upcomingImportantDays"),
    );
  }
}

String _esc(String text) => text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");

/// 摘要带时间高亮：HH:MM → 白色加粗。
String _highlightScript(String plainEscaped) {
  return plainEscaped.replaceAllMapped(
    RegExp(r"(\d{1,2}:\d{2})"),
    (Match m) => "<b class=\"hl\">${m.group(1)}</b>",
  );
}

/// 时间行：时间徽标 + 标题（标题两行内自适应由 CSS -webkit-line-clamp 控制）。
String _itTime(String time, String title) {
  final String t = time.trim();
  final String tm = t.isEmpty ? "" : '<span class="tm">${_esc(t)}</span>';
  return '<div class="it">$tm<div class="tt">${_esc(title.trim())}</div></div>';
}

/// 圆点行（无时间列：待办 / 笔记 / 热搜 / 纪念日 / 行程标签）。
String _itBullet(String text, {bool amber = false}) {
  return '<div class="it"><span class="bul${amber ? " amber" : ""}"></span>'
      '<div class="tt">${_esc(text.trim())}</div></div>';
}

/// 分组面板：头（主色方块 + 标签 + 可选计数）+ 行 + 可选脚注。
String _panel({
  required String label,
  required String inner,
  String count = "",
  String foot = "",
  bool amber = false,
  bool first = false,
}) {
  final String cnt = count.isEmpty ? "" : '<span class="n">${_esc(count)}</span>';
  final String footHtml = foot.isEmpty ? "" : '<div class="p-foot">${_esc(foot)}</div>';
  return '<section class="panel${first ? " first" : ""}">'
      '<div class="p-h"><span class="dot${amber ? " amber" : ""}"></span>'
      '${_esc(label)}$cnt</div>$inner$footHtml</section>';
}

/// 兴趣热搜行文案：「标题 · 平台」。
String _interestHitText(Map<String, dynamic> item) {
  final String title = item["title"]?.toString() ?? "";
  final String platform = item["platform"]?.toString() ?? "";
  return platform.isEmpty ? title : "$title · $platform";
}

/// 重要日子行文案：「妈妈的生日 · 还有 3 天」。
String _importantDayText(Map<String, dynamic> item) {
  final String name = item["name"]?.toString() ?? "";
  final String type = item["type"]?.toString() ?? "";
  final String typeLabel =
      type == "anniversary" ? "纪念日" : type == "custom" ? "特殊日子" : "生日";
  final Object? rawDays = item["daysUntil"];
  final String when = rawDays is int
      ? (rawDays == 0 ? "就是今天" : rawDays == 1 ? "明天" : "还有 $rawDays 天")
      : "";
  return "$name的$typeLabel${when.isEmpty ? "" : " · $when"}";
}

/// 卡面内容层：摘要带（置顶）+ 各数据板块的分组面板。
///
/// 2026-10-20 版式（用户拍板：摘要置顶 + 分组面板结合）：口播稿回到卡面当
/// 「今日一句话」；某板块没数据 → 整块不渲染（不出现空面板、不留空位）；
/// 行标题两行内自适应。全部先 HTML 转义再拼，杜绝内容注入。
String _composeBriefingBody(_BriefingData d, String narration) {
  final StringBuffer buf = StringBuffer();

  // 摘要带（置顶）：口播稿即「今日一句话」；空则整条不出现
  final String hero = narration.trim();
  if (hero.isNotEmpty) {
    buf.write('<div class="hero">${_highlightScript(_esc(hero))}</div>');
  }

  // 首个面板用更大的上间距；无数据的面板整体不进（调用处按需 if 判断）。
  bool first = true;
  String panel(
    String label,
    String inner, {
    String count = "",
    String foot = "",
    bool amber = false,
  }) {
    final String html = _panel(
      label: label,
      inner: inner,
      count: count,
      foot: foot,
      amber: amber,
      first: first,
    );
    first = false;
    return html;
  }

  // 今日日程
  if (d.schedule.isNotEmpty) {
    final StringBuffer rows = StringBuffer();
    for (final Map<String, dynamic> s in d.schedule) {
      final String title = s["title"]?.toString() ?? "";
      if (title.trim().isEmpty) continue;
      rows.write(_itTime(s["time"]?.toString() ?? "", title));
    }
    if (rows.isNotEmpty) {
      buf.write(panel("📅 今日日程", rows.toString(), count: "${d.schedule.length}"));
    }
  }

  // 待办跟进（之前交代未完成 + 今日已办结脚注）
  if (d.todoPending.isNotEmpty) {
    final StringBuffer rows = StringBuffer();
    for (final String p in d.todoPending) {
      rows.write(_itBullet(p));
    }
    buf.write(panel(
      "✅ 待办跟进",
      rows.toString(),
      foot: d.doneTodayCount > 0 ? "今天已完成 ${d.doneTodayCount} 件" : "",
    ));
  }

  // 待复习笔记
  if (d.notes.isNotEmpty) {
    final StringBuffer rows = StringBuffer();
    for (final Map<String, dynamic> n in d.notes) {
      final String title = n["title"]?.toString() ?? "";
      if (title.trim().isEmpty) continue;
      rows.write(_itBullet(title));
    }
    if (rows.isNotEmpty) {
      buf.write(panel("📝 待复习笔记", rows.toString(), count: "${d.notes.length}"));
    }
  }

  // 兴趣热搜
  if (d.hits.isNotEmpty) {
    final StringBuffer rows = StringBuffer();
    for (final Map<String, dynamic> h in d.hits) {
      final String text = _interestHitText(h);
      if (text.trim().isEmpty) continue;
      rows.write(_itBullet(text));
    }
    if (rows.isNotEmpty) {
      buf.write(panel("🔥 兴趣热搜", rows.toString(), count: "${d.hits.length}"));
    }
  }

  // 近期重要日子（琥珀色：唯一暖色，拉注意力）
  if (d.days.isNotEmpty) {
    final StringBuffer rows = StringBuffer();
    for (final Map<String, dynamic> day in d.days) {
      rows.write(_itBullet(_importantDayText(day), amber: true));
    }
    buf.write(panel("🎉 近期重要日子", rows.toString(), amber: true));
  }

  return buf.toString();
}

/// 抬头右侧统计胶囊（最多 3 项、0 值省略——再多会挤爆抬头行）。
String _buildChips(_BriefingData d) {
  final List<String> chips = <String>[];
  void add(String label, int count) {
    if (count > 0 && chips.length < 3) {
      chips.add('<span class="chip"><b>$count</b>${_esc(label)}</span>');
    }
  }

  add("日程", d.schedule.length);
  add("待办", d.todoPending.length);
  add("笔记", d.notes.length);
  add("热搜", d.hits.length);
  add("纪念日", d.days.length);
  return chips.isEmpty ? "" : '<div class="chips">${chips.join()}</div>';
}

/// 生成简报卡片页面（与窗口同尺寸，深底 + 圆角卡片）。
///
/// 2026-10-20 版式：抬头（问候/日期 + 统计胶囊）→ 摘要带置顶 → 分组面板；
/// 卡面无 TTS 状态行，内容层由 _composeBriefingBody 直出结构化 HTML。
String buildBriefingHtml({
  Map<String, dynamic>? briefing,
  String narrationText = "",
  String appellation = "",
}) {
  final DailyBriefingCardContent content = buildDailyBriefingCard(
    briefing: briefing ?? const <String, dynamic>{},
    narrationText: narrationText,
    appellation: appellation,
  );

  // meta 只放日期；抬头问候带称呼（无称呼/空载荷时兜底「今日简报」）
  final String metaLine = dailyBriefingDateLabel(DateTime.now());
  final String greetLine =
      content.greeting.trim().isEmpty ? "今日简报" : content.greeting;

  final _BriefingData data = _BriefingData.of(briefing);
  final String chipsHtml = _buildChips(data);
  final String bodyHtml = _composeBriefingBody(data, narrationText);

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

  /* 卡片：条目极多、内容超出窗口时内部滚动，绝不裁掉内容 */
  .widget {
    position: relative;
    width: ${kCardWidth}px;
    max-height: 100%; overflow-y: auto; overflow-x: hidden;
    background: rgba(10, 11, 14, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), inset 1px 0 0 rgba(255, 255, 255, 0.05);
    padding: 20px 22px 18px;
    cursor: default;
  }
  .widget::-webkit-scrollbar { width: 6px; }
  .widget::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
  .widget::-webkit-scrollbar-track { background: transparent; }

  .close {
    position: absolute; top: 8px; right: 8px; z-index: 5;
    width: 34px; height: 34px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.45); cursor: pointer; transition: all .15s;
  }
  .close:hover { background: rgba(255,255,255,0.12); color: #eceff4; }
  .close svg { width: 16px; height: 16px; }

  /* ── 抬头：问候 + 日期 + 右侧统计胶囊 ── */
  .head { display: flex; align-items: flex-start; gap: 12px; }
  .head .t { min-width: 0; }
  .head .name { font-size: 17px; font-weight: 600; line-height: 24px; letter-spacing: .3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head .meta { margin-top: 4px; font-size: 12px; line-height: 17px; color: #8f97a3; }
  .chips { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; padding-top: 3px; }
  .chip { font-size: 10.5px; color: #8f97a3; letter-spacing: .5px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.06);
    border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .chip b { color: #eceff4; font-weight: 600; margin-right: 3px; font-variant-numeric: tabular-nums; }

  /* ── 摘要带（置顶）：口播稿回到卡面当「今日一句话」 ── */
  .hero { margin-top: 14px; font-size: 13px; line-height: 21px; color: #ccd2db;
    padding: 11px 13px; background: rgba(136,187,255,.07);
    border: 1px solid rgba(136,187,255,.16); border-radius: 12px; }
  .hero .hl { color: #eceff4; font-weight: 600; }

  /* ── 分组面板：无数据的板块整块不出现、不留空位 ── */
  .panel { margin-top: 10px; background: rgba(255,255,255,.035);
    border: 1px solid rgba(255,255,255,.055); border-radius: 12px;
    padding: 11px 14px 12px; }
  .panel.first { margin-top: 14px; }
  .p-h { display: flex; align-items: center; gap: 7px; font-size: 11px; letter-spacing: 1px;
    line-height: 15px; color: #8f97a3; font-weight: 600; margin-bottom: 3px; }
  .p-h .dot { width: 6px; height: 6px; border-radius: 2px; background: #88bbff; flex-shrink: 0; }
  .p-h .dot.amber { background: #f0c052; }
  .p-h .n { margin-left: auto; color: #5c6370; font-weight: 400; font-variant-numeric: tabular-nums; }
  .it { display: flex; gap: 10px; align-items: flex-start; padding-top: 5px; }
  .it .tm { width: 44px; flex-shrink: 0; color: #a8c8ff; font-size: 12.5px; line-height: 19px;
    font-weight: 600; font-variant-numeric: tabular-nums; }
  .it .bul { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,.28);
    margin: 7px 4px 0 0; flex-shrink: 0; }
  .it .bul.amber { background: #f0c052; }
  .it .tt { font-size: 13px; line-height: 19px; color: #eceff4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .p-foot { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,.07);
    font-size: 11.5px; color: #5c6370; }

  /* ── 行高常量（briefingWindowHeight 首帧估算用同一组：行 24=5+19、面板 10 间距 +
     23 内边距 + 18 面板头(15+3)、脚注 27、摘要带 14+22+21、抬头 24+4+17）；
     真实高度由页面加载后 JS 上报（action:"height"）校正 ── */
</style>
</head>
<body>
<div class="widget" id="card">
  <div class="close" id="close" title="关闭">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </div>

  <div class="head">
    <div class="t">
      <div class="name">${_esc(greetLine)}</div>
      <div class="meta">${_esc(metaLine)}</div>
    </div>
    $chipsHtml
  </div>
  $bodyHtml
</div>

<script>
  var pai = function (m) { try { window.chrome.webview.postMessage(m); } catch (e) {} };
  document.getElementById("close").addEventListener("click", function (e) {
    e.stopPropagation(); pai({ action: "close" });
  });
  // 整卡拖拽判定：按下后位移超 6px 视作拖拽 → startDragging（原生接管）。
  // 2026-10-20 TTS 断线后点击卡片不再有行为，故只保留拖拽。
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
  card.addEventListener("pointerup", function () { pressed = false; dragSent = false; });
  card.addEventListener("pointercancel", function () { pressed = false; dragSent = false; });

  // 内容加载完成后上报真实高度（新版行标题可两行换行，纯常量累加钉不死高度）：
  // +2 = 卡片上下各 1px 描边（scrollHeight 不含 border）。宿主 setSize 校正；
  // 浏览器预览（tool/preview_briefing.dart）下无宿主，消息静默丢弃。
  function reportHeight() {
    var el = document.getElementById("card");
    if (!el) return;
    pai({ action: "height", value: Math.ceil(el.scrollHeight) + 2 });
  }
  var fontsReady = (document.fonts && document.fonts.ready) || null;
  if (fontsReady) {
    fontsReady.then(function () { requestAnimationFrame(reportHeight); });
  } else {
    requestAnimationFrame(reportHeight);
  }
  window.addEventListener("load", function () { requestAnimationFrame(reportHeight); });
</script>
</body>
</html>
""";
}
