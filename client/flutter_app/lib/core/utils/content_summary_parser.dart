import "dart:convert";

class ContentSummarySectionInfo {
  const ContentSummarySectionInfo({
    required this.title,
    required this.pointCount,
  });

  final String title;
  final int pointCount;

  factory ContentSummarySectionInfo.fromJson(Map<String, dynamic> json) {
    return ContentSummarySectionInfo(
      title: json["title"]?.toString() ?? "",
      pointCount: _asInt(json["pointCount"]),
    );
  }
}

/// 从响应中提取的结构化条目（典型来源：search_web 返回的 items 数组）。
/// 仅在 briefText 中检测到 items 数组时填充，UI 用作「折叠框内嵌的搜索结果列表」。
class ContentSummaryItem {
  const ContentSummaryItem({
    required this.title,
    this.url,
    this.snippet,
    this.source,
    this.publishedAt,
  });

  final String title;
  final String? url;
  final String? snippet;
  final String? source;
  final String? publishedAt;

  bool get hasContent => title.isNotEmpty || (snippet?.isNotEmpty ?? false);
}

/// 气泡简洁要点（服务端 briefPoints）：折叠卡上方展示的概要内容，
/// 详细正文在折叠卡对应的右侧面板/弹窗中。
class ContentSummaryBriefPoint {
  const ContentSummaryBriefPoint({required this.icon, required this.text});

  final String icon;
  final String text;

  factory ContentSummaryBriefPoint.fromJson(Map<String, dynamic> json) {
    return ContentSummaryBriefPoint(
      icon: json["icon"]?.toString() ?? "•",
      text: json["text"]?.toString() ?? "",
    );
  }

  bool get hasContent => text.trim().isNotEmpty;
}

class ContentSummaryDataV2 {
  const ContentSummaryDataV2({
    required this.id,
    required this.category,
    required this.title,
    required this.cardIcon,
    required this.cardLabel,
    required this.briefCount,
    this.briefPoints = const <ContentSummaryBriefPoint>[],
    this.detailContent,
    this.sections,
    this.metadata,
  });

  final String id;
  final String category;
  final String title;
  final String cardIcon;
  final String cardLabel;
  final int briefCount;
  final List<ContentSummaryBriefPoint> briefPoints;
  final String? detailContent;
  final List<ContentSummarySectionInfo>? sections;
  final Map<String, dynamic>? metadata;

  factory ContentSummaryDataV2.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawSections = json["sections"] as List<dynamic>?;
    final List<dynamic>? rawBriefPoints =
        json["briefPoints"] as List<dynamic>?;
    return ContentSummaryDataV2(
      id: json["id"]?.toString() ?? "",
      category: json["category"]?.toString() ?? "general",
      title: json["title"]?.toString() ?? "",
      cardIcon: json["cardIcon"]?.toString() ?? "☰",
      cardLabel: json["cardLabel"]?.toString() ?? "详情",
      briefCount: _asInt(json["briefCount"]),
      briefPoints: (rawBriefPoints ?? const <dynamic>[])
          .whereType<Map>()
          .map(
            (Map raw) => ContentSummaryBriefPoint.fromJson(
              raw.cast<String, dynamic>(),
            ),
          )
          .where((ContentSummaryBriefPoint p) => p.hasContent)
          .toList(),
      detailContent: json["detailContent"]?.toString(),
      sections: rawSections
          ?.whereType<Map<String, dynamic>>()
          .map(ContentSummarySectionInfo.fromJson)
          .toList(),
      metadata: (json["metadata"] as Map?)?.cast<String, dynamic>(),
    );
  }
}

class ContentSummaryParseResult {
  const ContentSummaryParseResult({
    required this.summary,
    required this.briefText,
    required this.cleanedText,
    this.structuredItems = const <ContentSummaryItem>[],
  });

  final ContentSummaryDataV2? summary;
  final String briefText;
  final String cleanedText;

  /// 从 briefText 中解析出的结构化条目（如 search_web 的 items 列表）。
  /// UI 应优先渲染此字段，结构化渲染后再展示 briefText 中剩余的纯文本部分。
  final List<ContentSummaryItem> structuredItems;
}

class ContentSummaryParser {
  ContentSummaryParser._();

  static const String startMarker = "[CONTENT_SUMMARY_V2_START]";
  static const String endMarker = "[CONTENT_SUMMARY_V2_END]";
  static final RegExp cardMarker = RegExp(
    r'<details_card\s+ref="([^"]+)"\s*/>',
  );

  /// 渲染层兜底：把文本中的整个 CONTENT_SUMMARY_V2 块（标记对 + JSON 载荷 +
  /// 孤儿 details_card 占位）剥掉。任何把文本直接交给 markdown 渲染的路径
  /// （mediaCards 分支 / 结构化正文 / image_result 回退）都应先过这里，
  /// 保证块无论从哪条链路到达都绝不以裸 JSON 透出（2026-10-10 搜图轮泄漏）。
  /// 服务端出口也有同语义剥离（stripContentSummaryBlock），两侧任一生效即可。
  static final RegExp _summaryBlockRe = RegExp(
    r"\[CONTENT_SUMMARY_V2_START\][\s\S]*?\[CONTENT_SUMMARY_V2_END\][ \t]*",
  );
  static final RegExp _orphanDetailsCardRe = RegExp(
    r'^[ \t]*<details_card\s+ref="[^"]*"\s*/>[ \t]*$',
    multiLine: true,
  );

  static String stripSummaryBlocks(String text) {
    final String noBlock = text.replaceAll(_summaryBlockRe, "");
    // 孤儿 details_card 占位行无条件清（与服务端 stripContentSummaryBlock 同语义）
    final String cleaned = noBlock.replaceAll(_orphanDetailsCardRe, "");
    return cleaned
        .replaceAll(RegExp(r"\n{3,}"), "\n\n")
        .trim();
  }

  /// 匹配「{ ... "items": [ ... ] ... }」形式的 JSON 块。
  /// 允许内层包含嵌套花括号（外层用平衡式扫描，不依赖正则）。
  static final RegExp _itemsJsonHint = RegExp(
    r'"items"\s*:\s*\[',
  );

  static const Map<String, String> categoryLabels = <String, String>{
    "news": "资讯日报",
    "article": "长文详情",
    "search_result": "搜索结果",
    "webpage": "网页内容",
    "document": "文档资料",
    "code": "代码片段",
    "data": "调研报告",
    "list": "清单列表",
    "multi_section": "分类汇总",
    "table": "数据表格",
    "general": "详细内容",
  };

  /// 任务主体文案（优先服务端推断的 cardLabel / subjectLabel，如「科技新闻」「旅游计划」）
  static String taskSubject(ContentSummaryDataV2 summary) {
    final Object? fromMeta = summary.metadata?["subjectLabel"];
    if (fromMeta != null && fromMeta.toString().trim().isNotEmpty) {
      return fromMeta.toString().trim();
    }
    final String fromCard = summary.cardLabel.trim();
    if (fromCard.isNotEmpty && !_legacyGenericLabels.contains(fromCard)) {
      return fromCard;
    }
    return categoryLabels[summary.category] ?? "内容详情";
  }

  static const Set<String> _legacyGenericLabels = <String>{
    "详情",
    "资讯",
    "文章",
    "网页",
    "文档",
    "代码",
    "清单",
    "汇总",
    "数据表",
  };

  /// 展示形态声明标记行（[RENDER_HINT:xxx] / [RENDER_AS:xxx]）——只属于
  /// 渲染路由信号，不属于正文。历史落库消息的 detailContent 可能残留
  /// （服务端旧版只剥离文本开头的标记），展示时整行剥离。
  static final RegExp _renderDeclarationLine =
      RegExp(r"^\[RENDER_(?:HINT|AS):\w+\]$");

  /// 详情正文消毒：剥离裸露的形态标记行 + 删除与卡片标题重复的首行导语
  /// （标题即取自正文首行时，面板/弹窗顶栏已展示标题，正文不再复读）。
  /// 服务端 2026-09 起生成即消毒，此处兜底历史消息。
  static String sanitizeDetailContent(String content, String title) {
    if (content.trim().isEmpty) return content;

    // YAML front matter（首行 --- 到下一个 --- 之间，AIGC 标识等元数据）
    // 不属于正文，剥离；后续出现的 --- 是板块分隔线，保留给渲染器。
    String text = content;
    final List<String> rawLines = text.trimLeft().split("\n");
    if (rawLines.first.trim() == "---") {
      for (int i = 1; i < rawLines.length; i++) {
        if (rawLines[i].trim() == "---") {
          text = rawLines.skip(i + 1).join("\n");
          break;
        }
      }
    }

    final String titleTrim = title.trim();
    final List<String> lines = text
        .split("\n")
        .where((String line) => !_renderDeclarationLine.hasMatch(line.trim()))
        .toList();
    if (titleTrim.isEmpty) {
      return lines.join("\n").trim();
    }
    final int firstIdx =
        lines.indexWhere((String line) => line.trim().isNotEmpty);
    if (firstIdx == -1) return lines.join("\n").trim();
    final String first = lines[firstIdx].trim();
    final String firstSansHash =
        first.replaceFirst(RegExp(r"^#{1,3}\s+"), "").trim();
    final bool echoed = first == titleTrim ||
        firstSansHash == titleTrim ||
        (titleTrim.length >= 12 && first.contains(titleTrim));
    if (echoed) {
      lines.removeAt(firstIdx);
    }
    return lines.join("\n").trim();
  }

  @Deprecated("Use taskSubject(summary) for display copy")
  static String categoryLabel(String category, String cardLabel) {
    final String fromCard = cardLabel.trim();
    if (fromCard.isNotEmpty && !_legacyGenericLabels.contains(fromCard)) {
      return fromCard;
    }
    return categoryLabels[category] ?? (fromCard.isNotEmpty ? fromCard : "详情");
  }

  static ContentSummaryParseResult parse(String text) {
    final int startIndex = text.indexOf(startMarker);
    final int endIndex = text.indexOf(endMarker);
    if (startIndex == -1 || endIndex == -1 || endIndex <= startIndex) {
      return ContentSummaryParseResult(
        summary: null,
        briefText: "",
        cleanedText: text,
      );
    }

    try {
      final String jsonStr = text
          .substring(startIndex + startMarker.length, endIndex)
          .trim();
      final Map<String, dynamic> data =
          jsonDecode(jsonStr) as Map<String, dynamic>;
      final ContentSummaryDataV2 summary = ContentSummaryDataV2.fromJson(data);

      final String afterEnd =
          text.substring(endIndex + endMarker.length).trim();
      final RegExpMatch? cardMatch = cardMarker.firstMatch(afterEnd);

      String briefText = "";
      String displayText = afterEnd;
      if (cardMatch != null) {
        briefText = afterEnd.substring(0, cardMatch.start).trim();
        displayText = briefText;
      }

      // === 关键修复：剥离 briefText 中残留的 raw JSON（search_web 工具结果回显） ===
      // 现象：服务端 `[CONTENT_SUMMARY_V2_END]` 与 `<details_card>` 之间可能混入
      // `{"items":[{title,url,snippet,source,publishedAt}, ...]}` 这种结构化数据，
      // 旧逻辑会原样塞进 _BriefContentPreview，渲染为「乱码」JSON。
      // 修复：从 briefText 中提取结构化条目，剩余纯文本保留在 briefText。
      final _ExtractedStructured extracted = _extractStructuredItems(briefText);
      final List<ContentSummaryItem> structuredItems = extracted.items;
      if (structuredItems.isNotEmpty) {
        briefText = extracted.remaining.trim();
      }

      // 冗余守卫：briefText 不再自动补概要。卡片自身已展示 label + title，
      // 详情点击后在右侧双面板查看；在卡片前再垫一段生成文案属于冗余设计。
      // 服务端自 2026-09 起也不再输出 titleLine，briefText 通常为空。

      return ContentSummaryParseResult(
        summary: summary,
        briefText: briefText,
        cleanedText: displayText,
        structuredItems: structuredItems,
      );
    } catch (_) {
      return ContentSummaryParseResult(
        summary: null,
        briefText: "",
        cleanedText: text,
      );
    }
  }

  /// 在 [text] 中扫描 `"items":[ ... ]` 的 JSON 块，提取为 [ContentSummaryItem]。
  /// 已剥离的 JSON 区域从 [text] 中删除，剩余纯文本作为 `remaining` 返回。
  static _ExtractedStructured _extractStructuredItems(String text) {
    if (text.isEmpty || !_itemsJsonHint.hasMatch(text)) {
      return _ExtractedStructured(items: const <ContentSummaryItem>[]);
    }

    final List<ContentSummaryItem> items = <ContentSummaryItem>[];
    final StringBuffer remaining = StringBuffer();
    int cursor = 0;

    while (cursor < text.length) {
      // 从 cursor 位置起找下一个 "items":[ ... ] 锚点
      RegExpMatch? hint;
      for (final RegExpMatch m in _itemsJsonHint.allMatches(text, cursor)) {
        hint = m;
        break;
      }
      if (hint == null) {
        // 没找到下一个锚点，把剩余文本原样保留
        remaining.write(text.substring(cursor));
        break;
      }
      final int itemsKeyPos = hint.start;

      // 向前找最近的 '{'（允许空白 / 换行 / 引号）。从 itemsKeyPos 倒扫到首个未配对 '{'。
      int braceStart = -1;
      int depth = 0;
      for (int i = itemsKeyPos; i >= 0; i--) {
        final String ch = text[i];
        if (ch == "}") {
          depth++;
        } else if (ch == "{") {
          if (depth == 0) {
            braceStart = i;
            break;
          }
          depth--;
        }
      }

      if (braceStart == -1) {
        // 没找到匹配的 '{'，剩余内容原样保留
        remaining.write(text.substring(cursor));
        break;
      }

      // 累积 braceStart 之前的纯文本
      remaining.write(text.substring(cursor, braceStart));

      // 从 braceStart 出发，向后找匹配的 '}'（平衡式）
      int braceEnd = -1;
      int openDepth = 0;
      bool inString = false;
      bool escape = false;
      for (int i = braceStart; i < text.length; i++) {
        final String ch = text[i];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch == r"\") {
            escape = true;
          } else if (ch == '"') {
            inString = false;
          }
          continue;
        }
        if (ch == '"') {
          inString = true;
          continue;
        }
        if (ch == "{") {
          openDepth++;
        } else if (ch == "}") {
          openDepth--;
          if (openDepth == 0) {
            braceEnd = i;
            break;
          }
        }
      }

      if (braceEnd == -1) {
        // JSON 不闭合，剩余内容原样保留
        remaining.write(text.substring(braceStart));
        break;
      }

      final String jsonText = text.substring(braceStart, braceEnd + 1);
      final List<ContentSummaryItem> parsed = _parseItemsFromJsonText(jsonText);
      if (parsed.isEmpty) {
        // 解析失败或不含有效 items，保留原文
        remaining.write(text.substring(braceStart, braceEnd + 1));
      } else {
        items.addAll(parsed);
      }

      cursor = braceEnd + 1;
    }

    return _ExtractedStructured(
      items: items,
      remaining: remaining.toString(),
    );
  }

  static List<ContentSummaryItem> _parseItemsFromJsonText(String jsonText) {
    try {
      final dynamic decoded = jsonDecode(jsonText);
      if (decoded is! Map<String, dynamic>) return const <ContentSummaryItem>[];
      final dynamic rawItems = decoded["items"];
      if (rawItems is! List) return const <ContentSummaryItem>[];

      final List<ContentSummaryItem> result = <ContentSummaryItem>[];
      for (final dynamic raw in rawItems) {
        if (raw is! Map) continue;
        final String title = raw["title"]?.toString() ?? "";
        final String? url = raw["url"]?.toString();
        final String? snippet = (raw["snippet"] ?? raw["content"] ?? raw["description"])
            ?.toString();
        final String? source = raw["source"]?.toString();
        final String? publishedAt =
            (raw["publishedAt"] ?? raw["date"] ?? raw["published_at"])
                ?.toString();
        final ContentSummaryItem item = ContentSummaryItem(
          title: title,
          url: (url != null && url.isNotEmpty) ? url : null,
          snippet: (snippet != null && snippet.isNotEmpty) ? snippet : null,
          source: (source != null && source.isNotEmpty) ? source : null,
          publishedAt:
              (publishedAt != null && publishedAt.isNotEmpty) ? publishedAt : null,
        );
        if (item.hasContent) {
          result.add(item);
        }
      }
      return result;
    } catch (_) {
      return const <ContentSummaryItem>[];
    }
  }
}

class _ExtractedStructured {
  const _ExtractedStructured({required this.items, this.remaining = ""});

  final List<ContentSummaryItem> items;
  final String remaining;
}

int _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? "") ?? 0;
}
