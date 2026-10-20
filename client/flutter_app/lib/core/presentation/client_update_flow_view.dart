import "package:flutter/material.dart";

import "../services/client_update_installer.dart";

/// 「立即升级 → 下载进度 → 重启完成更新」的共享操作区。
///
/// 启动检查弹窗（client_update_dialog.dart）与「检查更新」浮卡
/// （update_result_card.dart）两个容器都嵌它：用户点升级后就地进入
/// 下载流程，全程不出应用、不跳浏览器；下完一键重启静默安装。
/// 胶囊按钮与浮卡同一套黑白玻璃语言，配色按明暗主题推导。
class ClientUpdateFlowView extends StatelessWidget {
  const ClientUpdateFlowView({
    super.key,
    required this.controller,
    this.showCancel = true,
    this.onDismiss,
  });

  final ClientUpdateFlowController controller;

  /// false = 强锁弹窗等不可退场景：不渲染「暂不更新/取消」出口
  final bool showCancel;

  /// idle/failed 态的「暂不更新」出口（弹窗=关闭弹窗，浮卡=回到静态卡）
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    // 配色全部交给主题：主操作=主题 FilledButton、次操作=描边胶囊，
    // 文字用 onSurface/onSurfaceVariant——深色/暖米白两套主题各自成立
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Color ink = cs.onSurface;
    final Color inkSoft = cs.onSurfaceVariant;
    // 次操作胶囊描边：outline 在暖色主题的奶白底上过淡，用 onSurface 半透明
    final Color line = ink.withValues(alpha: 0.28);

    return ListenableBuilder(
      listenable: controller,
      builder: (BuildContext context, _) => switch (controller.phase) {
        ClientUpdatePhase.idle => _wrapPills(<Widget>[
            _pill("立即升级", emphasized: true, onTap: controller.begin),
            if (showCancel)
              _pill("暂不更新", ink: ink, line: line, onTap: onDismiss),
          ]),
        ClientUpdatePhase.downloading => _buildDownloading(ink, inkSoft, line),
        ClientUpdatePhase.downloaded => _wrapPills(<Widget>[
            _pill(
              "重启完成更新",
              emphasized: true,
              onTap: controller.restartToUpdate,
            ),
            if (showCancel)
              _pill("取消", ink: ink, line: line, onTap: controller.cancel),
          ]),
        ClientUpdatePhase.launching => _wrapPills(<Widget>[
            // onPressed=null = 主题禁用态（灰阶减弱），不再手调透明度
            _pill("正在完成更新…", emphasized: true),
          ]),
        ClientUpdatePhase.failed => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                controller.error ?? "下载失败",
                style: TextStyle(fontSize: 12.5, color: inkSoft),
              ),
              const SizedBox(height: 8),
              _wrapPills(<Widget>[
                _pill("重试", emphasized: true, onTap: controller.begin),
                if (showCancel)
                  _pill("暂不更新", ink: ink, line: line, onTap: onDismiss),
              ]),
            ],
          ),
      },
    );
  }

  Widget _buildDownloading(Color ink, Color inkSoft, Color line) {
    final double? value = controller.progress;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: value,
            minHeight: 3,
            backgroundColor: ink.withValues(alpha: 0.18),
            valueColor: AlwaysStoppedAnimation<Color>(ink),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          _progressCaption(),
          style: TextStyle(fontSize: 12, color: inkSoft),
        ),
        const SizedBox(height: 8),
        _wrapPills(<Widget>[
          _pill("取消", ink: ink, line: line, onTap: controller.cancel),
        ]),
      ],
    );
  }

  String _progressCaption() {
    final int received = controller.received;
    final int? total = controller.total;
    if (total == null) return "已下载 ${formatMb(received)}";
    final int percent = (controller.progress! * 100).round().clamp(0, 100);
    return "${formatMb(received)} / ${formatMb(total)} · $percent%";
  }

  Widget _wrapPills(List<Widget> children) {
    return Wrap(spacing: 8, runSpacing: 8, children: children);
  }

  /// 主/次操作直接用主题按钮：颜色随主题（含暖色）自动走，与升级弹窗、
  /// 更新浮卡同一语言；shrinkWrap 保持胶囊几何。
  /// 行高不写 1.0（旧运行时会无视纵向内边距、按 13px 字面行盒算高，
  /// 中文墨迹溢出胶囊），并以 32px 最小高度兜底。
  Widget _pill(
    String label, {
    bool emphasized = false,
    Color? ink,
    Color? line,
    VoidCallback? onTap,
  }) {
    const TextStyle textStyle = TextStyle(
      fontSize: 13,
      height: 1.2,
      fontWeight: FontWeight.w600,
    );
    if (emphasized) {
      return FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const StadiumBorder(),
          textStyle: textStyle,
        ),
        child: Text(label),
      );
    }
    return OutlinedButton(
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        foregroundColor: ink,
        side: BorderSide(color: line ?? Colors.transparent),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
        textStyle: textStyle,
      ),
      child: Text(label),
    );
  }
}

/// 字节 → MB 可读串（一位小数；安装包量级下 KB 不够看）
String formatMb(int bytes) {
  final double mb = bytes / (1024 * 1024);
  return mb >= 100 ? "${mb.round()} MB" : "${mb.toStringAsFixed(1)} MB";
}
