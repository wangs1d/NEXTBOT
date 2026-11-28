import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:ui" show ImageFilter, PathMetric;

import "package:flutter/foundation.dart" show ValueListenable, ValueNotifier;
import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../core/config/api_config.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";
import "../core/services/nb_http.dart";

/// 手机端「动态」页：快递 / 账单 / 邮件三类聚合卡的统一入口。
///
/// 每类全页只有一张聚合卡（卡面轮播类内数据）；顶部两个等宽槽位与信息流
/// 严格互斥——卡进槽后信息流整块消失，被挤出的卡回落信息流且不再被自动
/// 补位填回。顺序、置顶与排除项保存在本机。
class MobileDynamicsPage extends StatefulWidget {
  const MobileDynamicsPage({super.key, this.client});

  /// 注入 http client(测试用)。
  final http.Client? client;

  @override
  State<MobileDynamicsPage> createState() => MobileDynamicsPageState();
}

class MobileDynamicsPageState extends State<MobileDynamicsPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _data = const <String, dynamic>{};
  List<String> _order = <String>[];
  List<String?> _pins = <String?>[null, null];
  Set<String> _autoExcluded = <String>{};

  /// true = 有卡片正在被长按拖拽。轮播在拖拽期间暂停自动翻页，
  /// 松手恢复——既保证拖拽不被翻页打断，也让 FakeAsync 测试时序确定。
  final ValueNotifier<bool> _dragPause = ValueNotifier<bool>(false);

  @override
  void initState() {
    super.initState();
    unawaited(_loadLayout());
    unawaited(_load());
  }

  @override
  void dispose() {
    _dragPause.dispose();
    super.dispose();
  }

  /// 主壳切到本 tab 时触发重拉（IndexedStack 保活下 initState 只走一次）。
  /// 已有数据时静默后台刷新（秒进不转圈），无数据才走完整加载。
  void refresh() {
    if (!_loading) unawaited(_load(silent: _data.isNotEmpty));
  }

  /// 磁盘缓存 key：上次成功响应体原样落盘（stale-while-revalidate 用）。
  static String get _cacheKey => "dynamics_${ApiConfig.effectiveActorId}";

  /// [silent]=true 时已有数据保持展示，成功换数据、失败不闪错误页。
  Future<void> _load({bool silent = false}) async {
    if (!silent && _data.isEmpty) {
      if (_error == null) {
        final Map<String, dynamic>? cached =
            await MobilePageCache.instance.read(_cacheKey);
        if (!mounted) return;
        if (cached != null) {
          setState(() {
            _data = cached;
            _loading = false;
            _reconcileLayout();
          });
          unawaited(_fetch(silent: true));
          return;
        }
      }
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    await _fetch(silent: silent);
  }

  Future<void> _fetch({required bool silent}) async {
    try {
      final Uri uri = Uri.parse(
          "${ApiConfig.httpBase}/api/dynamics?userId=${Uri.encodeQueryComponent(ApiConfig.effectiveActorId)}");
      final http.Response res = await (widget.client ?? NbClient())
          .get(uri)
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw Exception("服务端返回 ${res.statusCode}");
      }
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) {
        throw Exception(body["error"]?.toString() ?? "未知错误");
      }
      MobilePageCache.instance.write(_cacheKey, body);
      if (!mounted) return;
      setState(() {
        _data = body;
        _loading = false;
        _error = null;
        _reconcileLayout();
      });
    } catch (e) {
      if (!mounted) return;
      // 静默刷新失败：已有数据保持展示（不闪错误页）；无数据才落到错误态。
      if (silent && _data.isNotEmpty) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  // —— 解析 helpers（网络与缓存共用同一 _data 形状） ——

  List<Map<String, dynamic>> _listOf(String section, String key) {
    final Map<String, dynamic> sec =
        (_data[section] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final List<dynamic> raw = (sec[key] as List<dynamic>?) ?? const <dynamic>[];
    return raw.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  /// 顶部账单卡轮播与月报明细页共用的月结数据（服务端 monthly 字段）。
  /// null = 台账未启用：账单卡退回最新一笔展示，月报明细不可进。
  Map<String, dynamic>? get _monthly {
    final Object? raw = _data["monthly"];
    return raw is Map<String, dynamic> && raw.isNotEmpty ? raw : null;
  }

  /// 月报明细页类目纠正用的可选类目列表（服务端 billTypes）。
  List<String> get _billTypes {
    final List<dynamic> raw =
        (_data["billTypes"] as List<dynamic>?) ?? const <dynamic>[];
    return raw.whereType<String>().toList(growable: false);
  }

  Future<void> _loadLayout() async {
    final _DynamicsLayout layout = await _DynamicsLayoutStore.load(
      ApiConfig.effectiveActorId,
    );
    if (!mounted) return;
    setState(() {
      _order = layout.order;
      _pins = <String?>[
        layout.pins.isNotEmpty ? layout.pins[0] : null,
        layout.pins.length > 1 ? layout.pins[1] : null,
      ];
      _autoExcluded = layout.excluded.toSet();
      _reconcileLayout();
    });
  }

  void _reconcileLayout() {
    final List<_DynamicsCard> cards = _cards;
    final Set<String> validIds =
        cards.map((_DynamicsCard card) => card.id).toSet();
    final Set<String> seen = <String>{};
    final List<String> nextOrder = <String>[];
    for (final String id in _order) {
      if (validIds.contains(id) && seen.add(id)) nextOrder.add(id);
    }
    for (final _DynamicsCard card in cards) {
      if (seen.add(card.id)) nextOrder.add(card.id);
    }
    _order = nextOrder;

    final Set<String> usedPins = <String>{};
    _pins = <String?>[
      for (int i = 0; i < 2; i++)
        if (i < _pins.length &&
            _pins[i] != null &&
            validIds.contains(_pins[i]) &&
            usedPins.add(_pins[i]!))
          _pins[i]
        else
          null,
    ];
    _autoExcluded = _autoExcluded.intersection(validIds);
  }

  // —— 一类一卡：快递 / 账单 / 邮件各只有一张聚合卡 ——

  /// 待取件优先，同组内按时间新→旧。
  static List<Map<String, dynamic>> _sortParcels(
      List<Map<String, dynamic>> items) {
    return List<Map<String, dynamic>>.from(items)
      ..sort((Map<String, dynamic> a, Map<String, dynamic> b) {
        final bool aa =
            (a["pickupCode"]?.toString() ?? "").isNotEmpty;
        final bool bb =
            (b["pickupCode"]?.toString() ?? "").isNotEmpty;
        if (aa != bb) return aa ? -1 : 1;
        return ((b["occurredAt"] as num?) ?? 0)
            .compareTo((a["occurredAt"] as num?) ?? 0);
      });
  }

  static List<Map<String, dynamic>> _sortBills(
      List<Map<String, dynamic>> items) {
    return List<Map<String, dynamic>>.from(items)
      ..sort((a, b) => ((b["occurredAt"] as num?) ?? 0)
          .compareTo((a["occurredAt"] as num?) ?? 0));
  }

  /// 邮件列表统一排序（新→旧），卡面与详情页共用同一口径。
  static List<Map<String, dynamic>> sortMailByNewest(
      List<Map<String, dynamic>> items) {
    final List<Map<String, dynamic>> sorted = List<Map<String, dynamic>>.from(
        items)
      ..sort(
          (a, b) => ((b["at"] as num?) ?? 0).compareTo((a["at"] as num?) ?? 0));
    return sorted;
  }

  static int _maxTime(List<Map<String, dynamic>> items, String key) {
    int max = 0;
    for (final Map<String, dynamic> item in items) {
      final int at = ((item[key] as num?) ?? 0).toInt();
      if (at > max) max = at;
    }
    return max;
  }

  int _maxPriority(
    _DynamicsKind kind,
    List<Map<String, dynamic>> items,
    int now,
  ) {
    int max = 0;
    for (final Map<String, dynamic> item in items) {
      final int v = _cardPriority(kind, item, now);
      if (v > max) max = v;
    }
    return max;
  }

  static int _cardPriority(
    _DynamicsKind kind,
    Map<String, dynamic> item,
    int now,
  ) {
    final int at = kind == _DynamicsKind.mail
        ? ((item["at"] as num?) ?? 0).toInt()
        : ((item["occurredAt"] as num?) ?? 0).toInt();
    final int age = at <= 0 ? 365 : (now - at).clamp(0, 365 * 86400000);
    final int recency = age <= 86400000
        ? 180
        : age <= 3 * 86400000
            ? 90
            : 0;
    return switch (kind) {
          _DynamicsKind.parcel =>
            (item["pickupCode"]?.toString().isNotEmpty ?? false) ? 1000 : 280,
          _DynamicsKind.bill => 560,
          _DynamicsKind.mail =>
            item["salience"]?.toString() == "high" ? 860 : 680,
        } +
        recency;
  }

  List<_DynamicsCard> get _cards {
    final int now = DateTime.now().millisecondsSinceEpoch;
    final List<_DynamicsCard> cards = <_DynamicsCard>[];

    final List<Map<String, dynamic>> parcels =
        _sortParcels(_listOf("parcels", "recent"));
    if (parcels.isNotEmpty) {
      cards.add(_DynamicsCard(
        id: "parcel",
        kind: _DynamicsKind.parcel,
        items: parcels,
        timestamp: _maxTime(parcels, "occurredAt"),
        priority: _maxPriority(_DynamicsKind.parcel, parcels, now),
      ));
    }

    final List<Map<String, dynamic>> bills =
        _sortBills(_listOf("bills", "recent"));
    if (bills.isNotEmpty) {
      cards.add(_DynamicsCard(
        id: "bill",
        kind: _DynamicsKind.bill,
        items: bills,
        timestamp: _maxTime(bills, "occurredAt"),
        priority: _maxPriority(_DynamicsKind.bill, bills, now),
      ));
    }

    final List<Map<String, dynamic>> mail =
        sortMailByNewest(_listOf("mail", "recent"));
    if (mail.isNotEmpty) {
      cards.add(_DynamicsCard(
        id: "mail",
        kind: _DynamicsKind.mail,
        items: mail,
        timestamp: _maxTime(mail, "at"),
        priority: _maxPriority(_DynamicsKind.mail, mail, now),
      ));
    }
    return cards;
  }

  List<_DynamicsCard> get _orderedCards {
    final Map<String, _DynamicsCard> byId = <String, _DynamicsCard>{
      for (final _DynamicsCard card in _cards) card.id: card,
    };
    return <_DynamicsCard>[
      for (final String id in _order)
        if (byId[id] case final _DynamicsCard card) card,
    ];
  }

  /// 槽位占位：手动置顶优先，剩余按优先级自动补位（排除被用户移出的卡）。
  List<String?> get _slotIds {
    final Set<String> validIds =
        _cards.map((_DynamicsCard card) => card.id).toSet();
    final List<String?> slots = <String?>[null, null];
    final Set<String> used = <String>{};
    for (int i = 0; i < 2; i++) {
      final String? id = i < _pins.length ? _pins[i] : null;
      if (id != null && validIds.contains(id) && used.add(id)) slots[i] = id;
    }
    final List<_DynamicsCard> candidates = _orderedCards
        .where((_DynamicsCard card) =>
            !used.contains(card.id) && !_autoExcluded.contains(card.id))
        .toList()
      ..sort((_DynamicsCard a, _DynamicsCard b) {
        final int byPriority = b.priority.compareTo(a.priority);
        return byPriority != 0
            ? byPriority
            : b.timestamp.compareTo(a.timestamp);
      });
    for (final _DynamicsCard card in candidates) {
      final int emptyIndex = slots.indexOf(null);
      if (emptyIndex < 0) break;
      slots[emptyIndex] = card.id;
      used.add(card.id);
    }
    return slots;
  }

  /// 信息流 = 全部卡 − 槽位占用的卡（类型级互斥：槽里有的，下面绝不重复）。
  List<_DynamicsCard> get _feedCards {
    final List<String?> slots = _slotIds;
    return _orderedCards
        .where((_DynamicsCard card) => !slots.contains(card.id))
        .toList(growable: false);
  }

  void _saveLayout() {
    unawaited(_DynamicsLayoutStore.save(
      ApiConfig.effectiveActorId,
      _DynamicsLayout(
        order: List<String>.of(_order),
        pins: List<String?>.of(_pins),
        excluded: _autoExcluded.toList(),
      ),
    ));
  }

  void _moveOrderBefore(String id, String targetId) {
    if (id == targetId) return;
    final List<String> next = List<String>.of(_order)..remove(id);
    final int target = next.indexOf(targetId);
    next.insert(target < 0 ? next.length : target, id);
    _order = next;
  }

  /// 信息流卡拖入槽位。原占位卡回落信息流并进入排除集——不排除的话它作为
  /// 最高优先级候选会在下一帧被自动补位抓回槽位，用户「移出」的意图就丢了。
  void _pinCard(String id, int slot) {
    if (slot < 0 || slot > 1 || _slotIds[slot] == id) return;
    final String? displaced = _slotIds[slot];
    setState(() {
      final List<String?> nextPins = List<String?>.of(_pins);
      final int existing = nextPins.indexOf(id);
      final bool displacedMoved = existing >= 0 && existing != slot;
      if (displacedMoved) nextPins[existing] = displaced;
      nextPins[slot] = id;
      _pins = nextPins;
      _autoExcluded.remove(id);
      if (displaced != null && !displacedMoved) _autoExcluded.add(displaced);
    });
    _saveLayout();
  }

  /// 槽位卡拖到另一个槽位：两槽互换。
  void _moveTopCardToSlot(String id, int targetSlot) {
    final int sourceSlot = _slotIds.indexOf(id);
    if (sourceSlot < 0 || sourceSlot == targetSlot) return;
    final String? displaced = _slotIds[targetSlot];
    setState(() {
      final List<String?> nextPins = List<String?>.of(_pins);
      nextPins[sourceSlot] = displaced;
      nextPins[targetSlot] = id;
      _pins = nextPins;
      _autoExcluded.remove(id);
    });
    _saveLayout();
  }

  /// 槽位卡拖到信息流卡上：移出置顶，插到目标卡前面，且不再被自动补位。
  void _moveTopCardToFeed(String id, String targetId) {
    setState(() {
      _pins = <String?>[
        for (final String? pin in _pins) pin == id ? null : pin,
      ];
      _autoExcluded.add(id);
      _moveOrderBefore(id, targetId);
    });
    _saveLayout();
  }

  // —— 构建 ——

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: _GlassAppBar(title: "动态"),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : _error != null
              ? _buildError(p)
              : RefreshIndicator(
                  onRefresh: () => _load(silent: true),
                  child: _buildBody(p),
                ),
    );
  }

  Widget _buildError(MobilePalette p) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 40, color: p.textMuted),
            const SizedBox(height: 12),
            Text(
              "动态获取失败\n请确认已连接服务器(${ApiConfig.httpBase})",
              textAlign: TextAlign.center,
              style: TextStyle(color: p.textSecondary, fontSize: 14),
            ),
            const SizedBox(height: 16),
            OutlinedButton(
                onPressed: () => unawaited(_load()), child: const Text("重试")),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(MobilePalette p) {
    final List<_DynamicsCard> all = _cards;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double feedWidth = constraints.maxWidth - 32;
        final double slotWidth = (feedWidth - 10) / 2;
        final List<_DynamicsCard> feed = _feedCards;
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 24),
          children: <Widget>[
            _buildTopArea(p, slotWidth),
            if (all.isEmpty) _buildEmpty(p),
            for (final _DynamicsCard card in feed)
              _buildFeedCard(p, card, feedWidth),
          ],
        );
      },
    );
  }

  Widget _buildEmpty(MobilePalette p) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 40, 20, 24),
      child: Column(
        children: <Widget>[
          Icon(Icons.graphic_eq, size: 44, color: p.textMuted),
          const SizedBox(height: 12),
          Text(
            "还没有动静\n识别到账单、快递或重要邮件时会出现在这里",
            textAlign: TextAlign.center,
            style: TextStyle(color: p.textSecondary, fontSize: 14),
          ),
        ],
      ),
    );
  }

  Widget _buildTopArea(MobilePalette p, double slotWidth) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: 14),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SizedBox(
            height: 132,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Expanded(child: _buildTopSlot(p, 0, slotWidth)),
                const SizedBox(width: 10),
                Expanded(child: _buildTopSlot(p, 1, slotWidth)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
      ],
    );
  }

  Widget _buildTopSlot(MobilePalette p, int slot, double width) {
    final String? id = _slotIds[slot];
    _DynamicsCard? card;
    if (id != null) {
      for (final _DynamicsCard c in _cards) {
        if (c.id == id) {
          card = c;
          break;
        }
      }
    }
    return DragTarget<_TopDragData>(
      key: ValueKey<String>("dynamics-slot-$slot"),
      onWillAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
          details.data.id != id,
      onAcceptWithDetails: (DragTargetDetails<_TopDragData> details) {
        if (details.data.slot >= 0) {
          _moveTopCardToSlot(details.data.id, slot);
        } else {
          _pinCard(details.data.id, slot);
        }
      },
      builder: (BuildContext context, List<_TopDragData?> candidateData,
          List<dynamic> rejectedData) {
        final bool highlighted = candidateData.isNotEmpty;
        return AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            color: highlighted ? p.innerFieldBackground : Colors.transparent,
            borderRadius: BorderRadius.circular(17),
            border: Border.all(
              color: highlighted ? p.textPrimary : Colors.transparent,
              width: 1.5,
            ),
          ),
          child: card == null
              ? _buildEmptySlot(p)
              : _buildTopDraggable(card, slot, width - 6),
        );
      },
    );
  }

  Widget _buildEmptySlot(MobilePalette p) {
    return CustomPaint(
      foregroundPainter: _DashRectPainter(
        color: p.textMuted.withValues(alpha: 0.45),
      ),
      child: _GlassCard(
        padding: EdgeInsets.zero,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(Icons.add, size: 22, color: p.textMuted),
            const SizedBox(height: 6),
            Text(
              "暂无优先事项",
              style: TextStyle(color: p.textMuted, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTopDraggable(_DynamicsCard card, int slot, double width) {
    final _MonthlyView? monthly =
        _monthly == null ? null : _MonthlyView(_monthly!);
    final VoidCallback? onTap = switch (card.kind) {
      _DynamicsKind.mail => () => _openMailDetail(context, card.items),
      _DynamicsKind.bill => monthly != null
          ? () => _openMonthlyDetail(context, _monthly!, card.items)
          : null,
      _DynamicsKind.parcel => null,
    };
    final Widget child = _TopCard(
      card: card,
      billPages: card.kind == _DynamicsKind.bill && monthly != null
          ? _billSlotPages(monthly)
          : null,
      pause: _dragPause,
    );
    return LongPressDraggable<_TopDragData>(
      data: _TopDragData(card.id, slot),
      delay: const Duration(milliseconds: 220),
      onDragStarted: () => _dragPause.value = true,
      onDragEnd: (_) => _dragPause.value = false,
      feedback: _dragFeedback(
        content: child,
        width: width,
        height: 126,
      ),
      childWhenDragging: _dragPlaceholder(context, child),
      child: onTap != null
          ? Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(14),
                child: child,
              ),
            )
          : child,
    );
  }

  Widget _buildFeedCard(MobilePalette p, _DynamicsCard card, double width) {
    final _MonthlyView? monthly =
        _monthly == null ? null : _MonthlyView(_monthly!);
    final Widget content = SizedBox(
      width: width,
      child: switch (card.kind) {
        _DynamicsKind.parcel => _AggregateCard(
            icon: Icons.local_shipping_outlined,
            cap: _parcelCap(card),
            pages: <Widget>[
              for (final Map<String, dynamic> item in card.items)
                _ParcelPanel(item: item),
            ],
            pageHeight: 48,
            pause: _dragPause,
          ),
        _DynamicsKind.bill => _AggregateCard(
            icon: Icons.receipt_outlined,
            cap: monthly != null ? "账单 · ${monthly.monthLabel}" : "账单",
            pages: _billFeedPages(monthly, card.items),
            pageHeight: 72,
            pause: _dragPause,
            onTap: monthly != null
                ? () => _openMonthlyDetail(context, _monthly!, card.items)
                : null,
          ),
        _DynamicsKind.mail => _AggregateCard(
            icon: Icons.mail_outline,
            cap: "邮件 · ${card.items.length} 封要事",
            pages: <Widget>[_MailPanel(item: card.items.first)],
            pageHeight: 62,
            pause: _dragPause,
            onTap: () => _openMailDetail(context, card.items),
          ),
      },
    );
    return Padding(
      key: ValueKey<String>(card.id),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: DragTarget<_TopDragData>(
        onWillAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
            details.data.id != card.id,
        onAcceptWithDetails: (DragTargetDetails<_TopDragData> details) {
          final _TopDragData data = details.data;
          if (data.slot >= 0) {
            _moveTopCardToFeed(data.id, card.id);
          } else {
            setState(() => _moveOrderBefore(data.id, card.id));
            _saveLayout();
          }
        },
        builder: (BuildContext context, List<_TopDragData?> candidateData,
            List<dynamic> rejectedData) {
          final bool highlighted = candidateData.isNotEmpty;
          return LongPressDraggable<_TopDragData>(
            data: _TopDragData(card.id, -1),
            delay: const Duration(milliseconds: 220),
            onDragStarted: () => _dragPause.value = true,
            onDragEnd: (_) => _dragPause.value = false,
            feedback: _dragFeedback(content: content, width: width),
            childWhenDragging: _dragPlaceholder(context, content),
            child: AnimatedScale(
              duration: const Duration(milliseconds: 160),
              scale: highlighted ? 1.015 : 1,
              child: content,
            ),
          );
        },
      ),
    );
  }

  String _parcelCap(_DynamicsCard card) {
    final int awaiting = card.items
        .where((Map<String, dynamic> e) =>
            (e["pickupCode"]?.toString() ?? "").isNotEmpty)
        .length;
    return awaiting > 0 ? "快递 · $awaiting 件待取" : "快递";
  }

  /// 账单聚合卡轮播页：合计 / 订阅续费 / Top 类目 / 最大单笔（无月结退回最新一笔）。
  List<Widget> _billFeedPages(
    _MonthlyView? m,
    List<Map<String, dynamic>> bills,
  ) {
    if (m == null) {
      if (bills.isEmpty) {
        return <Widget>[_BillPanel(big: "—", tag: "本月合计", sub: "暂无账单")];
      }
      final Map<String, dynamic> item = bills.first;
      final num? amount = item["amount"] as num?;
      return <Widget>[
        _BillPanel(
          big: amount != null ? "¥${_fmtAmount(amount)}" : "—",
          tag: "最新一笔",
          sub: <String>[
            item["title"]?.toString() ?? "",
            switch (item["source"]?.toString()) {
              "email" => "邮件识别",
              "sms" => "短信识别",
              _ => "通知识别",
            },
            _fmtTime(((item["occurredAt"] as num?) ?? 0).toInt()),
          ].where((String s) => s.isNotEmpty).join(" · "),
        ),
      ];
    }
    final bool noData = m.count == 0;
    final List<Widget> pages = <Widget>[
      _BillPanel(
        big: noData ? "—" : "¥${_fmtAmount(m.totalAmount)}",
        tag: "本月合计",
        sub: noData ? "这个月还没有识别到账单" : "${m.count} 笔 · ${m.momLine}",
      ),
    ];
    final num chargedCount = _MonthlyView._n(m.subscriptions, "chargedCount");
    final num forecastCount =
        _MonthlyView._n(m.subscriptions, "forecastCount");
    if (!noData && chargedCount > 0) {
      String nextLine = "";
      if (m.forecast.isNotEmpty) {
        final Map<String, dynamic> f = m.forecast.first;
        nextLine =
            " · 下笔 ${f["merchant"]?.toString() ?? ""} ${_fmtTime(_MonthlyView._n(f, "expectedAt").toInt())}";
      }
      pages.add(_BillPanel(
        big:
            "¥${_fmtAmount(_MonthlyView._n(m.subscriptions, "chargedAmount"))}",
        tag: "订阅续费",
        sub: "已扣 $chargedCount 笔$nextLine",
      ));
    } else if (!noData && forecastCount > 0) {
      pages.add(_BillPanel(
        big:
            "¥${_fmtAmount(_MonthlyView._n(m.subscriptions, "forecastAmount"))}",
        tag: "下月预计",
        sub: "预计 $forecastCount 笔",
      ));
    }
    final List<Map<String, dynamic>> tops = m.topCategories;
    if (!noData && tops.isNotEmpty) {
      final Map<String, dynamic> top = tops.first;
      final String secondLine = tops.length > 1
          ? " · 其次 ${tops[1]["type"]?.toString() ?? "其他"} ${(_MonthlyView._n(tops[1], "ratio") * 100).round()}%"
          : "";
      pages.add(_BillPanel(
        big: "¥${_fmtAmount(_MonthlyView._n(top, "amount"))}",
        tag:
            "${top["type"]?.toString() ?? "其他"} · ${(_MonthlyView._n(top, "ratio") * 100).round()}%",
        barRatio: _MonthlyView._n(top, "ratio").toDouble(),
        sub: "本月最大类目$secondLine",
      ));
    }
    final Map<String, dynamic>? largest = m.largest;
    if (!noData && largest != null) {
      pages.add(_BillPanel(
        big: "¥${_fmtAmount(_MonthlyView._n(largest, "amount"))}",
        tag: "最大单笔",
        sub:
            "${largest["title"]?.toString() ?? ""} · ${_fmtTime(_MonthlyView._n(largest, "occurredAt").toInt())}",
      ));
    }
    return pages;
  }

  /// 槽位账单卡小轮播：合计 + 订阅（两页以内，槽位空间有限）。
  List<Widget> _billSlotPages(_MonthlyView m) {
    final bool noData = m.count == 0;
    final List<Widget> pages = <Widget>[
      _BillMiniPanel(
        amount: noData ? null : m.totalAmount,
        tag: "本月合计",
        sub: noData ? "这个月还没有识别到账单" : "${m.count} 笔 · ${m.momLine}",
      ),
    ];
    final num chargedCount = _MonthlyView._n(m.subscriptions, "chargedCount");
    final num forecastCount =
        _MonthlyView._n(m.subscriptions, "forecastCount");
    if (!noData && chargedCount > 0) {
      String nextLine = "";
      if (m.forecast.isNotEmpty) {
        final Map<String, dynamic> f = m.forecast.first;
        nextLine =
            " · 下笔 ${f["merchant"]?.toString() ?? ""} ${_fmtTime(_MonthlyView._n(f, "expectedAt").toInt())}";
      }
      pages.add(_BillMiniPanel(
        amount: _MonthlyView._n(m.subscriptions, "chargedAmount"),
        tag: "订阅续费",
        sub: "已扣 $chargedCount 笔$nextLine",
      ));
    } else if (!noData && forecastCount > 0) {
      pages.add(_BillMiniPanel(
        amount: _MonthlyView._n(m.subscriptions, "forecastAmount"),
        tag: "下月预计",
        sub: "预计 $forecastCount 笔",
      ));
    }
    return pages;
  }

  /// 拖拽浮起的卡：微倾 + 微放大 + 投影。
  Widget _dragFeedback({
    required Widget content,
    required double width,
    double? height,
  }) {
    return Material(
      type: MaterialType.transparency,
      child: Transform(
        alignment: Alignment.center,
        transform: Matrix4.identity()
          ..rotateZ(0.035)
          ..scaleByDouble(1.02, 1.02, 1.02, 1.0),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.28),
                blurRadius: 32,
                offset: const Offset(0, 16),
              ),
            ],
          ),
          child: SizedBox(
            width: width,
            height: height,
            child: content,
          ),
        ),
      ),
    );
  }

  /// 拖拽原位虚线占位。
  Widget _dragPlaceholder(BuildContext context, Widget content) {
    final MobilePalette p = MobileTheme.of(context);
    return CustomPaint(
      foregroundPainter: _DashRectPainter(
        color: p.textMuted.withValues(alpha: 0.4),
      ),
      child: Opacity(opacity: 0.18, child: content),
    );
  }

  static String _fmtAmount(num v) {
    final double d = v.toDouble();
    if (d == d.roundToDouble()) return d.toStringAsFixed(0);
    return d.toStringAsFixed(2);
  }

  /// 相对时间：今天 → "HH:mm"；昨天 → "昨天 HH:mm"；更早 → "M月d日 HH:mm"。
  static String _fmtTime(num ms) {
    if (ms <= 0) return "";
    final DateTime t = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    final DateTime now = DateTime.now();
    final bool sameDay =
        t.year == now.year && t.month == now.month && t.day == now.day;
    final String hm =
        "${t.hour.toString().padLeft(2, "0")}:${t.minute.toString().padLeft(2, "0")}";
    if (sameDay) return hm;
    final DateTime yesterday = now.subtract(const Duration(days: 1));
    final bool isYesterday = t.year == yesterday.year &&
        t.month == yesterday.month &&
        t.day == yesterday.day;
    if (isYesterday) return "昨天 $hm";
    return "${t.month}月${t.day}日 $hm";
  }

  /// 点邮件卡 → 全屏详情页看全部。
  /// 数据直接复用本页已拉取的 mail 列表，不再发第二次请求。
  /// 按 at 降序（新→旧）传入，卡面与详情首条一致都是最新一封。
  void _openMailDetail(BuildContext context, List<Map<String, dynamic>> items) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MobileMailDetailPage(
            items: MobileDynamicsPageState.sortMailByNewest(items),
          ),
        ),
      ),
    );
  }

  /// 点账单卡 → 月报明细页（小结块 + 类目筛选 + 明细，类目可改）。
  /// 账单条目复用本页已拉取的 bills.recent，改类目后由详情页自己回写本地状态。
  void _openMonthlyDetail(
    BuildContext context,
    Map<String, dynamic> monthly,
    List<Map<String, dynamic>> bills,
  ) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MobileMonthlyDetailPage(
            monthly: monthly,
            bills: bills,
            billTypes: _billTypes,
          ),
        ),
      ),
    );
  }
}

// —— 磨砂玻璃 —— //

/// 玻璃卡的深浅两套参数（填充/描边/投影），对照设计稿 V3：
/// blur 26 + 半透明底（深 .45 / 浅 .48）+ 白描边 + 投影，背景保持纯色不动。
/// 顶部高光渐变已按用户要求移除，卡片不再有发光感。
class _GlassTone {
  const _GlassTone({
    required this.fill,
    required this.stroke,
    required this.shadow,
  });

  final Color fill;
  final Color stroke;
  final List<BoxShadow> shadow;

  factory _GlassTone.of(BuildContext context) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    if (dark) {
      return _GlassTone(
        fill: const Color(0xFF1B1B1F).withValues(alpha: 0.45),
        stroke: Colors.white.withValues(alpha: 0.12),
        shadow: <BoxShadow>[
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.38),
            blurRadius: 32,
            offset: const Offset(0, 12),
          ),
        ],
      );
    }
    return _GlassTone(
      fill: Colors.white.withValues(alpha: 0.48),
      stroke: Colors.white.withValues(alpha: 0.60),
      shadow: <BoxShadow>[
        BoxShadow(
          color: const Color(0xFF1E293B).withValues(alpha: 0.18),
          blurRadius: 28,
          offset: const Offset(0, 12),
        ),
      ],
    );
  }
}

/// 磨砂玻璃卡容器。投影层在 ClipRRect 外（否则阴影被裁掉），
/// 内层 半透明底 + 白描边（顶部高光渐变已移除，无发光效果）。
class _GlassCard extends StatelessWidget {
  const _GlassCard({
    required this.child,
    this.radius = 14,
    this.padding = const EdgeInsets.all(12),
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final _GlassTone tone = _GlassTone.of(context);
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        boxShadow: tone.shadow,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 26, sigmaY: 26),
          child: Container(
            padding: padding,
            decoration: BoxDecoration(
              color: tone.fill,
              borderRadius: BorderRadius.circular(radius),
              border: Border.all(color: tone.stroke),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// 玻璃 AppBar：磨砂底 + 描边下沿，标题居中。
class _GlassAppBar extends StatelessWidget implements PreferredSizeWidget {
  const _GlassAppBar({required this.title});

  final String title;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final _GlassTone tone = _GlassTone.of(context);
    return AppBar(
      backgroundColor: Colors.transparent,
      foregroundColor: p.textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      centerTitle: true,
      title: Text(title),
      flexibleSpace: ClipRect(
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 26, sigmaY: 26),
          child: Container(
            decoration: BoxDecoration(
              color: tone.fill,
              border: Border(bottom: BorderSide(color: tone.stroke)),
            ),
          ),
        ),
      ),
    );
  }
}

/// 虚线圆角矩形描边（拖拽占位 / 空槽提示）。
class _DashRectPainter extends CustomPainter {
  const _DashRectPainter({required this.color});

  final Color color;

  static const double _radius = 14;
  static const double _strokeWidth = 1.4;
  static const double _dash = 5;
  static const double _gap = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = Path()
      ..addRRect(RRect.fromRectAndRadius(
        Offset.zero & size,
        Radius.circular(_radius),
      ));
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _strokeWidth
      ..color = color;
    for (final PathMetric metric in path.computeMetrics()) {
      double dist = 0;
      while (dist < metric.length) {
        final double end =
            (dist + _dash).clamp(0.0, metric.length).toDouble();
        canvas.drawPath(metric.extractPath(dist, end), paint);
        dist += _dash + _gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashRectPainter oldDelegate) =>
      oldDelegate.color != color;
}

// —— 轮播 —— //

/// 信息流聚合卡：玻璃壳 + 卡头（图标/标题/指示点）+ 自动翻页的页体。
/// 自动 4s 一翻；任何翻页（含手动）都重置节奏；拖拽期间由 [pause] 挂起。
class _AggregateCard extends StatefulWidget {
  const _AggregateCard({
    required this.icon,
    required this.cap,
    required this.pages,
    required this.pageHeight,
    this.pause,
    this.onTap,
  });

  final IconData icon;
  final String cap;
  final List<Widget> pages;
  final double pageHeight;
  final ValueListenable<bool>? pause;
  final VoidCallback? onTap;

  @override
  State<_AggregateCard> createState() => _AggregateCardState();
}

class _AggregateCardState extends State<_AggregateCard> {
  PageController? _ctrl;
  Timer? _timer;
  int _index = 0;

  bool get _multi => widget.pages.length > 1;

  bool get _paused => widget.pause?.value ?? false;

  @override
  void initState() {
    super.initState();
    widget.pause?.addListener(_onPauseChanged);
    if (_multi) _ctrl = PageController();
    _arm();
  }

  @override
  void didUpdateWidget(_AggregateCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.pause, widget.pause)) {
      oldWidget.pause?.removeListener(_onPauseChanged);
      widget.pause?.addListener(_onPauseChanged);
    }
    if (_multi) {
      _ctrl ??= PageController();
      _arm();
    } else {
      _timer?.cancel();
      _timer = null;
      _index = 0;
    }
  }

  @override
  void dispose() {
    widget.pause?.removeListener(_onPauseChanged);
    _timer?.cancel();
    _ctrl?.dispose();
    super.dispose();
  }

  void _arm() {
    _timer?.cancel();
    _timer = null;
    if (_multi && !_paused) {
      _timer = Timer.periodic(const Duration(seconds: 4), (_) => _flip());
    }
  }

  void _onPauseChanged() {
    if (!mounted) return;
    if (_paused) {
      _timer?.cancel();
      _timer = null;
    } else {
      _arm();
    }
  }

  void _flip() {
    final PageController? ctrl = _ctrl;
    if (!mounted || ctrl == null || !ctrl.hasClients) return;
    final int next = (_index + 1) % widget.pages.length;
    ctrl.animateToPage(
      next,
      duration: const Duration(milliseconds: 450),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget body = _multi
        ? PageView(
            controller: _ctrl,
            onPageChanged: (int i) {
              setState(() => _index = i);
              _arm();
            },
            children: <Widget>[
              for (final Widget page in widget.pages)
                Align(alignment: Alignment.topLeft, child: page),
            ],
          )
        : Align(alignment: Alignment.topLeft, child: widget.pages.first);
    final Widget card = _GlassCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          _CardHead(
            icon: widget.icon,
            cap: widget.cap,
            dots: _multi ? widget.pages.length : 0,
            current: _index,
          ),
          const SizedBox(height: 8),
          SizedBox(height: widget.pageHeight, child: body),
        ],
      ),
    );
    if (widget.onTap == null) return card;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: widget.onTap,
        borderRadius: BorderRadius.circular(14),
        child: card,
      ),
    );
  }
}

/// 聚合卡卡头：类型图标 + 标题 + 翻页指示点 + 右箭头。
class _CardHead extends StatelessWidget {
  const _CardHead({
    required this.icon,
    required this.cap,
    required this.dots,
    required this.current,
  });

  final IconData icon;
  final String cap;
  final int dots;
  final int current;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Row(
      children: <Widget>[
        Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            color: p.innerFieldBackground,
            borderRadius: BorderRadius.circular(7),
          ),
          child: Icon(icon, size: 14, color: p.textPrimary),
        ),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            cap,
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (dots > 1) ...<Widget>[
          const SizedBox(width: 8),
          _Dots(count: dots, current: current),
          const SizedBox(width: 8),
        ],
        Icon(Icons.chevron_right, size: 16, color: p.textMuted),
      ],
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.current});

  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 250),
            width: i == current ? 12 : 4,
            height: 4,
            margin: EdgeInsets.only(right: i < count - 1 ? 4 : 0),
            decoration: BoxDecoration(
              color: i == current
                  ? p.textPrimary
                  : p.textPrimary.withValues(alpha: 0.25),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
      ],
    );
  }
}

/// 槽位卡内的小轮播（无卡头指示点，自动翻页节奏与聚合卡一致）。
class _MiniCarousel extends StatefulWidget {
  const _MiniCarousel({required this.pages, this.pause});

  final List<Widget> pages;
  final ValueListenable<bool>? pause;

  @override
  State<_MiniCarousel> createState() => _MiniCarouselState();
}

class _MiniCarouselState extends State<_MiniCarousel> {
  PageController? _ctrl;
  Timer? _timer;

  bool get _multi => widget.pages.length > 1;

  bool get _paused => widget.pause?.value ?? false;

  @override
  void initState() {
    super.initState();
    widget.pause?.addListener(_onPauseChanged);
    if (_multi) _ctrl = PageController();
    _arm();
  }

  @override
  void didUpdateWidget(_MiniCarousel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.pause, widget.pause)) {
      oldWidget.pause?.removeListener(_onPauseChanged);
      widget.pause?.addListener(_onPauseChanged);
    }
    if (_multi) {
      _ctrl ??= PageController();
      _arm();
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    widget.pause?.removeListener(_onPauseChanged);
    _timer?.cancel();
    _ctrl?.dispose();
    super.dispose();
  }

  void _arm() {
    _timer?.cancel();
    _timer = null;
    if (_multi && !_paused) {
      _timer = Timer.periodic(const Duration(seconds: 4), (_) => _flip());
    }
  }

  void _onPauseChanged() {
    if (!mounted) return;
    if (_paused) {
      _timer?.cancel();
      _timer = null;
    } else {
      _arm();
    }
  }

  void _flip() {
    final PageController? ctrl = _ctrl;
    if (!mounted || ctrl == null || !ctrl.hasClients) return;
    final Object? page = ctrl.page;
    final int current = page is num ? page.round() : 0;
    ctrl.animateToPage(
      (current + 1) % widget.pages.length,
      duration: const Duration(milliseconds: 450),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_multi) {
      return Align(alignment: Alignment.topLeft, child: widget.pages.first);
    }
    return PageView(
      controller: _ctrl,
      onPageChanged: (_) => _arm(),
      children: <Widget>[
        for (final Widget page in widget.pages)
          Align(alignment: Alignment.topLeft, child: page),
      ],
    );
  }
}

// —— 卡面面板 —— //

/// 快递页：标题 + 承运/时间，待取件在右侧放反白取件码块。
class _ParcelPanel extends StatelessWidget {
  const _ParcelPanel({required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String title = item["title"]?.toString() ?? "包裹动态";
    final String pickup = item["pickupCode"]?.toString() ?? "";
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                title,
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 4),
              Text(
                <String>[
                  if ((item["carrier"]?.toString() ?? "").isNotEmpty)
                    item["carrier"].toString(),
                  if ((item["trackingNo"]?.toString() ?? "").isNotEmpty)
                    "单号 ${item["trackingNo"]}",
                  MobileDynamicsPageState._fmtTime(
                    ((item["occurredAt"] as num?) ?? 0).toInt(),
                  ),
                ].join(" · "),
                style: TextStyle(color: p.textMuted, fontSize: 12),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
        if (pickup.isNotEmpty) ...<Widget>[
          const SizedBox(width: 10),
          _PickupBlock(code: pickup),
        ],
      ],
    );
  }
}

/// 反白取件码块：置顶进槽位后同样保留。
class _PickupBlock extends StatelessWidget {
  const _PickupBlock({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: p.accent,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            "取件码",
            style: TextStyle(
              color: p.onAccent.withValues(alpha: 0.75),
              fontSize: 9,
              letterSpacing: 1,
            ),
          ),
          Text(
            code,
            style: TextStyle(
              color: p.onAccent,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

/// 账单页：大数字 + 类目进度条（可选）+ 说明行。
class _BillPanel extends StatelessWidget {
  const _BillPanel({
    required this.big,
    required this.tag,
    required this.sub,
    this.barRatio,
  });

  final String big;
  final String tag;
  final String sub;
  final double? barRatio;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: <Widget>[
            Text(
              big,
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 24,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.3,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                tag,
                style: TextStyle(color: p.textSecondary, fontSize: 12),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
        if (barRatio != null) ...<Widget>[
          const SizedBox(height: 8),
          Container(
            height: 5,
            width: double.infinity,
            decoration: BoxDecoration(
              color: p.innerFieldBackground,
              borderRadius: BorderRadius.circular(3),
            ),
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: barRatio!.clamp(0.0, 1.0).toDouble(),
              child: Container(
                decoration: BoxDecoration(
                  color: p.textPrimary,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 6),
        Text(
          sub,
          style: TextStyle(color: p.textMuted, fontSize: 12),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

/// 槽位账单卡的小页：小号大数字 + 说明行。
class _BillMiniPanel extends StatelessWidget {
  const _BillMiniPanel({
    required this.amount,
    required this.tag,
    required this.sub,
  });

  final num? amount;
  final String tag;
  final String sub;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: <Widget>[
            Text(
              amount == null ? "—" : "¥${MobileDynamicsPageState._fmtAmount(amount!)}",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 20,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.3,
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                tag,
                style: TextStyle(color: p.textSecondary, fontSize: 11),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          sub,
          style: TextStyle(color: p.textMuted, fontSize: 10),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

/// 邮件页：最新一封的标题 / 摘要 / 时间。
class _MailPanel extends StatelessWidget {
  const _MailPanel({required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final String title = item["title"]?.toString() ?? "邮件";
    final String text = item["text"]?.toString() ?? "";
    final num at = (item["at"] as num?) ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          title,
          style: TextStyle(
            color: p.textPrimary,
            fontSize: 14,
            fontWeight: FontWeight.w600,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        if (text.isNotEmpty) ...<Widget>[
          const SizedBox(height: 3),
          Text(
            text,
            style: TextStyle(color: p.textSecondary, fontSize: 12),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
        const SizedBox(height: 4),
        Text(
          MobileDynamicsPageState._fmtTime(at),
          style: TextStyle(color: p.textMuted, fontSize: 11),
        ),
      ],
    );
  }
}

// —— 数据模型 —— //

enum _DynamicsKind { parcel, bill, mail }

/// 一类一张聚合卡：id 即类名，items 为该类全部条目。
class _DynamicsCard {
  const _DynamicsCard({
    required this.id,
    required this.kind,
    required this.items,
    required this.timestamp,
    required this.priority,
  });

  final String id;
  final _DynamicsKind kind;
  final List<Map<String, dynamic>> items;
  final int timestamp;
  final int priority;
}

class _TopDragData {
  const _TopDragData(this.id, this.slot);

  /// slot = -1 表示卡片来自信息流。
  final String id;
  final int slot;
}

class _DynamicsLayout {
  const _DynamicsLayout({
    this.order = const <String>[],
    this.pins = const <String?>[null, null],
    this.excluded = const <String>[],
  });

  final List<String> order;
  final List<String?> pins;
  final List<String> excluded;
}

class _DynamicsLayoutStore {
  static const String _fileName = "mobile_dynamics_layout";

  static Future<_DynamicsLayout> load(String actorId) async {
    try {
      final File file =
          await _file(actorId).timeout(const Duration(seconds: 1));
      if (!await file.exists()) return const _DynamicsLayout();
      final Map<String, dynamic> json =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final List<dynamic> rawPins =
          json["pins"] as List<dynamic>? ?? const <dynamic>[];
      return _DynamicsLayout(
        order: (json["order"] as List<dynamic>? ?? const <dynamic>[])
            .whereType<String>()
            .toList(),
        pins: <String?>[
          for (int i = 0; i < 2; i++)
            i < rawPins.length && rawPins[i] is String
                ? rawPins[i] as String
                : null,
        ],
        excluded: (json["excluded"] as List<dynamic>? ?? const <dynamic>[])
            .whereType<String>()
            .toList(),
      );
    } catch (_) {
      return const _DynamicsLayout();
    }
  }

  static Future<void> save(String actorId, _DynamicsLayout layout) async {
    try {
      final File file =
          await _file(actorId).timeout(const Duration(seconds: 1));
      await file.parent.create(recursive: true);
      final File temp = File("${file.path}.tmp");
      await temp.writeAsString(
        const JsonEncoder.withIndent("  ").convert(<String, dynamic>{
          "order": layout.order,
          "pins": layout.pins,
          "excluded": layout.excluded,
          "updatedAt": DateTime.now().toIso8601String(),
        }),
        flush: true,
      );
      await temp.rename(file.path);
    } catch (_) {}
  }

  static Future<File> _file(String actorId) async {
    final Directory directory = await getApplicationSupportDirectory();
    final String safeActor = actorId.replaceAll(
      RegExp(r"[^A-Za-z0-9_.-]"),
      "_",
    );
    return File(
      "${directory.path}${Platform.pathSeparator}nextbot"
      "${Platform.pathSeparator}${_fileName}_$safeActor.json",
    );
  }
}

// —— 槽位卡 —— //

/// 顶部槽位卡：玻璃壳 + 类型头 + 按类定制的主体。
/// 快递 = 标题/来源 + 反白取件码；账单 = 合计/订阅小轮播；邮件 = 最新一封标题。
class _TopCard extends StatelessWidget {
  const _TopCard({
    required this.card,
    this.billPages,
    this.pause,
  });

  final _DynamicsCard card;
  final List<Widget>? billPages;
  final ValueListenable<bool>? pause;

  static const Map<_DynamicsKind, String> _labels = <_DynamicsKind, String>{
    _DynamicsKind.parcel: "快递",
    _DynamicsKind.bill: "账单",
    _DynamicsKind.mail: "邮件",
  };

  static const Map<_DynamicsKind, IconData> _icons = <_DynamicsKind, IconData>{
    _DynamicsKind.parcel: Icons.local_shipping_outlined,
    _DynamicsKind.bill: Icons.receipt_outlined,
    _DynamicsKind.mail: Icons.mail_outline,
  };

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final Widget head = Row(
      children: <Widget>[
        Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            color: p.innerFieldBackground,
            borderRadius: BorderRadius.circular(7),
          ),
          child: Icon(_icons[card.kind], size: 14, color: p.textPrimary),
        ),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            _labels[card.kind]!,
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.w500,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );

    Widget body;
    switch (card.kind) {
      case _DynamicsKind.parcel:
        final Map<String, dynamic> item = card.items.first;
        final String pickup = item["pickupCode"]?.toString() ?? "";
        final int awaiting = card.items
            .where((Map<String, dynamic> e) =>
                (e["pickupCode"]?.toString() ?? "").isNotEmpty)
            .length;
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              item["title"]?.toString() ?? "包裹动态",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const Spacer(),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Expanded(
                  child: Text(
                    <String>[
                      if ((item["carrier"]?.toString() ?? "").isNotEmpty)
                        item["carrier"].toString(),
                      MobileDynamicsPageState._fmtTime(
                        ((item["occurredAt"] as num?) ?? 0).toInt(),
                      ),
                      if (awaiting > 1) "待取 $awaiting 件",
                    ].where((String s) => s.isNotEmpty).join(" · "),
                    style: TextStyle(color: p.textMuted, fontSize: 11),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (pickup.isNotEmpty) ...<Widget>[
                  const SizedBox(width: 10),
                  _PickupBlock(code: pickup),
                ],
              ],
            ),
          ],
        );
        break;
      case _DynamicsKind.bill:
        final List<Widget>? pages = billPages;
        if (pages != null && pages.isNotEmpty) {
          body = _MiniCarousel(pages: pages, pause: pause);
          break;
        }
        final Map<String, dynamic> item = card.items.first;
        final num? amount = item["amount"] as num?;
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              amount != null
                  ? "¥${MobileDynamicsPageState._fmtAmount(amount)}"
                  : (item["title"]?.toString() ?? "账单"),
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 6),
            Text(
              <String>[
                item["title"]?.toString() ?? "",
                MobileDynamicsPageState._fmtTime(
                  ((item["occurredAt"] as num?) ?? 0).toInt(),
                ),
              ].where((String s) => s.isNotEmpty).join(" · "),
              style: TextStyle(color: p.textMuted, fontSize: 11),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        );
        break;
      case _DynamicsKind.mail:
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              card.items.first["title"]?.toString() ?? "邮件",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.2,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        );
        break;
    }

    return _GlassCard(
      radius: 14,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          head,
          const SizedBox(height: 8),
          Expanded(child: body),
        ],
      ),
    );
  }
}

// —— 邮件详情页 —— //

/// 邮件要事详情页：全屏列表展示全部高价值邮件（最新在前）。
/// 列表项复用 [_MailDetailRow]，数据由动态页带过来，不发第二次请求。
class MobileMailDetailPage extends StatelessWidget {
  const MobileMailDetailPage({super.key, required this.items});

  final List<Map<String, dynamic>> items;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: const _GlassAppBar(title: "邮件要事"),
      body: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        itemCount: items.length,
        itemBuilder: (BuildContext context, int index) =>
            _MailDetailRow(p: p, item: items[index]),
      ),
    );
  }
}

/// 详情页单封邮件：标题 + 摘要（完整展示，不截断）+ 时间。
class _MailDetailRow extends StatelessWidget {
  const _MailDetailRow({required this.p, required this.item});

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "邮件";
    final String text = item["text"]?.toString() ?? "";
    final num at = (item["at"] as num?) ?? 0;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (text.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              text,
              style:
                  TextStyle(color: p.textSecondary, fontSize: 13, height: 1.5),
            ),
          ],
          const SizedBox(height: 8),
          Text(
            MobileDynamicsPageState._fmtTime(at),
            style: TextStyle(color: p.textMuted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

// —— 月报 —— //

/// 卡片角标：区分「本月进行中」与「上月完整版」。
class _PhaseChip extends StatelessWidget {
  const _PhaseChip({required this.p, required this.label});

  final MobilePalette p;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: p.innerFieldBackground,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(color: p.textMuted, fontSize: 10),
      ),
    );
  }
}

/// `/api/dynamics` 的 `monthly` 字段的类型化读法。
///
/// 原始 Map 只在这里解析一次：卡面与明细页共用同一份口径，UI 里不到处 cast。
/// 缺字段一律按零值渲染——服务端每个区块都可选，客户端不能因为少一段就崩。
class _MonthlyView {
  _MonthlyView(this.raw);

  final Map<String, dynamic> raw;

  Map<String, dynamic> _sub(String key) {
    final Object? v = raw[key];
    return v is Map<String, dynamic> ? v : const <String, dynamic>{};
  }

  List<Map<String, dynamic>> _list(String key) {
    final List<dynamic>? v = raw[key] as List<dynamic>?;
    return v?.whereType<Map<String, dynamic>>().toList(growable: false) ??
        const <Map<String, dynamic>>[];
  }

  static num _n(Map<String, dynamic> m, String key) => (m[key] as num?) ?? 0;

  Map<String, dynamic> get totals => _sub("totals");
  Map<String, dynamic> get previous => _sub("previous");
  Map<String, dynamic> get mom => _sub("mom");
  Map<String, dynamic> get subscriptions => _sub("subscriptions");
  Map<String, dynamic>? get largest {
    final Map<String, dynamic> v = _sub("largest");
    return v.isEmpty ? null : v;
  }

  List<Map<String, dynamic>> get topCategories => _list("topCategories");

  /// 本月已扣 / 下月预计扣款（都在 subscriptions 段里）
  List<Map<String, dynamic>> get charged {
    final Object? v = subscriptions["charged"];
    return v is List<dynamic>
        ? v.whereType<Map<String, dynamic>>().toList(growable: false)
        : const <Map<String, dynamic>>[];
  }

  List<Map<String, dynamic>> get forecast {
    final Object? v = subscriptions["forecast"];
    return v is List<dynamic>
        ? v.whereType<Map<String, dynamic>>().toList(growable: false)
        : const <Map<String, dynamic>>[];
  }

  String get monthLabel => raw["monthLabel"]?.toString() ?? "本月";
  bool get complete => raw["complete"] == true;
  String get coverageHint => raw["coverageHint"]?.toString() ?? "";

  num get totalAmount => _n(totals, "totalAmount");
  num get count => _n(totals, "count");
  num get amountCount => _n(totals, "amountCount");
  num get missingAmount => _n(totals, "missingAmount");

  /// 标题：「11月小结」
  String get title => "$monthLabel小结";
  String get phaseLabel => complete ? "上月完整版" : "本月进行中";

  /// 环比一句话。上月为 0 时服务端不给 ratio，此时只说绝对差额。
  String get momLine {
    final String delta =
        "¥${MobileDynamicsPageState._fmtAmount(_n(mom, "deltaAmount"))}";
    switch (mom["direction"]?.toString()) {
      case "up":
        return "比${_shortMonth()}多花 $delta${_momPct()}";
      case "down":
        return "比${_shortMonth()}少花 $delta${_momPct()}";
      default:
        return "与${_shortMonth()}持平";
    }
  }

  String _shortMonth() {
    // previous.month = "2026-10" → "10月"
    final List<String> parts =
        previous["month"]?.toString().split("-") ?? const [];
    if (parts.length == 2) {
      final int? n = int.tryParse(parts[1]);
      if (n != null) return "$n月";
    }
    return "上月";
  }

  String _momPct() {
    final Object? r = mom["ratio"];
    if (r is! num) return "";
    final int pct = (r.abs() * 100).round();
    return "（$pct%）";
  }

  /// 订阅/续费一句话：本月已扣 + 下月预计扣款
  String get subscriptionLine {
    final num charged = _n(subscriptions, "chargedCount");
    final num forecast = _n(subscriptions, "forecastCount");
    if (charged == 0 && forecast == 0) return "";
    final String a = charged == 0
        ? "本月订阅未扣款"
        : "本月已扣 $charged 笔 ¥${MobileDynamicsPageState._fmtAmount(_n(subscriptions, "chargedAmount"))}";
    final String b = forecast == 0
        ? "下月无预计扣款"
        : "下月预计 $forecast 笔 ¥${MobileDynamicsPageState._fmtAmount(_n(subscriptions, "forecastAmount"))}";
    return "$a · $b";
  }
}

/// 月报明细页：小结块 + 类目筛选 + 全部明细，类目在这里改。
///
/// 改类目 → POST /api/dynamics/bills/category → 服务端回写台账并打纠正标记，
/// 下一次识别把这条当训练样本用（分类器反馈闭环）。改完只更新本地这一行，
/// 不回灌整页重拉：合计要变的是下一次打开动态页，用户当场看的是这条改对了。
class MobileMonthlyDetailPage extends StatefulWidget {
  const MobileMonthlyDetailPage({
    super.key,
    required this.monthly,
    required this.bills,
    required this.billTypes,
  });

  final Map<String, dynamic> monthly;
  final List<Map<String, dynamic>> bills;
  final List<String> billTypes;

  @override
  State<MobileMonthlyDetailPage> createState() =>
      _MobileMonthlyDetailPageState();
}

class _MobileMonthlyDetailPageState extends State<MobileMonthlyDetailPage> {
  late List<Map<String, dynamic>> _bills = List<Map<String, dynamic>>.of(
    widget.bills,
  );
  bool _saving = false;
  String _filter = "全部";

  Future<void> _correctCategory(
    Map<String, dynamic> item,
    String current,
  ) async {
    final String? id = item["id"]?.toString();
    if (id == null) return;
    final List<String> options = <String>[
      ...widget.billTypes.where((String t) => t != current),
      if (current.isNotEmpty) current,
    ];
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: MobileTheme.of(context).surface,
      builder: (BuildContext ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Text(
                "这条账单归到哪一类？",
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: MobileTheme.of(ctx).textPrimary,
                ),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final String t in options)
                    ListTile(
                      dense: true,
                      title: Text(t),
                      onTap: () => Navigator.of(ctx).pop(t),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (picked == null || picked == current) return;
    setState(() => _saving = true);
    String? err;
    try {
      final Uri uri = Uri.parse(
        "${ApiConfig.httpBase}/api/dynamics/bills/category",
      );
      final http.Response res = await NbHttp.post(
        uri,
        headers: const <String, String>{"Content-Type": "application/json"},
        body: jsonEncode(<String, dynamic>{
          "userId": ApiConfig.effectiveActorId,
          "id": id,
          "billType": picked,
        }),
      ).timeout(const Duration(seconds: 15));
      final Map<String, dynamic> body =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode != 200 || body["ok"] != true) {
        err = body["error"]?.toString() ?? "HTTP ${res.statusCode}";
      } else {
        _bills = _bills
            .map(
              (Map<String, dynamic> e) => e["id"]?.toString() == id
                  ? <String, dynamic>{...e, "billType": picked}
                  : e,
            )
            .toList(growable: false);
      }
    } catch (e) {
      err = "$e";
    }
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 2),
        content: Text(err == null ? "已改成「$picked」，我会记住这个分类" : "改类目失败：$err"),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final _MonthlyView m = _MonthlyView(widget.monthly);
    final List<String> options = <String>["全部"];
    for (final Map<String, dynamic> b in _bills) {
      final String t = b["billType"]?.toString() ?? "";
      if (t.isNotEmpty && !options.contains(t)) options.add(t);
    }
    final List<Map<String, dynamic>> filtered =
        (_filter == "全部" || !options.contains(_filter))
            ? _bills
            : _bills
                .where((Map<String, dynamic> b) =>
                    (b["billType"]?.toString() ?? "") == _filter)
                .toList(growable: false);
    return Scaffold(
      backgroundColor: p.background,
      appBar: const _GlassAppBar(title: "账单"),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: <Widget>[
          _MonthlySummaryBlock(m: m),
          if (options.length > 1) ...<Widget>[
            const SizedBox(height: 12),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: <Widget>[
                  for (final String t in options)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: GestureDetector(
                        onTap: () => setState(() => _filter = t),
                        child: _FilterChip(p: p, label: t, selected: _filter == t),
                      ),
                    ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          Text(
            "账单明细（点一条改类目）",
            style: TextStyle(
              color: p.textSecondary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          if (filtered.isEmpty)
            Text(
              "本月暂无明细",
              style: TextStyle(color: p.textMuted, fontSize: 13),
            )
          else
            for (final Map<String, dynamic> item in filtered)
              _MonthlyBillRow(
                p: p,
                item: item,
                busy: _saving,
                onCorrect: () => _correctCategory(
                  item,
                  item["billType"]?.toString() ?? "",
                ),
              ),
        ],
      ),
    );
  }
}

/// 月报小结块：合计 / 订阅 / 最大单笔 / Top3 类目，一眼看完这个月。
class _MonthlySummaryBlock extends StatelessWidget {
  const _MonthlySummaryBlock({required this.m});

  final _MonthlyView m;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final Map<String, dynamic>? largest = m.largest;
    final bool noData = m.count == 0;
    final num chargedCount = _MonthlyView._n(m.subscriptions, "chargedCount");
    final num forecastCount =
        _MonthlyView._n(m.subscriptions, "forecastCount");

    String subValue;
    String subHint;
    if (chargedCount > 0) {
      subValue =
          "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(m.subscriptions, "chargedAmount"))}";
      final String nextLine = m.forecast.isNotEmpty
          ? " · 下笔 ${m.forecast.first["merchant"]?.toString() ?? ""} ${MobileDynamicsPageState._fmtTime(_MonthlyView._n(m.forecast.first, "expectedAt").toInt())}"
          : "";
      subHint = "已扣 $chargedCount 笔$nextLine";
    } else if (forecastCount > 0) {
      subValue =
          "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(m.subscriptions, "forecastAmount"))}";
      subHint = "下月预计 $forecastCount 笔";
    } else {
      subValue = "—";
      subHint = "暂无订阅扣款";
    }
    final String largestValue = largest == null
        ? "—"
        : "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(largest, "amount"))}";
    final String largestHint = largest == null
        ? "暂无带金额账单"
        : "${largest["title"]?.toString() ?? ""} · ${MobileDynamicsPageState._fmtTime(_MonthlyView._n(largest, "occurredAt").toInt())}";

    return _GlassCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                m.title,
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 6),
              _PhaseChip(p: p, label: m.phaseLabel),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              Text(
                noData
                    ? "—"
                    : "¥${MobileDynamicsPageState._fmtAmount(m.totalAmount)}",
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  noData
                      ? "这个月还没有识别到账单"
                      : "${m.count} 笔 · ${m.momLine}",
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              Expanded(
                child: _MsItem(
                  p: p,
                  label: "订阅续费",
                  value: subValue,
                  hint: subHint,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _MsItem(
                  p: p,
                  label: "最大单笔",
                  value: largestValue,
                  hint: largestHint,
                ),
              ),
            ],
          ),
          if (m.topCategories.isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            for (final Map<String, dynamic> c
                in m.topCategories.take(3))
              _MsCatRow(c: c),
          ],
          if (m.missingAmount > 0 && m.coverageHint.isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              m.coverageHint,
              style: const TextStyle(color: Color(0xFFB45309), fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

/// 小结块里的两格指标（订阅续费 / 最大单笔）。
class _MsItem extends StatelessWidget {
  const _MsItem({
    required this.p,
    required this.label,
    required this.value,
    required this.hint,
  });

  final MobilePalette p;
  final String label;
  final String value;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: p.innerFieldBackground,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: TextStyle(color: p.textMuted, fontSize: 10)),
          const SizedBox(height: 4),
          Text(
            value,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Text(
            hint,
            style: TextStyle(color: p.textMuted, fontSize: 10),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

/// 小结块里的类目进度条一行。
class _MsCatRow extends StatelessWidget {
  const _MsCatRow({required this.c});

  final Map<String, dynamic> c;

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final double ratio = _MonthlyView._n(c, "ratio").toDouble().clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 64,
            child: Text(
              c["type"]?.toString() ?? "其他",
              style: TextStyle(color: p.textSecondary, fontSize: 12),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Container(
              height: 5,
              decoration: BoxDecoration(
                color: p.innerFieldBackground,
                borderRadius: BorderRadius.circular(3),
              ),
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: ratio,
                child: Container(
                  decoration: BoxDecoration(
                    color: p.textPrimary,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(c, "amount"))} · ${(_MonthlyView._n(c, "ratio") * 100).round()}%",
            style: TextStyle(color: p.textMuted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

/// 类目筛选 chip。
class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.p,
    required this.label,
    required this.selected,
  });

  final MobilePalette p;
  final String label;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: selected ? p.textPrimary : p.innerFieldBackground,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: selected ? p.onAccent : p.textSecondary,
          fontSize: 12,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
        ),
      ),
    );
  }
}

/// 明细页一条账单：摘要 + 金额 + 当前类目，点整行改类目。
class _MonthlyBillRow extends StatelessWidget {
  const _MonthlyBillRow({
    required this.p,
    required this.item,
    required this.busy,
    required this.onCorrect,
  });

  final MobilePalette p;
  final Map<String, dynamic> item;
  final bool busy;
  final VoidCallback onCorrect;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "账单";
    final String? billType = item["billType"]?.toString();
    final num? amount = item["amount"] as num?;
    final num at = (item["occurredAt"] as num?) ?? 0;
    return InkWell(
      onTap: busy ? null : onCorrect,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: p.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: p.divider.withValues(alpha: 0.6)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    <String>[
                      billType?.isNotEmpty == true ? "类目 $billType" : "未分类",
                      MobileDynamicsPageState._fmtTime(at),
                    ].join(" · "),
                    style: TextStyle(color: p.textMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
            if (amount != null)
              Text(
                "¥${MobileDynamicsPageState._fmtAmount(amount)}",
                style: TextStyle(
                  color: p.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            const SizedBox(width: 4),
            Icon(Icons.edit_outlined, size: 15, color: p.textMuted),
          ],
        ),
      ),
    );
  }
}
