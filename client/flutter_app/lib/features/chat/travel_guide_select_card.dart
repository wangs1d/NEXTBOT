import 'package:flutter/material.dart';

import '../../core/utils/agent_result_parser.dart';
import '../../core/utils/link_utils.dart';
import 'media_disk_cache.dart';

/// 规划前「种草选择卡」（travel.destination-guide 工具结果 →
/// travel_guide_select 卡）：三分类候选（必玩/住宿/美食）图文列表，
/// 每条带文字介绍 + 实拍图 + 服务端算好的真数指标（评分/本店报价/
/// 距离/热度，没取到的就不出这条），勾选全部交给用户（服务端不预选），
/// 「确认选择」把分组结果作为用户消息回传（服务端把 chat.user_action
/// 转写为 user_message，LLM 按语义把选中项填 wishlist / foodWishlist /
/// stayWishlist 再生成行程）。
///
/// 数据在 [AgentResultData.extra]['guide']：
/// {destination, cats: [{key: view|stay|food, label, sortNote, anchor?,
///  items: [{name, intro, photos[], metrics: [{kind, label, source}], address, picked}]}]}。
/// 旧载荷缺 extra 时回退 items 文字清单（通用卡渲染），本组件不会被构建。
class TravelGuideSelectCard extends StatefulWidget {
  const TravelGuideSelectCard({
    super.key,
    required this.data,
    required this.cs,
    this.onUserAction,
  });

  final AgentResultData data;
  final ColorScheme cs;

  /// 与 AgentActionChoiceCard 同一回传链：确认/委托按钮由此发出。
  final void Function(AgentResultAction action, {required AgentResultData cardData})?
      onUserAction;

  @override
  State<TravelGuideSelectCard> createState() => _TravelGuideSelectCardState();
}

class _TravelGuideSelectCardState extends State<TravelGuideSelectCard> {
  static const Color _amber = Color(0xFFF5A552);
  static const Color _jade = Color(0xFF6FC3B8);
  static const Color _tileFallback = Color(0xFF14323C);

  late final Map<String, List<_GuideEntry>> _cats;
  late final Map<String, bool> _picked;
  String _filter = 'view';
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _cats = <String, List<_GuideEntry>>{};
    final Map<String, dynamic>? guide =
        widget.data.extra?['guide'] as Map<String, dynamic>?;
    final List<dynamic>? cats = guide?['cats'] as List<dynamic>?;
    if (cats != null) {
      for (final dynamic c in cats) {
        if (c is! Map<String, dynamic>) continue;
        final String key = c['key']?.toString() ?? '';
        final List<_GuideEntry> entries = <_GuideEntry>[];
        final List<dynamic>? items = c['items'] as List<dynamic>?;
        if (items != null) {
          for (final dynamic it in items) {
            if (it is! Map<String, dynamic>) continue;
            final _GuideEntry e = _GuideEntry(
              name: it['name']?.toString() ?? '',
              intro: it['intro']?.toString() ?? '',
              metrics: <_GuideMetricEntry>[
                for (final dynamic m in (it['metrics'] as List<dynamic>? ??
                    const <dynamic>[]))
                  if (m is Map<String, dynamic> &&
                      (m['label']?.toString() ?? '').isNotEmpty)
                    _GuideMetricEntry(
                      kind: m['kind']?.toString() ?? '',
                      label: m['label'].toString(),
                      source: m['source']?.toString() ?? '',
                    ),
              ],
              photos: ((it['photos'] as List<dynamic>?)
                          ?.map((dynamic u) => u.toString())
                          .where((String u) => u.isNotEmpty)
                          .toList() ??
                      const <String>[])
                  .take(3)
                  .toList(),
            );
            if (e.name.isNotEmpty) entries.add(e);
          }
        }
        if (entries.isNotEmpty) _cats[key] = entries;
      }
    }
    // 默认落在有内容的第一个分类（必玩 → 住宿 → 美食）
    _filter = _cats.containsKey('view')
        ? 'view'
        : (_cats.keys.isNotEmpty ? _cats.keys.first : 'all');
    _picked = <String, bool>{};
    _cats.forEach((String _, List<_GuideEntry> list) {
      for (final _GuideEntry e in list) {
        // 零预选：一条都不替用户勾。
        _picked[e.key] = false;
      }
    });
  }

  int get _pickedCount =>
      _picked.values.where((bool v) => v).length;

  List<_GuideEntry> get _visible {
    if (_filter == 'all') {
      final List<_GuideEntry> all = <_GuideEntry>[];
      for (final List<_GuideEntry> list in _cats.values) {
        all.addAll(list);
      }
      return all;
    }
    return _cats[_filter] ?? const <_GuideEntry>[];
  }

  void _submit() {
    if (_done || _pickedCount == 0 || widget.onUserAction == null) return;
    final Map<String, List<String>> byCat = <String, List<String>>{
      'view': <String>[],
      'stay': <String>[],
      'food': <String>[],
    };
    _cats.forEach((String cat, List<_GuideEntry> list) {
      for (final _GuideEntry e in list) {
        if (_picked[e.key] == true) byCat[cat]?.add(e.name);
      }
    });
    const Map<String, String> catLabel = <String, String>{
      'view': '必玩',
      'stay': '住宿',
      'food': '美食',
    };
    final String joined = byCat.entries
        .where((MapEntry<String, List<String>> e) => e.value.isNotEmpty)
        .map((MapEntry<String, List<String>> e) =>
            '${catLabel[e.key]} ${e.value.join('、')}')
        .join('；');
    setState(() => _done = true);
    widget.onUserAction!(
      AgentResultAction(
        id: 'select_confirm',
        label: '就按这些去规划：$joined。天数日期按之前说的来',
        payload: <String, dynamic>{
          'selected': byCat.values.expand((List<String> l) => l).toList(),
          'selectedView': byCat['view'],
          'selectedStay': byCat['stay'],
          'selectedFood': byCat['food'],
        },
      ),
      cardData: widget.data,
    );
  }

  void _delegate() {
    if (_done || widget.onUserAction == null) return;
    final String dest = (widget.data.extra?['guide']
            as Map<String, dynamic>?)?['destination']?.toString() ??
        '';
    setState(() => _done = true);
    widget.onUserAction!(
      AgentResultAction(
        id: 'select_delegate',
        label: '不想挑了，你按推荐直接帮我规划${dest.isEmpty ? '' : dest}行程',
      ),
      cardData: widget.data,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cats.isEmpty) return const SizedBox.shrink();
    final ColorScheme cs = widget.cs;
    return Opacity(
      opacity: _done ? 0.66 : 1,
      child: IgnorePointer(
        ignoring: _done,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: cs.surfaceContainerLow,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: cs.outlineVariant.withValues(alpha: .35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _buildHeader(cs),
              const SizedBox(height: 10),
              _buildChips(cs),
              const SizedBox(height: 10),
              SizedBox(
                height: 382,
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: <Widget>[
                    for (final _GuideEntry e in _visible) _buildRow(cs, e),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              _buildFooter(cs),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(ColorScheme cs) {
    final String dest = (widget.data.extra?['guide']
            as Map<String, dynamic>?)?['destination']?.toString() ??
        '';
    return Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '🌿 ${dest.isEmpty ? '目的' : dest} · 种草手册',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                _done
                    ? '选择已提交，正在按你的选择规划…'
                    : '文字介绍与实拍图已备好；卡上只放查得到的真数，勾掉不想要的再排行程',
                style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildChips(ColorScheme cs) {
    const Map<String, String> labels = <String, String>{
      'view': '必玩',
      'stay': '住宿',
      'food': '美食',
    };
    final List<Widget> chips = <Widget>[
      _chip(cs, 'all', '全部', _cats.values.fold<int>(0, (int a, List<_GuideEntry> l) => a + l.length)),
      for (final MapEntry<String, List<_GuideEntry>> e in _cats.entries)
        _chip(cs, e.key, labels[e.key] ?? e.key, e.value.length),
    ];
    return SizedBox(
      height: 30,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: <Widget>[const SizedBox(width: 2), ...chips],
      ),
    );
  }

  Widget _chip(ColorScheme cs, String key, String label, int count) {
    final bool on = _filter == key;
    return Padding(
      padding: const EdgeInsets.only(right: 7),
      child: GestureDetector(
        onTap: () => setState(() => _filter = key),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 5),
          decoration: BoxDecoration(
            color: on ? _amber.withValues(alpha: .14) : Colors.transparent,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: on ? _amber.withValues(alpha: .55) : cs.outlineVariant,
            ),
          ),
          child: Text(
            '$label $count',
            style: TextStyle(
              fontSize: 11.5,
              color: on ? _amber : cs.onSurfaceVariant,
              fontWeight: on ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  /// 价格那条指标：服务端只在本店真报价取到时才给数字，取不到就是「待核价」。
  _GuideMetricEntry? _priceOf(_GuideEntry e) {
    for (final _GuideMetricEntry m in e.metrics) {
      if (m.kind == 'price') return m;
    }
    return null;
  }

  Widget _buildRow(ColorScheme cs, _GuideEntry e) {
    final bool picked = _picked[e.key] == true;
    final _GuideMetricEntry? price = _priceOf(e);
    final bool priceReal = price != null && price.label.contains('¥');
    final List<_GuideMetricEntry> others =
        e.metrics.where((_GuideMetricEntry m) => m.kind != 'price').toList();
    return GestureDetector(
      onTap: () => setState(() => _picked[e.key] = !picked),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHighest.withValues(alpha: .5),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: picked ? _amber : cs.outlineVariant.withValues(alpha: .4),
            width: picked ? 1.4 : 1,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                width: 84,
                height: 68,
                child: e.photos.isEmpty
                    ? Container(
                        color: _tileFallback,
                        child: Icon(Icons.photo_outlined,
                            size: 20, color: cs.onSurfaceVariant),
                      )
                    : CachedMediaImage(
                        url: LinkUtils.resolveMediaUrl(e.photos.first),
                        fit: BoxFit.cover,
                        errorBuilder: (BuildContext _, Object __,
                                StackTrace? ___) =>
                            Container(color: _tileFallback),
                      ),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          e.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: cs.onSurface,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      if (price != null)
                        Text(
                          price.label,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: priceReal
                                ? (price.label.contains('免费') ? _jade : _amber)
                                : cs.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                  if (e.intro.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(
                        e.intro,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 10.5,
                            height: 1.35,
                            color: cs.onSurfaceVariant),
                      ),
                    ),
                  const SizedBox(height: 4),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: <Widget>[
                      Expanded(
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 3,
                          children: <Widget>[
                            for (final _GuideMetricEntry m in others)
                              Tooltip(
                                message: m.source.isEmpty ? m.label : m.source,
                                waitDuration: const Duration(milliseconds: 500),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 7, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: cs.surfaceContainerLow,
                                    borderRadius: BorderRadius.circular(6),
                                    border:
                                        Border.all(color: cs.outlineVariant),
                                  ),
                                  child: Text(
                                    m.label,
                                    style: TextStyle(
                                        fontSize: 9.5,
                                        color: cs.onSurfaceVariant),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      Icon(
                        picked
                            ? Icons.check_circle_rounded
                            : Icons.radio_button_unchecked,
                        size: 17,
                        color: picked ? _amber : cs.outline,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFooter(ColorScheme cs) {
    final bool canSubmit = _pickedCount > 0 && !_done;
    return Row(
      children: <Widget>[
        Text(
          '已选 $_pickedCount 处${_done ? ' · 已提交' : ''}',
          style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
        ),
        const Spacer(),
        GestureDetector(
          onTap: _done ? null : _delegate,
          child: Text(
            '全部交给你',
            style: TextStyle(
              fontSize: 12.5,
              color: _done ? cs.outline : cs.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(width: 12),
        FilledButton(
          onPressed: canSubmit ? _submit : null,
          style: FilledButton.styleFrom(
            backgroundColor: _amber,
            foregroundColor: const Color(0xFF1D1407),
            disabledBackgroundColor: cs.outline.withValues(alpha: .25),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
          ),
          child: Text(
            _done ? '已提交' : '就按这些规划',
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}

class _GuideMetricEntry {
  const _GuideMetricEntry({
    required this.kind,
    required this.label,
    required this.source,
  });

  final String kind;
  final String label;

  /// 这个数怎么来的（服务端给的真源说明），悬停展示。
  final String source;
}

class _GuideEntry {
  const _GuideEntry({
    required this.name,
    required this.photos,
    required this.intro,
    required this.metrics,
  });

  final String name;
  final List<String> photos;
  final String intro;
  final List<_GuideMetricEntry> metrics;

  /// 勾选状态键（同目的地同名不同类视为同一处）。
  String get key => name;
}
