import "dart:async";
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;
import "package:path_provider/path_provider.dart";

import "../core/config/api_config.dart";
import "mobile_page_cache.dart";
import "mobile_theme.dart";
import "../core/services/nb_http.dart";

/// 手机端「动态」页：账单、快递、邮件要事的统一入口。
///
/// 顶部两个固定槽位按当前待处理优先级动态填充，用户也可以拖拽任意卡片
/// 替换槽位内容；信息流顺序与置顶选择保存在本机。
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
  int? _hoverSlot;
  String? _hoverFeedId;
  final List<GlobalKey> _slotKeys = <GlobalKey>[GlobalKey(), GlobalKey()];
  String? _pointerCardId;
  String? _draggingFeedId;
  Offset? _pointerDown;
  bool _pointerMoved = false;

  @override
  void initState() {
    super.initState();
    unawaited(_loadLayout());
    unawaited(_load());
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

  /// 顶部汇总卡里的月结数据（服务端 monthly 字段，自然月口径）。
  /// null = 台账未启用：汇总卡退回 30 天窗口合计，月报明细不可进。
  Map<String, dynamic>? get _monthly {
    final Object? raw = _data["monthly"];
    return raw is Map<String, dynamic> && raw.isNotEmpty ? raw : null;
  }

  /// 月报卡明细页要用的账单条目（与下方账单区块同一份，不再发第二次请求）
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

  List<_DynamicsCard> get _cards {
    final int now = DateTime.now().millisecondsSinceEpoch;
    final List<_DynamicsCard> cards = <_DynamicsCard>[];

    final List<Map<String, dynamic>> parcels = _listOf("parcels", "recent");
    for (int i = 0; i < parcels.length; i++) {
      final Map<String, dynamic> item = parcels[i];
      final int at = ((item["occurredAt"] as num?) ?? 0).toInt();
      cards.add(_DynamicsCard(
        id: _stableItemId("parcel", item, i),
        kind: _DynamicsKind.parcel,
        items: <Map<String, dynamic>>[item],
        timestamp: at,
        priority: _cardPriority(_DynamicsKind.parcel, item, now),
      ));
    }

    final List<Map<String, dynamic>> bills = _listOf("bills", "recent");
    for (int i = 0; i < bills.length; i++) {
      final Map<String, dynamic> item = bills[i];
      final int at = ((item["occurredAt"] as num?) ?? 0).toInt();
      cards.add(_DynamicsCard(
        id: _stableItemId("bill", item, i),
        kind: _DynamicsKind.bill,
        items: <Map<String, dynamic>>[item],
        timestamp: at,
        priority: _cardPriority(_DynamicsKind.bill, item, now),
      ));
    }

    final List<Map<String, dynamic>> mail = sortMailByNewest(
      _listOf("mail", "recent"),
    );
    if (mail.isNotEmpty) {
      cards.add(_DynamicsCard(
        id: "mail",
        kind: _DynamicsKind.mail,
        items: mail,
        timestamp: ((mail.first["at"] as num?) ?? 0).toInt(),
        priority: _cardPriority(_DynamicsKind.mail, mail.first, now),
      ));
    }
    return cards;
  }

  static String _stableItemId(
    String kind,
    Map<String, dynamic> item,
    int index,
  ) {
    final String rawId = item["id"]?.toString() ?? "";
    if (rawId.isNotEmpty) return "$kind:$rawId";
    final num at = (item["occurredAt"] as num?) ?? 0;
    final String identity = <String>[
      item["title"]?.toString() ?? "",
      item["trackingNo"]?.toString() ?? "",
      item["pickupCode"]?.toString() ?? "",
      item["amount"]?.toString() ?? "",
    ].join("|");
    return "$kind:$at:$identity:$index";
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

  List<_DynamicsCard> get _orderedCards {
    final Map<String, _DynamicsCard> byId = <String, _DynamicsCard>{
      for (final _DynamicsCard card in _cards) card.id: card,
    };
    return <_DynamicsCard>[
      for (final String id in _order)
        if (byId[id] case final _DynamicsCard card) card,
    ];
  }

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

  List<_DynamicsCard> get _feedCards => _orderedCards;

  List<_FeedEntry> get _feedEntries {
    final List<_DynamicsCard> feed = _feedCards;
    final List<_FeedEntry> entries = <_FeedEntry>[];
    for (final _DynamicsSection section in _DynamicsSection.values) {
      final List<_DynamicsCard> group = feed
          .where((_DynamicsCard card) => card.section == section)
          .toList(growable: false);
      final bool showMonthly =
          section == _DynamicsSection.bills && _monthly != null;
      if (group.isEmpty && !showMonthly) continue;
      entries.add(_FeedHeaderEntry(section.label));
      if (showMonthly) entries.add(const _FeedMonthlyEntry());
      entries.addAll(group);
    }
    return entries;
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

  int? _slotAt(Offset globalPosition) {
    for (int i = 0; i < _slotKeys.length; i++) {
      final BuildContext? context = _slotKeys[i].currentContext;
      if (context == null) continue;
      final RenderBox? box = context.findRenderObject() as RenderBox?;
      if (box == null || !box.hasSize) continue;
      final Rect rect = box.localToGlobal(Offset.zero) & box.size;
      if (rect.contains(globalPosition)) return i;
    }
    return null;
  }

  void _onFeedPointerDown(PointerDownEvent event, String id) {
    _pointerCardId = id;
    _pointerDown = event.position;
    _pointerMoved = false;
  }

  void _onFeedPointerMove(PointerMoveEvent event) {
    final Offset? down = _pointerDown;
    if (down != null && (event.position - down).distance > 18) {
      _pointerMoved = true;
    }
    final int? slot = _slotAt(event.position);
    if (slot != _hoverSlot) setState(() => _hoverSlot = slot);
  }

  void _onFeedPointerUp(PointerUpEvent event) {
    final String? id = _pointerCardId;
    final int? slot = _slotAt(event.position);
    if (id != null && slot != null && _pointerMoved && _draggingFeedId == id) {
      final int targetSlot = slot;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _pinCard(id, targetSlot);
      });
    }
    _clearPointer();
  }

  void _onFeedPointerCancel(PointerCancelEvent event) => _clearPointer();

  void _clearPointer() {
    _pointerCardId = null;
    _draggingFeedId = null;
    _pointerDown = null;
    _pointerMoved = false;
    if (_hoverSlot != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _hoverSlot = null);
      });
    }
  }

  void _moveOrderBefore(String id, String targetId) {
    if (id == targetId) return;
    final List<String> next = List<String>.of(_order)..remove(id);
    final int target = next.indexOf(targetId);
    next.insert(target < 0 ? next.length : target, id);
    _order = next;
  }

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
      _hoverSlot = null;
    });
    _saveLayout();
  }

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
      _hoverSlot = null;
    });
    _saveLayout();
  }

  void _moveTopCardToFeed(String id, String targetId) {
    setState(() {
      _pins = <String?>[
        for (final String? pin in _pins) pin == id ? null : pin,
      ];
      _autoExcluded.add(id);
      _moveOrderBefore(id, targetId);
      _hoverFeedId = null;
    });
    _saveLayout();
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("动态")),
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
    final List<_FeedEntry> entries = _feedEntries;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double feedWidth = constraints.maxWidth - 32;
        final double slotWidth = (feedWidth - 10) / 2;
        return Listener(
          behavior: HitTestBehavior.opaque,
          onPointerMove: _onFeedPointerMove,
          onPointerUp: _onFeedPointerUp,
          onPointerCancel: _onFeedPointerCancel,
          child: ReorderableListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            physics: const AlwaysScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            itemCount: entries.length + 1,
            onReorderStart: (int index) {
              if (index <= 0 || index > entries.length) return;
              final _FeedEntry entry = entries[index - 1];
              if (entry is _DynamicsCard) _draggingFeedId = entry.id;
            },
            onReorderItem: _onReorder,
            proxyDecorator:
                (Widget child, int index, Animation<double> animation) {
              return AnimatedBuilder(
                animation: animation,
                builder: (BuildContext context, Widget? proxy) => Material(
                  type: MaterialType.transparency,
                  child: Transform.scale(
                    scale: 1 + 0.025 * animation.value,
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(14),
                        boxShadow: <BoxShadow>[
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.2),
                            blurRadius: 28,
                            offset: const Offset(0, 16),
                          ),
                        ],
                      ),
                      child: proxy,
                    ),
                  ),
                ),
                child: child,
              );
            },
            itemBuilder: (BuildContext context, int index) {
              if (index == 0) {
                return Container(
                  key: const ValueKey<String>("__dynamics_header__"),
                  child: _buildTopArea(p, slotWidth),
                );
              }
              final _FeedEntry entry = entries[index - 1];
              if (entry is _FeedHeaderEntry) {
                return _FeedHeader(
                  key: ValueKey<String>("__section_${entry.title}"),
                  p: p,
                  title: entry.title,
                );
              }
              if (entry is _FeedMonthlyEntry) {
                return _MonthlySummaryCard(
                  key: const ValueKey<String>("__dynamics_monthly__"),
                  p: p,
                  monthly: _monthly!,
                  onTap: () => _openMonthlyDetail(
                    context,
                    _monthly!,
                    _listOf("bills", "recent"),
                  ),
                );
              }
              final _DynamicsCard card = entry as _DynamicsCard;
              return _buildFeedCard(p, card, index, feedWidth);
            },
          ),
        );
      },
    );
  }

  Widget _buildTopArea(MobilePalette p, double slotWidth) {
    final List<_DynamicsCard> cards = _cards;
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
        if (cards.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 54, 20, 24),
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
          ),
      ],
    );
  }

  Widget _buildTopSlot(MobilePalette p, int slot, double width) {
    final String? id = _slotIds[slot];
    final _DynamicsCard? card = id == null
        ? null
        : _cards.firstWhere((_DynamicsCard card) => card.id == id);
    return DragTarget<_TopDragData>(
      key: ValueKey<String>("dynamics-slot-$slot"),
      onWillAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
          details.data.id != id,
      onAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
          _moveTopCardToSlot(details.data.id, slot),
      builder: (BuildContext context, List<_TopDragData?> candidateData,
          List<dynamic> rejectedData) {
        final bool highlighted = _hoverSlot == slot || candidateData.isNotEmpty;
        return AnimatedContainer(
          key: _slotKeys[slot],
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
              ? Container(
                  decoration: BoxDecoration(
                    color: p.surface,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: p.divider),
                  ),
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
                )
              : _buildTopDraggable(p, card, slot, width - 6),
        );
      },
    );
  }

  Widget _buildTopDraggable(
    MobilePalette p,
    _DynamicsCard card,
    int slot,
    double width,
  ) {
    final Widget child = _TopCard(
      p: p,
      card: card,
      onTap: card.kind == _DynamicsKind.mail
          ? () => _openMailDetail(context, card.items)
          : null,
    );
    final Widget feedback = Material(
      type: MaterialType.transparency,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.2),
              blurRadius: 30,
              offset: const Offset(0, 18),
            ),
          ],
        ),
        child: SizedBox(
          width: width,
          height: 126,
          child: _TopCard(p: p, card: card),
        ),
      ),
    );
    final Widget placeholder = Opacity(opacity: 0.2, child: child);
    return LongPressDraggable<_TopDragData>(
      data: _TopDragData(card.id, slot),
      feedback: feedback,
      childWhenDragging: placeholder,
      delay: const Duration(milliseconds: 220),
      onDragStarted: () => setState(() => _hoverSlot = slot),
      onDragEnd: (_) {
        if (mounted && _hoverSlot != null) {
          setState(() => _hoverSlot = null);
        }
      },
      child: child,
    );
  }

  Widget _buildFeedCard(
    MobilePalette p,
    _DynamicsCard card,
    int listIndex,
    double width,
  ) {
    final Widget content = switch (card.kind) {
      _DynamicsKind.parcel => _ParcelCard(
          p: p,
          item: card.items.first,
        ),
      _DynamicsKind.bill => _BillCard(
          p: p,
          item: card.items.first,
        ),
      _DynamicsKind.mail => _MailDigestCard(
          p: p,
          items: card.items,
          onTap: () => _openMailDetail(context, card.items),
        ),
    };
    final Widget target = DragTarget<_TopDragData>(
      onWillAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
          details.data.id != card.id,
      onMove: (_) {
        if (_hoverFeedId != card.id) setState(() => _hoverFeedId = card.id);
      },
      onLeave: (_) {
        if (_hoverFeedId == card.id) setState(() => _hoverFeedId = null);
      },
      onAcceptWithDetails: (DragTargetDetails<_TopDragData> details) =>
          _moveTopCardToFeed(details.data.id, card.id),
      builder: (BuildContext context, List<_TopDragData?> candidateData,
          List<dynamic> rejectedData) {
        final bool highlighted =
            _hoverFeedId == card.id || candidateData.isNotEmpty;
        return AnimatedScale(
          duration: const Duration(milliseconds: 160),
          scale: highlighted ? 1.015 : 1,
          child: SizedBox(width: width, child: content),
        );
      },
    );
    final Widget draggable =
        ReorderableDelayedDragStartListener(index: listIndex, child: target);
    return Listener(
      key: ValueKey<String>(card.id),
      behavior: HitTestBehavior.opaque,
      onPointerDown: (PointerDownEvent event) =>
          _onFeedPointerDown(event, card.id),
      child: draggable,
    );
  }

  void _onReorder(int oldIndex, int newIndex) {
    if (oldIndex <= 0 || newIndex < 0) return;
    final List<_FeedEntry> entries = _feedEntries;
    final int oldEntryIndex = oldIndex - 1;
    if (oldEntryIndex >= entries.length) return;
    final _FeedEntry moved = entries[oldEntryIndex];
    if (moved is! _DynamicsCard) return;
    setState(() {
      final List<_FeedEntry> nextEntries = List<_FeedEntry>.from(entries)
        ..removeAt(oldEntryIndex);
      final int insertAt =
          newIndex <= 0 ? 0 : (newIndex - 1).clamp(0, nextEntries.length);
      nextEntries.insert(insertAt, moved);
      final List<String> visible = <String>[
        for (final _FeedEntry entry in nextEntries)
          if (entry is _DynamicsCard) entry.id,
      ];
      final Set<String> visibleIds = visible.toSet();
      int cursor = 0;
      _order = <String>[
        for (final String id in _order)
          if (visibleIds.contains(id)) visible[cursor++] else id,
      ];
    });
    _saveLayout();
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

  static String _fmtAmount(num v) {
    final double d = v.toDouble();
    if (d == d.roundToDouble()) return d.toStringAsFixed(0);
    return d.toStringAsFixed(2);
  }

  /// 相对时间：今天 → "HH:mm"；昨天 → "昨天 HH:mm"；更早 → "M月d日"。
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

  /// 点邮件收束卡 → 全屏详情页看全部。
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

  /// 点顶部「账单月结」卡 → 月报明细页（§9 交互：点开看明细，类目可改）。
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

// —— 通用小组件 ——

class _FeedHeader extends StatelessWidget {
  const _FeedHeader({super.key, required this.p, required this.title});

  final MobilePalette p;
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          color: p.textSecondary,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
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
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: p.textSecondary, fontSize: 12)),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: 24,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 2),
          Text(hint,
              style: TextStyle(color: p.textMuted, fontSize: 11),
              maxLines: 2,
              overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }
}

enum _DynamicsKind { parcel, bill, mail }

enum _DynamicsSection {
  parcels("快递"),
  bills("账单"),
  mail("邮件要事");

  const _DynamicsSection(this.label);
  final String label;
}

class _DynamicsCard extends _FeedEntry {
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

  _DynamicsSection get section => switch (kind) {
        _DynamicsKind.parcel => _DynamicsSection.parcels,
        _DynamicsKind.bill => _DynamicsSection.bills,
        _DynamicsKind.mail => _DynamicsSection.mail,
      };
}

abstract class _FeedEntry {
  const _FeedEntry();
}

class _FeedHeaderEntry extends _FeedEntry {
  const _FeedHeaderEntry(this.title);
  final String title;
}

class _FeedMonthlyEntry extends _FeedEntry {
  const _FeedMonthlyEntry();
}

class _TopDragData {
  const _TopDragData(this.id, this.slot);
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

class _TopCard extends StatelessWidget {
  const _TopCard({
    required this.p,
    required this.card,
    this.onTap,
  });

  final MobilePalette p;
  final _DynamicsCard card;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> item = card.items.first;
    final String label = card.section.label;
    final String value = switch (card.kind) {
      _DynamicsKind.parcel =>
        (item["pickupCode"]?.toString().isNotEmpty ?? false)
            ? item["pickupCode"].toString()
            : item["title"]?.toString() ?? "包裹动态",
      _DynamicsKind.bill => item["amount"] is num
          ? "¥${MobileDynamicsPageState._fmtAmount(item["amount"] as num)}"
          : item["title"]?.toString() ?? "账单",
      _DynamicsKind.mail => item["title"]?.toString() ?? "邮件",
    };
    final String hint = switch (card.kind) {
      _DynamicsKind.parcel => <String>[
          if ((item["carrier"]?.toString() ?? "").isNotEmpty)
            item["carrier"].toString(),
          MobileDynamicsPageState._fmtTime(
            (item["occurredAt"] as num?) ?? 0,
          ),
        ].where((String part) => part.isNotEmpty).join(" · "),
      _DynamicsKind.bill => <String>[
          if ((item["billType"]?.toString() ?? "").isNotEmpty)
            item["billType"].toString(),
          switch (item["source"]?.toString()) {
            "email" => "邮件识别",
            "sms" => "短信识别",
            _ => "通知识别",
          },
          MobileDynamicsPageState._fmtTime(
            (item["occurredAt"] as num?) ?? 0,
          ),
        ].where((String part) => part.isNotEmpty).join(" · "),
      _DynamicsKind.mail => "共 ${card.items.length} 封",
    };
    final IconData icon = switch (card.kind) {
      _DynamicsKind.parcel => Icons.local_shipping_outlined,
      _DynamicsKind.bill => Icons.receipt_outlined,
      _DynamicsKind.mail => Icons.mail_outline,
    };

    final Widget content = Container(
      width: double.infinity,
      height: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
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
                  label,
                  style: TextStyle(color: p.textSecondary, fontSize: 11),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              color: p.textPrimary,
              fontSize: value.length > 9 ? 15 : 21,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.3,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          Text(
            hint,
            style: TextStyle(color: p.textMuted, fontSize: 10, height: 1.35),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: content,
      ),
    );
  }
}

/// 快递卡：待取件取件码大字；其余显示运单号/承运商
class _ParcelCard extends StatelessWidget {
  const _ParcelCard({
    required this.p,
    required this.item,
  });

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "包裹动态";
    final String? pickupCode = item["pickupCode"]?.toString();
    final String? trackingNo = item["trackingNo"]?.toString();
    final String? carrier = item["carrier"]?.toString();
    final num occurredAt = (item["occurredAt"] as num?) ?? 0;
    final bool awaiting = (pickupCode ?? "").isNotEmpty;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: awaiting
              ? p.textPrimary.withValues(alpha: 0.55)
              : p.divider.withValues(alpha: 0.6),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
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
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  <String>[
                    if (carrier != null && carrier.isNotEmpty) carrier,
                    if (trackingNo != null && trackingNo.isNotEmpty)
                      "单号 $trackingNo",
                    MobileDynamicsPageState._fmtTime(occurredAt),
                  ].join(" · "),
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (awaiting)
            Container(
              margin: const EdgeInsets.only(left: 10),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: p.textPrimary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  Text("取件码",
                      style: TextStyle(
                          color: p.surface, fontSize: 9, letterSpacing: 1)),
                  Text(
                    pickupCode!,
                    style: TextStyle(
                      color: p.surface,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 账单卡：类型/金额/来源/时间
class _BillCard extends StatelessWidget {
  const _BillCard({
    required this.p,
    required this.item,
  });

  final MobilePalette p;
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final String title = item["title"]?.toString() ?? "账单";
    final String? billType = item["billType"]?.toString();
    final num? amount = item["amount"] as num?;
    final String source = item["source"]?.toString() ?? "";
    final num occurredAt = (item["occurredAt"] as num?) ?? 0;
    final String sourceLabel = switch (source) {
      "email" => "邮件",
      "sms" => "短信",
      _ => "手机通知",
    };
    return Container(
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
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(
                  <String>[
                    if (billType != null && billType.isNotEmpty) billType,
                    sourceLabel,
                    MobileDynamicsPageState._fmtTime(occurredAt),
                  ].join(" · "),
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (amount != null)
            Text(
              "¥${MobileDynamicsPageState._fmtAmount(amount)}",
              style: TextStyle(
                color: p.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
        ],
      ),
    );
  }
}

/// 邮件要事收束卡（卡面展示最新一封；多封叠成一张薄卡，点进去看全部）。
///
/// 表面三要素：图标 + 最新一封标题/摘要 + 「N 封 · 查看全部」提示；
/// 数据来自 /api/dynamics 的 mail.recent（title/text/at），验证码已被服务端拦下。
class _MailDigestCard extends StatelessWidget {
  const _MailDigestCard({
    required this.p,
    required this.items,
    required this.onTap,
  });

  final MobilePalette p;
  final List<Map<String, dynamic>> items;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // 自行按 at 取最新，不依赖上游顺序（缓存/规则调整都不影响「卡面=最新一封」）。
    final Map<String, dynamic> item =
        MobileDynamicsPageState.sortMailByNewest(items).first;
    final String title = item["title"]?.toString() ?? "邮件";
    final String text = item["text"]?.toString() ?? "";
    final num at = (item["at"] as num?) ?? 0;
    final int count = items.length;

    return Semantics(
      button: true,
      label: "邮件要事，共 $count 封，最新一封：$title，点击查看全部",
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: p.divider.withValues(alpha: 0.6)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: p.textPrimary.withValues(alpha: 0.06),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child:
                      Icon(Icons.mail_outline, size: 19, color: p.textPrimary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              title,
                              style: TextStyle(
                                color: p.textPrimary,
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            MobileDynamicsPageState._fmtTime(at),
                            style: TextStyle(color: p.textMuted, fontSize: 11),
                          ),
                        ],
                      ),
                      if (text.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          text,
                          style:
                              TextStyle(color: p.textSecondary, fontSize: 12),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      const SizedBox(height: 4),
                      Text(
                        "共 $count 封 · 查看全部",
                        style: TextStyle(
                          color: p.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Icon(Icons.chevron_right, size: 18, color: p.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

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
      appBar: AppBar(title: const Text("邮件要事")),
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

// ---------------------------------------------------------------------- //
// §9 钱的月报（PRD 需求七）：「{月份}小结」卡 + 明细页
// ---------------------------------------------------------------------- //

/// 账单区块顶部的「{月份}小结」卡：合计 + 环比 + Top3 类目 + 最大单笔。
/// 整卡可点，点开进明细页（类目在那里改）。
class _MonthlySummaryCard extends StatelessWidget {
  const _MonthlySummaryCard({
    super.key,
    required this.p,
    required this.monthly,
    required this.onTap,
  });

  final MobilePalette p;
  final Map<String, dynamic> monthly;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final _MonthlyView m = _MonthlyView(monthly);
    final Map<String, dynamic>? largest = m.largest;
    final String subLine = m.subscriptionLine;
    final bool noData = m.count == 0;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
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
              Row(
                children: [
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
                  const Spacer(),
                  Icon(Icons.chevron_right, size: 18, color: p.textMuted),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
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
                      noData ? "这个月还没有识别到账单" : "${m.count} 笔 · ${m.momLine}",
                      style: TextStyle(color: p.textSecondary, fontSize: 12),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              if (m.topCategories.isNotEmpty) ...[
                const SizedBox(height: 10),
                for (final Map<String, dynamic> c in m.topCategories)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 96,
                          child: Text(
                            c["type"]?.toString() ?? "其他",
                            style:
                                TextStyle(color: p.textSecondary, fontSize: 13),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text(
                          "¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(c, "amount"))}",
                          style: TextStyle(
                            color: p.textPrimary,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          "${(_MonthlyView._n(c, "ratio") * 100).round()}%",
                          style: TextStyle(color: p.textMuted, fontSize: 11),
                        ),
                      ],
                    ),
                  ),
              ],
              if (largest != null) ...[
                const SizedBox(height: 2),
                Text(
                  "最大单笔：${largest["title"]?.toString() ?? ""} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(largest, "amount"))}",
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              if (subLine.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  subLine,
                  style: TextStyle(color: p.textSecondary, fontSize: 12),
                ),
              ],
              if (m.missingAmount > 0) ...[
                const SizedBox(height: 6),
                Text(
                  m.coverageHint,
                  style:
                      const TextStyle(color: Color(0xFFB45309), fontSize: 12),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

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
/// 原始 Map 只在这里解析一次：卡片与明细页共用同一份口径，UI 里不到处 cast。
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

  /// 标题：「11月小结」，明细页 AppBar 用
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

/// 月报明细页：小结全量数字 + 本月账单明细，类目在这里改。
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
    final Map<String, dynamic>? largest = m.largest;
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: Text(m.title)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          _SummaryCard(
            p: p,
            label: "${m.monthLabel}合计",
            value: m.count == 0
                ? "—"
                : "¥${MobileDynamicsPageState._fmtAmount(m.totalAmount)}",
            hint: m.count == 0 ? "暂无识别到的账单" : "${m.count} 笔 · ${m.momLine}",
          ),
          const SizedBox(height: 10),
          _DetailBlock(
            p: p,
            title: "分类",
            lines: m.topCategories
                .map(
                  (Map<String, dynamic> c) =>
                      "${c["type"] ?? "其他"} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(c, "amount"))}（${c["count"] ?? 0} 笔 · ${(_MonthlyView._n(c, "ratio") * 100).round()}%）",
                )
                .toList(growable: false),
            empty: "还没有带金额的账单",
          ),
          _DetailBlock(
            p: p,
            title: "最大单笔",
            lines: largest == null
                ? const <String>[]
                : <String>[
                    "${largest["title"] ?? ""} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(largest, "amount"))}",
                    MobileDynamicsPageState._fmtTime(
                      _MonthlyView._n(largest, "occurredAt"),
                    ),
                  ],
            empty: "暂无带金额的账单",
          ),
          _DetailBlock(
            p: p,
            title: "订阅 / 自动续费",
            lines: <String>[
              if (m.subscriptionLine.isNotEmpty) m.subscriptionLine,
              for (final Map<String, dynamic> s in m.charged)
                "已扣：${s["merchant"]} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(s, "amount"))}（${MobileDynamicsPageState._fmtTime(_MonthlyView._n(s, "chargedAt"))}）",
              for (final Map<String, dynamic> f in m.forecast)
                "预计：${f["merchant"]} ¥${MobileDynamicsPageState._fmtAmount(_MonthlyView._n(f, "amount"))}（${MobileDynamicsPageState._fmtTime(_MonthlyView._n(f, "expectedAt"))}）",
            ],
            empty: "没有识别到订阅或自动续费",
          ),
          _DetailBlock(
            p: p,
            title: "识别覆盖率",
            lines: <String>[
              "${m.amountCount}/${m.count} 笔带金额",
              if (m.coverageHint.isNotEmpty) m.coverageHint,
            ],
            empty: "",
          ),
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
          if (_bills.isEmpty)
            Text("本月暂无明细", style: TextStyle(color: p.textMuted, fontSize: 13))
          else
            for (final Map<String, dynamic> item in _bills)
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

/// 明细页的一组说明（标题 + 若干行；空则不渲染整块）
class _DetailBlock extends StatelessWidget {
  const _DetailBlock({
    required this.p,
    required this.title,
    required this.lines,
    required this.empty,
  });

  final MobilePalette p;
  final String title;
  final List<String> lines;
  final String empty;

  @override
  Widget build(BuildContext context) {
    final List<String> content =
        lines.where((String l) => l.isNotEmpty).toList(growable: false);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
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
                color: p.textSecondary,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            if (content.isEmpty)
              Text(empty, style: TextStyle(color: p.textMuted, fontSize: 12))
            else
              for (final String line in content)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Text(
                    line,
                    style: TextStyle(
                      color: p.textPrimary,
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ),
          ],
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
