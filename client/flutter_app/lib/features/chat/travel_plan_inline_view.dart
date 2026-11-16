part of "travel_plan_archive.dart";

// 内联视图与桌面规划页同库，直接复用私有阶段卡模型/组件。
// ignore_for_file: library_private_types_in_public_api

// ═══════════════════════════════════════════════════════════════════
// 手机端「聊天内联规划流」（2026-11-14）
//
// 与桌面规划页共用 TravelPlanFlowController（同一份 plan-session 状态机）
// 和 _buildPlanFlowItem（同一套阶段卡渲染），只是把外层从「整页 + 玻璃气泡」
// 换成「聊天流末尾的一段内联卡片」：
//   - 不推路由、不打开 TravelPlanArchivePage；
//   - 聊天输入框继续复用（由 MobileChatController 把文本转进 controller）；
//   - 生成的最终行程卡点「查看完整行程」才打开行程详情页。
// ═══════════════════════════════════════════════════════════════════

/// 卡片类流条目（整个规划流程只把最后一张放进卡位）。
bool _isPlanCardKind(_FlowKind kind) =>
    kind == _FlowKind.choice ||
    kind == _FlowKind.guide ||
    kind == _FlowKind.wishlist ||
    kind == _FlowKind.budget ||
    kind == _FlowKind.draft;

/// 分段筛选卡的说明文案：单段卡按段写，兼容多段合卡的旧口径。
String _planGuideStageDesc(_GuideCardData card) {
  if (card.cats.any((_GuideCatData c) => c.key == "view")) {
    return "点卡片右上角就是选它；想去的没在列表里，下一步可以自己补。";
  }
  final String key = card.cats.length == 1 ? card.cats.first.key : "";
  return switch (key) {
    "stay" => "点一行就是选它；没合适的后面可以自己补。",
    _ => "点一行就是选它；想去的没在列表里，下一步可以自己补。",
  };
}

/// 单个规划流条目 → widget（桌面规划页 / 手机聊天内联共用）。
Widget _buildPlanFlowItem({
  required BuildContext context,
  required _FlowItem item,
  required _StageColors c,
  required TravelPlanFlowController ctrl,
  required String agentLabel,
  required Future<void> Function(_DraftData draft) onOpenDraft,
  required void Function(_GuideItemData entry, String catLabel, int index)
      onGuidePreview,
  required void Function(String example) onAdjust,
}) {
  switch (item.kind) {
    case _FlowKind.user:
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.only(bottom: 16),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          constraints: const BoxConstraints(maxWidth: 420),
          decoration: BoxDecoration(
            color: c.accentSoft,
            border: Border.all(color: c.borderSoft),
            borderRadius: BorderRadius.circular(15),
          ),
          child: Text(item.text,
              style: TextStyle(fontSize: 13.5, height: 1.6, color: c.text)),
        ),
      );
    case _FlowKind.say:
    case _FlowKind.error:
      final bool isError = item.kind == _FlowKind.error;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: c.card,
            border: Border.all(
                color: isError ? c.orange.withValues(alpha: 0.45) : c.borderSoft),
            borderRadius: BorderRadius.circular(15),
          ),
          child: Text(
            item.text,
            style: TextStyle(
              fontSize: 13.5,
              height: 1.65,
              color: isError ? c.orange : c.text,
            ),
          ),
        ),
      );
    case _FlowKind.typing:
      return _AgentBlock(name: agentLabel, colors: c, child: _TypingDots(colors: c));
    case _FlowKind.weather:
      final _WeatherCardData card = item.weather!;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: _StageCardShell(
          colors: c,
          icon: Icons.wb_sunny_outlined,
          stage: card.title.isEmpty ? "目的地天气" : card.title,
          trailing: card.sub.isEmpty
              ? null
              : Text(card.sub, style: TextStyle(fontSize: 10.5, color: c.muted)),
          child: _WeatherPanel(card: card, colors: c),
        ),
      );
    case _FlowKind.choice:
      final _ChoiceCardData card = item.choice!;
      final _CardProgress? progress = card.progress;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: _StageCardShell(
          colors: c,
          icon: _stageIcon(card.id),
          stage: card.stage.isNotEmpty ? card.stage : "行程偏好",
          trailing: progress != null && progress.total > 0
              ? _StageTrailing(
                  text: "已确认 ${progress.done}/${progress.total}",
                  colors: c,
                )
              : null,
          lead: card.title.isEmpty ? null : card.title,
          desc: card.infer.isNotEmpty
              ? "选了同行人，节奏我替你定；不合适点「改」。"
              : card.multi
                  ? "可以多选，选完按「就这些」。"
                  : card.allowNote
                      ? "点一个就好，也可以直接写。"
                      : null,
          child: _ChoiceCard(
            card: card,
            colors: c,
            enabled: !ctrl.busy,
            onConfirm: (List<String> values, String? note) =>
                ctrl.sendChoice(item, card, values, note),
          ),
        ),
      );
    case _FlowKind.guide:
      final _GuideCardData card = item.guide!;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: _StageCardShell(
          colors: c,
          icon: Icons.explore_outlined,
          stage: card.stage.isEmpty ? "挑一挑" : card.stage,
          lead: card.title.isEmpty ? "这三天想给${card.destination}留哪些地方？" : card.title,
          desc: _planGuideStageDesc(card),
          child: _GuideSelectCard(
            card: card,
            colors: c,
            enabled: !ctrl.busy,
            onConfirm: () => ctrl.submitGuide(item, card),
            onDelegate: () => ctrl.submitGuide(item, card, delegate: true),
            onPreview: onGuidePreview,
          ),
        ),
      );
    case _FlowKind.wishlist:
      final _WishlistCardData card = item.wishlist!;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: _StageCardShell(
          colors: c,
          icon: Icons.playlist_add_outlined,
          stage: card.stage.isEmpty ? "再补一句" : card.stage,
          trailing: _StageTrailing(text: "可跳过", colors: c),
          lead: card.title,
          desc: card.sub.isEmpty ? "写名字就行，几个用顿号隔开；没有就跳过。" : card.sub,
          child: _WishlistAddCard(
            card: card,
            colors: c,
            enabled: !ctrl.busy,
            onSubmit: (Map<String, List<String>> extras, String note) =>
                ctrl.submitExtras(item, extras, note),
          ),
        ),
      );
    case _FlowKind.budget:
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: _StageCardShell(
          colors: c,
          icon: Icons.receipt_long_outlined,
          stage: "预算确认",
          lead: "确认这版预算，我就按它出方案",
          child: _BudgetCard(
            budget: item.budget!,
            colors: c,
            enabled: !ctrl.busy,
            onApprove: ctrl.approve,
            onAdjust: () => onAdjust("住宿换民宿、预算再省一点"),
          ),
        ),
      );
    case _FlowKind.draft:
      final _DraftData draft = item.draft!;
      return _AgentBlock(
        name: agentLabel,
        colors: c,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Align(
              alignment: Alignment.centerLeft,
              child: _DraftCard(
                draft: draft,
                colors: c,
                enabled: !ctrl.busy,
                onGenerate: () => onOpenDraft(draft),
                onAdjust: () => onAdjust("第二天想去都江堰"),
              ),
            ),
            if (draft.days.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: _DraftDetailCard(draft: draft, colors: c),
              ),
            ],
          ],
        ),
      );
  }
}

/// 手机聊天流末尾的内联规划视图（不推路由）。
class TravelPlanInlineFlowView extends StatelessWidget {
  const TravelPlanInlineFlowView({
    super.key,
    required this.controller,
    required this.agentName,
    required this.onOpenPlan,
    required this.onClose,
    required this.onFocusComposer,
  });

  final TravelPlanFlowController controller;
  final String agentName;
  final Future<void> Function(String planId) onOpenPlan;
  final VoidCallback onClose;

  /// 预算/草案卡「再调整」：聚焦聊天输入框，让用户直接说话改。
  final VoidCallback onFocusComposer;

  String get _agentLabel => agentName.trim();

  @override
  Widget build(BuildContext context) {
    final _StageColors c = _StageColors.of(context);
    final List<_FlowItem> flow = controller.flow;
    int cardIndex = -1;
    for (int i = flow.length - 1; i >= 0; i--) {
      if (_isPlanCardKind(flow[i].kind)) {
        cardIndex = i;
        break;
      }
    }
    // 卡前 / 卡后文本分开：卡后的天气卡要落在最终方案下面。
    final List<_FlowItem> before = <_FlowItem>[];
    final List<_FlowItem> after = <_FlowItem>[];
    for (int i = 0; i < flow.length; i++) {
      if (_isPlanCardKind(flow[i].kind)) continue;
      if (cardIndex >= 0 && i > cardIndex) {
        after.add(flow[i]);
      } else {
        before.add(flow[i]);
      }
    }
    final _FlowItem? card = cardIndex < 0 ? null : flow[cardIndex];
    final double maxWidth =
        (MediaQuery.sizeOf(context).width - 28).clamp(240.0, 600.0);

    Widget buildItem(_FlowItem item) => _buildPlanFlowItem(
          context: context,
          item: item,
          c: c,
          ctrl: controller,
          agentLabel: _agentLabel,
          onOpenDraft: (_DraftData draft) async {
            if (draft.planId.isEmpty) return;
            await onOpenPlan(draft.planId);
          },
          onGuidePreview: (_, __, ___) {},
          onAdjust: (String example) {
            onFocusComposer();
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(
                _agentLabel.isEmpty
                    ? "在输入框说想改哪里，比如：$example"
                    : "告诉 $_agentLabel 想改哪里，比如：$example",
                style: const TextStyle(fontSize: 12),
              ),
              behavior: SnackBarBehavior.floating,
              duration: const Duration(seconds: 2),
            ));
          },
        );

    return SelectionContainer.disabled(
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          width: maxWidth,
          margin: const EdgeInsets.only(top: 4, bottom: 10),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
          decoration: BoxDecoration(
            color: c.card.withValues(alpha: 0.96),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: c.borderSoft),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // 顶部状态条：一眼看出还在规划 / 已出方案，随时可结束。
              Row(
                children: <Widget>[
                  Icon(Icons.route_outlined, size: 14, color: c.accent),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      controller.completed ? "行程规划 · 已完成" : "行程规划 · 进行中",
                      style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w700,
                        color: c.text2,
                      ),
                    ),
                  ),
                  InkWell(
                    onTap: onClose,
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      child: Text(
                        "结束规划",
                        style: TextStyle(fontSize: 11, color: c.muted),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              for (final _FlowItem item in before) buildItem(item),
              if (card != null)
                AnimatedSize(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeOutCubic,
                  alignment: Alignment.topCenter,
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 260),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeInCubic,
                    child: KeyedSubtree(
                      key: ValueKey<String>("plan-card-${card.seq}"),
                      child: buildItem(card),
                    ),
                  ),
                ),
              for (final _FlowItem item in after) buildItem(item),
            ],
          ),
        ),
      ),
    );
  }
}
