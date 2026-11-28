import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/digital_human_avatar_api.dart";
import "../../core/services/voice_duplex_service.dart";
import "../../core/vision/pick_gallery_vision.dart";
import "digital_human_view.dart";

class DigitalHumanDetailPage extends StatefulWidget {
  const DigitalHumanDetailPage({super.key});

  @override
  State<DigitalHumanDetailPage> createState() => _DigitalHumanDetailPageState();
}

class _DigitalHumanDetailPageState extends State<DigitalHumanDetailPage> {
  final GlobalKey<DigitalHumanViewState> _viewKey =
      GlobalKey<DigitalHumanViewState>();
  DigitalHumanAvatarApi? _api;
  bool _busy = false;
  int _progress = 0;
  String _status = "";

  @override
  void initState() {
    super.initState();
    // 倾听态跟随双工麦克风：用户开麦说话时数字人注视镜头并小幅点头，
    // 关麦恢复空闲微动。数字人开口说话时服务端会自动挂起倾听微动。
    VoiceDuplexService.instance.micOpen.addListener(_onMicOpen);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // 页面晚于开麦打开时补同步一次初始状态
      unawaited(_pushListening(VoiceDuplexService.instance.micOpen.value));
    });
  }

  void _onMicOpen() {
    unawaited(_pushListening(VoiceDuplexService.instance.micOpen.value));
  }

  Future<void> _pushListening(bool listening) async {
    await _viewKey.currentState?.setListening(listening);
  }

  @override
  void dispose() {
    VoiceDuplexService.instance.micOpen.removeListener(_onMicOpen);
    unawaited(_viewKey.currentState?.setListening(false));
    _api?.close();
    super.dispose();
  }

  Future<void> _changeAvatar() async {
    if (_busy) return;
    final PickedImage? image = await pickGalleryImage();
    if (image == null || !mounted) return;

    final DigitalHumanAvatarApi api = DigitalHumanAvatarApi();
    _api = api;
    setState(() {
      _busy = true;
      _progress = 5;
      _status = "正在上传并校验人脸…";
    });

    try {
      final String job = await api.upload(image.bytes, image.name);
      for (int attempt = 0; attempt < 600; attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 800));
        if (!mounted) return;
        final DigitalHumanAvatarJob status = await api.status(job);
        if (!mounted) return;
        setState(() {
          _progress = status.progress;
          _status = status.message;
        });
        if (status.isReady) {
          await _viewKey.currentState?.reloadAvatar();
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("头像已切换")),
          );
          setState(() => _busy = false);
          return;
        }
        if (status.isError) throw StateError(status.message);
      }
      throw StateError("头像重建超时，请稍后再试");
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error is StateError ? error.message : error.toString()),
        ),
      );
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F5F7),
      appBar: AppBar(
        backgroundColor: const Color(0xFFF5F5F7),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        title: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text("数字人", style: TextStyle(fontSize: 16)),
            if (_busy)
              Text(
                "$_status $_progress%",
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Color(0xFF8A8A8E)),
              ),
          ],
        ),
        actions: [
          if (_busy)
            const Padding(
              padding: EdgeInsets.only(right: 18),
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            IconButton(
              tooltip: "更换头像",
              icon: const Icon(Icons.photo_camera_outlined),
              onPressed: () {
                unawaited(_changeAvatar());
              },
            ),
        ],
      ),
      body: DigitalHumanView(key: _viewKey),
    );
  }
}
