import "dart:math" show max;

import "package:flutter/material.dart";
import "package:flutter/scheduler.dart" show Ticker;
import "package:webview_windows/webview_windows.dart";

import "../../core/services/shared_browser_host.dart";

/// 浏览器页（用户与 Agent 共用）。
///
/// 颜色全部取自 [Theme.of] —— 深色/暖色两套主题自动跟随：
///   - 主页态：工具栏整条收起，只留居中标识 + 单层搜索框 + 「试试让 Agent」
///     任务建议 chips（点击直接把任务发进对话）
///   - 浏览态：顶部一条细工具栏（后退/前进/刷新 + omnibox + 主页），
///     工具栏底边贴 2px 加载进度线；omnibox 获得焦点即全选，输入直接替换
///   - Agent 正在操作时工具栏下浮出细状态条（操作可见、可接管）；
///     状态条/确认条均带滑出过渡，确认条用 errorContainer 语义色区分
///
/// 嵌入模式（embedded=true）：渲染在右侧 Dock 面板里，不自带关闭按钮
/// （面板顶栏已有）；false 时为整页（预留全屏打开形态）。
class BrowserPage extends StatefulWidget {
  const BrowserPage({super.key, this.embedded = false, this.onAgentTask});

  final bool embedded;

  /// 主页「试试让 Agent」chips 的回调：把任务文本作为用户消息发给 Agent。
  final ValueChanged<String>? onAgentTask;

  @override
  State<BrowserPage> createState() => _BrowserPageState();
}

class _BrowserPageState extends State<BrowserPage> {
  final SharedBrowserHost host = SharedBrowserHost.instance;
  final TextEditingController _omnibox = TextEditingController();
  final FocusNode _omniboxFocus = FocusNode();
  bool _starting = false;

  /// 「试试让 Agent」任务建议（点击即作为用户消息发给 Agent）。
  static const List<String> _agentSuggestions = <String>[
    "比较目的地酒店价格",
    "附近美食推荐",
    "查一下今天的重要新闻",
    "整理邮箱中的广告邮件",
    "帮我比价一个商品",
    "看看快递到哪了",
  ];

  @override
  void initState() {
    super.initState();
    _bootstrap();
    host.currentUrl.addListener(_syncOmnibox);
    _omniboxFocus.addListener(_onOmniboxFocusChanged);
    _syncOmnibox();
  }

  Future<void> _bootstrap() async {
    if (host.isReady) return;
    setState(() => _starting = true);
    await host.ensureStarted();
    if (mounted) setState(() => _starting = false);
  }

  @override
  void dispose() {
    host.currentUrl.removeListener(_syncOmnibox);
    _omniboxFocus.removeListener(_onOmniboxFocusChanged);
    _omnibox.dispose();
    _omniboxFocus.dispose();
    super.dispose();
  }

  /// WebView 地址变化同步到 omnibox（用户手动点链接时输入框跟随）。
  /// 聚焦中不同步，避免覆盖用户正在输入的内容。
  void _syncOmnibox() {
    final String url = host.currentUrl.value;
    if (_omniboxFocus.hasFocus) return;
    if (host.atHome) {
      if (_omnibox.text.isNotEmpty) _omnibox.clear();
    } else if (_omnibox.text != url) {
      _omnibox.value = TextEditingValue(text: url);
    }
  }

  void _submit(String raw) {
    _omniboxFocus.unfocus();
    host.submitQuery(raw);
  }

  // ── omnibox 聚焦全选（浏览器标准行为：点入即选中整个地址，输入即替换）──
  //
  // 鼠标点击聚焦分两步：tap-down 请求焦点（此处先全选一次，覆盖键盘聚焦等
  // 无落点竞争的场景），tap-up 才把光标落到点击点——会覆盖上一步，因此标记
  // _omniboxSelectPending，由 onTap 再补一次全选。已聚焦后的再次点击不标记，
  // 光标正常落点，方便局部编辑。

  /// 本次聚焦是否由 tap-down 触发且尚未被 onTap 消费。
  bool _omniboxSelectPending = false;

  void _onOmniboxFocusChanged() {
    if (_omniboxFocus.hasFocus) {
      _selectAllOmnibox();
      _omniboxSelectPending = true;
    } else {
      _omniboxSelectPending = false;
    }
  }

  void _handleOmniboxTap() {
    if (!_omniboxSelectPending) return;
    _omniboxSelectPending = false;
    _selectAllOmnibox();
  }

  void _selectAllOmnibox() {
    if (_omnibox.text.isEmpty) return;
    _omnibox.selection = TextSelection(
      baseOffset: 0,
      extentOffset: _omnibox.text.length,
    );
  }

  void _sendAgentTask(String task) {
    _omniboxFocus.unfocus();
    widget.onAgentTask?.call(task);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // URL 变化驱动工具栏重建（按钮可用态、omnibox 图标跟随）。
        // 主页态整条收起（主页有自己的大搜索框，避免双搜索框叠加），
        // 进入浏览态时滑出。
        ValueListenableBuilder<String>(
          valueListenable: host.currentUrl,
          builder: (BuildContext context, String _, Widget? __) =>
              AnimatedSize(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOutCubic,
                alignment: Alignment.topCenter,
                child: host.atHome
                    ? const SizedBox(width: double.infinity)
                    : _buildToolbar(cs),
              ),
        ),
        // Agent 操作状态条（共用浏览器：操作可见、可接管）
        ValueListenableBuilder<int>(
          valueListenable: host.pendingAgentActions,
          builder: (BuildContext context, int pending, _) => _AnimatedBar(
            visible: pending > 0,
            child: _AgentStatusBar(cs: cs, action: host.lastAgentAction.value),
          ),
        ),
        // 高风险动作确认条（提交/支付类操作需用户点头才执行）。
        // 注意：null 态不能急切求值 cast（child 参数总会先构建），
        // 否则确认条关闭时 `null as SbConfirmRequest` 直接抛类型错误。
        ValueListenableBuilder<Object?>(
          valueListenable: host.confirmRequest,
          builder: (BuildContext context, Object? request, _) {
            final SbConfirmRequest? req =
                request is SbConfirmRequest ? request : null;
            return _AnimatedBar(
              visible: req != null,
              child: req == null
                  ? const SizedBox(width: double.infinity)
                  : _ConfirmBar(
                      cs: cs,
                      request: req,
                      onAllow: () => host.resolveConfirmation(true),
                      onDeny: () => host.resolveConfirmation(false),
                    ),
            );
          },
        ),
        // 「允许保存登录态」征询条：服务端捕获 Cookie 前必问，问一次记住
        ValueListenableBuilder<SbSaveLoginAsk?>(
          valueListenable: host.saveLoginAsk,
          builder: (BuildContext context, SbSaveLoginAsk? ask, _) {
            return _AnimatedBar(
              visible: ask != null,
              child: ask == null
                  ? const SizedBox(width: double.infinity)
                  : _SaveLoginAskBar(
                      cs: cs,
                      ask: ask,
                      onAllow: () => host.resolveSaveLoginAsk(true),
                      onDeny: () => host.resolveSaveLoginAsk(false),
                    ),
            );
          },
        ),
        ValueListenableBuilder<String>(
          valueListenable: host.currentUrl,
          builder: (BuildContext context, String url, _) {
            final bool home = host.atHome;
            if (home) return Expanded(child: _buildHomePage(cs));
            return Expanded(child: _buildWebView(cs));
          },
        ),
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 工具栏（Chrome 式：图标按钮 + 胶囊 omnibox；底边贴 2px 加载进度线）
  // ═══════════════════════════════════════════════════════════

  Widget _buildToolbar(ColorScheme cs) {
    return Stack(
      alignment: Alignment.bottomCenter,
      children: <Widget>[
        Container(
          height: 44,
          decoration: BoxDecoration(
            color: cs.surface,
            border: Border(
              bottom: BorderSide(color: cs.outline.withValues(alpha: 0.25)),
            ),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(
            children: <Widget>[
              _NavButton(
                icon: Icons.arrow_back_ios_new,
                tooltip: "后退",
                cs: cs,
                onTap: host.atHome ? null : host.goBack,
              ),
              _NavButton(
                icon: Icons.arrow_forward_ios,
                tooltip: "前进",
                cs: cs,
                onTap: host.atHome ? null : host.goForward,
              ),
              ValueListenableBuilder<bool>(
                valueListenable: host.isLoading,
                builder: (BuildContext context, bool loading, _) => _NavButton(
                  icon: loading ? Icons.close : Icons.refresh,
                  tooltip: loading ? "停止" : "刷新",
                  cs: cs,
                  onTap: loading ? host.stop : (host.atHome ? null : host.reload),
                ),
              ),
              const SizedBox(width: 4),
              Expanded(child: _buildOmnibox(cs)),
              const SizedBox(width: 4),
              _NavButton(
                icon: Icons.home_outlined,
                tooltip: "主页",
                cs: cs,
                onTap: host.atHome ? null : host.goHome,
              ),
            ],
          ),
        ),
        // 加载进度线：不确定进度模式，贴底边压在分隔线上，淡入淡出
        ValueListenableBuilder<bool>(
          valueListenable: host.isLoading,
          builder: (BuildContext context, bool loading, _) => AnimatedSwitcher(
            duration: const Duration(milliseconds: 150),
            child: loading
                ? SizedBox(
                    key: const ValueKey<String>("loading"),
                    width: double.infinity,
                    child: LinearProgressIndicator(
                      minHeight: 2,
                      backgroundColor: Colors.transparent,
                      color: cs.primary,
                    ),
                  )
                : const SizedBox(
                    key: ValueKey<String>("idle"),
                    width: double.infinity,
                    height: 2,
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildOmnibox(ColorScheme cs) {
    // 淡色胶囊填充，聚焦时浅描边（主页态工具栏整体收起，无主页分支）。
    return TextField(
      controller: _omnibox,
      focusNode: _omniboxFocus,
      onTap: _handleOmniboxTap,
      style: TextStyle(fontSize: 13, color: cs.onSurface),
      textAlignVertical: TextAlignVertical.center,
      textInputAction: TextInputAction.go,
      onSubmitted: _submit,
      decoration: InputDecoration(
        isDense: true,
        filled: true,
        fillColor: cs.surfaceContainerHigh.withValues(alpha: 0.6),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        prefixIcon: Icon(_omniboxIcon, size: 15, color: cs.onSurfaceVariant),
        prefixIconConstraints: const BoxConstraints(minWidth: 34),
        hintText: "搜索或输入网址",
        hintStyle: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
        border: InputBorder.none,
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(20),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(20),
          borderSide:
              BorderSide(color: cs.onSurface.withValues(alpha: 0.45)),
        ),
      ),
    );
  }

  IconData get _omniboxIcon {
    final String t = _omnibox.text.trim();
    if (t.isEmpty || SharedBrowserHost.resolveInputToUrl(t) == null) {
      return Icons.search;
    }
    return Icons.lock_outline_rounded;
  }

  // ═══════════════════════════════════════════════════════════
  // 主页：大标题 + 单层搜索框 + 「试试让 Agent」任务建议
  // ═══════════════════════════════════════════════════════════

  Widget _buildHomePage(ColorScheme cs) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 单层搜索框：仅一层淡色填充圆角，无外框、无描边
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: _HomeSearchBox(cs: cs, onSubmitted: _submit),
              ),
            ),
            const SizedBox(height: 36),
            Text(
              "试试让 Agent",
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
            const SizedBox(height: 14),
            // 滚动展示栏：通栏铺满面板宽，chips 在两侧边缘裁切，横向滚动
            _AgentSuggestionsRow(
              cs: cs,
              suggestions: _agentSuggestions,
              onTap: _sendAgentTask,
            ),
          ],
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════
  // WebView 渲染区
  // ═══════════════════════════════════════════════════════════

  Widget _buildWebView(ColorScheme cs) {
    final WebviewController? controller = host.controller;
    if (_starting && controller == null) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2.2,
            color: cs.onSurfaceVariant,
          ),
        ),
      );
    }
    if (controller == null) {
      return _buildErrorState(cs);
    }
    return Webview(controller);
  }

  /// 初始化失败空态：图标 + 一句话 + 重试（ensureStarted 失败会清空 _starting，
  /// 重调即真正重试）。
  Widget _buildErrorState(ColorScheme cs) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.error_outline_rounded,
              size: 36,
              color: cs.onSurfaceVariant.withValues(alpha: 0.6),
            ),
            const SizedBox(height: 14),
            Text(
              host.error ?? "浏览器组件暂不可用",
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 13,
                color: cs.onSurfaceVariant,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _bootstrap,
              style: OutlinedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor: cs.onSurface,
                side: BorderSide(color: cs.outline.withValues(alpha: 0.5)),
              ),
              icon: const Icon(Icons.refresh, size: 15),
              label: const Text("重试", style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }
}

/// 主页搜索框：单层淡色填充圆角（无外框、无描边、无聚焦描边），回车提交。
class _HomeSearchBox extends StatefulWidget {
  const _HomeSearchBox({required this.cs, required this.onSubmitted});

  final ColorScheme cs;
  final ValueChanged<String> onSubmitted;

  @override
  State<_HomeSearchBox> createState() => _HomeSearchBoxState();
}

class _HomeSearchBoxState extends State<_HomeSearchBox> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = widget.cs;
    return TextField(
      controller: _controller,
      focusNode: _focus,
      style: TextStyle(fontSize: 14.5, color: cs.onSurface),
      textInputAction: TextInputAction.search,
      onSubmitted: (String v) {
        widget.onSubmitted(v);
        _controller.clear();
      },
      decoration: InputDecoration(
        filled: true,
        fillColor: cs.surfaceContainerHigh,
        contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 15),
        prefixIcon: Icon(Icons.search, size: 20, color: cs.onSurfaceVariant),
        prefixIconConstraints: const BoxConstraints(minWidth: 46),
        hintText: "搜索或输入网址",
        hintStyle: TextStyle(fontSize: 14, color: cs.onSurfaceVariant),
        // 单层：所有状态一律无描边，仅靠填充色区分
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}

/// 「试试让 Agent」滚动展示栏：chips 从右往左循环滚动（跑马灯），
/// 移到末尾无缝回到开头重复；鼠标悬停暂停，移开继续，方便点击。
class _AgentSuggestionsRow extends StatefulWidget {
  const _AgentSuggestionsRow({
    required this.cs,
    required this.suggestions,
    required this.onTap,
  });

  final ColorScheme cs;
  final List<String> suggestions;
  final ValueChanged<String> onTap;

  @override
  State<_AgentSuggestionsRow> createState() => _AgentSuggestionsRowState();
}

class _AgentSuggestionsRowState extends State<_AgentSuggestionsRow>
    with SingleTickerProviderStateMixin {
  /// 滚动速度（像素/秒，从右往左）。
  static const double _speedPxPerSec = 32;

  final ScrollController _controller = ScrollController();
  final GlobalKey _setKey = GlobalKey();
  Ticker? _ticker;
  Duration _lastTick = Duration.zero;
  double _setContentWidth = 0;
  int _copies = 2;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _prepare());
  }

  @override
  void dispose() {
    _ticker?.stop();
    _controller.dispose();
    super.dispose();
  }

  /// 首帧后测量单组 chips 宽度与可视宽度，决定复制份数后开动跑马灯。
  /// 复制份数 = max(2, 视口宽/组宽 + 1)，保证循环回跳时右缘不露白。
  void _prepare() {
    if (!mounted) return;
    final BuildContext? ctx = _setKey.currentContext;
    if (ctx != null) {
      final RenderObject? ro = ctx.findRenderObject();
      if (ro is RenderBox) _setContentWidth = ro.size.width;
    }
    if (_controller.hasClients) {
      final double viewport = _controller.position.viewportDimension;
      if (_setContentWidth > 0) {
        _copies = max(2, (viewport / _setContentWidth).ceil() + 1);
      }
    }
    setState(() {});
    _startTicker();
  }

  void _startTicker() {
    _lastTick = Duration.zero;
    _ticker ??= createTicker(_onTick)..start();
  }

  void _onTick(Duration elapsed) {
    final double deltaSec =
        (elapsed - _lastTick).inMicroseconds / Duration.microsecondsPerSecond;
    _lastTick = elapsed;
    if (_setContentWidth <= 0 || !_controller.hasClients) return;
    double next = _controller.offset + _speedPxPerSec * deltaSec;
    // 一组内容滚完即回跳一组宽度：内容成对复制，回跳点视觉无缝
    if (next >= _setContentWidth) next -= _setContentWidth;
    _controller.jumpTo(next);
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> chips = <Widget>[
      for (final String text in widget.suggestions)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5),
          child: _AgentSuggestionChip(
            cs: widget.cs,
            label: text,
            onTap: () => widget.onTap(text),
          ),
        ),
    ];
    Widget content = Row(
      key: _setKey,
      mainAxisSize: MainAxisSize.min,
      children: chips,
    );
    if (_setContentWidth > 0) {
      content = Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < _copies; i++)
            if (i == 0)
              content
            else
              Row(mainAxisSize: MainAxisSize.min, children: chips),
        ],
      );
    }
    return ClipRect(
      child: SingleChildScrollView(
        controller: _controller,
        scrollDirection: Axis.horizontal,
        physics: const NeverScrollableScrollPhysics(),
        child: content,
      ),
    );
  }
}

/// 单个任务建议 chip：淡色填充、无描边。
class _AgentSuggestionChip extends StatelessWidget {
  const _AgentSuggestionChip({
    required this.cs,
    required this.label,
    required this.onTap,
  });

  final ColorScheme cs;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Text(
            label,
            style: TextStyle(fontSize: 12.5, color: cs.onSurface),
          ),
        ),
      ),
    );
  }
}

/// 工具栏导航圆按钮。
class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.tooltip,
    required this.cs,
    this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final ColorScheme cs;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 500),
      child: IconButton(
        onPressed: onTap,
        visualDensity: VisualDensity.compact,
        iconSize: 16,
        color: onTap == null ? cs.onSurfaceVariant.withValues(alpha: 0.35) : cs.onSurface,
        icon: Icon(icon),
      ),
    );
  }
}

/// 状态条出现/消失的过渡容器：AnimatedSize 负责高度收展（内容从工具栏
/// 下方推/收），AnimatedSwitcher 负责淡入淡出，避免硬切跳动。
class _AnimatedBar extends StatelessWidget {
  const _AnimatedBar({required this.visible, required this.child});

  final bool visible;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 150),
        child: visible
            ? child
            : const SizedBox(width: double.infinity),
      ),
    );
  }
}

/// 「Agent 正在操作」状态条：细、低饱和，不抢注意力。
class _AgentStatusBar extends StatelessWidget {
  const _AgentStatusBar({required this.cs, required this.action});

  final ColorScheme cs;
  final String action;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: cs.surfaceContainerHigh.withValues(alpha: 0.8),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 10,
            height: 10,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            "Agent 正在操作浏览器（$action）· 你随时可以手动接管",
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// 「允许保存登录态」征询条：服务端捕获 Cookie 前必问（与主流做法一致），
/// 问一次记住；secondaryContainer 语义色，与错误色确认条区分。
class _SaveLoginAskBar extends StatelessWidget {
  const _SaveLoginAskBar({
    required this.cs,
    required this.ask,
    required this.onAllow,
    required this.onDeny,
  });

  final ColorScheme cs;
  final SbSaveLoginAsk ask;
  final VoidCallback onAllow;
  final VoidCallback onDeny;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: cs.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: <Widget>[
            Icon(Icons.key_rounded, size: 16, color: cs.onSecondaryContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                "允许 NextBot 保存你在${ask.siteLabel}的登录态吗？加密存本机，比价 / 下单免重复登录",
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 12, color: cs.onSecondaryContainer),
              ),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: onDeny,
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor:
                    cs.onSecondaryContainer.withValues(alpha: 0.75),
              ),
              child: const Text("不保存", style: TextStyle(fontSize: 12.5)),
            ),
            const SizedBox(width: 2),
            FilledButton.tonal(
              onPressed: onAllow,
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 14),
              ),
              child: const Text("允许保存", style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }
}

/// 高风险动作确认条：服务端风险分级判定为提交/支付类操作时浮出，
/// 用户点「允许」才真正下发到页面；120 秒未决自动视为拒绝。
/// 用 errorContainer 语义底色与灰底的 Agent 状态条区分——
/// 这一条是需要用户决策的。
class _ConfirmBar extends StatelessWidget {
  const _ConfirmBar({
    required this.cs,
    required this.request,
    required this.onAllow,
    required this.onDeny,
  });

  final ColorScheme cs;
  final SbConfirmRequest request;
  final VoidCallback onAllow;
  final VoidCallback onDeny;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: cs.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: <Widget>[
            Icon(Icons.verified_user_outlined, size: 16, color: cs.error),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                "Agent 请求执行「${request.targetSummary}」· ${request.reason}",
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style:
                    TextStyle(fontSize: 12, color: cs.onErrorContainer),
              ),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: onDeny,
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor:
                    cs.onErrorContainer.withValues(alpha: 0.75),
              ),
              child: const Text("拒绝", style: TextStyle(fontSize: 12.5)),
            ),
            const SizedBox(width: 2),
            FilledButton.tonal(
              onPressed: onAllow,
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 14),
              ),
              child: const Text("允许执行", style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }
}
