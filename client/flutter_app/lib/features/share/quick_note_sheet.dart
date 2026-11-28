import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";

import "../../core/services/share_intake_service.dart";
import "../../core/services/speech_service.dart";
import "../../core/vision/pick_gallery_vision.dart";
import "../../core/vision/vision_wire_frame.dart";

/// 半屏速记卡（2026-11-23 PRD §8.1 的三种「记一下」入口共用的那张卡）。
///
/// 为什么是一张卡而不是一个新页面：从长按快捷方式 / 快捷设置磁贴 / 常驻通知
/// 「记一下」进来的人，手上正被别的事打断，要的是「说一句就走」。拉起整个
/// 对话页再让他自己找输入框，等于把打断还给他。
///
/// 卡片只收集内容，不解释内容：文本 / 语音转的字 / 拍的照片，统一交
/// [ShareIntakeService.submit] 进既有聊天链路——「打算怎么做」是管家说的话，
/// 不在这里编。
class QuickNoteSheet extends StatefulWidget {
  const QuickNoteSheet({super.key, required this.entry});

  /// quick_note / ask_note / voice_note：只影响标题、初始焦点与是否直接开始听写。
  final String entry;

  static Future<void> show(BuildContext context, String entry) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (BuildContext ctx) => QuickNoteSheet(entry: entry),
    );
  }

  static String titleOf(String entry) => switch (entry) {
        "ask_note" => "问一下管家",
        "voice_note" => "语音记一下",
        "camera_note" => "拍一下",
        _ => "记一下",
      };

  @override
  State<QuickNoteSheet> createState() => _QuickNoteSheetState();
}

class _QuickNoteSheetState extends State<QuickNoteSheet> {
  final TextEditingController _text = TextEditingController();
  final FocusNode _focus = FocusNode();
  final List<VisionWireFrame> _frames = <VisionWireFrame>[];

  bool _listening = false;
  bool _sending = false;
  String? _hint;

  @override
  void initState() {
    super.initState();
    if (widget.entry != "voice_note") {
      // 文字入口：键盘直接等着；语音入口交给下面的听写，别抢焦点
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _focus.requestFocus();
      });
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_toggleListen());
      });
    }
  }

  @override
  void dispose() {
    if (_listening) unawaited(SpeechService().stopListening());
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _toggleListen() async {
    if (_listening) {
      await SpeechService().stopListening();
      if (mounted) setState(() => _listening = false);
      return;
    }
    final SpeechService stt = SpeechService();
    if (!stt.isAvailable) {
      // 麦克风权限 + 系统识别引擎都在这一步探明（内部会弹权限框）
      final bool ok = await stt.initialize();
      if (!ok) {
        if (mounted) {
          setState(() => _hint = "这台手机没给出语音识别服务（或没给麦克风权限），先打字记一下");
        }
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      _listening = true;
      _hint = null;
    });
    // 系统听写（与桌面语音输入同一套 SpeechService）：识别结果直接进输入框，
    // 用户看得见、能改——管家听错一个字，比重新说一遍便宜得多。
    final bool started = await stt.startListening(
      onResult: (String text) {
        if (!mounted) return;
        final String merged = _text.text.trim().isEmpty
            ? text
            : "${_text.text.trim()} $text";
        _text.value = TextEditingValue(
          text: merged,
          selection: TextSelection.collapsed(offset: merged.length),
        );
      },
      onDone: () {
        if (mounted) setState(() => _listening = false);
      },
    );
    if (!started && mounted) {
      setState(() {
        _listening = false;
        _hint = "语音识别启动失败，请检查麦克风权限后重试";
      });
    }
  }

  Future<void> _pickCamera() async {
    try {
      final VisionWireFrame? frame = await pickCameraVisionWireFrame();
      if (frame == null || !mounted) return;
      setState(() {
        _frames.add(frame);
        _hint = null;
      });
    } catch (e) {
      if (mounted) setState(() => _hint = "相机没打开：$e");
    }
  }

  Future<void> _pickGallery() async {
    try {
      final VisionWireFrame? frame = await pickGalleryVisionWireFrame();
      if (frame == null || !mounted) return;
      setState(() => _frames.add(frame));
    } catch (e) {
      if (mounted) setState(() => _hint = "相册没打开：$e");
    }
  }

  Future<void> _send() async {
    final String text = _text.text.trim();
    if (text.isEmpty && _frames.isEmpty) {
      setState(() => _hint = "先说一句，或拍一张");
      return;
    }
    setState(() => _sending = true);
    final NavigatorState nav = Navigator.of(context);
    // 先收卡再发：发送走的是聊天 WS，气泡会落在被这张卡挡住的那一页上，
    // 卡不关掉用户就看不到管家回了什么（§8.2 的「就这样 → 回执」）。
    nav.pop();
    await ShareIntakeService.instance.submit(
      text: ShareIntakeService.compose(
        text: text,
        subject: "",
        source: "quick_note",
        hasImages: _frames.isNotEmpty,
      ),
      frames: _frames,
      source: "quick_note",
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Material(
        color: cs.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 12, 4),
                child: Row(
                  children: <Widget>[
                    Text(
                      QuickNoteSheet.titleOf(widget.entry),
                      style: Theme.of(context)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                    const Spacer(),
                    if (_listening)
                      const Padding(
                        padding: EdgeInsets.only(right: 8),
                        child: Icon(Icons.mic, size: 20, color: Colors.redAccent),
                      ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: TextField(
                  controller: _text,
                  focusNode: _focus,
                  minLines: 2,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: _frames.isEmpty
                        ? "说一件要记的事，或要问管家的话"
                        : "要不要补一句话？（可以留空）",
                    border: InputBorder.none,
                  ),
                ),
              ),
              if (_frames.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                  child: SizedBox(
                    height: 64,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: _frames.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (BuildContext _, int i) => ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.memory(
                          Uint8List.fromList(_frames[i].bytes),
                          width: 64,
                          height: 64,
                          fit: BoxFit.cover,
                        ),
                      ),
                    ),
                  ),
                ),
              if (_hint != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
                  child: Text(
                    _hint!,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: cs.error,
                        ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                child: Row(
                  children: <Widget>[
                    IconButton(
                      tooltip: "语音",
                      onPressed: _sending ? null : () => unawaited(_toggleListen()),
                      icon: Icon(_listening ? Icons.graphic_eq : Icons.mic_none),
                    ),
                    IconButton(
                      tooltip: "拍一下",
                      onPressed: _sending ? null : () => unawaited(_pickCamera()),
                      icon: const Icon(Icons.photo_camera_outlined),
                    ),
                    IconButton(
                      tooltip: "选一张图",
                      onPressed: _sending ? null : () => unawaited(_pickGallery()),
                      icon: const Icon(Icons.image_outlined),
                    ),
                    const Spacer(),
                    FilledButton(
                      onPressed: _sending ? null : () => unawaited(_send()),
                      child: const Text("交给管家"),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
