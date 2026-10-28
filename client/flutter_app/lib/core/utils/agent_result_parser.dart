import "dart:convert";

/// 智能体结果卡片的数据模型。
///
/// 服务端（或前端脚本）按以下格式把结构化数据注入到消息文本里，
/// 解析器会把它从普通文本中剥离并渲染为 [AgentResultCard]。
///
/// 协议（参考）：
/// ```
/// [AGENT_RESULT_CARD_START]
/// {"avatar":"NB","avatarStyle":"default","title":"...","items":[...],"footer":"..."}
/// [AGENT_RESULT_CARD_END]
/// ```
class AgentResultItem {
  const AgentResultItem({
    required this.type,
    required this.text,
    this.depth = 0,
    this.url,
    this.mediaType,
    this.mediaUrl,
    /// 已解析出的可播放视频流（经后端 /agent/media/proxy 代理的绝对/相对地址）。
    /// 非空时视频卡点击走右侧双栏面板内联播放，为空才降级为打开播放页。
    this.playableUrl,
    this.thumbnailUrl,
    this.pageUrl,
    this.source,
    this.caption,
    this.side,
    this.sideLabel,
    this.width,
    this.height,
  });

  /// "check"（✓ 已完成） / "num"（• 序号） / "warn"（! 警告）
  final String type;
  final String text;

  /// 列表层级：0=一级条目，1=子步骤（steps 卡渲染为缩进子行）。
  /// 由服务端 formatter 按原文缩进推断。
  final int depth;

  /// 可选的链接 URL（搜索/资讯类卡片使用）
  final String? url;

  /// 可选媒体元数据（图片/视频搜索结果卡片使用）。
  final String? mediaType;
  final String? mediaUrl;

  /// 可播放视频流地址（服务端解析成功时下发，指向视频代理路由）。
  /// 非空 = 应用内可播，点击不再跳浏览器。
  final String? playableUrl;
  final String? thumbnailUrl;
  final String? pageUrl;
  final String? source;

  /// 图片的真实画面描述（服务端视觉模型看图生成，2026-09-03）。
  /// 渲染在对应照片下方；为空表示未生成（不显示说明文字）。
  final String? caption;

  /// 对比侧：A=左侧 / B=右侧（用于媒体卡片 A/B 分栏）。
  final String? side;

  /// 侧标签（如「A 品牌」「B 品牌」），用于分栏表头。
  final String? sideLabel;

  /// 原图宽/高（像素，可选）：照片按自然宽高比渲染大图，竖幅人像不再被裁切。
  final int? width;
  final int? height;

  /// 自然宽高比（width/height），缺数据时返回 null。
  double? get naturalAspect {
    final int? w = width;
    final int? h = height;
    if (w == null || h == null || w <= 0 || h <= 0) return null;
    final double aspect = w / h;
    // 过滤明显异常的比例（极端长图/宽条），异常时回退默认版式
    if (aspect < 0.4 || aspect > 2.8) return null;
    return aspect;
  }

  factory AgentResultItem.fromJson(Map<String, dynamic> json) {
    return AgentResultItem(
      type: json["type"]?.toString() ?? "check",
      text: json["text"]?.toString() ?? "",
      depth: (json["depth"] as num?)?.toInt() ?? 0,
      url: json["url"]?.toString(),
      mediaType: json["mediaType"]?.toString() ?? json["kind"]?.toString(),
      mediaUrl: json["mediaUrl"]?.toString() ?? json["imageUrl"]?.toString(),
      playableUrl: json["playableUrl"]?.toString(),
      thumbnailUrl: json["thumbnailUrl"]?.toString() ?? json["thumbUrl"]?.toString(),
      pageUrl: json["pageUrl"]?.toString() ?? json["sourceUrl"]?.toString(),
      source: json["source"]?.toString(),
      caption: json["caption"]?.toString(),
      side: json["side"]?.toString(),
      sideLabel: json["sideLabel"]?.toString(),
      width: (json["width"] as num?)?.toInt(),
      height: (json["height"] as num?)?.toInt(),
    );
  }

  /// 与 [fromJson] 键位对齐（独立行程窗口进程经此序列化传输）。
  Map<String, dynamic> toJson() => <String, dynamic>{
        "type": type,
        "text": text,
        "depth": depth,
        if (url != null) "url": url,
        if (mediaType != null) "mediaType": mediaType,
        if (mediaUrl != null) "mediaUrl": mediaUrl,
        if (playableUrl != null) "playableUrl": playableUrl,
        if (thumbnailUrl != null) "thumbnailUrl": thumbnailUrl,
        if (pageUrl != null) "pageUrl": pageUrl,
        if (source != null) "source": source,
        if (caption != null) "caption": caption,
        if (side != null) "side": side,
        if (sideLabel != null) "sideLabel": sideLabel,
        if (width != null) "width": width,
        if (height != null) "height": height,
      };
}

/// 单个可选的"抉择按钮"定义。
///
/// 用于 [AgentResultData.actions] 列表,渲染在卡片底部供用户一键选择。
/// 与 [AgentResultItem] 不同:它不是文本条目,而是带点击动作的 UI 控件。
class AgentResultAction {
  const AgentResultAction({
    required this.id,
    required this.label,
    this.variant = "primary",
    this.payload = const <String, dynamic>{},
  });

  /// 唯一动作 ID(用于后端路由/审计;前端不依赖此字段做去重)。
  final String id;

  /// 按钮显示文案(同时作为回退的 user message 文本)。
  final String label;

  /// 视觉变体:`primary` 主按钮(实心) / `secondary` 次按钮(描边)。
  /// 默认 `primary`,渲染时第一个为 `primary`,其余按 schema 显式指定。
  final String variant;

  /// 透传给后端的附加负载(后端可按需解析;前端不强约束 schema)。
  final Map<String, dynamic> payload;

  factory AgentResultAction.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? rawPayload =
        json["payload"] as Map<String, dynamic>?;
    return AgentResultAction(
      id: json["id"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      variant: json["variant"]?.toString() ?? "primary",
      payload: rawPayload ?? const <String, dynamic>{},
    );
  }

  /// 与 [fromJson] 键位对齐。
  Map<String, dynamic> toJson() => <String, dynamic>{
        "id": id,
        "label": label,
        "variant": variant,
        "payload": payload,
      };
}

/// product_compare 卡：分侧大图头部（商品图/试色图 + 品名 + 参考价）
class AgentResultCardSide {
  const AgentResultCardSide({
    required this.side,
    required this.label,
    this.priceLabel,
    this.image,
  });

  factory AgentResultCardSide.fromJson(Map<String, dynamic> json) =>
      AgentResultCardSide(
        side: json["side"]?.toString() ?? "",
        label: json["label"]?.toString() ?? "",
        priceLabel: json["priceLabel"]?.toString(),
        image: json["image"]?.toString(),
      );

  final String side;
  final String label;
  final String? priceLabel;
  final String? image;
}

/// product_compare 卡：参数对比（已转置：维度为行、sides 为列）
class AgentResultCompareTable {
  const AgentResultCompareTable({
    required this.dims,
    required this.rows,
  });

  factory AgentResultCompareTable.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawRows = json["rows"] as List<dynamic>?;
    return AgentResultCompareTable(
      dims: (json["dims"] as List<dynamic>? ?? const <dynamic>[])
          .map((e) => e.toString())
          .toList(growable: false),
      rows: (rawRows ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map((row) => MapEntry(
                row["label"]?.toString() ?? "",
                (row["values"] as List<dynamic>? ?? const <dynamic>[])
                    .map((e) => e.toString())
                    .toList(growable: false),
              ))
          .toList(growable: false),
    );
  }

  final List<String> dims;
  /// (维度, 各侧取值) —— values 顺序与 sides 一致
  final List<MapEntry<String, List<String>>> rows;
}

/// product_pick 卡（立场化推荐）：主推商品（图+价+主推理由+渠道价 CTA）。
class AgentResultPick {
  const AgentResultPick({
    required this.productId,
    required this.label,
    this.priceLabel,
    this.image,
    this.headline,
    this.reasons = const <String>[],
    this.cautions = const <String>[],
    this.channels = const <AgentResultPickChannel>[],
  });

  factory AgentResultPick.fromJson(Map<String, dynamic> json) => AgentResultPick(
        productId: json["productId"]?.toString() ?? "",
        label: json["label"]?.toString() ?? "",
        priceLabel: json["priceLabel"]?.toString(),
        image: json["image"]?.toString(),
        headline: json["headline"]?.toString(),
        reasons: (json["reasons"] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        cautions: (json["cautions"] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        channels: (json["channels"] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(AgentResultPickChannel.fromJson)
            .toList(growable: false),
      );

  final String productId;
  final String label;
  final String? priceLabel;
  final String? image;
  /// 为什么是它（个性化主推理由，引用用户场景匹配点）
  final String? headline;
  final List<String> reasons;
  final List<String> cautions;
  final List<AgentResultPickChannel> channels;
}

/// product_pick 卡：渠道实时价（「去比价/去购买」CTA 数据源）。
class AgentResultPickChannel {
  const AgentResultPickChannel({required this.name, required this.priceCny, this.url});

  factory AgentResultPickChannel.fromJson(Map<String, dynamic> json) =>
      AgentResultPickChannel(
        name: json["name"]?.toString() ?? "",
        priceCny: (json["priceCny"] as num?)?.toDouble() ?? 0,
        url: json["url"]?.toString(),
      );

  final String name;
  final double priceCny;
  final String? url;
}

/// product_pick 卡：备选商品（差异化定位「什么时候选它」）。
class AgentResultPickAlt {
  const AgentResultPickAlt({
    required this.productId,
    required this.label,
    this.priceLabel,
    this.image,
    this.whenChoose,
  });

  factory AgentResultPickAlt.fromJson(Map<String, dynamic> json) => AgentResultPickAlt(
        productId: json["productId"]?.toString() ?? "",
        label: json["label"]?.toString() ?? "",
        priceLabel: json["priceLabel"]?.toString(),
        image: json["image"]?.toString(),
        whenChoose: json["whenChoose"]?.toString(),
      );

  final String productId;
  final String label;
  final String? priceLabel;
  final String? image;
  final String? whenChoose;
}

/// product_pick 卡：真实口碑摘要（小红书 UGC，服务端聚合，归属主推）。
class AgentResultUgc {
  const AgentResultUgc({
    this.platformLabel,
    this.mentions = 0,
    this.pros = const <String>[],
    this.cons = const <String>[],
    this.posts = const <AgentResultUgcPost>[],
  });

  factory AgentResultUgc.fromJson(Map<String, dynamic> json) => AgentResultUgc(
        platformLabel: json["platformLabel"]?.toString(),
        mentions: (json["mentions"] as num?)?.toInt() ?? 0,
        pros: (json["pros"] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        cons: (json["cons"] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        posts: (json["posts"] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(AgentResultUgcPost.fromJson)
            .toList(growable: false),
      );

  final String? platformLabel;
  final int mentions;
  final List<String> pros;
  final List<String> cons;
  final List<AgentResultUgcPost> posts;
}

/// product_pick 卡：口碑来源帖（标题+链接，可点）。
class AgentResultUgcPost {
  const AgentResultUgcPost({required this.title, this.url});

  factory AgentResultUgcPost.fromJson(Map<String, dynamic> json) =>
      AgentResultUgcPost(
        title: json["title"]?.toString() ?? "",
        url: json["url"]?.toString(),
      );

  final String title;
  final String? url;
}

/// product_compare 卡：评测/试色视频入口
class AgentResultCardVideo {
  const AgentResultCardVideo({required this.title, this.url, this.source});

  factory AgentResultCardVideo.fromJson(Map<String, dynamic> json) =>
      AgentResultCardVideo(
        title: json["title"]?.toString() ?? "",
        url: json["url"]?.toString(),
        source: json["source"]?.toString(),
      );

  final String title;
  final String? url;
  final String? source;
}

/// price_compare 卡（跨平台实时比价 shopping.compare.prices）：
/// 单个平台分组的最低价报价（同款归一后每组取最优报价）。
class AgentResultPriceGroup {
  const AgentResultPriceGroup({
    required this.platform,
    required this.title,
    this.priceCny,
    this.shop,
    this.url,
    this.image,
    this.similar = false,
    this.offerCount = 1,
  });

  factory AgentResultPriceGroup.fromJson(Map<String, dynamic> json) =>
      AgentResultPriceGroup(
        priceCny: (json["priceCny"] as num?)?.toDouble(),
        platform: json["platform"]?.toString() ?? "",
        title: json["title"]?.toString() ?? "",
        shop: json["shop"]?.toString(),
        url: json["url"]?.toString(),
        image: json["image"]?.toString(),
        similar: json["similar"] == true,
        offerCount: (json["offerCount"] as num?)?.toInt() ?? 1,
      );

  /// 最低价（元）；抓取失败为 null（渲染「价格待查」）。
  final double? priceCny;
  final String platform;
  final String title;
  final String? shop;

  /// 平台商品页链接（整行可点）。
  final String? url;
  final String? image;

  /// 低置信同款标注。
  final bool similar;

  /// 组内报价数（>1 时渲染「等N家」）。
  final int offerCount;
}

/// price_compare 卡：整体结构化载荷（分组报价 + 决策页入口）。
class AgentResultPriceCompare {
  const AgentResultPriceCompare({required this.groups, this.decisionPageUrl});

  factory AgentResultPriceCompare.fromJson(Map<String, dynamic> json) =>
      AgentResultPriceCompare(
        groups: (json["groups"] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(AgentResultPriceGroup.fromJson)
            .toList(growable: false),
        decisionPageUrl: json["decisionPageUrl"]?.toString(),
      );

  final List<AgentResultPriceGroup> groups;
  final String? decisionPageUrl;
}

class AgentResultData {
  const AgentResultData({
    this.avatar = "NB",
    this.avatarStyle = "default",
    this.title = "",
    this.items = const <AgentResultItem>[],
    this.footer = "",
    this.actions = const <AgentResultAction>[],
    this.cardId = "",
    this.cardType = "",
    this.speak = "",
    this.travelPlan,
    this.autoOpen = false,
    this.groupTitle,
    this.sideA,
    this.sideB,
    this.sides = const <AgentResultCardSide>[],
    this.compare,
    this.videos = const <AgentResultCardVideo>[],
    this.pick,
    this.alternatives = const <AgentResultPickAlt>[],
    this.ugc,
    this.priceCompare,
    this.extra,
  });

  /// 智能体头像缩写（默认 "NB"）。
  final String avatar;

  /// 头像配色：default | gradient | accent | success
  final String avatarStyle;

  /// 卡片标题（第一行）。
  final String title;

  /// 条目列表。
  final List<AgentResultItem> items;

  /// 底部附加文案（可选，可包含简单 inline 标签）。
  final String footer;

  /// 底部抉择按钮列表(可选;非空时由 [AgentActionChoiceCard] 渲染)。
  /// 与 [items]/[footer] 解耦:即便后两者为空,仅靠 actions 也能撑起整张卡。
  final List<AgentResultAction> actions;

  /// 卡片唯一 ID(用于后端关联原始上下文;前端主要用于点击事件回传)。
  /// 由服务端注入,前端不强校验。
  final String cardId;

  /// 工具专用卡片类型(服务端按 toolName 推断注入):
  /// weather / schedule / wallet / order / file / carousel / compare / timeline / media;
  /// 空串=通用列表卡。
  final String cardType;

  /// 语音播报优先级:`high`(优先朗读结论) / `low`(可跳过) / 空串(默认)。
  /// 供语音输出端决定取舍。
  final String speak;

  /// 结构化行程数据(仅 travel_itinerary 卡携带,来自服务端结构化结果):
  /// {toolName, ts, destination, title, days:[{date, items:[{type,name,startTime,...}]}]}。
  /// 供行程规划界面直读渲染;为 null 时前端回退到 items 文本解析。
  final Map<String, dynamic>? travelPlan;

  /// 自动展开标志(目前仅 travel_itinerary 卡使用):服务端在本轮规划实时完成时置
  /// true,chat.assistant_done 收到后直接弹出独立规划界面,无需用户点按钮。卡片仍保留
  /// 在消息里供回看;历史加载不走 done 事件,不会重复弹开。
  final bool autoOpen;

  /// 对比媒体分组维度标题（如「颜色持久度」），非空时媒体卡片按分组渲染。
  final String? groupTitle;

  /// 对比左/右两侧的标签（如「A 品牌」「B 品牌」），配合侧标分栏展示。
  final String? sideA;
  final String? sideB;

  /// product_compare 卡（shopping.suggest）：分侧大图头部（商品图/试色图）。
  final List<AgentResultCardSide> sides;

  /// product_compare 卡：参数对比（已转置：维度为行、sides 为列）。
  final AgentResultCompareTable? compare;

  /// product_compare 卡：评测/试色视频入口。
  final List<AgentResultCardVideo> videos;

  /// product_pick 卡（立场化推荐）：主推商品（含主推理由与渠道价 CTA）。
  final AgentResultPick? pick;

  /// product_pick 卡：备选商品（差异化定位「什么时候选它」）。
  final List<AgentResultPickAlt> alternatives;

  /// product_pick 卡：真实口碑摘要（小红书 UGC，归属主推；无口碑为 null）。
  final AgentResultUgc? ugc;

  /// price_compare 卡（跨平台实时比价）：分组报价 + 决策页入口。
  /// 为 null 时客户端回退通用卡渲染（服务端旧形态兜底）。
  final AgentResultPriceCompare? priceCompare;

  /// 卡片私有载荷透传（morning_briefing 等自渲染卡携带的原始数据）。
  /// 通用卡不读它；由对应 cardType 的渲染分支自行解析。
  final Map<String, dynamic>? extra;

  factory AgentResultData.fromJson(Map<String, dynamic> json) {
    final List<dynamic>? rawItems = json["items"] as List<dynamic>?;
    final List<dynamic>? rawActions = json["actions"] as List<dynamic>?;
    final Map<String, dynamic>? rawTravelPlan = json["travelPlan"] as Map<String, dynamic>?;
    final Map<String, dynamic>? rawExtra = json["extra"] as Map<String, dynamic>?;
    return AgentResultData(
      avatar: json["avatar"]?.toString() ?? "NB",
      avatarStyle: json["avatarStyle"]?.toString() ?? "default",
      title: json["title"]?.toString() ?? "",
      items: rawItems
              ?.whereType<Map<String, dynamic>>()
              .map(AgentResultItem.fromJson)
              .toList() ??
          const <AgentResultItem>[],
      footer: json["footer"]?.toString() ?? "",
      actions: rawActions
              ?.whereType<Map<String, dynamic>>()
              .map(AgentResultAction.fromJson)
              .where((AgentResultAction a) => a.label.isNotEmpty)
              .toList() ??
          const <AgentResultAction>[],
      cardId: json["cardId"]?.toString() ?? "",
      cardType: json["cardType"]?.toString() ?? "",
      speak: json["speak"]?.toString() ?? "",
      travelPlan: rawTravelPlan,
      autoOpen: json["autoOpen"] == true,
      extra: rawExtra,
      sides: (json["sides"] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(AgentResultCardSide.fromJson)
          .toList(growable: false),
      compare: json["compare"] is Map<String, dynamic>
          ? AgentResultCompareTable.fromJson(
              json["compare"] as Map<String, dynamic>)
          : null,
      videos: (json["videos"] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(AgentResultCardVideo.fromJson)
          .toList(growable: false),
      pick: json["pick"] is Map<String, dynamic>
          ? AgentResultPick.fromJson(json["pick"] as Map<String, dynamic>)
          : null,
      alternatives: (json["alternatives"] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(AgentResultPickAlt.fromJson)
          .toList(growable: false),
      ugc: json["ugc"] is Map<String, dynamic>
          ? AgentResultUgc.fromJson(json["ugc"] as Map<String, dynamic>)
          : null,
      priceCompare: json["priceCompare"] is Map<String, dynamic>
          ? AgentResultPriceCompare.fromJson(
              json["priceCompare"] as Map<String, dynamic>)
          : null,
    );
  }

  /// 与 [fromJson] 键位对齐（独立行程窗口进程经此序列化传输）。
  Map<String, dynamic> toJson() => <String, dynamic>{
        "avatar": avatar,
        "avatarStyle": avatarStyle,
        "title": title,
        "items": items.map((AgentResultItem e) => e.toJson()).toList(),
        "footer": footer,
        "actions": actions.map((AgentResultAction e) => e.toJson()).toList(),
        "cardId": cardId,
        "cardType": cardType,
        "speak": speak,
        if (travelPlan != null) "travelPlan": travelPlan,
        if (extra != null) "extra": extra,
        "autoOpen": autoOpen,
        "sides": sides.map((AgentResultCardSide e) => <String, dynamic>{
              "side": e.side,
              "label": e.label,
              if (e.priceLabel != null) "priceLabel": e.priceLabel,
              if (e.image != null) "image": e.image,
            }).toList(),
        "compare": compare == null
            ? null
            : <String, dynamic>{
                "dims": compare!.dims,
                "rows": [
                  for (final MapEntry<String, List<String>> row in compare!.rows)
                    <String, dynamic>{"label": row.key, "values": row.value},
                ],
              },
        "videos": videos.map((AgentResultCardVideo e) => <String, dynamic>{
              "title": e.title,
              if (e.url != null) "url": e.url,
              if (e.source != null) "source": e.source,
            }).toList(),
        if (pick != null)
          "pick": <String, dynamic>{
            "productId": pick!.productId,
            "label": pick!.label,
            if (pick!.priceLabel != null) "priceLabel": pick!.priceLabel,
            if (pick!.image != null) "image": pick!.image,
            if (pick!.headline != null) "headline": pick!.headline,
            "reasons": pick!.reasons,
            "cautions": pick!.cautions,
            "channels": pick!.channels
                .map((AgentResultPickChannel c) => <String, dynamic>{
                      "name": c.name,
                      "priceCny": c.priceCny,
                      if (c.url != null) "url": c.url,
                    })
                .toList(),
          },
        "alternatives": alternatives
            .map((AgentResultPickAlt a) => <String, dynamic>{
                  "productId": a.productId,
                  "label": a.label,
                  if (a.priceLabel != null) "priceLabel": a.priceLabel,
                  if (a.image != null) "image": a.image,
                  if (a.whenChoose != null) "whenChoose": a.whenChoose,
                })
            .toList(),
        if (ugc != null)
          "ugc": <String, dynamic>{
            if (ugc!.platformLabel != null) "platformLabel": ugc!.platformLabel,
            "mentions": ugc!.mentions,
            "pros": ugc!.pros,
            "cons": ugc!.cons,
            "posts": ugc!.posts
                .map((AgentResultUgcPost p) => <String, dynamic>{
                      "title": p.title,
                      if (p.url != null) "url": p.url,
                    })
                .toList(),
          },
        if (priceCompare != null)
          "priceCompare": <String, dynamic>{
            "groups": priceCompare!.groups
                .map((AgentResultPriceGroup g) => <String, dynamic>{
                      if (g.priceCny != null) "priceCny": g.priceCny,
                      "platform": g.platform,
                      "title": g.title,
                      if (g.shop != null) "shop": g.shop,
                      if (g.url != null) "url": g.url,
                      if (g.image != null) "image": g.image,
                      if (g.similar) "similar": true,
                      "offerCount": g.offerCount,
                    })
                .toList(),
            if (priceCompare!.decisionPageUrl != null)
              "decisionPageUrl": priceCompare!.decisionPageUrl,
          },
        if (groupTitle != null) "groupTitle": groupTitle,
        if (sideA != null) "sideA": sideA,
        if (sideB != null) "sideB": sideB,
      };
}

class AgentResultParseResult {
  const AgentResultParseResult({
    required this.data,
    required this.cleanedText,
  });

  final AgentResultData? data;
  final String cleanedText;
}

/// 按原文位置展开的渲染块：一段正文或一张卡片。
/// 与新版服务端 reply blocks（text/card 序列）同构，用于无 blocks 的
/// 历史消息回退渲染——「总览卡置首、正文居中、行程卡收尾」按原位呈现。
class AgentResultBlock {
  const AgentResultBlock.text(String this.text) : data = null;
  const AgentResultBlock.card(AgentResultData this.data) : text = null;

  final String? text;
  final AgentResultData? data;

  bool get isCard => data != null;
}

class AgentResultParser {
  AgentResultParser._();

  static const String startMarker = "[AGENT_RESULT_CARD_START]";
  static const String endMarker = "[AGENT_RESULT_CARD_END]";

  static final RegExp _blockPattern = RegExp(
    r'\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]',
  );

  /// 解析一段消息文本：若包含结果卡片标记则返回 [data] 与剥离后的 cleanedText；
  /// 否则 [data] 为 null，cleanedText 与原文本相同。
  ///
  /// 文本含多个卡片块时（如通用列表卡之后确定性附加的行程卡），
  /// [data] 优先取 travel_itinerary 行程卡——它是唯一携带 autoOpen
  /// （独立规划界面自动弹出）与结构化行程数据的卡；cleanedText 剥离
  /// 全部卡片块，避免剩余块的原始标记/JSON 混进正文展示。
  static AgentResultParseResult parse(String text) {
    if (text.isEmpty) {
      return AgentResultParseResult(data: null, cleanedText: text);
    }
    final List<RegExpMatch> matches =
        _blockPattern.allMatches(text).toList(growable: false);
    if (matches.isEmpty) {
      return AgentResultParseResult(data: null, cleanedText: text);
    }
    AgentResultData? data;
    // 优先取行程卡，否则回退第一张卡
    RegExpMatch? chosen;
    for (final RegExpMatch match in matches) {
      final AgentResultData? parsed = _parseCardJson(
        match.group(1)?.trim() ?? "",
      );
      if (parsed == null) continue;
      chosen ??= match;
      if (parsed.cardType == "travel_itinerary") {
        chosen = match;
        data = parsed;
        break;
      }
    }
    // 仍然为 null 说明所有块都解析失败 → 回退第一个块的位置
    chosen ??= matches.first;
    data ??= _parseCardJson(chosen.group(1)?.trim() ?? "");
    final String cleaned = _stripAllCardBlocks(text, matches);
    return AgentResultParseResult(data: data, cleanedText: cleaned);
  }

  /// 把消息文本按位置拆成「正文段 / 卡片」序列（卡片不合并不丢弃）。
  ///
  /// 多卡消息（如模型总览卡 + 服务端附加的行程卡）按标记在原文中的位置
  /// 原样展开，前端按序渲染即可还原「总览卡置首、正文居中、行程卡收尾」。
  /// JSON 损坏的卡片块被静默跳过（防脏 JSON 混进正文），不产生块。
  static List<AgentResultBlock> parseBlocks(String text) {
    if (text.isEmpty) {
      return <AgentResultBlock>[AgentResultBlock.text(text)];
    }
    final List<RegExpMatch> matches =
        _blockPattern.allMatches(text).toList(growable: false);
    if (matches.isEmpty) {
      return <AgentResultBlock>[AgentResultBlock.text(text)];
    }
    final List<AgentResultBlock> blocks = <AgentResultBlock>[];
    int cursor = 0;
    for (final RegExpMatch match in matches) {
      final String before = text.substring(cursor, match.start).trim();
      if (before.isNotEmpty) {
        blocks.add(AgentResultBlock.text(before));
      }
      final AgentResultData? data = _parseCardJson(
        match.group(1)?.trim() ?? "",
      );
      if (data != null) {
        blocks.add(AgentResultBlock.card(data));
      }
      cursor = match.end;
    }
    final String tail = text.substring(cursor).trim();
    if (tail.isNotEmpty) {
      blocks.add(AgentResultBlock.text(tail));
    }
    return blocks;
  }

  static AgentResultData? _parseCardJson(String rawJson) {
    if (rawJson.isEmpty) return null;
    try {
      final dynamic decoded = jsonDecode(rawJson);
      if (decoded is Map<String, dynamic>) {
        return AgentResultData.fromJson(decoded);
      }
    } catch (_) {
      // JSON 损坏 → 静默回退为普通文本
    }
    return null;
  }

  /// 剥离全部完整卡片块；无配对的孤立标记原样保留。
  static String _stripAllCardBlocks(String text, List<RegExpMatch> matches) {
    String cleaned = text;
    for (final RegExpMatch match in matches.reversed) {
      cleaned = cleaned.replaceRange(match.start, match.end, "");
    }
    return cleaned.trim();
  }
}
