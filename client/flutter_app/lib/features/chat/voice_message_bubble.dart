import "package:flutter/material.dart";

import "../../core/config/media_url.dart";
import "../../core/services/tts_player.dart";

/// 微信式可重播语音消息气泡（2026-11-20 交互对齐 mockup）。
///
/// 设计要点：
///   - 左侧（他人）/ 右侧（自己）布局，圆角气泡
///   - 喇叭 icon + 声波条（waveform 数组画高度）+ 时长文字「23″」
///   - 点击播放 / 暂停；播放中声波条流动动画
///   - **默认不显示转写文字**：长按（手机）/ 右键（电脑）弹出微信式深色菜单
///     「转文字 / 收藏 / 删除」，点「转文字」才在气泡下方展开 transcript
///   - 无 waveform 时用静默 placeholder（16 段自然波形）
///   - 不可播放时降级显示 transcript 文本（无障碍兜底）
class VoiceMessageBubble extends StatefulWidget {
  const VoiceMessageBubble({
    super.key,
    required this.mediaUrl,
    required this.isMe,
    this.durationMs = 0,
    this.waveform,
    this.transcript,
    this.isRead = true,
    this.onDelete,
    this.onFavorite,
  });

  /// 服务端返回的可访问路径，如 `/agent/voice/messages/.../xxx.mp3`。
  final String mediaUrl;

  /// 是否为自己发的消息（影响左右布局与配色）。
  final bool isMe;

  /// 音频时长（毫秒）。
  final int durationMs;

  /// 波形数据（0.0-1.0），可空。
  final List<double>? waveform;

  /// 转写文本备份：默认不展示，仅「转文字」展开 / 无障碍兜底时用。
  final String? transcript;

  /// 是否已读（影响喇叭 icon 颜色）。
  final bool isRead;

  /// 删除回调（长按菜单「删除」）：由宿主接入真实删除链路
  /// （移动端 = controller.removeMessage 落盘；未注入时气泡本地隐藏兜底）。
  final VoidCallback? onDelete;

  /// 收藏回调（长按菜单「收藏」）：未注入时仅本地 SnackBar 反馈。
  final VoidCallback? onFavorite;

  @override
  State<VoiceMessageBubble> createState() => _VoiceMessageBubbleState();
}

class _VoiceMessageBubbleState extends State<VoiceMessageBubble>
    with SingleTickerProviderStateMixin {
  late AnimationController _waveController;
  bool _isPlaying = false;
  bool _loadFailed = false;
  bool _transcriptExpanded = false;
  bool _removedLocally = false;
  OverlayEntry? _menuEntry;

  @override
  void initState() {
    super.initState();
    _waveController = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    );
    TtsPlayer.instance.addOnCompleted(_onPlayCompleted);
  }

  @override
  void dispose() {
    _closeMenu();
    TtsPlayer.instance.removeOnCompleted(_onPlayCompleted);
    _waveController.dispose();
    super.dispose();
  }

  void _onPlayCompleted() {
    if (!mounted) return;
    setState(() {
      _isPlaying = false;
      _waveController.stop();
    });
  }

  Future<void> _togglePlay() async {
    if (_isPlaying) {
      await TtsPlayer.instance.stop();
      setState(() {
        _isPlaying = false;
        _waveController.stop();
      });
      return;
    }

    setState(() {
      _isPlaying = true;
      _waveController.repeat();
    });

    final fullUrl = _resolveFullUrl(widget.mediaUrl);
    final ok = await TtsPlayer.instance.playFromUrl(fullUrl);
    if (!ok) {
      if (!mounted) return;
      setState(() {
        _isPlaying = false;
        _loadFailed = true;
        _waveController.stop();
      });
    }
  }

  String _resolveFullUrl(String mediaUrl) {
    // mediaUrl 形如 /agent/voice/messages/.../xxx.mp3；播放器只能吃 URL，
    // 凭证走 query（UrlSource 发不出请求头）
    return MediaUrl.resolve(mediaUrl);
  }

  // ── 长按 / 右键菜单（微信式深色横排） ──────────────────────────────

  void _showMenu(Offset globalPosition) {
    if (_menuEntry != null) {
      _closeMenu();
      return;
    }
    final OverlayState? overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return;

    _menuEntry = OverlayEntry(
      builder: (BuildContext ctx) => _VoiceMenuOverlay(
        anchor: globalPosition,
        hasTranscript: widget.transcript?.isNotEmpty == true,
        onDismiss: _closeMenu,
        onTranscribe: () {
          _closeMenu();
          if (widget.transcript?.isNotEmpty != true) {
            _toast("转写还没好，稍后再试");
            return;
          }
          setState(() => _transcriptExpanded = !_transcriptExpanded);
        },
        onFavorite: () {
          _closeMenu();
          widget.onFavorite?.call();
          _toast("已收藏");
        },
        onDelete: () {
          _closeMenu();
          if (widget.onDelete != null) {
            widget.onDelete!();
          } else {
            // 宿主未接删除链路：本地隐藏兜底（桌面端当前无消息删除 API）
            if (!mounted) return;
            setState(() => _removedLocally = true);
          }
        },
      ),
    );
    overlay.insert(_menuEntry!);
  }

  void _closeMenu() {
    _menuEntry?.remove();
    _menuEntry = null;
  }

  void _toast(String message) {
    final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 1)));
  }

  @override
  Widget build(BuildContext context) {
    if (_removedLocally) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    final isMe = widget.isMe;
    final bg = isMe ? cs.primary : cs.surfaceContainerHighest;
    final fg = isMe ? cs.onPrimary : cs.onSurface;

    // 与服务端 agent-voice-tools.ts 的 Math.round(durationMs / 1000) 同口径：
    // 旧实现用 ceil（1.2s 会显示 2″）且 clamp 到 99（长语音被截成 99″），
    // 与工具回执的秒数对不上，正是「语音条后面显示时间不准」的直接原因。
    final seconds = (widget.durationMs / 1000).round().clamp(1, 599);

    final wave = widget.waveform ?? _defaultWaveform();
    final waveCount = wave.length.clamp(3, 32);

    final bool showTranscript =
        widget.transcript != null && widget.transcript!.isNotEmpty && _transcriptExpanded;

    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.7,
        ),
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isMe ? 16 : 4),
            bottomRight: Radius.circular(isMe ? 4 : 16),
          ),
        ),
        // 手机端长按 / 电脑端右键 → 微信式菜单（转文字入口）
        child: GestureDetector(
          onLongPressStart: (LongPressStartDetails d) => _showMenu(d.globalPosition),
          onSecondaryTapUp: (TapUpDetails d) => _showMenu(d.globalPosition),
          child: Column(
            crossAxisAlignment: isMe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // 喇叭 icon（左侧/右侧根据 isMe 翻转）
                  if (!isMe) _buildSpeakerIcon(fg),
                  if (!isMe) const SizedBox(width: 8),
                  // 声波条
                  _buildWaveform(wave.take(waveCount).toList(), fg),
                  if (isMe) const SizedBox(width: 8),
                  if (isMe) _buildSpeakerIcon(fg),
                  const SizedBox(width: 8),
                  // 时长
                  Text(
                    "$seconds″",
                    style: theme.textTheme.bodySmall?.copyWith(color: fg),
                  ),
                ],
              ),
              if (_loadFailed && widget.transcript != null) ...[
                const SizedBox(height: 6),
                Text(
                  widget.transcript!,
                  style: theme.textTheme.bodySmall?.copyWith(color: fg.withValues(alpha: 0.7)),
                ),
              ],
              // 转写文字：默认不显示，仅长按/右键菜单「转文字」展开（对齐微信）
              if (showTranscript) ...[
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: fg.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    widget.transcript!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: fg.withValues(alpha: 0.85),
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSpeakerIcon(Color color) {
    return Icon(
      _isPlaying ? Icons.pause_circle_filled : Icons.graphic_eq,
      color: color,
      size: 22,
    );
  }

  Widget _buildWaveform(List<double> wave, Color color) {
    // 播放中：左侧已播放段用更高饱和度；这里简化为整体动画
    final animated = _waveController.isAnimating;
    return GestureDetector(
      onTap: _togglePlay,
      child: SizedBox(
        height: 24,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: List.generate(wave.length, (i) {
            final h = (wave[i] * 22).clamp(2.0, 24.0);
            // 播放时偶数条变高（伪动画效果）
            final dynamicH = animated && (i % 3 == 0) ? h * 1.2 : h;
            return Container(
              margin: const EdgeInsets.symmetric(horizontal: 1),
              width: 3,
              height: dynamicH.clamp(2.0, 24.0),
              decoration: BoxDecoration(
                color: color.withValues(alpha: _isPlaying ? 1.0 : 0.6),
                borderRadius: BorderRadius.circular(1.5),
              ),
            );
          }),
        ),
      ),
    );
  }

  List<double> _defaultWaveform() {
    // 默认 16 段，模拟自然语音波形（中间高、两端低）
    return List.generate(16, (i) {
      final t = (i - 8).abs() / 8.0;
      return (0.4 + (1 - t) * 0.5).clamp(0.3, 0.9);
    });
  }
}

/// 微信式深色横排菜单（转文字 / 收藏 / 删除）。
///
/// 全屏透明屏障负责点外部关闭；菜单条锚定在长按点上方，
/// 靠近顶部时翻转到下方，左右越界自动收进屏内。
class _VoiceMenuOverlay extends StatelessWidget {
  const _VoiceMenuOverlay({
    required this.anchor,
    required this.hasTranscript,
    required this.onDismiss,
    required this.onTranscribe,
    required this.onFavorite,
    required this.onDelete,
  });

  final Offset anchor;
  final bool hasTranscript;
  final VoidCallback onDismiss;
  final VoidCallback onTranscribe;
  final VoidCallback onFavorite;
  final VoidCallback onDelete;

  static const Color _menuBg = Color(0xE6484848);
  static const Color _menuFg = Color(0xFFE8E8EC);

  @override
  Widget build(BuildContext context) {
    final Size screen = MediaQuery.sizeOf(context);
    const double menuHeight = 58;
    // 三项横排：每项约 64 宽 + 分隔线
    const double menuWidth = 200;

    double left = anchor.dx - menuWidth / 2;
    left = left.clamp(8.0, screen.width - menuWidth - 8.0);

    // 优先出现在手指/光标上方（微信语义），越顶翻到下方
    double top = anchor.dy - menuHeight - 14;
    final bool flipBelow = top < MediaQuery.paddingOf(context).top + 8;
    if (flipBelow) top = anchor.dy + 14;
    top = top.clamp(8.0, screen.height - menuHeight - 8.0);

    Widget item({
      required IconData icon,
      required String label,
      required VoidCallback onTap,
      bool muted = false,
    }) {
      final Color color = muted ? _menuFg.withValues(alpha: 0.45) : _menuFg;
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: menuWidth / 3,
          height: menuHeight,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(height: 3),
              Text(
                label,
                style: TextStyle(fontSize: 11, color: color, decoration: TextDecoration.none),
              ),
            ],
          ),
        ),
      );
    }

    Widget divider() => Container(width: 1, height: 34, color: Colors.white.withValues(alpha: 0.15));

    return Stack(
      children: [
        // 全屏屏障：点外部关闭
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onDismiss,
            onLongPress: onDismiss,
            onSecondaryTap: onDismiss,
          ),
        ),
        Positioned(
          left: left,
          top: top,
          child: Container(
            width: menuWidth,
            height: menuHeight,
            decoration: BoxDecoration(
              color: _menuBg,
              borderRadius: BorderRadius.circular(10),
              boxShadow: const [
                BoxShadow(color: Color(0x66000000), blurRadius: 18, offset: Offset(0, 4)),
              ],
            ),
            child: Row(
              children: [
                item(icon: Icons.notes, label: "转文字", onTap: onTranscribe, muted: !hasTranscript),
                divider(),
                item(icon: Icons.star_border, label: "收藏", onTap: onFavorite),
                divider(),
                item(icon: Icons.delete_outline, label: "删除", onTap: onDelete),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
