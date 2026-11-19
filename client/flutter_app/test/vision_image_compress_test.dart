import "dart:typed_data";

import "package:flutter_test/flutter_test.dart";
import "package:image/image.dart" as img;

import "package:nextbot/core/vision/vision_image_compress.dart";
import "package:nextbot/core/vision/vision_user_limits.dart";
import "package:nextbot/core/vision/vision_wire_frame.dart";

Uint8List _noisyPhoto() {
  final img.Image image = img.Image(width: 2400, height: 1800);
  int seed = 20261118;
  for (int y = 0; y < image.height; y++) {
    for (int x = 0; x < image.width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      image.setPixelRgb(
        x,
        y,
        seed & 0xff,
        (seed >> 8) & 0xff,
        (seed >> 16) & 0xff,
      );
    }
  }
  return img.encodePng(image);
}

void main() {
  test("大图压到服务端单帧上限内，且最长边不超过 2048", () {
    final Uint8List original = _noisyPhoto();
    expect(original.length, greaterThan(kAgentUserVisionMaxBytesPerFrame));

    final Uint8List sent = compressVisionImageBytesSync(original);

    expect(sent.length, lessThanOrEqualTo(kAgentUserVisionMaxBytesPerFrame));
    expect(sent.length, lessThan(original.length));
    expect(sniffImageMimeType(sent), "image/jpeg");

    final img.Image? decoded = img.decodeImage(sent);
    expect(decoded, isNotNull);
    expect(decoded!.width, lessThanOrEqualTo(kAgentUserVisionMaxEdgePx));
    expect(decoded.height, lessThanOrEqualTo(kAgentUserVisionMaxEdgePx));
  });

  test("发送目标字节数小于服务端默认单帧上限", () {
    expect(kAgentUserVisionMaxBytesPerFrame, lessThan(4 * 1024 * 1024));
  });
}
