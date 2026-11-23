import "package:flutter/material.dart";

import "../core/models/notify_action.dart";
import "../core/services/local_notification_actions.dart";
import "../core/services/proactive_decision.dart";

/// 决策半屏页（2026-11-30 PRD §4.4 行 2「App 被杀、厂商通道可用」）。
///
/// 为什么是半屏模态、而不是跳到某个页面：厂商推送弹出来的那条通知**带不出按钮**
/// （§1.2 R4：华为系统模板通知渲染不出按钮），用户点开它本来只会落到首页，
/// 然后要在对话流里自己找那条消息——「不打开 App 就处理完」变成「打开 App 再找一遍」。
/// 半屏页把这条决策的两个按钮直接端到他面前，**一步拍完自己收起来**。
///
/// 状态机与载荷解析都在 core/services/proactive_decision.dart（纯逻辑、可单测），
/// 这里只画界面。复用而非新建：
///  · 按钮 = 服务端签好的同一批动作（`actionIntent.actions`，与通知栏同一 actionId、
///    同一枚一次性 token）→ 执行走 [executeNotifyAction]，即
///    `POST /api/action-intents/execute`，与通知栏按钮、对话卡按钮同一条链路；
///  · 弹层 = `showModalBottomSheet` 挂在手机主壳那个 MaterialApp 的导航器上
///    （与 QuickNoteSheet 同款，主题才不会被桌面端主题串掉）；
///  · 不新建 WS 连接、不新建通知渠道、不新建状态存储。
class MobileDecisionSheet extends StatefulWidget {
  const MobileDecisionSheet({
    super.key,
    required this.request,
    this.onExecute,
    this.autoCloseDelay = const Duration(milliseconds: 1600),
  });

  /// 这条待处理的决策（标题 + 正文 + 两个按钮），由 [DecisionRequest] 的两个
  /// 解析入口产出（通知点开的载荷 / 重连补投的 proactive 事件）。
  final DecisionRequest request;

  /// 动作执行口（默认走既有的 action-intent HTTP 链路；测试注入桩）
  final Future<ActionReceipt> Function(NotifyAction action, String input)?
      onExecute;

  /// 拍板成功后回执在页上停留多久再自动收起
  final Duration autoCloseDelay;

  /// 弹出半屏页。返回 `true` = 用户选了「打开对话」，主壳据此把他切到会话 tab。
  ///
  /// [context] 必须来自手机主壳的导航器（main.dart 的 `_mobileMainNavigatorKey`）：
  /// 根导航器的 context 在 MobileTheme 之外，弹出来会是桌面端主题（QuickNoteSheet
  /// 注释里记着同一个坑）。
  static Future<bool> show(
    BuildContext context, {
    required DecisionRequest request,
  }) async {
    final bool? openChat = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (BuildContext ctx) => MobileDecisionSheet(request: request),
    );
    return openChat == true;
  }

  @override
  State<MobileDecisionSheet> createState() => _MobileDecisionSheetState();
}

class _MobileDecisionSheetState extends State<MobileDecisionSheet> {
  late final DecisionSheetModel _model;
  final TextEditingController _input = TextEditingController();

  @override
  void initState() {
    super.initState();
    _model = DecisionSheetModel(
      request: widget.request,
      execute: widget.onExecute ??
          (NotifyAction action, String input) =>
              executeNotifyAction(action, input: input),
      autoCloseDelay: widget.autoCloseDelay,
      // 一步完成后由状态机自己收起：pop(true/false) = 要不要顺带回会话。
      // 划走/点外部只是「这条没在这儿处理」——服务端那条意图仍在待处理区，
      // 下次补投或「你不在时」汇总卡还会端出来，不算拒绝。
      requestClose: () {
        if (!mounted) return;
        final NavigatorState nav = Navigator.of(context);
        if (nav.canPop()) nav.pop(_model.requestsConversation);
      },
    );
  }

  @override
  void dispose() {
    _model.dispose();
    _input.dispose();
    super.dispose();
  }

  Future<void> _submit(NotifyAction action) async {
    await _model.submit(action, input: _input.text);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final List<NotifyAction> actions = _model.actions;
    final bool needsInput = actions.any((NotifyAction a) => a.needsInput);
    return AnimatedBuilder(
      animation: _model,
      builder: (BuildContext context, Widget? child) {
        return Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
          child: Material(
            color: cs.surface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Center(
                      child: Container(
                        width: 36,
                        height: 4,
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(
                          color: cs.onSurfaceVariant.withValues(alpha: .32),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    if (widget.request.title.trim().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Text(
                          widget.request.title.trim(),
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                    if (widget.request.body.trim().isNotEmpty)
                      Text(
                        widget.request.body.trim(),
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    if (needsInput && !_model.settled)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: TextField(
                          controller: _input,
                          minLines: 1,
                          maxLines: 3,
                          decoration: InputDecoration(
                            hintText: _inputHint(actions),
                            isDense: true,
                            border: const OutlineInputBorder(),
                          ),
                        ),
                      ),
                    if (_model.phase != DecisionPhase.idle)
                      _statusLine(context, cs),
                    if (!_model.settled)
                      Padding(
                        padding: const EdgeInsets.only(top: 14),
                        child: Row(
                          children: <Widget>[
                            for (final NotifyAction a in actions)
                              Expanded(
                                child: Padding(
                                  padding: const EdgeInsets.only(right: 8),
                                  child: FilledButton(
                                    onPressed: _model.busy ? null : () => _submit(a),
                                    child: Text(a.label),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    // 「想整段聊」的出口。§4.4 的「一步完成」说的是拍板那条路；
                    // 这一枚同时把意图在服务端收口（不另建状态），所以它不算
                    // 第二次要求用户做什么。
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: _model.busy ? null : _model.openChat,
                        child: const Text("打开对话"),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  static String _inputHint(List<NotifyAction> actions) {
    for (final NotifyAction a in actions) {
      if (a.needsInput) return a.inputLabel ?? "回一句";
    }
    return "回一句";
  }

  Widget _statusLine(BuildContext context, ColorScheme cs) {
    if (_model.phase == DecisionPhase.sending) {
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary),
            ),
            const SizedBox(width: 8),
            Text("处理中…", style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      );
    }
    final String text = _model.message.trim();
    if (text.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(
        text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: _model.ok ? cs.primary : cs.error,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}
