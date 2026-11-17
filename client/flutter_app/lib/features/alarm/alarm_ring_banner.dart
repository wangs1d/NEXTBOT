import "dart:async";

import "package:flutter/material.dart";

import "alarm_engine.dart";
import "alarm_platform.dart";

/// 应用内闹钟关闭通道。
///
/// 到点响铃时原生会拉起全屏意图并常驻响铃通知（通知栏带「贪睡/关闭」），
/// 但 App 内没有落地的关闭入口——用户被全屏拉到前台后只能下拉通知栏。
/// 这里在页面顶部常驻一条横幅，关闭 = 停铃 + 推进本次闹钟（与通知动作同一业务链路）。
class AlarmRingBannerHost extends StatefulWidget {
  const AlarmRingBannerHost({super.key, required this.child});

  final Widget child;

  @override
  State<AlarmRingBannerHost> createState() => _AlarmRingBannerHostState();
}

class _AlarmRingBannerHostState extends State<AlarmRingBannerHost>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_sync());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_sync());
  }

  /// 响铃可能早于 Dart 桥就绪（全屏意图冷启动），回前台时补一次查询。
  Future<void> _sync() async {
    final AlarmRingInfo? info = await AlarmPlatform.currentRing();
    if (!mounted) return;
    if (info != null) {
      AlarmPlatform.activeRing.value = info;
    } else if (AlarmPlatform.activeRing.value != null) {
      AlarmPlatform.activeRing.value = null;
    }
  }

  void _dismiss(AlarmRingInfo info) {
    // 先撤横幅保证点击即反馈；停铃与本地库推进交给 AlarmEngine（幂等）。
    AlarmPlatform.activeRing.value = null;
    unawaited(AlarmEngine.instance.dismiss(info.alarmId));
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<AlarmRingInfo?>(
      valueListenable: AlarmPlatform.activeRing,
      builder: (BuildContext context, AlarmRingInfo? info, Widget? child) {
        return Stack(
          children: <Widget>[
            if (child != null) child,
            if (info != null)
              Positioned(
                top: 0,
                left: 0,
                right: 0,
                child: _AlarmRingBanner(
                  info: info,
                  onDismiss: () => _dismiss(info),
                ),
              ),
          ],
        );
      },
      child: widget.child,
    );
  }
}

class _AlarmRingBanner extends StatelessWidget {
  const _AlarmRingBanner({required this.info, required this.onDismiss});

  final AlarmRingInfo info;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final String title =
        info.label.trim().isEmpty ? "闹钟" : info.label.trim();
    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: Material(
          color: const Color(0xF21F1F1F),
          borderRadius: BorderRadius.circular(16),
          elevation: 8,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
            child: Row(
              children: <Widget>[
                const Icon(Icons.alarm, size: 22, color: Color(0xFFFFB74D)),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        info.message,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 12.5,
                          height: 1.3,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                TextButton(
                  onPressed: onDismiss,
                  style: TextButton.styleFrom(
                    foregroundColor: Colors.white,
                    backgroundColor: Colors.white.withValues(alpha: 0.14),
                    minimumSize: const Size(0, 34),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text("关闭"),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
