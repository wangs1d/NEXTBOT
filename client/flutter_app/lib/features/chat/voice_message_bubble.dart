import "package:flutter/material.dart";

import "../../core/config/media_url.dart";
import "../../core/services/tts_player.dart";

/// 微信式可重播语音消息气泡。
///
/// 设计要点：
///   - 左侧（他人）/ 右侧（自己）布局，圆角气泡
///   - 喇叭 icon + 声波条（用 waveform 数组画 Container 高度）+ 时长文字「23″」
///   - 点击播放 / 暂停；播放中声波条流动动画
///   - 已读：灰色喇叭；未读：高亮喇叭
///   - 无 waveform 时用静默 placeholder（5 段等高条）
///   - 不可播放时降级显示 transcript 文本
class VoiceMessageBubble extends StatefulWidget {
  const VoiceMessageBubble({
    super.key,
    required this.mediaUrl,
    required this.isMe,
    this.durationMs = 0,
    this.waveform,
    this.transcript,
    this.isRead = true,
  });

  /// 服务端返回的可访问路径，如 `/agent/voice/messages/.../xxx.mp3`。
  final String mediaUrl;

  /// 是否为自己发的消息（影响左右布局与配色）。
  final bool isMe;

  /// 音频时长（毫秒）。
  final int durationMs;

  /// 波形数据（0.0-1.0），可空。
  final List<double>? waveform;

  /// 文本备份，无障碍 / 不可播放时降级展示。
  final String? transcript;

  /// 是否已读（影响喇叭 icon 颜色）。
  final bool isRead;

  @override
  State<VoiceMessageBubble> createState() => _VoiceMessageBubbleState();
}

class _VoiceMessageBubbleState extends State<VoiceMessageBubble>
    with SingleTickerProviderStateMixin {
  late AnimationController _waveController;
  bool _isPlaying = false;
  bool _loadFailed = false;

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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    final isMe = widget.isMe;
    final bg = isMe ? cs.primary : cs.surfaceContainerHighest;
    final fg = isMe ? cs.onPrimary : cs.onSurface;

    final seconds = (widget.durationMs / 1000).ceil().clamp(1, 99);

    final wave = widget.waveform ?? _defaultWaveform();
    final waveCount = wave.length.clamp(3, 32);

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
            // ASR 完成后由服务端回推 transcript：有转写文本时就在波形下面展示，
            // 方便用户核对 ASR 准确率（微信式「语音→文字」体验）。
            if (!_loadFailed &&
                widget.transcript != null &&
                widget.transcript!.isNotEmpty) ...[
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
