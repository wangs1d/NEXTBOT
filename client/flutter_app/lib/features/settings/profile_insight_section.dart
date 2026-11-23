import "package:flutter/material.dart";

import "../../core/services/client_telemetry.dart";
import "../../core/services/profile_manage_api.dart";

/// 「它眼里的你」（2026-09-30 起挂在 Agent 主页，原设置页分区）：
/// Agent 对用户的画像/理解/事实三层的只读概览 + 画像行级纠错（改/删）。
/// 黑白极简：无彩色徽标；空分区不渲染；行级操作收进右键菜单。
class ProfileInsightSection extends StatefulWidget {
  const ProfileInsightSection({super.key});

  @override
  State<ProfileInsightSection> createState() => _ProfileInsightSectionState();
}

class _ProfileInsightSectionState extends State<ProfileInsightSection> {
  final ProfileManageApi _api = ProfileManageApi();
  ProfileManageData? _data;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    // §12.1：资料库打开率——「它眼里的你」被翻过几次
    ClientEventTelemetry.track("profile_viewed");
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final ProfileManageData? data = await _api.fetch();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (data == null) {
        _error = "读不到画像（检查与服务端的连接）";
      } else {
        _data = data;
      }
    });
  }

  Future<void> _deleteLine(ProfileSectionData section, ProfileLineData line) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("删除这条画像？"),
        content: Text("「${line.text}」\n\n删除后，之后的对话里它不会再出现（对话原文仍保留）。"),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("删除")),
        ],
      ),
    );
    if (confirmed != true) return;
    final String? markdown =
        await _api.mutateLine(op: "DELETE", section: section.key, match: line.text);
    if (!mounted) return;
    if (markdown == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("删除失败，请重试")));
      return;
    }
    ClientEventTelemetry.track(
      "profile_item_deleted",
      props: <String, Object>{"section": section.key},
    );
    await _reload();
  }

  Future<void> _editLine(ProfileSectionData section, ProfileLineData line) async {
    final TextEditingController controller = TextEditingController(text: line.text);
    final String? newValue = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: const Text("修改这条画像"),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 2,
          decoration: const InputDecoration(hintText: "改成什么？"),
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
          TextButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text("保存"),
          ),
        ],
      ),
    );
    if (newValue == null || newValue.isEmpty || newValue == line.text) return;
    final String? markdown = await _api.mutateLine(
      op: "UPDATE",
      section: section.key,
      line: newValue,
      match: line.text,
    );
    if (!mounted) return;
    if (markdown == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("修改失败，请重试")));
      return;
    }
    ClientEventTelemetry.track(
      "profile_item_edited",
      props: <String, Object>{"section": section.key, "op": "update"},
    );
    await _reload();
  }

  Future<void> _addLine(ProfileSectionData section) async {
    final TextEditingController controller = TextEditingController();
    final String? newValue = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: Text("在「${section.title}」加一条"),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 2,
          decoration: const InputDecoration(hintText: "例如：称呼：老周"),
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
          TextButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text("添加"),
          ),
        ],
      ),
    );
    if (newValue == null || newValue.isEmpty) return;
    final String? markdown =
        await _api.mutateLine(op: "ADD", section: section.key, line: newValue);
    if (!mounted) return;
    if (markdown == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("添加失败（可能已存在同条）")));
      return;
    }
    ClientEventTelemetry.track(
      "profile_item_edited",
      props: <String, Object>{"section": section.key, "op": "add"},
    );
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final TextTheme te = Theme.of(context).textTheme;
    final ColorScheme cs = Theme.of(context).colorScheme;
    // 组标识：让这几张卡在主页里可被认出是「它眼中的你」，
    // 并交代隐藏交互（右键纠错）。
    final Widget groupHeader = Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text("它眼里的你", style: te.titleSmall?.copyWith(fontWeight: FontWeight.w700, letterSpacing: 0.5)),
          const SizedBox(height: 2),
          Text(
            "随对话自动更新 · 右键一条可改/删",
            style: te.bodySmall?.copyWith(color: cs.onSurfaceVariant.withValues(alpha: 0.8)),
          ),
        ],
      ),
    );

    if (_loading) {
      return groupHeader;
    }
    if (_error != null || _data == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          groupHeader,
          _QuietCard(
            child: Row(
              children: <Widget>[
                Expanded(child: Text(_error ?? "暂无数据", style: te.bodySmall)),
                TextButton(onPressed: _reload, child: const Text("重试")),
              ],
            ),
          ),
        ],
      );
    }
    final ProfileManageData data = _data!;

    // 只渲染有内容的分区：空分区整卡不出（要加也先得有第一条——
    // 在对话里说，或用下面「加一条」入口）。
    final List<ProfileSectionData> visibleSections = <ProfileSectionData>[
      for (final ProfileSectionData s in data.sections)
        if (s.realLines.isNotEmpty) s,
    ];
    final bool empty = visibleSections.isEmpty && data.understandings.isEmpty && data.facts.isEmpty;
    if (empty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          groupHeader,
          _QuietCard(
            child: Text(
              "它还在了解你——多聊聊，画像会自动长出来；也可以直接告诉它几件事（比如怎么称呼你）。",
              style: te.bodySmall?.copyWith(color: cs.onSurfaceVariant, height: 1.6),
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        groupHeader,
        // ── 画像分区（右键改/删；标题右侧「加一条」） ──
        for (final ProfileSectionData section in visibleSections) ...<Widget>[
          _QuietCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      section.title,
                      style: te.labelLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.4,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    const Spacer(),
                    _AddLineButton(section: section, onAdd: _addLine),
                  ],
                ),
                const SizedBox(height: 6),
                for (final ProfileLineData line in section.realLines)
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onSecondaryTapUp: (TapUpDetails d) =>
                        _showLineMenuAt(section, line, d.globalPosition),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text(
                        line.text,
                        style: te.bodyMedium?.copyWith(height: 1.5),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        // ── 理解 / 事实（只读，随对话演进） ──
        if (data.understandings.isNotEmpty || data.facts.isNotEmpty)
          _QuietCard(
            child: Theme(
              data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                title: Text(
                  "理解与事实（随对话自动演进）",
                  style: te.labelLarge?.copyWith(
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                    color: cs.onSurfaceVariant,
                  ),
                ),
                children: <Widget>[
                  for (final u in data.understandings)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text(
                        "· ${u.topic}（${u.kind}）：${u.note}",
                        style: te.bodySmall?.copyWith(height: 1.5),
                      ),
                    ),
                  for (final f in data.facts)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text("· ${f.field}：${f.value}", style: te.bodySmall?.copyWith(height: 1.5)),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  void _showLineMenuAt(
    ProfileSectionData section,
    ProfileLineData line,
    Offset globalPos,
  ) {
    showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(globalPos.dx, globalPos.dy, globalPos.dx, globalPos.dy),
      items: const <PopupMenuEntry<String>>[
        PopupMenuItem(value: "edit", height: 40, child: Text("修改这条")),
        PopupMenuItem(value: "delete", height: 40, child: Text("删除这条")),
      ],
    ).then((String? action) {
      if (action == "edit") _editLine(section, line);
      if (action == "delete") _deleteLine(section, line);
    });
  }
}

/// 「加一条」入口：默认只显一个细加号，hover/触摸后显文字。
class _AddLineButton extends StatefulWidget {
  const _AddLineButton({required this.section, required this.onAdd});

  final ProfileSectionData section;
  final Future<void> Function(ProfileSectionData section) onAdd;

  @override
  State<_AddLineButton> createState() => _AddLineButtonState();
}

class _AddLineButtonState extends State<_AddLineButton> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => widget.onAdd(widget.section),
      onHover: (bool h) => setState(() => _hovering = h),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.add, size: 15, color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
            if (_hovering) ...<Widget>[
              const SizedBox(width: 2),
              Text(
                "加一条",
                style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant.withValues(alpha: 0.9)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 全站统一容器：低面层 + 细边框 + 14 圆角（与主页其他区块同一语言）。
class _QuietCard extends StatelessWidget {
  const _QuietCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
      ),
      child: child,
    );
  }
}
