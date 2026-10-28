import "package:flutter/material.dart";

import "../services/client_update_checker.dart";
import "../services/client_update_installer.dart";
import "client_update_flow_view.dart";

/// 客户端升级弹窗（启动版本检查触发）。
///
/// - 软提醒（forced=false）：「发现新版本」，可暂不更新继续使用。
/// - 强制锁（forced=true）：本地版本低于 minVersion，弹窗不可关闭
///   （点空白/Esc/系统返回均无效），唯一出口是升级到新版本。
///
/// 点「立即升级」就地进入应用内下载流程（进度条 → 「重启完成更新」→
/// 静默覆盖安装并自动拉起新版），全程不跳浏览器；下载流为全局共享单飞
/// （2026-10-28），弹窗关闭不终止后台预下载。侧栏「检查更新」按钮的手动
/// 检查不走弹窗——已是最新走右上角玻璃通知卡、其余结果走更新按钮正上方
/// 浮卡（见 update_result_card.dart）；仅强锁场景经 showClientUpdateDialog
/// 以不可关闭弹窗截停（可选升级启动时已改为后台预下载 + 左下角胶囊，
/// 不再弹模态）。
Future<void> showClientUpdateDialog({
  required BuildContext context,
  required ClientManifest manifest,
  required String localVersion,
  required bool forced,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => _ClientUpdateDialogBody(
      manifest: manifest,
      localVersion: localVersion,
      forced: forced,
    ),
  );
}

class _ClientUpdateDialogBody extends StatefulWidget {
  const _ClientUpdateDialogBody({
    required this.manifest,
    required this.localVersion,
    required this.forced,
  });

  final ClientManifest manifest;
  final String localVersion;
  final bool forced;

  @override
  State<_ClientUpdateDialogBody> createState() =>
      _ClientUpdateDialogBodyState();
}

class _ClientUpdateDialogBodyState extends State<_ClientUpdateDialogBody> {
  ClientUpdateFlowController? _flow;

  void _startFlow() {
    // 下载流为全局共享单飞（2026-10-28 主流式）：若后台已在预下载
    // （左下角胶囊），这里直接并入同一条流展示进度，不再另起下载
    sharedUpdateFlow(
      downloadUrl: widget.manifest.url,
      version: widget.manifest.latest,
    );
    ensureSharedUpdateDownloading();
    setState(() => _flow = activeSharedUpdateFlow);
  }

  @override
  void dispose() {
    // 只解绑不取消（2026-10-28 起共享流归全局所有）：弹窗任何路径退出
    // （含点空白/Esc）后台预下载继续，左下角胶囊继续反映进度
    _flow = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 配色走主题 ColorScheme：深色/暖米白两套主题各自成立，
    // 不再写死深色 locationDialog 常量（暖色主题下弹窗不再变成深灰）
    final ColorScheme cs = Theme.of(context).colorScheme;
    final String title = widget.forced ? "版本过旧，需要升级" : "发现新版本";
    final String body = widget.forced
        ? "当前版本 v${widget.localVersion} 已不可用，请升级到 v${widget.manifest.latest} 后继续使用。\n"
            "点击立即升级将在应用内下载新版，完成后重启即完成更新。"
        : "当前 v${widget.localVersion} → 最新 v${widget.manifest.latest}"
            "${widget.manifest.notes.isEmpty ? "" : "\n\n${widget.manifest.notes}"}";

    return PopScope(
      canPop: !widget.forced,
      child: Dialog(
        // 底色/surfaceTint 继承主题 dialogTheme，这里只自带圆角描边
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: cs.outline),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 400),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(
                  title,
                  style: TextStyle(
                    color: cs.onSurface,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  body,
                  style: TextStyle(
                    color: cs.onSurfaceVariant.withValues(alpha: 0.92),
                    fontSize: 15,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 12),
                // 手动出口：极端失败场景可复制链接去别处下载
                SelectableText(
                  widget.manifest.url,
                  style: TextStyle(
                    color: cs.onSurfaceVariant.withValues(alpha: 0.8),
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 20),
                if (_flow == null)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: <Widget>[
                      if (!widget.forced) ...<Widget>[
                        TextButton(
                          autofocus: true,
                          onPressed: () => Navigator.pop(context),
                          style: TextButton.styleFrom(
                            foregroundColor: cs.onSurfaceVariant,
                          ),
                          child: const Text("暂不更新"),
                        ),
                        const SizedBox(width: 8),
                      ],
                      // 主按钮继承主题 filledButtonTheme（含暖色配色）
                      FilledButton(
                        onPressed: _startFlow,
                        child: const Text("立即升级"),
                      ),
                    ],
                  )
                else
                  ClientUpdateFlowView(
                    controller: _flow!,
                    showCancel: !widget.forced,
                    onDismiss: () => Navigator.pop(context),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
