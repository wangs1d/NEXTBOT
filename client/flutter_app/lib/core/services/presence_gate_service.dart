import "dart:async";
import "dart:convert";

import "package:camera/camera.dart";
import "package:http/http.dart" as http;

import "nb_http.dart";

import "../config/api_config.dart";

/// 开机简报在座检测（摄像头门禁）。
///
/// 流程：摄像头抓拍一帧 → POST /api/presence/detect（服务端视觉模型判定
/// 「用户是否正坐在电脑前」）→ true/false；无法判定返回 null（无摄像头、
/// 初始化失败、服务不可用等）。
///
/// 失败语义（与产品决策一致）：
///   - null（无法判定）→ 调用方直接放行播报（等价于"没有摄像头开机即播"）；
///   - false（确认无人）→ 调用方继续轮询等待，直到有人在座或超时。
class PresenceGateService {
  PresenceGateService._();

  /// 设备是否有可用摄像头；插件缺失/异常按无摄像头处理。
  static Future<bool> hasCamera() async {
    try {
      final List<CameraDescription> cameras = await availableCameras();
      return cameras.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  /// 抓拍一帧并在座判定。
  /// 返回 true/false = 判定结论；null = 无法判定（不放行也不拦截，由调用方定夺）。
  static Future<bool?> detectPresentOnce({required String sessionId}) async {
    CameraController? controller;
    try {
      final List<CameraDescription> cameras = await availableCameras();
      if (cameras.isEmpty) return null;
      controller = CameraController(
        cameras.first,
        ResolutionPreset.low,
        enableAudio: false,
      );
      await controller.initialize();
      final XFile file = await controller.takePicture();
      final List<int> bytes = await file.readAsBytes();
      final http.Response res = await NbHttp.post(
            Uri.parse("${ApiConfig.httpBase}/api/presence/detect"),
            headers: const <String, String>{
              "Content-Type": "application/json",
            },
            body: jsonEncode(<String, dynamic>{
              "sessionId": sessionId,
              "imageBase64": base64Encode(bytes),
              "mimeType": "image/jpeg",
            }),
          )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return null;
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (data["ok"] != true) return null;
      return data["present"] == true;
    } catch (_) {
      return null;
    } finally {
      try {
        await controller?.dispose();
      } catch (_) {
        // dispose 失败无害
      }
    }
  }

  /// 轮询等待「用户坐在电脑前」。
  ///
  /// 返回 true = 可播报（在座确认，或首轮即无法判定——视为等价"无摄像头"放行）；
  /// 返回 false = 超时仍未确认在座（[shouldAbort] 中止同样返回 false）。
  ///
  /// [shouldAbort]：等待期间逐轮检查的外部中止条件（如简报已被其他渠道投递）。
  static Future<bool> waitUntilPresent({
    required String sessionId,
    required Duration maxWait,
    Duration interval = const Duration(seconds: 8),
    FutureOr<bool> Function()? shouldAbort,
  }) async {
    final DateTime deadline = DateTime.now().add(maxWait);
    while (true) {
      if (shouldAbort != null && await shouldAbort()) return false;
      final bool? verdict = await detectPresentOnce(sessionId: sessionId);
      // 首轮即无法判定（无摄像头/服务不可用）→ 直接放行，不等不拦
      if (verdict == null) return true;
      if (verdict) return true;
      if (DateTime.now().isAfter(deadline)) return false;
      try {
        await Future<void>.delayed(interval);
      } catch (_) {
        return false;
      }
    }
  }
}
