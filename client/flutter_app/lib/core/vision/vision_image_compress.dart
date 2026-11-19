import "dart:math" as math;
import "dart:typed_data";

import "package:flutter/foundation.dart" show compute;
import "package:image/image.dart" as img;

import "vision_user_limits.dart";

/// 发送前把手机相册/相机图片压到服务端单帧上限内。
///
/// 主流视觉管线做法：先按最长边降采样，再逐级降低 JPEG 质量；
/// 不用调大服务端 `AGENT_VISION_MAX_BYTES_PER_FRAME`，也不把原图 base64
/// 塞进 WebSocket。`image` 解码器会一并把 EXIF 方向烘焙进像素，避免模型
/// 看到横躺的照片。
///
/// 目标字节数见 [kAgentUserVisionMaxBytesPerFrame]（3MiB，对服务端 4MiB
/// 留 1MiB 余量）；极小图直接放行，省一次isolate + 重编码。
const List<int> _kEdgeSteps = <int>[
  kAgentUserVisionMaxEdgePx,
  1600,
  1280,
  960,
];

const List<int> _kQualitySteps = <int>[85, 75, 65, 55];

/// 在后台 isolate 压缩大图，避免 12MP 解码/编码卡住聊天页。
Future<Uint8List> compressVisionImageBytes(List<int> bytes) async {
  final Uint8List input = Uint8List.fromList(bytes);
  if (input.isEmpty || input.length <= kAgentUserVisionSkipBytes) {
    return input;
  }
  return compute(_compressVisionImageSync, input);
}

/// 同步版本：供单元测试和小图路径使用。
Uint8List compressVisionImageBytesSync(List<int> bytes) =>
    _compressVisionImageSync(Uint8List.fromList(bytes));

Uint8List _compressVisionImageSync(Uint8List input) {
  final img.Image? decoded = img.decodeImage(input);
  if (decoded == null) {
    // 解码失败（不支持的格式/损坏文件）原样交服务端，由它给出明确错误。
    return input;
  }

  final int longestEdge = math.max(decoded.width, decoded.height);
  for (final int edge in _kEdgeSteps) {
    img.Image working = decoded;
    if (longestEdge > edge) {
      final double scale = edge / longestEdge;
      working = img.copyResize(
        decoded,
        width: math.max(1, (decoded.width * scale).round()),
        height: math.max(1, (decoded.height * scale).round()),
        interpolation: img.Interpolation.average,
        linearBlend: true,
      );
    }
    for (final int quality in _kQualitySteps) {
      final Uint8List out = img.encodeJpg(
        working,
        quality: quality,
        chroma: img.JpegChroma.yuv420,
      );
      if (out.length <= kAgentUserVisionMaxBytesPerFrame) {
        return out;
      }
    }
  }

  // 兜底：正常照片走不到这里，仍保证一个远低于上限的结果。
  final img.Image smallest = img.copyResize(
    decoded,
    width: 960,
    interpolation: img.Interpolation.average,
  );
  return img.encodeJpg(
    smallest,
    quality: 35,
    chroma: img.JpegChroma.yuv420,
  );
}
