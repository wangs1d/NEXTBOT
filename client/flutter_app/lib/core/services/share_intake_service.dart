import "dart:async";
import "dart:io" show File, Platform;

import "package:flutter/foundation.dart";
import "package:flutter/services.dart";

import "../vision/pick_gallery_vision.dart";
import "../vision/vision_user_limits.dart";
import "../vision/vision_wire_frame.dart";
import "../../mobile_ui/mobile_chat_controller.dart";
import "client_telemetry.dart";

/// 分享给管家（2026-11-23 PRD §8）：原生五种入口 → 既有聊天链路的唯一消费者。
///
/// 内容落地的路径只有一条，这是刻意的：
///   原生 [ShareIntakeStore] 队列 → `take` → 组装成一条 `chat.user_message`
///   → Agent 回「打算怎么做」→ 它自己把这件事建成日程 / 待办 / 账单 / 笔记。
/// 服务端不需要新端点：文本走 `text`，图片走 `visionFrames`（与相册发图同一个
/// sourceKind `agent_attachment`），建事项走的是聊天里本来就在用的工具。
/// 再造一个"分享专用"入口就会有两套身份解析、两套去重、两套失败补投。
///
/// 半屏速记卡（长按快捷方式 / 磁贴 / 通知按钮要的「记一下」）不在这里画：
/// 那是 UI，走 [onEntryRequest] 交给 main.dart 注册的处理函数，本服务只负责
/// 「内容 → 消息」这一段，因此 Dart 侧任何界面都能复用同一条发送路径。
class ShareIntakeService {
  ShareIntakeService._();

  static final ShareIntakeService instance = ShareIntakeService._();

  static const MethodChannel _channel = MethodChannel("nextbot/share_intake");

  /// 当前对话控制器（手机主壳持有）。为 null 时内容留在原生队列里，
  /// `attachChat` 一进来就会补取——冷启动时分享比主壳先到是常态。
  MobileChatController? _chat;

  bool _started = false;
  bool _draining = false;

  /// 入口提示的处理钩子（quick_note / ask_note / voice_note → 半屏速记卡）。
  /// camera_note 不经过它：拍一下直接开相机，回来就发，不多一次点击。
  void Function(String entry)? onEntryRequest;

  /// 跳页路由的处理钩子（桌面小组件各区域，PRD §5.3）。
  ///
  /// 与 [onEntryRequest] 同一条队列、同一次 `take`：原生只多存了一个 route 字段，
  /// Dart 只多一个消费者，不为此新建第二套原生↔Dart 通道。
  void Function(String route)? onRouteRequest;

  /// 厂商推送点开（2026-11-25「点通知直达」）：华为通知的 click_action 深链把
  /// intentId/deliveryId 带进同一条原生队列。intentId 非空 = 这是一条要点开
  /// 处理的决策（拉取意图端半屏页）；为空 = 只把用户带到对话页看那条内容。
  void Function(String intentId, String deliveryId)? onPushOpen;

  /// bootstrap 调用（仅 Android，幂等）。装上原生推送的回调并试取一次存量。
  Future<void> start() async {
    if (_started || kIsWeb || !Platform.isAndroid) return;
    _started = true;
    _channel.setMethodCallHandler(_onNativeCall);
    await drain();
  }

  /// 手机主壳建好对话控制器后接上（登出时传 null 断开）。
  void attachChat(MobileChatController? controller) {
    _chat = controller;
    if (controller != null) unawaited(drain());
  }

  bool get hasChat => _chat != null;

  Future<Object?> _onNativeCall(MethodCall call) async {
    // 原生只在「有新东西」时推一次，具体取什么由 drain 一次说清
    if (call.method == "onReady") unawaited(drain());
    return null;
  }

  /// 取走原生队列里的分享内容 + 入口提示。可重复调用：队列取走即清空。
  ///
  /// 对话未就绪时**不取**：`take` 是取走即清空的语义，主壳还没建好（冷启动
  /// 停在登录页 / 会话还在恢复）就取走等于把用户分享的东西弄丢。留在原生，
  /// [attachChat] 之后第一次 drain 会补上。
  Future<void> drain() async {
    if (_draining || kIsWeb || !Platform.isAndroid) return;
    if (_chat == null) return;
    _draining = true;
    try {
      final Map<Object?, Object?>? raw =
          await _channel.invokeMethod<Map<Object?, Object?>>("take");
      if (raw == null) return;
      // 引擎还没起来的推送会丢，但队列还在：attachChat 之后这一句会补上
      final List<Object?> shares =
          (raw["shares"] as List<Object?>?) ?? const <Object?>[];
      final String? entry = raw["entry"] as String?;
      // 跳页先于弹卡：小组件一条点按可能同时带 route 与 entry（「记一下」就是），
      // 要看到的是「落到了那一屏 + 卡弹出来」，而不是「卡弹在旧屏上」。
      final String? route = raw["route"] as String?;
      if (route != null && route.isNotEmpty) onRouteRequest?.call(route);
      // 厂商推送点开：深链带的 intentId/deliveryId 与 route 同批取出。
      // 先切页后的先后不重要——决策半屏页挂在主壳导航器上，切 tab 不影响它。
      final String pushIntent = (raw["pushIntent"] as String?) ?? "";
      final String pushDelivery = (raw["pushDelivery"] as String?) ?? "";
      if (pushIntent.isNotEmpty || pushDelivery.isNotEmpty) {
        onPushOpen?.call(pushIntent, pushDelivery);
      }
      for (final Object? item in shares) {
        if (item is! Map) continue;
        final Map<Object?, Object?> s = item;
        final String text = (s["text"] ?? "").toString();
        final String source = (s["source"] ?? "share_text").toString();
        final List<String> images = (s["images"] as List<Object?>?)
                ?.map((Object? e) => e.toString())
                .where((String p) => p.isNotEmpty)
                .toList() ??
            <String>[];
        ClientEventTelemetry.track(
          // §12.1 分享漏斗的入口一半：收到并准备进对话
          "share_ingest_started",
          props: <String, Object>{"source": source, "images": images.length},
        );
        await _submitShare(
          text: text,
          subject: (s["subject"] ?? "").toString(),
          source: source,
          imagePaths: images,
        );
        // 抄进缓存的截图用完即删：这是别人的相册内容，不该在本应用目录里过夜
        if (images.isNotEmpty) await _clean(images);
      }
      if (entry != null && entry.isNotEmpty) await _onEntry(entry);
    } catch (e) {
      debugPrint("[share-intake] 取件失败: $e");
    } finally {
      _draining = false;
    }
  }

  Future<void> _onEntry(String entry) async {
    if (entry == "camera_note") {
      // 拍一下：不开速记卡，直接开相机，拍完即发（§8.4 ≤3 次点击）
      try {
        final VisionWireFrame? frame = await pickCameraVisionWireFrame();
        if (frame != null) {
          await submit(
            // 与系统分享图片同一条措辞：那句「打算怎么做」才是这一期的交付物，
            // 少了它管家只会回一句「收到一张照片」。
            text: compose(
              text: "",
              subject: "",
              source: "camera_note",
              hasImages: true,
            ),
            frames: <VisionWireFrame>[frame],
            source: "camera_note",
          );
          return;
        }
      } catch (e) {
        debugPrint("[share-intake] 拍一下开相机失败: $e");
      }
    }
    onEntryRequest?.call(entry);
  }

  Future<void> _clean(List<String> paths) async {
    try {
      await _channel.invokeMethod<bool>("clean", <String, Object?>{"paths": paths});
    } catch (_) {/* 缓存目录留着也只是占地方，系统会清 */}
  }

  /// 一条分享内容 → 一条用户消息。文本/图片任意一个非空即可。
  Future<void> _submitShare({
    required String text,
    required String subject,
    required String source,
    required List<String> imagePaths,
  }) async {
    final List<VisionWireFrame> frames = <VisionWireFrame>[];
    for (final String path in imagePaths.take(kAgentUserVisionMaxFrames)) {
      try {
        final File f = File(path);
        if (!await f.exists()) continue;
        final List<int> bytes = await f.readAsBytes();
        if (bytes.isEmpty) continue;
        // 与相册发图同一个压缩口径：分享来的原图动辄 4000px，直传 base64 会把
        // WS 帧撑爆，服务端视觉管线也有自己的边长上限。
        frames.add(await frameFromGalleryBytes(
          bytes,
          name: path.split("/").last,
          path: path,
        ));
      } catch (e) {
        debugPrint("[share-intake] 读分享图片失败 $path: $e");
      }
    }
    await submit(
      text: compose(text: text, subject: subject, source: source, hasImages: frames.isNotEmpty),
      frames: frames,
      source: source,
    );
  }

  /// 组装发给管家的那句话：内容原样带上，末尾一句「你打算怎么做」。
  ///
  /// 这一问就是 §8 的验收项——用户要看到的是管家打算怎么办，而不是它又反问一句。
  /// 措辞按来源分三种：分享文本、圈选的文字、图片（可能配一段文字）。
  static String compose({
    required String text,
    required String subject,
    required String source,
    required bool hasImages,
  }) {
    const String ask = "\n——这个你打算怎么做？先用一句话说清你会把它变成什么"
        "（日程 / 待办 / 账单 / 收藏 / 记住一件事），然后就去做，别反问我。";
    final String body = text.trim();
    final String head = subject.trim().isEmpty ? "" : "${subject.trim()}\n";
    if (hasImages) {
      // 图 + 文都到（浏览器/微信分享常两个都带），只提一个就等于把用户的上下文丢了
      final String from =
          (source == "quick_note" || source == "camera_note")
              ? "刚拍给你"
              : "刚分享给你";
      final String caption = body.isEmpty
          ? "$head这是$from的图片。"
          : "$head这是$from的图片，随图的话是：$body";
      return "$caption$ask";
    }
    if (source == "process_text") {
      return "$head我把这段文字圈给你了：\n$body$ask";
    }
    if (source == "quick_note") {
      // 用户自己写的一句话，不是「分享」来的：措辞跟着来源走，
      // 否则聊天里会出现一条「分享给你：明天带伞」这种不像人说的话。
      return "$head记一下：$body$ask";
    }
    return "$head分享给你：\n$body$ask";
  }

  /// 半屏速记卡 / 拍一下 的共同出口：内容进既有聊天链路。
  Future<void> submit({
    required String text,
    List<VisionWireFrame> frames = const <VisionWireFrame>[],
    String source = "quick_note",
  }) async {
    final MobileChatController? chat = _chat;
    if (chat == null) {
      // 主壳还没建（停在登录页 / 正在换账号）：说清丢了什么，而不是静默返回
      debugPrint("[share-intake] 对话未就绪，这条内容没发出去");
      ClientEventTelemetry.track(
        "share_ingest_failed",
        props: <String, Object>{"source": source, "reason": "no_chat"},
      );
      return;
    }
    if (text.trim().isEmpty && frames.isEmpty) return;
    try {
      await chat.send(text, visionFrames: frames.isEmpty ? null : frames);
      ClientEventTelemetry.track(
        "share_ingest_committed",
        props: <String, Object>{
          "source": source,
          "images": frames.length,
          "chars": text.length,
        },
      );
    } catch (e) {
      debugPrint("[share-intake] 发送失败($source): $e");
      ClientEventTelemetry.track(
        "share_ingest_failed",
        props: <String, Object>{"source": source, "reason": "send"},
      );
    }
  }
}
