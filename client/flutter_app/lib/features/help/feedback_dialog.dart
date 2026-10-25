import "package:flutter/material.dart";

import "../../core/services/feedback_api.dart";

/// 用户菜单「反馈」弹窗 —— 轻量吐槽/建议入口,替代原全屏反馈页。
///
/// 分区（弹窗内 tab 切换,不再跳页）:
///  - 写反馈:类型 chips + 吐槽正文（标题自动取正文首行） + 联系方式（选填）
///  - 我的反馈:已提交记录与处理状态;管理员回复同时走站内信实时通知
///
/// 提交走控制面（POST /api/feedback,FeedbackApi）,管理员在后台流转状态。
class FeedbackDialog extends StatefulWidget {
  const FeedbackDialog({super.key, this.api});

  final FeedbackApi? api;

  /// 便捷入口:从任意 context 弹出反馈弹窗。
  static Future<void> show(BuildContext context, {FeedbackApi? api}) {
    return showDialog<void>(
      context: context,
      builder: (BuildContext _) => FeedbackDialog(api: api),
    );
  }

  @override
  State<FeedbackDialog> createState() => _FeedbackDialogState();
}

enum _FeedbackTab { write, history }

class _FeedbackDialogState extends State<FeedbackDialog> {
  late final FeedbackApi _api;

  _FeedbackTab _tab = _FeedbackTab.write;

  final TextEditingController _contentCtrl = TextEditingController();
  final TextEditingController _contactCtrl = TextEditingController();

  String _type = "bug";
  bool _submitting = false;

  bool _loadingHistory = true;
  List<FeedbackRecord> _history = const <FeedbackRecord>[];

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? FeedbackApi();
    _reloadHistory();
  }

  @override
  void dispose() {
    _contentCtrl.dispose();
    _contactCtrl.dispose();
    super.dispose();
  }

  Future<void> _reloadHistory() async {
    final FeedbackResult<List<FeedbackRecord>> res = await _api.listMine();
    if (!mounted) return;
    setState(() {
      _loadingHistory = false;
      _history = res.value ?? const <FeedbackRecord>[];
    });
  }

  /// 服务端要求标题 1–80 字;吐槽场景不单独设标题输入框,
  /// 自动取正文首行（截到 60 字）当标题。
  String _deriveTitle(String content) {
    final String firstLine =
        content.trim().split("\n").first.trim();
    final String source = firstLine.isEmpty ? content.trim() : firstLine;
    final List<String> chars = source.characters.toList();
    return chars.length > 60 ? chars.take(60).join() : source;
  }

  Future<void> _submit() async {
    final String content = _contentCtrl.text.trim();
    if (content.isEmpty) {
      _toast("写点什么再提交吧");
      return;
    }
    setState(() => _submitting = true);
    final FeedbackResult<FeedbackRecord> res = await _api.submit(
      type: _type,
      title: _deriveTitle(content),
      description: content,
      contact: _contactCtrl.text.trim(),
    );
    if (!mounted) return;
    setState(() => _submitting = false);
    if (res.ok) {
      Navigator.of(context).pop();
      _toast("已提交，感谢反馈");
    } else {
      _toast(res.error ?? "提交失败，请检查服务连接");
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  Color _statusColor(String status) {
    return switch (status) {
      "open" => Colors.orange,
      "processing" => Colors.blue,
      "resolved" => Colors.green,
      _ => Colors.grey,
    };
  }

  String get _contentHint => switch (_type) {
        "bug" => "哪里不爽？操作步骤、预期/实际表现，想到什么写什么…",
        "suggestion" => "想要什么？说说你期望的样子和使用场景…",
        _ => "想说什么都可以…",
      };

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final TextTheme te = Theme.of(context).textTheme;

    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // —— 头部:标题 + 关闭 ——
              Row(
                children: <Widget>[
                  Text("反馈", style: te.titleMedium),
                  const SizedBox(width: 8),
                  Text(
                    "吐槽、报障、提建议都行",
                    style: te.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  const Spacer(),
                  _CloseButton(onTap: () => Navigator.of(context).pop()),
                ],
              ),
              const SizedBox(height: 12),
              // —— 分区切换 ——
              _TabToggle(
                current: _tab,
                onSelect: (_FeedbackTab t) => setState(() => _tab = t),
              ),
              const SizedBox(height: 14),
              if (_tab == _FeedbackTab.write)
                _buildWriteForm()
              else
                _buildHistoryTab(te, cs),
            ],
          ),
        ),
      ),
    );
  }

  // —— 写反馈 ——

  Widget _buildWriteForm() {
    return Flexible(
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Wrap(
              spacing: 8,
              children: <String>["bug", "suggestion", "other"]
                  .map(
                    (String type) => ChoiceChip(
                      label: Text(switch (type) {
                        "bug" => "吐槽",
                        "suggestion" => "功能建议",
                        _ => "其他",
                      }),
                      selected: _type == type,
                      onSelected: (bool selected) {
                        if (selected) setState(() => _type = type);
                      },
                    ),
                  )
                  .toList(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contentCtrl,
              autofocus: true,
              maxLength: 4000,
              minLines: 4,
              maxLines: 8,
              decoration: InputDecoration(
                hintText: _contentHint,
                border: const OutlineInputBorder(),
                counterText: "",
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _contactCtrl,
              maxLength: 120,
              decoration: const InputDecoration(
                labelText: "联系方式（选填）",
                hintText: "方便我们跟进时找到你",
                border: OutlineInputBorder(),
                counterText: "",
              ),
            ),
            const SizedBox(height: 4),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text("提交"),
            ),
          ],
        ),
      ),
    );
  }

  // —— 我的反馈 ——

  Widget _buildHistoryTab(TextTheme te, ColorScheme cs) {
    return Flexible(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 380),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text("已提交 ${_history.length} 条",
                    style: te.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
                const Spacer(),
                IconButton(
                  onPressed: _reloadHistory,
                  icon: const Icon(Icons.refresh, size: 18),
                  tooltip: "刷新",
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Expanded(
              child: _loadingHistory
                  ? const Center(child: CircularProgressIndicator())
                  : _history.isEmpty
                      ? Center(
                          child: Text(
                            "还没有提交过反馈",
                            style: te.bodySmall
                                ?.copyWith(color: cs.onSurfaceVariant),
                          ),
                        )
                      : ListView.separated(
                          shrinkWrap: true,
                          padding: EdgeInsets.zero,
                          itemCount: _history.length,
                          separatorBuilder: (BuildContext _, int __) => Divider(
                            height: 1,
                            thickness: 1,
                            color: cs.outline.withValues(alpha: 0.15),
                          ),
                          itemBuilder: (BuildContext _, int index) =>
                              _buildHistoryTile(_history[index]),
                        ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHistoryTile(FeedbackRecord record) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        dense: true,
        title: Text(
          record.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        subtitle: Text(
          "${record.typeLabel} · "
          "${record.createdAt?.toLocal().toString().split(".").first ?? ""}",
          style: Theme.of(context).textTheme.bodySmall,
        ),
        trailing: Chip(
          label: Text(
            record.statusLabel,
            style: TextStyle(
              fontSize: 12,
              color: _statusColor(record.status),
            ),
          ),
          visualDensity: VisualDensity.compact,
          side: BorderSide(color: _statusColor(record.status)),
          backgroundColor: Colors.transparent,
        ),
        children: <Widget>[
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  SelectableText(record.description),
                  if (record.replyNote != null && record.replyNote!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color:
                              cs.surfaceContainerHighest.withValues(alpha: 0.5),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: SelectableText(
                          "管理员回复：${record.replyNote}",
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 弹窗右上角关闭按钮（无描边,hover 有底色反馈）。
class _CloseButton extends StatefulWidget {
  const _CloseButton({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_CloseButton> createState() => _CloseButtonState();
}

class _CloseButtonState extends State<_CloseButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) {
        if (mounted) setState(() => _hovering = true);
      },
      onExit: (_) {
        if (mounted) setState(() => _hovering = false);
      },
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            color: _hovering
                ? cs.surfaceContainerHighest.withValues(alpha: 0.6)
                : Colors.transparent,
            shape: BoxShape.circle,
          ),
          child: Icon(
            Icons.close_rounded,
            size: 16,
            color: cs.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// 「写反馈 / 我的反馈」分段切换（紧凑版 segmented control）。
class _TabToggle extends StatelessWidget {
  const _TabToggle({required this.current, required this.onSelect});

  final _FeedbackTab current;
  final ValueChanged<_FeedbackTab> onSelect;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        height: 30,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _segment(context, "写反馈", _FeedbackTab.write),
            _segment(context, "我的反馈", _FeedbackTab.history),
          ],
        ),
      ),
    );
  }

  Widget _segment(BuildContext context, String label, _FeedbackTab tab) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final bool active = current == tab;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onSelect(tab),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: active ? cs.surface : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: active ? FontWeight.w600 : FontWeight.w400,
              color: active ? cs.onSurface : cs.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}
