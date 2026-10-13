import "../../core/config/api_config.dart";
import "../../core/utils/agent_result_parser.dart";

/// 行程链路远程图床域（Wikimedia 家族）：这些域在国内网络直连不可达
/// （Flutter Image.network 不走系统代理，IPv4 被墙），统一重写到本机
/// server 的 /travel/media/remote 代理——服务端双路抓取落盘后本机直出。
const List<String> _remoteImageHostSuffixes = <String>[
  "wikimedia.org",
  "wikipedia.org",
  "wikidata.org",
];

bool _isBlockedRemoteImageHost(String url) {
  final Uri? uri = Uri.tryParse(url);
  final String host = (uri?.host ?? "").toLowerCase();
  if (host.isEmpty) return false;
  for (final String suffix in _remoteImageHostSuffixes) {
    if (host == suffix || host.endsWith(".$suffix")) return true;
  }
  return false;
}

/// 相对路径（/travel/media/assets/...）→ 服务端绝对地址；Wikimedia 家族
/// 远程 URL → 本机代理路由（存量行程/聊天快照里烤死的远程图由此通道渲染）；
/// 其余外链原样返回。
String resolveTravelMediaUrl(String url) {
  final String u = url.trim();
  if (u.isEmpty) return u;
  if (u.startsWith("http")) {
    if (_isBlockedRemoteImageHost(u)) {
      return "${ApiConfig.httpBase}/travel/media/remote?u=${Uri.encodeComponent(u)}";
    }
    return u;
  }
  return "${ApiConfig.httpBase}${_encodeNonAsciiPath(u)}";
}

/// 路径段含非 ASCII（如中文目录 `destcover贵阳-<sha>`）时逐段百分号编码。
/// 服务端对裸 UTF-8 路径返回 400（实测），只认编码形态；Dart HttpClient
/// 发请求时会自动编码，但 WebView `<img>` 等非 Dart 消费方不会——统一在
/// URL 构造处编码，所有消费方拿到的都是可直接请求的合法 URL。
String _encodeNonAsciiPath(String path) {
  final int q = path.indexOf("?");
  final String p = q >= 0 ? path.substring(0, q) : path;
  final String query = q >= 0 ? path.substring(q) : "";
  final bool hasNonAscii = p.contains(RegExp(r"[^\x00-\x7F]"));
  if (!hasNonAscii) return path;
  final String encoded = p
      .split("/")
      .map((String seg) =>
          seg.isEmpty || !seg.contains(RegExp(r"[^\x00-\x7F]"))
              ? seg
              : Uri.encodeComponent(seg))
      .join("/");
  return "$encoded$query";
}

/// 行程条目类型（决定右栏时间线图标 / 地图标记配色）。
enum TravelEntryKind {
  attraction,
  restaurant,
  hotel,
  transport,
  other,
}

/// 单条行程条目（右栏时间线的一行 / 地图标记 / 预订与详情面板的数据源）。
class TravelDayEntry {
  const TravelDayEntry({
    required this.time,
    required this.title,
    required this.kind,
    this.itemId = "",
    this.type = "",
    this.latitude,
    this.longitude,
    this.address = "",
    this.priceInfo = "",
    this.description = "",
    this.tips = const <String>[],
    this.splatUrl = "",
    this.images = const <String>[],
    this.anchor = false,
  });

  /// 条目唯一键（服务端 itemId，缺省用名称兜底；预订清单聚合用）。
  final String itemId;
  final String time;
  final String title;

  /// 服务端原始类型串（attraction/hotel/restaurant/transport/...）。
  final String type;
  final TravelEntryKind kind;

  /// 经纬度（文本兜底解析时为 null，无坐标的条目不参与地图/路线）。
  final double? latitude;
  final double? longitude;
  final String address;
  final String priceInfo;
  final String description;
  final List<String> tips;

  /// 3DGS 沉浸式实景素材地址（相对路径时地图 JS 侧拼 httpBase）。
  final String splatUrl;

  /// 实拍图（已 resolve 为绝对地址，最多取 6 张）。
  final List<String> images;

  /// 时间锚点：时刻被用户/预订钉住，重排不动（服务端 retimeDayAfterEdit 保护）。
  final bool anchor;

  /// 兼容旧面板的拼接备注（价格 · 描述 · 贴士 · 地址）。
  String get note => <String>[
        if (priceInfo.trim().isNotEmpty) priceInfo.trim(),
        if (description.trim().isNotEmpty) description.trim(),
        if (tips.isNotEmpty) tips.join("；"),
        if (address.trim().isNotEmpty) address.trim(),
      ].join(" · ");

  /// 聚合键：优先 itemId，退回名称（预订清单按它去重计数）。
  String get aggregateKey => itemId.isNotEmpty ? itemId : title;

  /// 数值价格（从 priceInfo 中抽数字，如「¥120/人」→ 120；预订清单兜底用）。
  double? get numericPrice {
    final RegExpMatch? m =
        RegExp(r'[¥￥]\s*(\d+(?:\.\d+)?)').firstMatch(priceInfo);
    if (m != null) return double.tryParse(m.group(1)!);
    return null;
  }

  /// 服务端 item JSON → 时间线行（type 直接映射图标，免正则推断）。
  static TravelDayEntry fromJson(Map<String, dynamic> raw) {
    final String name = raw["name"]?.toString() ?? "";
    final String type = raw["type"]?.toString() ?? "";
    final List<String> images = <String>[
      for (final dynamic img in (raw["images"] as List<dynamic>? ?? const <dynamic>[]))
        if (img?.toString().trim().isNotEmpty ?? false)
          resolveTravelMediaUrl(img!.toString().trim()),
    ].take(6).toList(growable: false);

    return TravelDayEntry(
      itemId: raw["itemId"]?.toString() ?? "",
      time: raw["startTime"]?.toString() ?? "",
      title: name.isEmpty ? "行程安排" : name,
      type: type,
      kind: _kindFromType(type),
      latitude: (raw["latitude"] as num?)?.toDouble(),
      longitude: (raw["longitude"] as num?)?.toDouble(),
      address: raw["address"]?.toString() ?? "",
      priceInfo: raw["priceInfo"]?.toString() ?? "",
      description: raw["description"]?.toString() ?? "",
      splatUrl: raw["splatUrl"]?.toString() ?? "",
      tips: <String>[
        for (final dynamic t in (raw["tips"] as List<dynamic>? ?? const <dynamic>[]))
          if (t != null) t.toString(),
      ],
      images: images,
      anchor: raw["anchor"] == true,
    );
  }

  static TravelEntryKind _kindFromType(String type) {
    switch (type) {
      case "attraction":
        return TravelEntryKind.attraction;
      case "hotel":
        return TravelEntryKind.hotel;
      case "restaurant":
        return TravelEntryKind.restaurant;
      case "transport":
        return TravelEntryKind.transport;
      default:
        return TravelEntryKind.other;
    }
  }
}

/// 按天分组（左栏一个 tab）。
class TravelPlanDay {
  const TravelPlanDay({
    required this.label,
    this.subtitle = "",
    this.date = "",
    required this.entries,
  });

  final String label;
  final String subtitle;

  /// 服务端日期串（YYYY-MM-DD，导出 ICS / 人流按周末计算用）。
  final String date;
  final List<TravelDayEntry> entries;
}

/// 候选 POI（服务端 pois 池，含未排入日程的备选；行程页「Agent 暂时收起」源）。
class TravelPoi {
  const TravelPoi({
    required this.name,
    required this.type,
    this.latitude,
    this.longitude,
    this.address = "",
  });

  factory TravelPoi.fromJson(Map<String, dynamic> json) {
    return TravelPoi(
      name: json["name"]?.toString() ?? "",
      type: json["type"]?.toString() ?? "",
      latitude: (json["latitude"] as num?)?.toDouble(),
      longitude: (json["longitude"] as num?)?.toDouble(),
      address: json["address"]?.toString() ?? "",
    );
  }

  final String name;
  final String type; // attraction | restaurant | hotel
  final double? latitude;
  final double? longitude;
  final String address;
}

/// 行程规划界面数据（优先来自服务端结构化 travelPlan，兜底从卡 items 文本启发式解析）。
class TravelPlanData {
  const TravelPlanData({
    required this.title,
    required this.destination,
    required this.days,
    this.planId = "",
    this.startDate = "",
    this.endDate = "",
    this.centerLatitude,
    this.centerLongitude,
    this.intro = "",
    this.packing = const <String>[],
    this.coverImage = "",
    this.weather = "",
    this.preferences = const <String>[],
    this.footer = "",
    this.rawItems = const <String>[],
    this.isStructured = false,
    this.dataQuality = "real",
    this.version,
    this.travelPois = const <TravelPoi>[],
  });

  final String title;
  final String destination;

  /// 服务端行程 ID（travel-plans 路由编辑/预订/分享接口的定位键；文本兜底时为空）。
  final String planId;
  final String startDate;
  final String endDate;

  /// 目的地地理编码中心（地图初始化定位用；文本兜底/旧数据时为 null）。
  final double? centerLatitude;
  final double? centerLongitude;

  /// 目的地一句话简介（行程卡海报区展示；文本兜底时为空，前端隐藏该行）。
  final String intro;

  /// 出行随身物品叮嘱（行程卡「记得带」胶囊；文本兜底时为空，前端隐藏该行）。
  final List<String> packing;

  /// 目的地代表性封面（服务端维基百科条目主图优先，已 resolve 为绝对地址）。
  /// 海报背景优先于任何条目实拍图——它是目的地本身的形象照，而非某个 POI 的
  /// 照片；空串表示服务端未解析到，海报退回条目实拍/渐变兜底。
  final String coverImage;

  /// 出发日天气一句话摘要（服务端 Open-Meteo 实时预报；空串=无数据，
  /// 行程桌面页据此隐藏顶栏天气胶囊，不编造天气读数）。
  final String weather;

  final List<String> preferences;
  final List<TravelPlanDay> days;
  final String footer;
  final List<String> rawItems;

  /// 数据来源：true = 服务端结构化 travelPlan JSON（days 即真实天，空天也计入
  /// 天数口径）；false = 卡片文本行兜底解析（可能补「全程」空骨架天，空天不计）。
  final bool isStructured;

  /// 数据可信度：real = 实时搜索数据；knowledge = 内置知识库真实 POI；
  /// synthetic = 离线合成占位。非 real 时 UI 需向用户明示数据来源。
  final String dataQuality;

  /// 候选 POI 池（服务端 pois，含未排入日程的备选；文本兜底时为空）。
  final List<TravelPoi> travelPois;

  /// 服务端乐观锁版本（A6）：编辑请求经 If-Match 回传，冲突时 409。
  final int? version;

  bool get hasPlanId => planId.isNotEmpty;

  /// 从 [AgentResultData] 构建：优先读结构化 travelPlan，缺失时回退文本解析。
  factory TravelPlanData.from(AgentResultData data) {
    final Map<String, dynamic>? tp = data.travelPlan;
    final List<dynamic>? tpDays = tp?["days"] as List<dynamic>?;
    if (tp != null && tpDays != null && tpDays.isNotEmpty) {
      final TravelPlanData built = TravelPlanData._fromTravelPlan(tp);
      // 结构化数据异常（如全空天）时仍回退文本解析
      if (built.days.any((TravelPlanDay d) => d.entries.isNotEmpty)) return built;
    }
    return TravelPlanData.fromCard(data);
  }

  /// 服务端行程 JSON（GET /travel/plans/:id 返回）→ 渲染数据（编辑后刷新用）。
  factory TravelPlanData.fromPlanJson(Map<String, dynamic> plan) {
    return TravelPlanData._fromTravelPlan(plan);
  }

  /// 服务端结构化行程（travel.plan-itinerary 产出）→ 直接渲染数据。
  static TravelPlanData _fromTravelPlan(Map<String, dynamic> tp) {
    final String title = tp["title"]?.toString() ?? "";
    final Object? destRawO = tp["destination"];
    final String destRaw = (destRawO?.toString() ?? "").trim();
    final String destination =
        destRaw.isNotEmpty ? destRaw : _inferDestination(title, const <String>[]);

    final List<dynamic> rawDays = tp["days"] as List<dynamic>? ?? const <dynamic>[];
    final List<TravelPlanDay> days = <TravelPlanDay>[];
    for (int i = 0; i < rawDays.length; i++) {
      final Map<String, dynamic> rawDay =
          (rawDays[i] as Map<String, dynamic>?) ?? const <String, dynamic>{};
      final String date = rawDay["date"]?.toString() ?? "";
      final List<dynamic> rawItems = rawDay["items"] as List<dynamic>? ?? const <dynamic>[];
      final List<TravelDayEntry> entries = <TravelDayEntry>[
        for (final dynamic raw in rawItems)
          if (raw is Map<String, dynamic>) TravelDayEntry.fromJson(raw),
      ];
      days.add(TravelPlanDay(
        label: date.isEmpty ? "Day ${i + 1}" : date,
        subtitle: date.isEmpty ? "" : "第 ${i + 1} 天",
        date: date,
        entries: entries,
      ));
    }

    return TravelPlanData(
      title: title.trim(),
      destination: destination,
      planId: tp["planId"]?.toString() ?? "",
      startDate: tp["startDate"]?.toString() ?? "",
      endDate: tp["endDate"]?.toString() ?? "",
      centerLatitude: (tp["center"]?["latitude"] as num?)?.toDouble(),
      centerLongitude: (tp["center"]?["longitude"] as num?)?.toDouble(),
      intro: tp["intro"]?.toString() ?? "",
      coverImage: resolveTravelMediaUrl(tp["coverImage"]?.toString() ?? ""),
      weather: tp["weather"]?.toString() ?? "",
      isStructured: true,
      dataQuality: tp["dataQuality"]?.toString() ?? "real",
      version: (tp["version"] as num?)?.toInt(),
      travelPois: <TravelPoi>[
        for (final dynamic p in (tp["pois"] as List<dynamic>? ?? const <dynamic>[]))
          if (p is Map<String, dynamic>) TravelPoi.fromJson(p),
      ],
      packing: <String>[
        for (final dynamic p in (tp["packing"] as List<dynamic>? ?? const <dynamic>[]))
          if (p != null && p.toString().trim().isNotEmpty) p.toString().trim(),
      ],
      preferences: <String>[
        for (final dynamic p in (tp["preferences"] as List<dynamic>? ?? const <dynamic>[]))
          if (p != null) p.toString(),
      ],
      days: days,
      footer: "",
    );
  }

  /// 解析行程卡（cardType = travel_itinerary）为按天分组的结构化数据（文本兜底）。
  factory TravelPlanData.fromCard(AgentResultData data) {
    final List<String> raw = <String>[
      for (final AgentResultItem it in data.items)
        if (it.text.trim().isNotEmpty) it.text.trim(),
    ];

    final List<TravelPlanDay> days = <TravelPlanDay>[];
    TravelPlanDay? current;
    for (final String line in raw) {
      final DayHeader? header = _parseDayHeader(line);
      if (header != null) {
        if (current != null) days.add(current);
        current = TravelPlanDay(
          label: header.label,
          subtitle: header.subtitle,
          entries: <TravelDayEntry>[],
        );
        continue;
      }
      (current ??= TravelPlanDay(
                label: "全程",
                entries: <TravelDayEntry>[],
              ))
          .entries
          .add(_parseEntry(line));
    }
    if (current != null) days.add(current);

    // 兜底：没解析出任何行时给一个空整天，保证双栏骨架完整可渲染
    if (days.isEmpty) {
      days.add(const TravelPlanDay(label: "全程", entries: <TravelDayEntry>[]));
    }

    return TravelPlanData(
      title: data.title.trim(),
      destination: _inferDestination(data.title, raw),
      days: days,
      footer: data.footer.trim(),
      rawItems: raw,
    );
  }

  /// 「Day N / 第N天」行 → 天分组头；非天标题行返回 null。
  static DayHeader? _parseDayHeader(String line) {
    final RegExp re = RegExp(
      r'^(?:第\s*([0-9一二三四五六七八九十百]+)\s*天|[dD]ay\s*([0-9一二三四五六七八九十百]+))[\s:：、-]*(.*)$',
    );
    final RegExpMatch? m = re.firstMatch(line);
    if (m == null) return null;
    final String? num = m.group(1) ?? m.group(2);
    if (num == null) return null;
    final String subtitle = (m.group(3) ?? "").trim();
    final String label = "Day $num";
    // 纯标题行（无余下内容）直接作为分组头
    if (subtitle.isEmpty) return DayHeader(label: label, subtitle: "");
    // 余下内容较长 → 视作首条行程条目而非分组副标题
    if (subtitle.length > 14) return null;
    return DayHeader(label: label, subtitle: subtitle);
  }

  /// 单行 → 行程条目（拆时间前缀 + 名称 + 备注 + 类型图标）。
  static TravelDayEntry _parseEntry(String line) {
    // 时间前缀：HH:mm / HH:mm-HH:mm / X点 / 上午 等
    final RegExp timeRe = RegExp(
      r'^(?:(\d{1,2}\s*[:：]\s*\d{2}\s*(?:[-~至]\s*\d{1,2}\s*[:：]\s*\d{2})?)'
      r'|(\d{1,2}\s*点\s*[半整一二三四五六七八九十]?)'
      r'|(清晨|早上|上午|中午|下午|傍晚|晚上|凌晨|夜里|白天|下午茶))\s*[:：、]?\s*',
    );
    final RegExpMatch? tm = timeRe.firstMatch(line);
    String rest = line;
    String time = "";
    if (tm != null) {
      time = tm.group(0)!.trim().replaceFirst(RegExp(r'[:：、]?\s*$'), "");
      rest = line.substring(tm.end).trim();
    }

    // 名称：第一个分隔符（：:，,、;；）之前的片段做名称，之后做备注
    final RegExp sepRe = RegExp(r'^(.{1,18}?)…?\s*([：:，,、;；|｜\-—]\s*)(.+)$');
    final RegExpMatch? sep = sepRe.firstMatch(rest);
    String title = rest;
    String note = "";
    if (sep != null) {
      title = sep.group(1)!.trim();
      note = sep.group(3)!.trim();
    }
    // 超长标题且无分隔符：直接截断标题，不做备注拆分（避免误切地名）；
    // 有分隔符时保留完整标题 + 备注
    if (title.length > 16 && note.isEmpty) {
      title = title.substring(0, 16);
    }

    return TravelDayEntry(
      time: time,
      title: title,
      kind: _inferKind(title, note),
    );
  }

  /// 目的地推断：优先 items 中「目的地：XXX」；否则从标题剥离天数/后缀词。
  static String _inferDestination(String title, List<String> raw) {
    for (final String line in raw) {
      final RegExpMatch? m =
          RegExp(r'目的地\s*[:：]\s*([\u4e00-\u9fa5A-Za-z·]{2,12})').firstMatch(line);
      if (m != null) return m.group(1)!.trim();
    }
    final String cleaned = title
        .replaceAll(
            RegExp(r'\d+\s*日游|\d+\s*天\s*游|日游|行程|规划|计划|自由行|攻略|旅游|安排|[·\-—|]\s*.*$'),
            '')
        .trim();
    if (cleaned.length >= 2 && cleaned.length <= 12) return cleaned;
    return title.isEmpty ? "行程" : title.substring(0, title.length.clamp(1, 8));
  }

  static TravelEntryKind _inferKind(String title, String note) {
    final String t = "$title $note";
    if (RegExp(r'餐|美食|火锅|小吃|面|馆|菜|咖啡|茶|早餐|午餐|晚餐|夜宵|外卖').hasMatch(t)) {
      return TravelEntryKind.restaurant;
    }
    if (RegExp(r'酒店|民宿|住宿|入住|旅馆|客栈|大厦|公寓').hasMatch(t)) {
      return TravelEntryKind.hotel;
    }
    if (RegExp(r'交通|地铁|公交|巴士|高铁|动车|飞机|打车|出租|导航|渡轮|轮船|步行|骑行|车程').hasMatch(t)) {
      return TravelEntryKind.transport;
    }
    if (RegExp(r'景点|游览|游玩|公园|寺|祠|街|巷|山|湖|河|馆|宫|塔|博物馆|遗址|古镇|门票|演出|show').hasMatch(t)) {
      return TravelEntryKind.attraction;
    }
    return TravelEntryKind.other;
  }
}

class DayHeader {
  const DayHeader({required this.label, required this.subtitle});
  final String label;
  final String subtitle;
}
