/// 右侧抽屉要展示的内容种类。
/// （行程规划不在此列：它以独立全屏界面打开，见 TravelPlanFullscreenPage。
///   设置同样不在此列：它以独立全屏界面打开，见 SettingsPage。
///   图库不在此列：2026-09-29 起退出一级 tab，走常用工具入口以全屏路由
///   打开（见 GalleryWorkbenchPage），右面板窄栏放不下 3D 照片墙。）
enum RightPanelKind { friends, messages, devices, schedule, imagePreview, videoPreview, browser, catalog, approvals, contentSummary, agentHome }

/// 宽屏布局断点：>= 此宽度时对话页显示右侧面板。
const double kWideLayoutBreakpoint = 820;

/// 各面板类型的默认左右占比（leftRatio = 左聊天区占比）。
/// - 消息/好友类：信息密度低，右面板小占比（左大右小）
/// - 设备/日程类：需要更大展示空间，右面板占比略大
extension RightPanelKindDefaults on RightPanelKind {
  /// 打开时左聊天区占可用宽度的比例（0.1~0.9）。
  /// 越大表示聊天区越宽、右面板越窄。
  double get defaultSplitRatio {
    switch (this) {
      case RightPanelKind.messages:
        return 0.62; // 消息聚合：右面板较窄
      case RightPanelKind.friends:
        return 0.58; // 好友列表：右面板较窄
      case RightPanelKind.devices:
        return 0.42; // 设备展示：需要更大空间
      case RightPanelKind.schedule:
        return 0.45; // 日程：日历周视图 + 事项列表，需要较大空间
      case RightPanelKind.imagePreview:
        return 0.52; // 图片预览：右栏显示原图，需较大空间
      case RightPanelKind.videoPreview:
        return 0.42; // 视频播放：16:9 画面需要较大宽度
      case RightPanelKind.browser:
        return 0.42; // 浏览器：网页内容需要较大空间
      case RightPanelKind.catalog:
        return 0.5; // 能力面板：域列表 + 明细两级视图
      case RightPanelKind.approvals:
        return 0.6; // 待确认收件箱：卡片流，右面板较窄
      case RightPanelKind.contentSummary:
        return 0.42; // 内容详情：长文阅读（书签栏 + 正文），需要较大空间
      case RightPanelKind.agentHome:
        return 0.55; // Agent 主页：动态卡片流，右面板中等宽度
    }
  }
}

/// 顶栏标题占位（对话 tab 为空；钱包占位为空）。
const List<String> kTabTitles = <String>[
  "",
  "",
];

/// 从多行状态文本中取最后一行非空行，并截断到 120 字符。
String shortLiveStatusLine(String text) {
  final String trimmed = text.trim();
  if (trimmed.isEmpty) return "";
  final List<String> lines = trimmed
      .split(RegExp(r"\r?\n"))
      .map((String s) => s.trim())
      .where((String s) => s.isNotEmpty)
      .toList();
  String line = lines.isNotEmpty ? lines.last : trimmed;
  if (line.length > 120) {
    line = "${line.substring(0, 119)}…";
  }
  return line;
}

/// 判断工具名是否为「主控调用子 Agent」工具（两种命名风格兼容）。
bool isMasterInvokeSubAgentTool(String toolName) {
  final String n = toolName.trim();
  return n == "master.invoke_sub_agent" || n == "master_invoke_sub_agent";
}

/// 平台标识 → 中文显示名。
String platformDisplayName(String platform) {
  switch (platform) {
    case "wechat":
      return "微信";
    case "qq":
      return "QQ";
    case "feishu":
      return "飞书";
    default:
      return "其他";
  }
}

/// 右侧面板标题。
String rightPanelTitle(RightPanelKind kind) {
  switch (kind) {
    case RightPanelKind.friends:
      return "好友";
    case RightPanelKind.messages:
      return "消息聚合";
    case RightPanelKind.devices:
      return "我的设备";
    case RightPanelKind.schedule:
      return "日程";
    case RightPanelKind.imagePreview:
      return "图片预览";
    case RightPanelKind.videoPreview:
      return "视频播放";
    case RightPanelKind.browser:
      return "浏览器";
    case RightPanelKind.catalog:
      return "能力面板";
    case RightPanelKind.approvals:
      return "决策中心";
    case RightPanelKind.contentSummary:
      // 内容详情面板自带完整顶栏（图标+标题+板块副标题），
      // 面板 chrome 对本类型隐藏默认标题，此处仅作兜底。
      return "内容详情";
    case RightPanelKind.agentHome:
      return "主页";
  }
}

/// 移动端简报摘要文本（2026-10-16 天气/穿衣迁出简报，摘要只留日程）。
String buildMobileBriefingSummary(Map<String, dynamic> briefing) {
  final List<String> parts = <String>[];
  final Object? schedule = briefing["todaySchedule"];
  if (schedule is List && schedule.isNotEmpty) {
    final Object? first = schedule.first;
    if (first is Map) {
      final String title = first["title"]?.toString() ?? "";
      final String time = first["time"]?.toString() ?? "";
      if (title.isNotEmpty) {
        parts.add(time.isEmpty ? title : "$time $title");
      }
    }
  }
  return parts.isEmpty ? "点击查看今天的简报内容" : parts.join(" · ");
}

/// 桌面端简报摘要文本（多行）。
String buildDesktopBriefingSummary(Map<String, dynamic> briefing) {
  final List<String> lines = <String>[];
  final String greeting = briefing["agentGreeting"]?.toString() ??
      briefing["greeting"]?.toString() ??
      "";
  if (greeting.isNotEmpty) {
    lines.add(greeting);
  }
  final Object? schedule = briefing["todaySchedule"];
  if (schedule is List && schedule.isNotEmpty) {
    final List<String> top = <String>[];
    for (final Object? item in schedule.take(3)) {
      if (item is Map) {
        final String time = item["time"]?.toString() ?? "";
        final String title = item["title"]?.toString() ?? "";
        if (title.isNotEmpty) {
          top.add(time.isEmpty ? title : "$time $title");
        }
      }
    }
    if (top.isNotEmpty) {
      lines.add("安排：${top.join("；")}");
    }
  }
  return lines.isEmpty ? "今天的简报已经准备好了。" : lines.join("\n");
}
