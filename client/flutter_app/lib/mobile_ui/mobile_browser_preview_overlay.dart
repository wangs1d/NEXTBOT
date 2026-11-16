import "dart:convert";
import "dart:typed_data";

import "package:flutter/material.dart";

import "mobile_chat_controller.dart";

/// 右上角「Agent 正在控制浏览器」悬浮窗（2026-11-12）。
///
/// 手机端没有可见内置浏览器（WebView2 仅 Windows）：agent_browser 在服务端
/// 无头 Chromium 里执行，每步动作后经 `agent.browser.preview` 推页面截图，
/// 本悬浮窗是这些帧的唯一展示面——用户在手机上也能实时看到 Agent 正在
/// 操作的网页画面（浏览器任务进行中自动弹出，任务收口/出错自动熄灭）。
///
/// 交互：
/// - 点箭头：展开/收起画面区（收起只留标题条，给消息流让地方）；
/// - 点右上角 ×：手动关闭本轮悬浮窗（不中断任务；下一个浏览器任务重新点亮）；
/// - 无帧时（任务刚开始等）画面区显示「正在打开浏览器…」占位态。
///
/// 挂载点：[MobileHomePage] 主壳 Stack 顶层（跨 tab 常驻）。
class MobileBrowserPreviewOverlay extends StatefulWidget {
  const MobileBrowserPreviewOverlay({super.key, required this.controller});

  final MobileChatController controller;

  @override
  State<MobileBrowserPreviewOverlay> createState() =>
      _MobileBrowserPreviewOverlayState();
}

class _MobileBrowserPreviewOverlayState
    extends State<MobileBrowserPreviewOverlay> {
  /// 画面区是否展开（点标题条箭头切换；收起只留标题条）。
  bool _expanded = true;

  /// 当前可见性（AnimatedSwitcher 用 key 区分进出两态）。
  bool _visible = false;

  /// 用户拖拽累积偏移（默认右上角；新任务点亮时归位）。
  Offset _dragOffset = Offset.zero;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
    _visible = widget.controller.browserPreviewVisible;
  }

  @override
  void didUpdateWidget(MobileBrowserPreviewOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onControllerChanged);
      widget.controller.addListener(_onControllerChanged);
      _visible = widget.controller.browserPreviewVisible;
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    super.dispose();
  }

  void _onControllerChanged() {
    // 无条件重建：新预览帧 / 脚注变化都要上屏（可见性没翻也得刷，
    // 否则画面永远停在占位态——2026-11-12 实测抓出）。卡片很小，
    // 预览帧又有服务端节流，重建开销可忽略。
    if (!mounted) return;
    final bool v = widget.controller.browserPreviewVisible;
    // 隐藏→点亮的新一轮任务：拖拽位置归位（默认右上角）。
    if (v && !_visible) _dragOffset = Offset.zero;
    setState(() => _visible = v);
  }

  /// 动作名 → 一句话（脚注展示当前在做什么）。
  String _actionLabel(String? action) {
    switch (action) {
      case "open":
        return "正在打开网页";
      case "click":
        return "正在点击页面";
      case "type":
        return "正在输入内容";
      case "scroll":
        return "正在滚动页面";
      case "wait_for":
        return "正在等待页面";
      case "screenshot":
        return "正在查看页面";
      // 购物族动作（云端浏览器同样会开页）：比价/搜索/下单/查单。
      case "prices":
        return "正在比价";
      case "research":
        return "正在调研价格";
      case "search":
        return "正在搜索商品";
      case "place":
        return "正在下单";
      case "track":
        return "正在查询订单";
      case "cancel":
        return "正在取消订单";
      case "spec.load":
        return "正在读取商品规格";
      case "check":
        return "正在核对状态";
      default:
        return "正在操作浏览器";
    }
  }

  /// URL → 展示用的站点名（取 hostname，去 www 前缀；解析失败原样截短）。
  String _siteLabel(String? url) {
    final String u = (url ?? "").trim();
    if (u.isEmpty) return "";
    try {
      final Uri uri = Uri.parse(u);
      String host = uri.host;
      if (host.startsWith("www.")) host = host.substring(4);
      return host;
    } catch (_) {
      return u.length > 24 ? "${u.substring(0, 24)}…" : u;
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      switchInCurve: Curves.easeOut,
      switchOutCurve: Curves.easeIn,
      child: _visible
          ? _buildCard(key: const ValueKey<String>("browser-preview-on"))
          : const SizedBox.shrink(
              key: ValueKey<String>("browser-preview-off"),
            ),
    );
  }

  Widget _buildCard({required Key key}) {
    final MobileChatController c = widget.controller;
    final String? imageB64 = c.browserPreviewImage;
    final String? url = c.browserPreviewUrl;
    final String? action = c.browserPreviewAction;
    final String site = _siteLabel(url);

    return Align(
      key: key,
      alignment: Alignment.topRight,
      child: Padding(
        padding: const EdgeInsets.only(top: 10, right: 12),
        child: Transform.translate(
          // 拖拽偏移（Grok/Muse 式任务预览窗同款交互：默认右上角，
          // 挡到内容可以拖走；新任务自动归位）。
          offset: _dragOffset,
          child: Material(
            color: Colors.transparent,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onPanUpdate: _handlePan,
              onPanEnd: (_) => _clampDragToBounds(context),
              child: Container(
                width: _expanded ? 196 : 168,
                decoration: BoxDecoration(
                  // NEXTBOT 黑底白字：悬浮窗压一层近黑卡片，画面区域自带暗边。
                  // 大圆角对齐 Grok 式任务预览卡。
                  color: const Color(0xF20E0E0E),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.28),
                      blurRadius: 18,
                      offset: const Offset(0, 6),
                    ),
                  ],
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(19),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _buildHeader(action),
                      if (_expanded) ...<Widget>[
                        _buildPreview(imageB64),
                        _buildFooter(site),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 拖拽：跟手 + 屏幕边界钳制（onPanEnd 时兜底，防拖出可视区）。
  void _handlePan(DragUpdateDetails d) {
    setState(() => _dragOffset += d.delta);
  }

  void _clampDragToBounds(BuildContext context) {
    final Size screen = MediaQuery.sizeOf(context);
    const double cardW = 196;
    const double cardH = 210; // 标题条 + 画面区 + 脚注（展开态最大高）
    final double dx = _dragOffset.dx.clamp(-(screen.width - cardW - 24), 12.0);
    final double dy = _dragOffset.dy.clamp(-(screen.height - cardH - 100), screen.height - cardH - 80);
    final Offset clamped = Offset(dx, dy);
    if (clamped != _dragOffset) {
      setState(() => _dragOffset = clamped);
    }
  }

  /// 标题条：工作点 + 当前动作短句（Grok 式「Grok is browsing…」——
  /// 动词跟帧实时走）+ 收起/关闭。
  Widget _buildHeader(String? action) {
    return Container(
      color: Colors.white.withValues(alpha: 0.06),
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      child: Row(
        children: <Widget>[
          const _WorkingDot(),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              _actionLabel(action),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.92),
                fontSize: 11.5,
                height: 1.2,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.2,
              ),
            ),
          ),
          // 收起/展开画面区
          _HeaderButton(
            icon: _expanded
                ? Icons.keyboard_arrow_up
                : Icons.keyboard_arrow_down,
            onTap: () => setState(() => _expanded = !_expanded),
          ),
          // 手动关闭（只藏 UI，不中断任务）
          _HeaderButton(
            icon: Icons.close,
            onTap: widget.controller.dismissBrowserPreview,
          ),
        ],
      ),
    );
  }

  /// 画面区：有帧显示最新截图（gapless 平滑换帧），无帧显示占位态。
  Widget _buildPreview(String? imageB64) {
    final MemoryImage? provider = _providerFor(imageB64);
    return Container(
      height: 118,
      color: Colors.black,
      alignment: Alignment.center,
      child: provider != null
          ? Image(
              image: provider,
              // contain：整页等比完整显示（服务端推的是全视口帧），
              // 黑底 letterbox 与 NEXTBOT 悬浮窗底色自然融合。
              fit: BoxFit.contain,
              width: double.infinity,
              gaplessPlayback: true,
              filterQuality: FilterQuality.low,
            )
          : Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(
                  Icons.public,
                  size: 22,
                  color: Colors.white.withValues(alpha: 0.35),
                ),
                const SizedBox(height: 6),
                Text(
                  "正在打开浏览器…",
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.45),
                    fontSize: 10.5,
                  ),
                ),
              ],
            ),
    );
  }

  /// 脚注：站点（动词已在标题条，这里只留「在哪」）。
  Widget _buildFooter(String site) {
    final String text = site.isEmpty ? "浏览器" : site;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 7),
      color: Colors.white.withValues(alpha: 0.04),
      child: Row(
        children: <Widget>[
          Icon(
            Icons.public,
            size: 10,
            color: Colors.white.withValues(alpha: 0.45),
          ),
          const SizedBox(width: 5),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.62),
                fontSize: 10.5,
                height: 1.25,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 已解码帧缓存：base64 串 → 解码字节 + 稳定 provider 实例。
  ///
  /// 每次 notifyListeners 都会整卡重建，若在 build 里 base64Decode 会重复
  /// 解码（每秒最多一帧 × 整卡重建频率，纯浪费）；且 MemoryImage 相等性是
  /// 实例身份比较，实例稳定才能命中 Flutter 图片缓存（换帧不闪、解码一次）。
  String? _cachedB64;
  Uint8List? _cachedBytes;
  MemoryImage? _cachedProvider;

  /// 取帧的 ImageProvider（同一条 base64 只解码一次）。
  MemoryImage? _providerFor(String? b64) {
    final String s = (b64 ?? "").trim();
    if (s.isEmpty) return null;
    if (s == _cachedB64 && _cachedProvider != null) return _cachedProvider;
    try {
      _cachedBytes = base64Decode(s);
      _cachedB64 = s;
      _cachedProvider = MemoryImage(_cachedBytes!);
    } catch (_) {
      return null;
    }
    return _cachedProvider;
  }
}

/// 标题条小圆钮（收起/关闭）。
class _HeaderButton extends StatelessWidget {
  const _HeaderButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.all(4),
        child: Icon(
          icon,
          size: 14,
          color: Colors.white.withValues(alpha: 0.55),
        ),
      ),
    );
  }
}

/// 标题条左侧的工作呼吸点。
class _WorkingDot extends StatefulWidget {
  const _WorkingDot();

  @override
  State<_WorkingDot> createState() => _WorkingDotState();
}

class _WorkingDotState extends State<_WorkingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void initState() {
    super.initState();
    _pulse.repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _pulse,
      builder: (BuildContext context, Widget? child) {
        return Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white.withValues(alpha: 0.45 + 0.55 * _pulse.value),
          ),
        );
      },
    );
  }
}
