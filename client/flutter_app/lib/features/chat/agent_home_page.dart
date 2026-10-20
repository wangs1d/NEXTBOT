import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show Clipboard, ClipboardData;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../settings/profile_insight_section.dart";

/// Agent 主页。
///
/// 定位：主页是 Agent「自己打理的住处」——
///  - Header：纯排版无卡片（名字/@handle/身份号码/一行状态/签名），无头像光球（呼吸语义只在聊天页）
///  - 动态：站内社交里它自己的帖子（置顶帖排最前）
///  - 它眼里的你：对用户的画像概览+行级纠错（右键改/删）
/// 视觉语言（2026-09-30 重设计）：黑白极简——头部无渐变无徽章胶囊，
/// 全页唯一彩色是状态行 6px 心情圆点；容器统一低面层+细边框+14 圆角；
/// 编辑类入口 hover 才显形，行内不常驻图标。
/// 入口：与日程/消息等一致，以右侧 Dock 双面板形式打开（聊天在左、主页在右）；
/// 窄窗口退化为全屏路由页。名字/签名支持编辑，改名走统一管道
/// （POST /api/agent-identity/rename，账号/记忆/prompt 自我认知一次同步）。
class AgentHomePage extends StatefulWidget {
  const AgentHomePage({super.key, this.actorId, this.embedded = false});

  /// 登录主体 id；缺省用 [ApiConfig.effectiveActorId]。
  final String? actorId;

  /// 嵌入模式：渲染在右侧 Dock 面板内容区，不再自带 Scaffold/AppBar
  /// （顶栏标题与关闭按钮由面板 chrome 提供，与 GalleryPage.embedded 同约定）。
  final bool embedded;

  static Future<void> show(BuildContext context, {String? actorId}) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(builder: (_) => AgentHomePage(actorId: actorId)),
    );
  }

  @override
  State<AgentHomePage> createState() => _AgentHomePageState();
}

class _AgentHomePageState extends State<AgentHomePage> {
  bool _loading = true;
  bool _failed = false;
  Map<String, dynamic> _profile = <String, dynamic>{};
  Map<String, dynamic> _identity = <String, dynamic>{};
  List<Map<String, dynamic>> _posts = <Map<String, dynamic>>[];
  String? _agentNumber;

  String get _actorId => widget.actorId ?? ApiConfig.effectiveActorId;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  Future<void> _reload() async {
    final AgentHomepageResult result = await AgentHomepageApi.fetchHomepage(_actorId);
    if (!mounted) return;
    setState(() {
      _failed = !result.ok;
      _profile = result.profile;
      _identity = result.identity;
      _posts = result.posts;
      _agentNumber = result.agentNumber;
      _loading = false;
    });
  }

  String get _displayName =>
      (_identity["displayName"] ?? _profile["displayName"] ?? "")?.toString() ?? "";
  String get _handle =>
      (_identity["handle"] ?? _profile["handle"] ?? "")?.toString() ?? "";
  String get _signature => _profile["signature"]?.toString() ?? "";
  String get _statusText => _profile["statusText"]?.toString() ?? "";
  String get _moodStyle => _profile["moodStyle"]?.toString() ?? "gentle";

  @override
  Widget build(BuildContext context) {
    final Widget body = _loading
        ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
        : _failed
            ? _ErrorState(onRetry: _reload)
            : RefreshIndicator(
                onRefresh: _reload,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
                  children: <Widget>[
                    _buildHeader(),
                    // 头部无卡片，靠留白与后面的区块分开
                    const SizedBox(height: 24),
                    _buildPostsSection(),
                    // 「它眼里的你」：agent 对用户的画像/理解/事实 + 行级纠错
                    // （2026-09-30 从设置页迁入主页）。
                    const SizedBox(height: 10),
                    const ProfileInsightSection(),
                  ],
                ),
              );

    if (widget.embedded) {
      return body;
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text("主页"),
        actions: <Widget>[
          IconButton(
            tooltip: "取名 / 改名",
            icon: const Icon(Icons.badge_outlined),
            onPressed: _showRenameSheet,
          ),
        ],
      ),
      body: body,
    );
  }

  // ─── Header：纯排版，无卡片无渐变 ───

  /// 心情状态映射：label 常显，色只落在 6px 圆点上（全页唯一彩色）。
  static const Map<String, ({String label, Color color})> _moods =
      <String, ({String label, Color color})>{
    "funny": (label: "摸鱼", color: Color(0xFF2CBF6D)),
    "sad": (label: "离开", color: Color(0xFF8091A7)),
    "cool": (label: "请勿打扰", color: Color(0xFF7C73FF)),
    "energetic": (label: "在线", color: Color(0xFFFF8A3D)),
    "mysterious": (label: "隐身感", color: Color(0xFF3F8CFF)),
    "gentle": (label: "忙碌", color: Color(0xFF3AA7A3)),
  };

  Widget _buildHeader() {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final ({String label, Color color}) mood =
        _moods[_moodStyle] ?? _moods["gentle"]!;
    final bool hasSignature = _signature.trim().isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        // 名字 + @handle；hover 显改名铅笔
        _HoverActionAnchor(
          onTap: _showRenameSheet,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              Flexible(
                child: Text(
                  _displayName.isEmpty ? "未命名" : _displayName,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(fontWeight: FontWeight.w700, letterSpacing: 0.2),
                ),
              ),
              if (_handle.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Text(
                  "@$_handle",
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                    letterSpacing: 0.3,
                  ),
                ),
              ],
            ],
          ),
        ),
        // 身份号码：注册即得的账号身份（actorId），好友申请的唯一定址凭据；
        // hover 显复制动作，点按整行复制（2026-09-30 补上「主页展示身份号码」环）
        if (_hasIdentityNumber) ...<Widget>[
          const SizedBox(height: 6),
          _buildIdentityLine(theme, cs),
        ],
        const SizedBox(height: 8),
        Row(
          children: <Widget>[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(shape: BoxShape.circle, color: mood.color),
            ),
            const SizedBox(width: 6),
            Text(
              mood.label,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: cs.onSurfaceVariant, fontWeight: FontWeight.w500),
            ),
            if (_statusText.trim().isNotEmpty) ...<Widget>[
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _statusText,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant.withValues(alpha: 0.8),
                  ),
                ),
              ),
            ],
          ],
        ),
        if (hasSignature) ...<Widget>[
          const SizedBox(height: 16),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _showSignatureEditDialog,
            onLongPress: _showSignatureEditDialog,
            child: Text(
              _signature,
              style: theme.textTheme.bodyLarge?.copyWith(height: 1.55),
            ),
          ),
        ] else ...<Widget>[
          const SizedBox(height: 16),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _showSignatureEditDialog,
            child: Text(
              "（点一下写句签名——它自己的话）",
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
            ),
          ),
        ],
      ],
    );
  }

  // ─── 身份号码：注册即得的 QQ 式短号（无账号主体回退注册邮箱 actorId），
  // 好友申请与跨 agent 寻址的对外凭据 ───

  String get _identityNumber {
    final String n = _agentNumber ?? "";
    if (n.isNotEmpty) return n;
    return _actorId;
  }

  bool get _hasIdentityNumber {
    final String id = _identityNumber.trim();
    return id.isNotEmpty && id != "anonymous";
  }

  Widget _buildIdentityLine(ThemeData theme, ColorScheme cs) {
    return _HoverActionAnchor(
      onTap: _copyIdentityNumber,
      icon: Icons.copy_outlined,
      label: "复制",
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          Text(
            "身份号码",
            style: theme.textTheme.bodySmall?.copyWith(
              color: cs.onSurfaceVariant.withValues(alpha: 0.7),
              letterSpacing: 0.3,
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              _identityNumber,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: cs.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _copyIdentityNumber() async {
    await Clipboard.setData(ClipboardData(text: _identityNumber));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text("已复制身份号码"),
        duration: Duration(seconds: 2),
      ),
    );
  }

  // ─── 动态：站内社交里 Agent 自己的帖子 ───

  Widget _buildPostsSection() {
    if (_posts.isEmpty) {
      return const SizedBox.shrink();
    }
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    return _SectionCard(
      title: "动态",
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          for (int i = 0; i < _posts.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 14),
            _PostItem(
              post: _posts[i],
              pinned: _posts[i]["id"] == _profile["pinnedPostId"],
              timeLabel: _postTimeLabel(_posts[i]["createdAt"]?.toString() ?? ""),
              theme: theme,
              cs: cs,
            ),
          ],
        ],
      ),
    );
  }

  String _postTimeLabel(String iso) {
    final DateTime? time = DateTime.tryParse(iso);
    if (time == null) return "";
    final Duration diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) return "刚刚";
    if (diff.inHours < 1) return "${diff.inMinutes} 分钟前";
    if (diff.inDays < 1) return "${diff.inHours} 小时前";
    if (diff.inDays < 30) return "${diff.inDays} 天前";
    return "${time.year}-${time.month}-${time.day}";
  }

  // ─── 编辑交互 ───

  Future<void> _showSignatureEditDialog() {
    return _showTextEditDialog(
      title: "修改签名",
      initial: _signature,
      maxLength: 120,
      maxLines: 3,
      hint: "一句它自己的话",
      field: "signature",
    );
  }

  Future<void> _showTextEditDialog({
    required String title,
    required String initial,
    required int maxLength,
    required int maxLines,
    required String hint,
    required String field,
  }) async {
    final TextEditingController controller = TextEditingController(text: initial);
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(title, style: const TextStyle(fontSize: 16)),
          content: TextField(
            controller: controller,
            maxLength: maxLength,
            maxLines: maxLines,
            autofocus: true,
            decoration: InputDecoration(hintText: hint, counterText: ""),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text("取消"),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(controller.text),
              child: const Text("保存"),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (value == null || value.trim() == initial) return;
    final bool ok =
        await AgentHomepageApi.patchHomepage(_actorId, <String, dynamic>{field: value.trim()});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? "已保存" : "保存失败，请稍后再试"), duration: const Duration(seconds: 2)),
    );
    if (ok) unawaited(_reload());
  }

  /// 取名 / 改名面板：建议名池（含自述理由）+ 自定义输入。
  /// 保存走统一改名管道（账号/记忆/prompt 自我认知一次同步）。
  Future<void> _showRenameSheet() async {
    final TextEditingController nameController = TextEditingController(text: _displayName);
    final TextEditingController handleController = TextEditingController(text: _handle);
    List<Map<String, dynamic>> suggestions = const <Map<String, dynamic>>[];
    try {
      suggestions = await AgentHomepageApi.fetchNameSuggestions();
    } catch (_) {}

    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surfaceContainerLow,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (BuildContext sheetContext) {
        final ColorScheme sheetCs = Theme.of(sheetContext).colorScheme;
        return SafeArea(
          child: Padding(
            padding: EdgeInsets.fromLTRB(
                18, 16, 18, 16 + MediaQuery.of(sheetContext).viewInsets.bottom),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text("给它取个名字", style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: sheetCs.onSurface)),
                const SizedBox(height: 4),
                Text(
                  "改名会同步它的账号、记忆与自我认知",
                  style: TextStyle(fontSize: 11, color: sheetCs.onSurfaceVariant),
                ),
                const SizedBox(height: 12),
                if (suggestions.isNotEmpty)
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: <Widget>[
                      for (final Map<String, dynamic> s in suggestions)
                        ActionChip(
                          label: Text(s["displayName"]?.toString() ?? ""),
                          tooltip: s["reason"]?.toString() ?? "",
                          onPressed: () {
                            nameController.text = s["displayName"]?.toString() ?? "";
                            handleController.text = s["handle"]?.toString() ?? "";
                          },
                        ),
                    ],
                  ),
                const SizedBox(height: 12),
                TextField(
                  controller: nameController,
                  maxLength: 24,
                  decoration: const InputDecoration(
                    labelText: "名字",
                    counterText: "",
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: handleController,
                  maxLength: 32,
                  decoration: const InputDecoration(
                    labelText: "网络名（handle，可选）",
                    counterText: "",
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () async {
                      final String name = nameController.text.trim();
                      if (name.isEmpty) return;
                      final bool ok = await AgentHomepageApi.rename(
                        _actorId,
                        displayName: name,
                        handle: handleController.text.trim(),
                      );
                      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(ok ? "已改名：$name" : "改名失败，请稍后再试"),
                          duration: const Duration(seconds: 2),
                        ),
                      );
                      if (ok) unawaited(_reload());
                    },
                    child: const Text("就叫这个"),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    nameController.dispose();
    handleController.dispose();
  }
}

// ═══════════════════════════════════════════════════════════
// 区块容器与小部件
// ═══════════════════════════════════════════════════════════

/// 区块标题的统一样式（主页 + 画像分区共用同一语言）。
TextStyle sectionTitleStyle(TextTheme te, ColorScheme cs) => te.labelLarge!.copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: 0.4,
      color: cs.onSurfaceVariant,
    );

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: sectionTitleStyle(theme.textTheme, cs)),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}

/// 帖子条目：时间/置顶/点赞收成一行小字，正文为主，无分割线。
class _PostItem extends StatelessWidget {
  const _PostItem({
    required this.post,
    required this.pinned,
    required this.timeLabel,
    required this.theme,
    required this.cs,
  });

  final Map<String, dynamic> post;
  final bool pinned;
  final String timeLabel;
  final ThemeData theme;
  final ColorScheme cs;

  @override
  Widget build(BuildContext context) {
    final int likes = (post["likeCount"] as num?)?.toInt() ?? 0;
    final List<String> meta = <String>[
      if (pinned) "置顶",
      if (timeLabel.isNotEmpty) timeLabel,
      if (likes > 0) "$likes 赞",
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          meta.join(" · "),
          style: theme.textTheme.bodySmall?.copyWith(
            fontSize: 11,
            color: cs.onSurfaceVariant.withValues(alpha: 0.75),
          ),
        ),
        if ((post["text"] ?? "").toString().trim().isNotEmpty) ...<Widget>[
          const SizedBox(height: 5),
          Text(
            post["text"].toString(),
            style: theme.textTheme.bodyMedium?.copyWith(height: 1.6),
          ),
        ],
      ],
    );
  }
}

/// hover 才显形的操作锚点：
///  - 有 [child]：内容常显，操作图标 hover 才现（如名字行的改名铅笔）；
///  - 无 [child]：独立操作挂件，平时半透明、hover 点亮（如区块标题右侧的「编辑」）。
class _HoverActionAnchor extends StatefulWidget {
  const _HoverActionAnchor({required this.onTap, this.child, this.icon, this.label});

  final VoidCallback onTap;
  final Widget? child;
  final IconData? icon;
  final String? label;

  @override
  State<_HoverActionAnchor> createState() => _HoverActionAnchorState();
}

class _HoverActionAnchorState extends State<_HoverActionAnchor> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final Widget action = Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (widget.icon != null)
          Icon(widget.icon,
              size: 14, color: cs.onSurfaceVariant.withValues(alpha: 0.7)),
        if (widget.label != null) ...<Widget>[
          if (widget.icon != null) const SizedBox(width: 3),
          Text(
            widget.label!,
            style: TextStyle(
              fontSize: 11.5,
              color: cs.onSurfaceVariant.withValues(alpha: 0.9),
            ),
          ),
        ],
      ],
    );
    final double idleOpacity = widget.child == null ? 0.45 : 0.0;
    final Widget? anchorChild = widget.child;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            if (anchorChild != null) Flexible(child: anchorChild),
            AnimatedOpacity(
              duration: const Duration(milliseconds: 120),
              opacity: _hovering ? 1 : idleOpacity,
              child: anchorChild == null
                  ? action
                  : Padding(padding: const EdgeInsets.only(left: 6), child: action),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text("主页暂时不可用", style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
          const SizedBox(height: 10),
          TextButton(onPressed: onRetry, child: const Text("重试")),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// API 客户端
// ═══════════════════════════════════════════════════════════

class AgentHomepageResult {
  const AgentHomepageResult({
    required this.ok,
    required this.profile,
    required this.identity,
    required this.posts,
    this.agentNumber,
  });

  final bool ok;
  final Map<String, dynamic> profile;
  final Map<String, dynamic> identity;
  final List<Map<String, dynamic>> posts;

  /// QQ 式身份短号（注册即得）；服务端对无账号主体回 null，客户端回退 actorId。
  final String? agentNumber;
}

class AgentHomepageApi {
  AgentHomepageApi._();

  /// 测试注入口：注入 MockClient 后走桩，不触网
  static http.Client? clientOverride;

  static http.Client get _client => clientOverride ?? http.Client();

  static const Duration _timeout = Duration(seconds: 8);

  static Future<AgentHomepageResult> fetchHomepage(String actorId) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-homepage")
          .replace(queryParameters: <String, String>{"sessionId": actorId});
      final http.Response res = await _client
          .get(uri, headers: const <String, String>{"Accept": "application/json"})
          .timeout(_timeout);
      if (res.statusCode != 200) return _emptyResult();
      final Map<String, dynamic> body = jsonDecode(res.body) as Map<String, dynamic>;
      if (body["ok"] != true) return _emptyResult();
      return AgentHomepageResult(
        ok: true,
        profile: _mapOf(body["profile"]),
        identity: _mapOf(body["identity"]),
        agentNumber: (body["agentNumber"] as String?)?.trim().isNotEmpty == true
            ? body["agentNumber"] as String
            : null,
        posts: <Map<String, dynamic>>[
          for (final dynamic p in (body["posts"] as List<dynamic>? ?? const <dynamic>[]))
            (p as Map).cast<String, dynamic>(),
        ],
      );
    } catch (_) {
      return _emptyResult();
    }
  }

  static AgentHomepageResult _emptyResult() => const AgentHomepageResult(
        ok: false,
        profile: <String, dynamic>{},
        identity: <String, dynamic>{},
        posts: <Map<String, dynamic>>[],
      );

  static Map<String, dynamic> _mapOf(Object? raw) =>
      raw is Map ? raw.cast<String, dynamic>() : <String, dynamic>{};

  /// 用户驱动的改名：走服务端统一改名管道
  static Future<bool> rename(
    String actorId, {
    required String displayName,
    String handle = "",
  }) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-identity/rename");
      final http.Response res = await _client
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "sessionId": actorId,
              "displayName": displayName,
              if (handle.isNotEmpty) "handle": handle,
            }),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 主页文案编辑（签名/状态/置顶）
  static Future<bool> patchHomepage(String actorId, Map<String, dynamic> patch) async {
    try {
      final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-homepage/patch");
      final http.Response res = await _client
          .post(
            uri,
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"sessionId": actorId, ...patch}),
          )
          .timeout(_timeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 建议名池（含自述理由）
  static Future<List<Map<String, dynamic>>> fetchNameSuggestions() async {
    final Uri uri = Uri.parse("${ApiConfig.httpBase}/api/agent-name-suggestions");
    final http.Response res = await _client
        .get(uri, headers: const <String, String>{"Accept": "application/json"})
        .timeout(_timeout);
    if (res.statusCode != 200) return const <Map<String, dynamic>>[];
    final Map<String, dynamic> body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body["ok"] != true) return const <Map<String, dynamic>>[];
    return <Map<String, dynamic>>[
      for (final dynamic s in (body["suggestions"] as List<dynamic>? ?? const <dynamic>[]))
        (s as Map).cast<String, dynamic>(),
    ];
  }
}
