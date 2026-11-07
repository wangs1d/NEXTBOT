import "dart:io";

import "package:file_picker/file_picker.dart";
import "package:flutter/foundation.dart" show kIsWeb;
import "package:image_picker/image_picker.dart";

import "vision_user_limits.dart";
import "vision_wire_frame.dart";

/// 与平台无关的选图结果（字节 + 文件名 + 可选本地路径）。
class PickedImage {
  final String name;
  final List<int> bytes;
  final String? path;
  const PickedImage({required this.name, required this.bytes, this.path});
}

/// 手机端（Android/iOS）必须走系统相册选择器：file_picker 的 FileType.image
/// 在 Android 上打开的是文件管理器（DocumentsUI），找照片很不方便。
bool get _useGalleryPicker => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

Future<PickedImage?> _fromXFile(XFile f) async {
  final List<int> bytes = await f.readAsBytes();
  if (bytes.isEmpty) {
    return null;
  }
  return PickedImage(name: f.name, bytes: bytes, path: f.path);
}

Future<PickedImage?> _fromPlatformFile(PlatformFile f) async {
  if (f.bytes != null && f.bytes!.isNotEmpty) {
    return PickedImage(name: f.name, bytes: f.bytes!, path: f.path);
  }
  final String? path = f.path;
  if (path == null || path.isEmpty) {
    return null;
  }
  final File file = File(path);
  if (!await file.exists()) {
    return null;
  }
  final List<int> bytes = await file.readAsBytes();
  if (bytes.isEmpty) {
    return null;
  }
  return PickedImage(name: f.name, bytes: bytes, path: path);
}

/// 单选一张图（供用户主动发给 Agent；与摄像头静默抓拍并行）：
/// 手机端打开系统相册，桌面端仍走文件选择器。
Future<PickedImage?> pickGalleryImage() async {
  if (_useGalleryPicker) {
    final XFile? f =
        await ImagePicker().pickImage(source: ImageSource.gallery);
    if (f == null) return null;
    return _fromXFile(f);
  }
  final FilePickerResult? r = await FilePicker.platform.pickFiles(
    type: FileType.image,
    withData: true,
  );
  if (r == null || r.files.isEmpty) {
    return null;
  }
  return _fromPlatformFile(r.files.first);
}

/// 多选图片，最多 [maxCount] 张（缺省与 Agent 视觉上限一致）：
/// 手机端打开系统相册，桌面端仍走文件选择器。
Future<List<PickedImage>> pickGalleryImages({int? maxCount}) async {
  final int limit = maxCount ?? kAgentUserVisionMaxFrames;
  if (_useGalleryPicker) {
    final List<XFile> files =
        await ImagePicker().pickMultiImage(limit: limit);
    final List<PickedImage> out = <PickedImage>[];
    for (final XFile f in files) {
      if (out.length >= limit) break;
      final PickedImage? one = await _fromXFile(f);
      if (one != null) {
        out.add(one);
      }
    }
    return out;
  }
  final FilePickerResult? r = await FilePicker.platform.pickFiles(
    type: FileType.image,
    allowMultiple: true,
    withData: true,
  );
  if (r == null || r.files.isEmpty) {
    return <PickedImage>[];
  }
  final List<PickedImage> out = <PickedImage>[];
  for (final PlatformFile f in r.files) {
    if (out.length >= limit) break;
    final PickedImage? one = await _fromPlatformFile(f);
    if (one != null) {
      out.add(one);
    }
  }
  return out;
}

VisionWireFrame _frameFromPicked(PickedImage p) {
  return VisionWireFrame(
    sourceKind: "agent_attachment",
    sourceId: "gallery:${p.path ?? p.name}",
    mimeType: sniffImageMimeType(p.bytes, pathHint: p.path ?? p.name),
    bytes: p.bytes,
    capturedAt: DateTime.now().toUtc().toIso8601String(),
  );
}

/// 从相册/文件选取一张图（供用户主动发给 Agent；与摄像头静默抓拍并行）。
Future<VisionWireFrame?> pickGalleryVisionWireFrame() async {
  final PickedImage? p = await pickGalleryImage();
  if (p == null) {
    return null;
  }
  return _frameFromPicked(p);
}

/// 多选相册/文件，最多 [kAgentUserVisionMaxFrames] 张，一次 `chat.user_message` 多帧。
Future<List<VisionWireFrame>> pickGalleryVisionWireFrames() async {
  final List<PickedImage> picked = await pickGalleryImages();
  return <VisionWireFrame>[
    for (final PickedImage p in picked) _frameFromPicked(p),
  ];
}
