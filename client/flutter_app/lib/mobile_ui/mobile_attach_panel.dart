import "dart:async";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:permission_handler/permission_handler.dart";
import "package:photo_manager/photo_manager.dart";

import "../core/vision/pick_gallery_vision.dart";
import "../core/vision/vision_user_limits.dart";import "../core/vision/vision_wire_frame.dart";
import "mobile_theme.dart";

/// 手机端输入栏「+」点开的底部附件面板。
///
/// 结构（对齐设计稿）：
/// - 顶部拖拽把手
/// - 一排四个功能入口：拍照 / 相册 / 本地文件 / 打电话
/// - 下面直接铺最近相册九宫格（右下角选择圈）
///
/// 交互（2026-11-19 起，对齐主流相册勾选）：
/// - 点一下照片：勾选/取消勾选（角标圈常显），可勾多张
/// - 选完按「添加 N 张」统一返回；照片进输入框上方待发送区，
///   由调用方让用户配文字后一并发送，面板只负责选图
///
/// 返回 `List<VisionWireFrame>`（空列表代表取消）；打电话项通过
/// [onCall] 回调外部处理，面板本身不 pop。
class MobileAttachPanel extends StatefulWidget {
  const MobileAttachPanel({
    super.key,
    required this.onCall,
  });

  /// 点「打电话」时回调，由外层决定拉起哪个通话入口。
  final VoidCallback onCall;

  static Future<List<VisionWireFrame>?> show(
    BuildContext context, {
    required VoidCallback onCall,
  }) {
    return showModalBottomSheet<List<VisionWireFrame>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black54,
      builder: (BuildContext sheetContext) =>
          MobileAttachPanel(onCall: onCall),
    );
  }

  @override
  State<MobileAttachPanel> createState() => _MobileAttachPanelState();
}

class _MobileAttachPanelState extends State<MobileAttachPanel> {
  final List<AssetEntity> _assets = <AssetEntity>[];
  final Map<String, Uint8List> _thumbs = <String, Uint8List>{};
  final Set<String> _selectedIds = <String>{};
  bool _loading = true;
  bool _denied = false;

  @override
  void initState() {
    super.initState();
    unawaited(_loadGallery());
  }

  Future<void> _loadGallery() async {
    PermissionState state;
    try {
      state = await PhotoManager.requestPermissionExtend();
    } catch (_) {
      state = PermissionState.denied;
    }
    if (!state.hasAccess && !state.isAuth) {
      if (mounted) setState(() => _denied = true);
      return;
    }
    try {
      final List<AssetPathEntity> paths = await PhotoManager.getAssetPathList(
        type: RequestType.image,
        onlyAll: true,
      );
      if (paths.isEmpty) {
        if (mounted) setState(() => _loading = false);
        return;
      }
      final List<AssetEntity> assets =
          await paths.first.getAssetListRange(start: 0, end: 120);
      if (!mounted) return;
      setState(() {
        _assets.addAll(assets);
        _loading = false;
      });
      _prefetchThumbs(assets.take(24));
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _prefetchThumbs(Iterable<AssetEntity> assets) async {
    for (final AssetEntity asset in assets) {
      try {
        final Uint8List? data = await asset.thumbnailDataWithSize(
          const ThumbnailSize(240, 240),
          quality: 80,
        );
        if (data == null || !mounted) continue;
        setState(() => _thumbs[asset.id] = data);
      } catch (_) {
        // 单张缩略图失败不影响整格。
      }
    }
  }

  /// 相册资源 → VisionWireFrame。
  /// 直接取 2048px 的原尺寸缩略图（平台侧已处理 EXIF 方向），不再把
  /// 12MP 原图读进内存；发送前统一走 [frameFromGalleryBytes] 压缩。
  Future<VisionWireFrame?> _toFrame(AssetEntity asset) async {
    try {
      final Uint8List? bytes = await asset.thumbnailDataWithSize(
        const ThumbnailSize(
          kAgentUserVisionMaxEdgePx,
          kAgentUserVisionMaxEdgePx,
        ),
        quality: 88,
      );
      if (bytes == null || bytes.isEmpty) return null;
      return await frameFromGalleryBytes(
        bytes,
        name: "${asset.id}.${asset.title ?? 'jpg'}",
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _sendSelected() async {
    final List<VisionWireFrame> frames = <VisionWireFrame>[];
    for (final AssetEntity asset in _assets) {
      if (!_selectedIds.contains(asset.id)) continue;
      final VisionWireFrame? frame = await _toFrame(asset);
      if (frame != null) frames.add(frame);
      if (frames.length >= kAgentUserVisionMaxFrames) break;
    }
    if (!mounted) return;
    if (frames.isEmpty) {
      Navigator.of(context).pop(<VisionWireFrame>[]);
      return;
    }
    Navigator.of(context).pop(frames);
  }

  /// 点照片：勾选/取消勾选（上限 kAgentUserVisionMaxFrames 张）。
  void _onTapTile(AssetEntity asset) {
    setState(() {
      if (_selectedIds.contains(asset.id)) {
        _selectedIds.remove(asset.id);
      } else if (_selectedIds.length < kAgentUserVisionMaxFrames) {
        _selectedIds.add(asset.id);
      }
    });
  }

  Future<void> _takePhoto() async {
    final VisionWireFrame? frame = await pickCameraVisionWireFrame();
    if (!mounted || frame == null) return;
    Navigator.of(context).pop(<VisionWireFrame>[frame]);
  }

  Future<void> _pickFromSystemGallery() async {
    final List<VisionWireFrame> frames = await pickGalleryVisionWireFrames();
    if (!mounted || frames.isEmpty) return;
    Navigator.of(context).pop(frames);
  }

  /// 「本地文件」：走系统文件管理器（非相册），从任意目录选图片文件。
  Future<void> _pickLocalFile() async {
    final VisionWireFrame? frame = await pickLocalFileVisionWireFrame();
    if (!mounted || frame == null) return;
    Navigator.of(context).pop(<VisionWireFrame>[frame]);
  }

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color sheetBg = dark ? const Color(0xFF151515) : p.surface;
    final Color iconColor = dark ? const Color(0xFFE6E6E6) : p.textPrimary;
    final Color labelColor = dark ? const Color(0xFF9A9A9A) : p.textSecondary;

    return Container(
      decoration: BoxDecoration(
        color: sheetBg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(top: 10, bottom: 6),
              decoration: BoxDecoration(
                color: dark ? const Color(0xFF4A4A4A) : p.divider,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            if (_selectedIds.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 12, 4),
                child: Row(
                  children: <Widget>[
                    Text(
                      "已选 ${_selectedIds.length}/$kAgentUserVisionMaxFrames",
                      style: TextStyle(fontSize: 12, color: labelColor),
                    ),
                    const Spacer(),
                    GestureDetector(
                      onTap: () => setState(_selectedIds.clear),
                      child: Text("清空",
                          style: TextStyle(fontSize: 12, color: labelColor)),
                    ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              child: Row(
                children: <Widget>[
                  _actionTile(
                    icon: Icons.photo_camera_outlined,
                    label: "拍照",
                    color: iconColor,
                    labelColor: labelColor,
                    onTap: _takePhoto,
                  ),
                  _actionTile(
                    icon: Icons.photo_library_outlined,
                    label: "相册",
                    color: iconColor,
                    labelColor: labelColor,
                    onTap: _pickFromSystemGallery,
                  ),
                  _actionTile(
                    icon: Icons.folder_outlined,
                    label: "本地文件",
                    color: iconColor,
                    labelColor: labelColor,
                    onTap: _pickLocalFile,
                  ),
                  _actionTile(
                    icon: Icons.phone_outlined,
                    label: "打电话",
                    color: iconColor,
                    labelColor: labelColor,
                    onTap: () {
                      Navigator.of(context).pop(<VisionWireFrame>[]);
                      widget.onCall();
                    },
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: dark ? const Color(0xFF262626) : p.divider),
            _buildGrid(p, dark, labelColor),
            if (_selectedIds.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                child: SizedBox(
                  width: double.infinity,
                  height: 42,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: dark ? Colors.white : p.accent,
                      foregroundColor: dark ? Colors.black : p.onAccent,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(21),
                      ),
                      elevation: 0,
                    ),
                    onPressed: _selectedIds.isEmpty ? null : _sendSelected,
                    child: Text(
                      _selectedIds.isEmpty
                          ? "选择要添加的照片"
                          : "添加 ${_selectedIds.length} 张",
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _actionTile({
    required IconData icon,
    required String label,
    required Color color,
    required Color labelColor,
    required VoidCallback onTap,
  }) {
    return Expanded(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.08),
              ),
              child: Icon(icon, size: 23, color: color),
            ),
            const SizedBox(height: 7),
            Text(label, style: TextStyle(fontSize: 11, color: labelColor)),
          ],
        ),
      ),
    );
  }

  Widget _buildGrid(MobilePalette p, bool dark, Color labelColor) {
    const double tileH = 92;
    if (_denied) {
      return SizedBox(
        height: 180,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.photo_library_outlined,
                  size: 30, color: labelColor),
              const SizedBox(height: 10),
              Text("需要相册权限才能显示照片",
                  style: TextStyle(fontSize: 12, color: labelColor)),
              const SizedBox(height: 10),
              TextButton(
                onPressed: () => unawaited(openAppSettings()),
                child: const Text("去设置"),
              ),
            ],
          ),
        ),
      );
    }
    if (_loading) {
      return const SizedBox(
        height: 180,
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (_assets.isEmpty) {
      return SizedBox(
        height: 180,
        child: Center(
          child: Text("相册还没有照片",
              style: TextStyle(fontSize: 12, color: labelColor)),
        ),
      );
    }
    return SizedBox(
      height: tileH * 2 + 8 + 12,
      child: GridView.builder(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
        physics: const BouncingScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 4,
          mainAxisSpacing: 4,
          crossAxisSpacing: 4,
          childAspectRatio: 1,
        ),
        itemCount: _assets.length,
        itemBuilder: (BuildContext context, int index) {
          final AssetEntity asset = _assets[index];
          final Uint8List? thumb = _thumbs[asset.id];
          final bool selected = _selectedIds.contains(asset.id);
          return GestureDetector(
            onTap: () => _onTapTile(asset),
            child: Stack(
              fit: StackFit.expand,
              children: <Widget>[
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: thumb == null
                      ? Container(color: dark ? const Color(0xFF232323) : p.divider)
                      : Image.memory(thumb, fit: BoxFit.cover, gaplessPlayback: true),
                ),
                Positioned(
                  right: 4,
                  bottom: 4,
                  child: Container(
                    width: 18,
                    height: 18,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: selected
                          ? Colors.white
                          : Colors.black.withValues(alpha: 0.35),
                      border: Border.all(color: Colors.white, width: 2),
                    ),
                    child: selected
                        ? const Icon(Icons.check, size: 13, color: Colors.black)
                        : null,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
