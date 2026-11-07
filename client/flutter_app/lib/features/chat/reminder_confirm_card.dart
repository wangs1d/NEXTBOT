import "package:flutter/material.dart";

import "../../core/utils/agent_result_parser.dart";

/// 提醒确认卡（2026-11-07 用户拍板「方案 A」+ A 版视觉）。
///
/// 版式与 `docs/design/mobile-reminder/index.html` v0.4 一致：
/// ```
/// ● 已定好 4 条提醒
///   明天 08:00 · 带工牌      （上一条，隐隐渐隐）
///   明天 09:00 · 交房租      （当前项，清晰）
///   明天 10:00 · 买咖啡      （下一条，隐隐渐隐）
/// ```
/// - 对话先行：正文气泡照常分泡，这张卡只是同轮最后一段「凭据」；
/// - 只读：无按钮、无 InkWell、无跳转，payload 的 actions 恒为空；
/// - 一轮一张卡；≥2 条时卡内上下轮动、一次只清晰渲染一条，rows 由服务端
///   全量下发，界面不铺开、不折叠、不显示「共 N 条」；
/// - 字体分层：固定 92px 时间列（label 12 / time 16 等宽数字）、事项 15/400，
///   邻项按距离分级透明 + 轻微缩放 + 连续渐隐，当前项有极淡选中槽；
/// - 脚注只在重复 / 跨时区时出现（服务端已经判好，这里只管显示）；
/// - 修改 / 取消由服务端推 card.update 原地换卡，本组件按 status 渲染
///   「已改为 / 已取消 / 已提醒」与删除线，不追加新卡。
///
/// 兼容性：老服务端或历史消息缺 `extra.reminder` 时回退 `data.items`
/// 的静态文本行，绝不空白、绝不炸。
class ReminderConfirmCard extends StatefulWidget {
  const ReminderConfirmCard({
    super.key,
    required this.data,
    required this.cs,
  });

  final AgentResultData data;
  final ColorScheme cs;

  @override
  State<ReminderConfirmCard> createState() => _ReminderConfirmCardState();
}

class _ReminderConfirmCardState extends State<ReminderConfirmCard> {
  static const double _rowHeight = 44;
  static const double _viewportHeight = 132;
  static const double _centerTop = (_viewportHeight - _rowHeight) / 2;
  static const double _stepHeight = 40;
  static const double _timeColumnWidth = 92;
  static const Duration _anim = Duration(milliseconds: 280);

  int _index = 0;
  double _dragAccum = 0;

  static String _s(Object? v) => v?.toString() ?? "";

  static List<Map<String, dynamic>> _rows(Map<String, dynamic> reminder) {
    final Object? raw = reminder["rows"];
    final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
    if (raw is List) {
      for (final Object? item in raw) {
        if (item is Map) out.add(Map<String, dynamic>.from(item));
      }
    }
    return out;
  }

  Map<String, dynamic> get _reminder {
    final Object? raw = widget.data.extra == null ? null : widget.data.extra!["reminder"];
    return raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
  }

  @override
  void didUpdateWidget(covariant ReminderConfirmCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    final int n = _rows(_reminder).length;
    if (n > 0 && _index > n - 1) _index = n - 1;
  }

  void _step(int delta, int total) {
    if (total < 2) return;
    final int next = (_index + delta).clamp(0, total - 1).toInt();
    if (next == _index) return;
    setState(() => _index = next);
  }

  Color _dotColor(String status) {
    if (status == "updated") return const Color(0xFFB8862F);
    if (status == "fired") return const Color(0xFF2E9E63);
    return widget.cs.onSurface.withValues(alpha: 0.28);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    final Map<String, dynamic> reminder = _reminder;
    final List<Map<String, dynamic>> rows = _rows(reminder);
    final String status = _s(reminder["status"]).isEmpty ? "created" : _s(reminder["status"]);
    final bool wheel = rows.length >= 2;
    // 描边派生自 onSurface：本主题 cs.outline ≈ #E8E9ED，420dpi 下几乎看不见
    final Color border = cs.onSurface.withValues(alpha: 0.12);
    final Color ink = cs.onSurface.withValues(alpha: 0.9);
    final Color subInk = cs.onSurface.withValues(alpha: 0.52);
    final Color hintInk = cs.onSurface.withValues(alpha: 0.38);
    final Color titleInk = cs.onSurface.withValues(alpha: 0.78);
    final Color strikeInk = cs.onSurface.withValues(alpha: 0.38);
    final Color slot = cs.onSurface.withValues(alpha: 0.035);

    final List<Widget> children = <Widget>[
      Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(color: _dotColor(status), shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              widget.data.title.isEmpty ? "已定好提醒" : widget.data.title,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                letterSpacing: 0.7,
                color: subInk,
                height: 1.2,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
      const SizedBox(height: 10),
    ];

    if (wheel) {
      children.add(
        _wheel(rows, status, ink: ink, hintInk: hintInk, titleInk: titleInk, strikeInk: strikeInk, slot: slot),
      );
    } else if (rows.length == 1) {
      children.add(
        _rowLine(
          rows[0],
          status,
          ink: ink,
          hintInk: hintInk,
          titleInk: titleInk,
          strikeInk: strikeInk,
        ),
      );
    } else {
      // 兜底：老载荷只有 items 文本行，静态展示全部事实
      for (final AgentResultItem item in widget.data.items) {
        if (item.text.trim().isEmpty) continue;
        children.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              item.text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w400, color: ink),
            ),
          ),
        );
      }
    }

    if (widget.data.footer.trim().isNotEmpty) {
      children.add(const SizedBox(height: 9));
      children.add(
        Text(
          widget.data.footer,
          style: TextStyle(fontSize: 10.5, color: cs.onSurface.withValues(alpha: 0.45)),
        ),
      );
    }
    // 不再渲染 more：服务端已不下发「共 N 条」折叠收口，界面靠轮动暗示还有条目。

    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 300),
        child: SizedBox(
          width: double.infinity,
          child: Container(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 13),
            decoration: BoxDecoration(
              color: cs.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: border, width: 1),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: children,
            ),
          ),
        ),
      ),
    );
  }

  /// 一行事实：固定 92px 时间列 + 弱化间隔点 + 事项，上下翻动时不会左右跳。
  Widget _rowLine(
    Map<String, dynamic> row,
    String status, {
    required Color ink,
    required Color hintInk,
    required Color titleInk,
    required Color strikeInk,
  }) {
    final String label = _s(row["label"]);
    final String time = _s(row["time"]);
    final String title = _s(row["title"]);
    final bool cancelled = _s(row["status"]) == "cancelled" || status == "cancelled";
    final Color mainInk = cancelled ? strikeInk : ink;
    final TextDecoration? deco = cancelled ? TextDecoration.lineThrough : null;
    final Color decoColor = strikeInk.withValues(alpha: 0.5);

    return SizedBox(
      height: _rowHeight,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          SizedBox(
            width: _timeColumnWidth,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: <Widget>[
                if (label.isNotEmpty)
                  Text(label, style: TextStyle(fontSize: 12, color: cancelled ? strikeInk : hintInk)),
                if (label.isNotEmpty && time.isNotEmpty) const SizedBox(width: 5),
                if (time.isNotEmpty)
                  Text(
                    time,
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                      letterSpacing: -0.3,
                      color: mainInk,
                      decoration: deco,
                      decorationColor: decoColor,
                      fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 9),
          Text("·", style: TextStyle(fontSize: 12, color: hintInk)),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w400,
                letterSpacing: 0.1,
                color: cancelled ? strikeInk : titleInk,
                decoration: deco,
                decorationColor: decoColor,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 上下轮动区：当前项清晰，邻项按距离分级透明 / 缩放 / 内收，边缘连续渐隐。
  Widget _wheel(
    List<Map<String, dynamic>> rows,
    String status, {
    required Color ink,
    required Color hintInk,
    required Color titleInk,
    required Color strikeInk,
    required Color slot,
  }) {
    return SizedBox(
      height: _viewportHeight,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onVerticalDragUpdate: (DragUpdateDetails details) {
          _dragAccum += details.delta.dy;
          if (_dragAccum <= -24) {
            _dragAccum = 0;
            _step(1, rows.length);
          } else if (_dragAccum >= 24) {
            _dragAccum = 0;
            _step(-1, rows.length);
          }
        },
        onVerticalDragEnd: (DragEndDetails _) => _dragAccum = 0,
        onVerticalDragCancel: () => _dragAccum = 0,
        onTapUp: (TapUpDetails details) {
          _step(details.localPosition.dy < _viewportHeight / 2 ? -1 : 1, rows.length);
        },
        child: ShaderMask(
          shaderCallback: (Rect rect) => const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[
              Color(0x00FFFFFF),
              Color(0xFFFFFFFF),
              Color(0xFFFFFFFF),
              Color(0x00FFFFFF),
            ],
            stops: <double>[0.0, 0.30, 0.70, 1.0],
          ).createShader(rect),
          blendMode: BlendMode.dstIn,
          child: Stack(
            children: <Widget>[
              Positioned(
                left: -4,
                right: -4,
                top: _centerTop,
                height: _rowHeight,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: slot,
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
              ),
              for (int i = 0; i < rows.length; i++)
                _wheelRow(
                  i,
                  rows[i],
                  status,
                  ink: ink,
                  hintInk: hintInk,
                  titleInk: titleInk,
                  strikeInk: strikeInk,
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _wheelRow(
    int i,
    Map<String, dynamic> row,
    String status, {
    required Color ink,
    required Color hintInk,
    required Color titleInk,
    required Color strikeInk,
  }) {
    final int d = i - _index;
    final int a = d < 0 ? -d : d;
    final double opacity = a == 0 ? 1 : (a == 1 ? 0.32 : (a == 2 ? 0.10 : 0));
    final double scale = a == 0 ? 1 : (a == 1 ? 0.94 : 0.88);
    return AnimatedPositioned(
      key: ValueKey<int>(i),
      duration: _anim,
      curve: Curves.easeOutCubic,
      left: a == 0 ? 0 : 3.0 * a,
      right: 0,
      top: _centerTop + d * _stepHeight,
      child: IgnorePointer(
        child: AnimatedOpacity(
          opacity: opacity,
          duration: _anim,
          curve: Curves.easeOutCubic,
          child: AnimatedScale(
            scale: scale,
            duration: _anim,
            curve: Curves.easeOutCubic,
            child: _rowLine(
              row,
              status,
              ink: ink,
              hintInk: hintInk,
              titleInk: titleInk,
              strikeInk: strikeInk,
            ),
          ),
        ),
      ),
    );
  }
}
