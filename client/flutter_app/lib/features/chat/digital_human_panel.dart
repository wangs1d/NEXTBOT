import "dart:async";

import "package:flutter/material.dart";

import "../../core/services/digital_human_avatar_api.dart";
import "../../core/services/digital_human_avatar_store.dart";
import "../../core/vision/pick_gallery_vision.dart";
import "digital_human_avatar_visual.dart";

/// 桌面端右侧「数字人」专属面板内容（嵌在 split 面板 chrome 内，不含 AppBar）。
///
/// 2026-11-27 用户最终确认：
/// - 面板内**不带任何框/底座/分隔线**，裸展示真实数字人模型人物本体；
///   不是 DG2 球，也不是把测试用的浏览器页面截过来。
/// - 面板里的文案（名字、绿点、「在线 · 可对话」）全部删除，只留人物与「换头像」。
///
/// 「换头像」完整链路（2026-11-28 补齐）：选图 → 本地静态层即时预览 →
/// 上传 avatar-talk-service 重建（模型推理/注册）→ 实时推流自动换装。
/// 服务离线时上传失败，本地预览仍生效，作为静态兜底。
class DigitalHumanPanel extends StatefulWidget {
  const DigitalHumanPanel({super.key, this.agentName});

  final String? agentName;

  @override
  State<DigitalHumanPanel> createState() => _DigitalHumanPanelState();
}

class _DigitalHumanPanelState extends State<DigitalHumanPanel> {
  bool _busy = false;
  int _progress = 0;
  String _status = "";

  Future<void> _changeAvatar() async {
    if (_busy) return;
    final PickedImage? image = await pickGalleryImage();
    if (image == null || !mounted) return;

    setState(() {
      _busy = true;
      _progress = 5;
      _status = "上传并校验中…";
    });

    final DigitalHumanAvatarApi api = DigitalHumanAvatarApi();
    try {
      // 本地静态层即时换装；服务重建完成后实时推流自动跟进（推流覆盖静态层）
      await DigitalHumanAvatarStore.instance.setBytes(image.bytes);
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
          if (!mounted) return;
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            const SnackBar(content: Text("数字人形象已切换")),
          );
          return;
        }
        if (status.isError) throw StateError(status.message);
      }
      throw StateError("头像重建超时，请稍后再试");
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(error is StateError ? error.message : error.toString()),
        ),
      );
    } finally {
      api.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              // 人物源图 683:900；裸展示，按可用空间等比缩放，不带任何框。
              const double aspect = 683.0 / 900.0;
              double height = constraints.maxHeight * 0.86;
              double width = height * aspect;
              final double maxW = constraints.maxWidth * 0.86;
              if (width > maxW) {
                width = maxW;
                height = width / aspect;
              }
              return Center(
                child: DigitalHumanAvatarVisual(
                  // 裸展示：showBase=false 时 circleSize 即人物显示高度。
                  circleSize: height,
                  headOverflow: 0,
                  showBase: false,
                ),
              );
            },
          ),
        ),
        SizedBox(
          height: 52,
          child: Center(
            child: _busy
                ? Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          "$_status $_progress%",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xFF8A8A8E),
                          ),
                        ),
                      ),
                    ],
                  )
                : TextButton.icon(
                    onPressed: () => unawaited(_changeAvatar()),
                    icon: const Icon(Icons.photo_camera_outlined, size: 15),
                    label: const Text("换头像"),
                  ),
          ),
        ),
      ],
    );
  }
}
