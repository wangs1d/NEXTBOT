import 'package:flutter/material.dart';

import '../../core/utils/agent_result_parser.dart';
import '../../core/utils/link_utils.dart';
import 'media_disk_cache.dart';

/// 规划前「种草选择卡」（travel.destination-guide 工具结果 →
/// travel_guide_select 卡）：两分类候选（必玩/住宿）图文列表，
/// 每条 = 名称 + 推荐率胶囊 + 一句介绍 + 错落三图；卡上只放服务端算好的
/// 真数指标（评分/报价/距离/热度，没取到的就不出这条），勾选全部交给用户
/// （服务端不预选），「确认选择」把分组结果作为用户消息回传（服务端把
/// chat.user_action 转写为 user_message，LLM 按语义把选中项填
/// wishlist / stayWishlist 再生成行程）。
///
/// 数据在 [AgentResultData.extra]['guide']：
/// {destination, cats: [{key: view|stay, label, sortNote, anchor?,
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
  /// 价格/推荐率的强调色（与行迹页 c.orange 同一支暖色）。
  static const Color _amber = Color(0xFFF5A552);

  /// 三张照片的版式：宽度占比 / 高度 / 顶部错落偏移。
  static const List<double> _photoWidth = <double>[0.315, 0.31, 0.30];
  static const List<double> _photoHeight = <double>[104, 114, 92];
  static const List<double> _photoTop = <double>[9, -3, 16];

  late final List<_GuideCat> _cats;
  late final Map<String, bool> _picked;
  String _filter = 'view';
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _cats = <_GuideCat>[];
    final Map<String, dynamic>? guide =
        widget.data.extra?['guide'] as Map<String, dynamic>?;
    final List<dynamic>? cats = guide?['cats'] as List<dynamic>?;
    if (cats != null) {
      for (final dynamic c in cats) {
        if (c is! Map<String, dynamic>) continue;
        final String key = c['key']?.toString() ?? '';
        // 吃饭交给用户自己决定：餐饮段不再出卡。
        if (key == 'food') continue;
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
        if (entries.isNotEmpty) {
          _cats.add(_GuideCat(
            key: key,
            label: c['label']?.toString() ?? '',
            sortNote: c['sortNote']?.toString() ?? '',
            entries: entries,
          ));
        }
      }
    }
    // 默认落在有内容的分类（必玩 → 住宿 → 全部）
    _filter = _cats.any((_GuideCat c) => c.key == 'view')
        ? 'view'
        : (_cats.any((_GuideCat c) => c.key == 'stay') ? 'stay' : 'all');
    _picked = <String, bool>{};
    for (final _GuideCat cat in _cats) {
      for (final _GuideEntry e in cat.entries) {
        // 零预选：一条都不替用户勾。
        _picked[e.key] = false;
      }
    }
  }

  int get _pickedCount => _picked.values.where((bool v) => v).length;

  List<_GuideCat> get _visibleCats => _filter == 'all'
      ? _cats
      : _cats.where((_GuideCat c) => c.key == _filter).toList();

  void _submit() {
    if (_done || _pickedCount == 0 || widget.onUserAction == null) return;
    final Map<String, List<String>> byCat = <String, List<String>>{
      'view': <String>[],
      'stay': <String>[],
    };
    for (final _GuideCat cat in _cats) {
      for (final _GuideEntry e in cat.entries) {
        if (_picked[e.key] == true) byCat[cat.key]?.add(e.name);
      }
    }
    const Map<String, String> catLabel = <String, String>{
      'view': '必玩',
      'stay': '住宿',
    };
    final String joined = byCat.entries
        .where((MapEntry<String, List<String>> e) => e.value.isNotEmpty)
        .map((MapEntry<String, List<String>> e) =>
            '${catLabel[e.key] ?? e.key} ${e.value.join('、')}')
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
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          // 纯主题表面色卡片，不加彩色渐变与模糊。
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(22),
              color: cs.surfaceContainerLow,
              border: Border.all(
                color: cs.outlineVariant.withValues(alpha: .35),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _buildHeader(cs),
                const SizedBox(height: 10),
                _buildChips(cs),
                for (final _GuideCat cat in _visibleCats) ...<Widget>[
                  _buildSectionHeader(cs, cat),
                  for (final _GuideEntry e in cat.entries) _buildRow(cs, e),
                ],
                const SizedBox(height: 4),
                _buildFooter(cs),
              ],
            ),
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
                    : '文字介绍与实拍图已备好；卡上只放查得到的真数，点一行就是选它',
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
    };
    final List<Widget> chips = <Widget>[
      _chip(
          cs,
          'all',
          '全部',
          _cats.fold<int>(
              0, (int a, _GuideCat c) => a + c.entries.length)),
      for (final _GuideCat cat in _cats)
        _chip(cs, cat.key, labels[cat.key] ?? cat.label, cat.entries.length),
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
            color: on ? cs.primary.withValues(alpha: .12) : Colors.transparent,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: on ? cs.primary.withValues(alpha: .55) : cs.outlineVariant,
            ),
          ),
          child: Text(
            '$label $count',
            style: TextStyle(
              fontSize: 11.5,
              color: on ? cs.primary : cs.onSurfaceVariant,
              fontWeight: on ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  /// 分类标题行：emoji + 粗体标题 + 右侧小字说明（服务端给的排序依据）。
  Widget _buildSectionHeader(ColorScheme cs, _GuideCat cat) {
    final String title = switch (cat.key) {
      'view' => '🔥 必玩景点',
      'stay' => '🏨 住宿推荐',
      _ => cat.label,
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 14, 2, 9),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: cs.onSurface,
              ),
            ),
          ),
          if (cat.sortNote.isNotEmpty) ...<Widget>[
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                cat.sortNote,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 推荐率胶囊只认第一条非价格指标（评分/热度/距离/收藏）；取不到就不出胶囊。
  _GuideMetricEntry? _rateOf(_GuideEntry e) {
    for (final _GuideMetricEntry m in e.metrics) {
      if (m.kind != 'price') return m;
    }
    return null;
  }

  Widget _buildRow(ColorScheme cs, _GuideEntry e) {
    final bool picked = _picked[e.key] == true;
    final _GuideMetricEntry? rate = _rateOf(e);
    final List<_GuideMetricEntry> rest = <_GuideMetricEntry>[
      for (final _GuideMetricEntry m in e.metrics)
        if (!identical(m, rate)) m,
    ];
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _picked[e.key] = !picked),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                // 圆形勾选按钮：未选空圈，选中实心打勾。
                AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  curve: Curves.easeOut,
                  width: 20,
                  height: 20,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: picked ? cs.primary : Colors.transparent,
                    border: Border.all(
                      color: picked ? cs.primary : cs.outline,
                      width: 1.5,
                    ),
                  ),
                  child: picked
                      ? Icon(Icons.check_rounded,
                          size: 13, color: cs.onPrimary)
                      : null,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          e.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15.5,
                            fontWeight: FontWeight.w700,
                            color: cs.onSurface,
                          ),
                        ),
                      ),
                      const SizedBox(width: 5),
                      _buildInfoDot(cs, e),
                    ],
                  ),
                ),
                if (picked || rate != null) ...<Widget>[
                  const SizedBox(width: 8),
                  _buildRatePill(cs, selected: picked, rate: rate),
                ],
              ],
            ),
            if (e.intro.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 5, left: 28),
                child: Text(
                  e.intro,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.7,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
            if (rest.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 3, left: 28),
                child: _buildMetricsLine(cs, rest),
              ),
            _buildPhotos(cs, e, picked),
          ],
        ),
      ),
    );
  }

  /// 小 i 圆标：悬停看这条数的出处（服务端给的 source）。
  Widget _buildInfoDot(ColorScheme cs, _GuideEntry e) {
    final List<String> sources = <String>[
      for (final _GuideMetricEntry m in e.metrics)
        if (m.source.isNotEmpty) m.source,
    ];
    return Tooltip(
      message: sources.isEmpty ? '推荐依据来自真实指标' : sources.join('\n'),
      waitDuration: const Duration(milliseconds: 500),
      child: Container(
        width: 12,
        height: 12,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: cs.outlineVariant),
        ),
        child: Text(
          'i',
          style: TextStyle(
            fontSize: 8,
            height: 1,
            fontWeight: FontWeight.w700,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }

  /// 推荐率胶囊：选中后整颗变主色「已选 ✓」。
  Widget _buildRatePill(
    ColorScheme cs, {
    required bool selected,
    _GuideMetricEntry? rate,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: selected ? cs.primary : cs.primary.withValues(alpha: .10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: selected ? cs.primary : cs.primary.withValues(alpha: .26),
        ),
      ),
      child: Text(
        selected ? '已选 ✓' : '${rate!.label} ›',
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: selected ? cs.onPrimary : cs.onSurfaceVariant,
        ),
      ),
    );
  }

  /// 指标行：除推荐率外拼一行灰字，价格用暖色提亮。
  Widget _buildMetricsLine(ColorScheme cs, List<_GuideMetricEntry> metrics) {
    final List<InlineSpan> spans = <InlineSpan>[];
    for (int i = 0; i < metrics.length; i++) {
      if (i > 0) {
        spans.add(TextSpan(
          text: ' · ',
          style: TextStyle(color: cs.outline),
        ));
      }
      final bool isPrice = metrics[i].kind == 'price';
      spans.add(TextSpan(
        text: metrics[i].label,
        style: TextStyle(
          color: isPrice ? _amber : cs.onSurfaceVariant,
          fontWeight: isPrice ? FontWeight.w600 : FontWeight.w400,
        ),
      ));
    }
    return Text.rich(
      TextSpan(children: spans),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 11.5, height: 1.4),
    );
  }

  /// 错落三图：宽度按 31.5% / 31% / 30% 分配（扣掉间距后等比归一），
  /// 高度与顶部偏移各不同；第一张选中加暖色描边 + 角标。
  Widget _buildPhotos(ColorScheme cs, _GuideEntry e, bool picked) {
    final List<String> photos = e.photos.take(3).toList();
    final bool placeholder = photos.isEmpty;
    final int count = placeholder ? 1 : photos.length;
    return LayoutBuilder(
      builder: (BuildContext _, BoxConstraints cons) {
        const double gap = 8;
        final double usable = cons.maxWidth - gap * (count - 1);
        final double total = _photoWidth
            .take(count)
            .fold<double>(0, (double a, double b) => a + b);
        final List<double> widths = <double>[
          for (int i = 0; i < count; i++) usable * _photoWidth[i] / total,
        ];
        final List<double> lefts = <double>[];
        double x = 0;
        for (int i = 0; i < count; i++) {
          lefts.add(x);
          x += widths[i] + gap;
        }
        // 错落靠 Stack 定位实现：上去的那张 top 为负，不能用负 padding。
        double height = 0;
        for (int i = 0; i < count; i++) {
          final double bottom = _photoTop[i] + _photoHeight[i];
          if (bottom > height) height = bottom;
        }
        return Padding(
          padding: const EdgeInsets.only(top: 10),
          child: SizedBox(
            height: height,
            child: Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                for (int i = 0; i < count; i++)
                  Positioned(
                    left: lefts[i],
                    top: _photoTop[i],
                    child: _GuidePhoto(
                      url: placeholder ? '' : photos[i],
                      cs: cs,
                      width: widths[i],
                      height: _photoHeight[i],
                      selected: picked && i == 0,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildFooter(ColorScheme cs) {
    final bool canSubmit = _pickedCount > 0 && !_done;
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            _done ? '已选 $_pickedCount 处 · 已提交' : '已选 $_pickedCount 处 · 可多选',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: 10),
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
            backgroundColor: cs.primary,
            foregroundColor: cs.onPrimary,
            disabledBackgroundColor: cs.outline.withValues(alpha: .25),
            minimumSize: const Size(0, 38),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
          ),
          child: Text(
            _done ? '已提交' : '就按这些规划',
            maxLines: 1,
            softWrap: false,
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}

/// 一张实拍图（无图时用主题渐变占位，不放任何假 URL）。
class _GuidePhoto extends StatelessWidget {
  const _GuidePhoto({
    required this.url,
    required this.cs,
    required this.width,
    required this.height,
    required this.selected,
  });

  final String url;
  final ColorScheme cs;
  final double width;
  final double height;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: selected
              ? cs.primary
              : Colors.white.withValues(alpha: .09),
          width: selected ? 1.5 : 1,
        ),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[cs.surfaceContainerHighest, cs.surfaceContainerLow],
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          if (url.isEmpty)
            Center(
              child: Icon(
                Icons.photo_outlined,
                size: 18,
                color: cs.outlineVariant,
              ),
            )
          else
            CachedMediaImage(
              url: LinkUtils.resolveMediaUrl(url),
              fit: BoxFit.cover,
              errorBuilder: (BuildContext _, Object __, StackTrace? ___) =>
                  Center(
                child: Icon(
                  Icons.photo_outlined,
                  size: 18,
                  color: cs.outlineVariant,
                ),
              ),
            ),
          if (selected)
            Positioned(
              top: 6,
              right: 6,
              child: Container(
                width: 17,
                height: 17,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: cs.primary,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.check_rounded,
                  size: 11,
                  color: cs.onPrimary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _GuideCat {
  const _GuideCat({
    required this.key,
    required this.label,
    required this.sortNote,
    required this.entries,
  });

  final String key;
  final String label;

  /// 这一段「是按什么排出来的」，由服务端按实际参与排序的信号拼出。
  final String sortNote;
  final List<_GuideEntry> entries;
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
