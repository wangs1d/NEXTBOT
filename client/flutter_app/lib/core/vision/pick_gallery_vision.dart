import "dart:io";
import "dart:typed_data";

import "package:file_picker/file_picker.dart";
import "package:flutter/foundation.dart" show kIsWeb;
import "package:image_picker/image_picker.dart";

import "vision_image_compress.dart";
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
///
/// 平台侧先按 2048px 降采样，避免把 12MP 原图读进内存；
/// 后续 [_frameFromPicked] 再做字节级兜底压缩。
Future<PickedImage?> pickGalleryImage() async {
  if (_useGalleryPicker) {
    final XFile? f = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: kAgentUserVisionMaxEdgePx.toDouble(),
      maxHeight: kAgentUserVisionMaxEdgePx.toDouble(),
      imageQuality: 88,
    );
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
    final List<XFile> files = await ImagePicker().pickMultiImage(
      limit: limit,
      maxWidth: kAgentUserVisionMaxEdgePx.toDouble(),
      maxHeight: kAgentUserVisionMaxEdgePx.toDouble(),
      imageQuality: 88,
    );
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

/// 选图字节 → 服务端可直接消费的视觉帧。
/// 所有入口（相册/附件面板/相机）共用这里，确保不会把原图 base64 上 WS。
Future<VisionWireFrame> _frameFromPicked(PickedImage p) async {
  final Uint8List sendBytes = await compressVisionImageBytes(p.bytes);
  return VisionWireFrame(
    sourceKind: "agent_attachment",
    sourceId: "gallery:${p.path ?? p.name}",
    mimeType: sniffImageMimeType(sendBytes, pathHint: p.path ?? p.name),
    bytes: sendBytes,
    capturedAt: DateTime.now().toUtc().toIso8601String(),
  );
}

/// 「本地文件」入口：走系统文件管理器（Android 上是 DocumentsUI），而非相册。
/// 与 [pickGalleryImage] 的区别：手机端也用 file_picker 打开文件管理器，
/// 用户可从 Download 等任意目录选图。视觉通道仅支持图片，故 FileType.image
/// 过滤；任意文件（PDF 等）没有发送通道（MessageAttachment 目前只有 audio），
/// 需要时是独立的新功能。
Future<VisionWireFrame?> pickLocalFileVisionWireFrame() async {
  final FilePickerResult? r = await FilePicker.platform.pickFiles(
    type: FileType.image,
    withData: true,
  );
  if (r == null || r.files.isEmpty) {
    return null;
  }
  final PickedImage? p = await _fromPlatformFile(r.files.first);
  if (p == null) {
    return null;
  }
  return _frameFromPicked(p);
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
  final List<VisionWireFrame> out = <VisionWireFrame>[];
  for (final PickedImage p in picked) {
    out.add(await _frameFromPicked(p));
  }
  return out;
}

/// 调起系统相机拍一张，作为 `device_camera` 帧随消息发给 Agent。
///
/// 与相册帧走同一条 `chat.user_message` / visionFrames 通道，服务端已支持。
Future<VisionWireFrame?> pickCameraVisionWireFrame() async {
  final XFile? f = await ImagePicker().pickImage(
    source: ImageSource.camera,
    maxWidth: kAgentUserVisionMaxEdgePx.toDouble(),
    maxHeight: kAgentUserVisionMaxEdgePx.toDouble(),
    imageQuality: 88,
  );
  if (f == null) return null;
  final PickedImage? p = await _fromXFile(f);
  if (p == null) return null;
  final VisionWireFrame compressed = await _frameFromPicked(p);
  return VisionWireFrame(
    sourceKind: "device_camera",
    sourceId: "camera:${p.path ?? p.name}",
    mimeType: compressed.mimeType,
    bytes: compressed.bytes,
    capturedAt: DateTime.now().toUtc().toIso8601String(),
  );
}

/// 把本地相册选出的字节构造成一张 `agent_attachment` 帧。
///
/// 供底部附件面板的相册网格调用：网格 thumbnail 只用于展示，
/// 真正发送时读原尺寸图字节走这里，再统一压到发送上限。
Future<VisionWireFrame> frameFromGalleryBytes(
  List<int> bytes, {
  required String name,
  String? path,
}) async {
  return _frameFromPicked(
    PickedImage(name: name, bytes: bytes, path: path),
  );
}
