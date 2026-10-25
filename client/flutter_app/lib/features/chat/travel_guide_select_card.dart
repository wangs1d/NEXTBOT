import 'package:flutter/material.dart';

import '../../core/utils/agent_result_parser.dart';
import '../../core/utils/link_utils.dart';
import 'media_disk_cache.dart';

/// 规划前「种草选择卡」（travel.destination-guide 工具结果 →
/// travel_guide_select 卡）：四分类候选（必玩/住宿/美食）多图勾选网格，
/// Agent 预选必玩 Top3，「确认选择」把分组结果作为用户消息回传
/// （服务端把 chat.user_action 转写为 user_message，LLM 按语义把选中项
/// 填 wishlist / foodWishlist / stayWishlist 再生成行程）。
///
/// 数据在 [AgentResultData.extra]['guide']：
/// {destination, cats: [{key: view|stay|food, label, items: [{name, rec,
///  rating, photos[], picked}]}]}。旧载荷缺 extra 时回退 items 文字清单
/// （通用卡渲染），本组件不会被构建。
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
  static const List<double> _rotations = <double>[-0.035, 0.028, -0.023];
  static const Color _amber = Color(0xFFF5A552);
  static const Color _jade = Color(0xFF6FC3B8);
  static const Color _tileFallback = Color(0xFF14323C);

  late final Map<String, List<_GuideEntry>> _cats;
  late final Map<String, bool> _picked;
  String _filter = 'view';
  bool _done = false;
  /// 照片簇悬停散开态（桌面 hover；触屏保持叠压）
  bool _spread = false;

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
              cat: key,
              rec: (it['rec'] as num?)?.toInt() ?? 0,
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
        _picked[e.key] = false;
      }
    });
    // Agent 预选：必玩前 3（把「从零选」变成「确认微调」）
    (_cats['view'] ?? const <_GuideEntry>[])
        .take(3)
        .forEach((_GuideEntry e) => _picked[e.key] = true);
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
                height: 356,
                child: GridView.count(
                  crossAxisCount: 2,
                  mainAxisSpacing: 9,
                  crossAxisSpacing: 9,
                  childAspectRatio: 1.62,
                  children: <Widget>[
                    for (final _GuideEntry e in _visible) _buildCell(cs, e),
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
                _done ? '选择已提交，正在按你的选择规划…' : '勾掉不想要的、补上想要的，我再按选择排行程',
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

  Widget _buildCell(ColorScheme cs, _GuideEntry e) {
    final bool picked = _picked[e.key] == true;
    return GestureDetector(
      onTap: () => setState(() => _picked[e.key] = !picked),
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHighest.withValues(alpha: .5),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: picked ? _amber : cs.outlineVariant.withValues(alpha: .4),
            width: picked ? 1.4 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            MouseRegion(
              onEnter: (_) => setState(() => _spread = true),
              onExit: (_) => setState(() => _spread = false),
              child: SizedBox(
                height: 48,
                // 交错叠压（对齐小红书参考图）：三张照片偏移压边、微旋转、
                // 中张最上（Stack 绘制顺序 0→2→1）；悬停整叠 → 动态散开摊平。
                child: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    for (final int i in const <int>[0, 2, 1])
                      AnimatedPositioned(
                        duration: const Duration(milliseconds: 240),
                        curve: Curves.easeOutBack,
                        left: _spread ? 8.0 + i * 52.0 : i * 31.0,
                        top: _spread ? 2.0 : (i == 1 ? 0.0 : 4.0),
                        child: Transform.rotate(
                          angle: _rotations[i % _rotations.length],
                          child: SizedBox(
                            width: 48,
                            height: 40,
                            child: _photoTile(e, i),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 7),
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    e.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                if (e.rec > 0)
                  Text(
                    '${e.rec}%',
                    style: const TextStyle(
                      fontSize: 10.5,
                      color: _jade,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// 簇里的一格照片：有图用图（磁盘缓存优先），无图/失败露出深青兜底底色。
  Widget _photoTile(_GuideEntry e, int i) {
    final ColorScheme cs = widget.cs;
    Widget body = Container(color: _tileFallback);
    if (i < e.photos.length) {
      final String url = LinkUtils.resolveMediaUrl(e.photos[i]);
      body = CachedMediaImage(
        url: url,
        fit: BoxFit.cover,
        errorBuilder:
            (BuildContext _, Object __, StackTrace? ___) => Container(
                  color: _tileFallback,
                ),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          body,
          Container(
            decoration: BoxDecoration(
              border: Border.all(color: cs.outlineVariant.withValues(alpha: .5)),
              borderRadius: BorderRadius.circular(6),
            ),
          ),
        ],
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

class _GuideEntry {
  const _GuideEntry({
    required this.name,
    required this.cat,
    required this.rec,
    required this.photos,
  });

  final String name;
  final String cat;
  final int rec;
  final List<String> photos;

  /// 勾选状态键（同目的地同名不同类视为同一处）。
  String get key => name;
}
