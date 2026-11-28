import "dart:async";
import "dart:convert";
import "dart:io"
    show HttpClient, HttpClientRequest, HttpClientResponse, WebSocket;
import "dart:math" as math;
import "dart:typed_data";
import "dart:ui" as ui;

import "package:flutter/material.dart";

import "../../core/config/api_config.dart";

/// 蒙版随头相似变换（服务端逐帧下发，512 帧像素空间）：
/// 当前点 = [a,-b; b,a]·中性点 + (tx,ty)。中性蒙版经此变换后始终贴住人物。
class _MaskPose {
  const _MaskPose({
    required this.a,
    required this.b,
    required this.tx,
    required this.ty,
  });

  final double a;
  final double b;
  final double tx;
  final double ty;

  bool get isIdentity => a == 1.0 && b == 0.0 && tx == 0.0 && ty == 0.0;
}

/// 数字人实时画面：直连本地 avatar-talk-service 的 WebSocket 逐帧推流。
///
/// 协议（与 `avatar-talk-service/static/index.html` 一致）：
/// - 文本帧：JSON 控制消息（`ready` / `avatar_changed` / `error` …）；
/// - 二进制帧：`<uint32 idx LE><uint16 ts LE>` 6 字节头 + JPEG；
///   `ts == 0xFFFF` 为空闲微动帧（呼吸/眨眼），其余为说话同步帧。
///
/// 渲染策略：只画「最新一帧」（解码完上一帧才收下一帧，落后的直接丢弃），
/// 不做音频同步播放——头像是常驻微动画面，不是播放器。
/// 断线自动重连；10s 收不到任何帧视为连接假死，强制重连。
class DigitalHumanLiveView extends StatefulWidget {
  const DigitalHumanLiveView({
    super.key,
    this.fit = BoxFit.cover,
    this.alignment = Alignment.topCenter,
    this.liveActive,
  });

  /// 测试 / 无服务场景开关：false 时视觉组件直接只用静态兜底图。
  static bool globallyEnabled = true;

  final BoxFit fit;
  final Alignment alignment;

  /// 实时帧是否在画（true=有帧，false=断流/无帧）。宿主据此决定
  /// 是否显示静态兜底层——背景透明化后实时层会透出底下的东西。
  final ValueNotifier<bool>? liveActive;

  @override
  State<DigitalHumanLiveView> createState() => _DigitalHumanLiveViewState();
}

class _DigitalHumanLiveViewState extends State<DigitalHumanLiveView> {
  static const Duration _reconnectDelay = Duration(seconds: 2);
  static const Duration _staleTimeout = Duration(seconds: 10);

  WebSocket? _socket;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _staleTimer;
  bool _disposed = false;
  bool _decoding = false;

  ui.Image? _frame;
  // 人物 alpha 蒙版（背景透明化）：按 mask_rev 增量拉取一次，逐帧 dstIn 合成
  ui.Image? _mask;
  int _maskRev = -1;
  // 蒙版随头变换：服务端在每帧二进制之前按序推送 pose JSON，
  // WS 顺序保证与紧随的帧配对；无 pose（旧服务/无蒙版）时按静态蒙版渲染。
  _MaskPose? _pose;

  String get _wsUrl {
    final String base = ApiConfig.digitalHumanBase;
    final String wsBase = base
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://");
    return "$wsBase/ws";
  }

  @override
  void initState() {
    super.initState();
    _connect();
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _staleTimer?.cancel();
    _subscription?.cancel();
    try {
      _socket?.close();
    } catch (_) {
      /* 已断开 */
    }
    _frame?.dispose();
    _mask?.dispose();
    super.dispose();
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    // 断线即作废蒙版版本号：对端可能是重启过的新服务进程（mask_rev 重新
    // 从 1 计数），按「rev 相同就跳过」会把旧蒙版永久留在手上。
    _maskRev = -1;
    _reconnectTimer = Timer(_reconnectDelay, _connect);
  }

  Future<void> _connect() async {
    if (_disposed) return;
    try {
      final WebSocket socket = await WebSocket.connect(_wsUrl);
      if (_disposed) {
        socket.close();
        return;
      }
      _socket = socket;
      _armStaleWatchdog();
      _subscription = socket.listen(
        (dynamic data) {
          if (data is String) {
            _handleJson(data);
          } else if (data is Uint8List) {
            _handleBinary(data);
          } else if (data is List<int>) {
            _handleBinary(Uint8List.fromList(data));
          }
        },
        onError: (Object _) => _scheduleReconnect(),
        onDone: () {
          if (_disposed) return;
          _subscription = null;
          _socket = null;
          _scheduleReconnect();
        },
      );
    } catch (_) {
      // 服务未就绪 / 引擎加载中：静默重试，父组件的静态兜底图继续显示。
      _scheduleReconnect();
    }
  }

  /// 服务端会把「发不出去帧」的连接直接丢弃；本地场景下若 10s 无帧，
  /// 视为连接假死（窗口休眠唤醒、引擎重载等），强制重建。
  void _armStaleWatchdog() {
    _staleTimer?.cancel();
    _staleTimer = Timer(_staleTimeout, () {
      if (_disposed) return;
      _subscription?.cancel();
      _subscription = null;
      try {
        _socket?.close();
      } catch (_) {
        /* ignore */
      }
      _socket = null;
      _scheduleReconnect();
    });
  }

  void _handleJson(String raw) {
    try {
      final Map<String, dynamic> msg =
          jsonDecode(raw) as Map<String, dynamic>;
      final String type = msg["type"] as String? ?? "";
      if (type == "avatar_changed") {
        // 头像热切换：旧帧作废，等下一帧新画面。
        if (mounted) setState(() => _frame = null);
        widget.liveActive?.value = false;
        _maybeFetchMask(msg["mask_rev"]);
      } else if (type == "ready") {
        _maybeFetchMask(msg["mask_rev"]);
      } else if (type == "pose") {
        final num? a = msg["a"] as num?;
        final num? b = msg["b"] as num?;
        final num? tx = msg["tx"] as num?;
        final num? ty = msg["ty"] as num?;
        if (a != null && b != null && tx != null && ty != null) {
          _pose = _MaskPose(
            a: a.toDouble(),
            b: b.toDouble(),
            tx: tx.toDouble(),
            ty: ty.toDouble(),
          );
        }
      }
    } catch (_) {
      /* 非 JSON 控制消息，忽略 */
    }
  }

  void _maybeFetchMask(Object? rev) {
    final int? parsed = rev is int ? rev : int.tryParse("$rev");
    if (parsed == null || parsed == _maskRev) return;
    unawaited(_fetchMask(parsed));
  }

  /// 拉一次人物 alpha 蒙版（RGBA PNG，alpha=羽化人物区）。
  /// 404（分割不可用）时保持无蒙版 → 帧按不透明渲染，同旧行为。
  Future<void> _fetchMask(int rev) async {
    try {
      final HttpClient client = HttpClient()
        ..connectionTimeout = const Duration(seconds: 5);
      final HttpClientRequest request = await client
          .getUrl(Uri.parse("${ApiConfig.digitalHumanBase}/api/avatar/mask"));
      final HttpClientResponse response = await request.close();
      if (_disposed || response.statusCode != 200) {
        client.close();
        return;
      }
      final BytesBuilder builder = BytesBuilder(copy: false);
      await for (final List<int> chunk in response) {
        builder.add(chunk);
      }
      client.close();
      final ui.Codec codec = await ui.instantiateImageCodec(
        builder.takeBytes(),
        targetWidth: 720,
      );
      final ui.FrameInfo info = await codec.getNextFrame();
      codec.dispose();
      if (_disposed) {
        info.image.dispose();
        return;
      }
      final ui.Image? previous = _mask;
      setState(() {
        _maskRev = rev;
        _mask = info.image;
      });
      previous?.dispose();
    } catch (_) {
      /* 蒙版拉取失败：保持不透明 */
    }
  }

  Future<void> _handleBinary(Uint8List bytes) async {
    if (_disposed || bytes.length <= 6) return;
    _armStaleWatchdog();
    if (_decoding) return; // 上一帧还没解完：丢帧，只追最新。
    _decoding = true;
    try {
      final Uint8List jpeg = Uint8List.sublistView(bytes, 6);
      final ui.Codec codec =
          await ui.instantiateImageCodec(jpeg, targetWidth: 720);
      final ui.FrameInfo info = await codec.getNextFrame();
      codec.dispose();
      if (_disposed) {
        info.image.dispose();
        return;
      }
      final ui.Image? previous = _frame;
      if (mounted) {
        setState(() => _frame = info.image);
        widget.liveActive?.value = true;
      } else {
        info.image.dispose();
      }
      previous?.dispose();
    } catch (_) {
      /* 坏帧丢弃 */
    } finally {
      _decoding = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ui.Image? frame = _frame;
    if (frame == null) return const SizedBox.expand();
    return CustomPaint(
      // 与 RawImage 同尺寸语义：无约束时按图片固有尺寸占位
      size: Size(frame.width.toDouble(), frame.height.toDouble()),
      painter: _MatteFramePainter(
        frame: frame,
        mask: _mask,
        pose: _pose,
        fit: widget.fit,
        alignment: widget.alignment,
      ),
    );
  }
}

/// 帧绘制 + 人物蒙版合成：saveLayer 后帧在上、蒙版以 dstIn 写入 alpha，
/// 人物边缘外全部透明（蒙版为空时等于不透明直绘，同旧行为）。
/// 蒙版经 pose 相似变换随头移动（服务端逐帧下发），歪头/转头时
/// 轮廓始终贴住人物，上传照片的背景像素零暴露。
class _MatteFramePainter extends CustomPainter {
  _MatteFramePainter({
    required this.frame,
    required this.mask,
    required this.pose,
    required this.fit,
    required this.alignment,
  });

  final ui.Image frame;
  final ui.Image? mask;
  final _MaskPose? pose;
  final BoxFit fit;
  final Alignment alignment;

  @override
  void paint(Canvas canvas, Size size) {
    final ui.Rect src = ui.Rect.fromLTWH(
      0, 0, frame.width.toDouble(), frame.height.toDouble(),
    );
    final ui.Rect dst = alignment.inscribe(
      applyBoxFit(fit, src.size, size).destination,
      Offset.zero & size,
    );
    final Paint imagePaint = Paint()
      ..filterQuality = FilterQuality.medium;
    canvas.saveLayer(null, Paint());
    canvas.drawImageRect(frame, src, dst, imagePaint);
    final ui.Image? mask = this.mask;
    if (mask != null) {
      final ui.Rect maskSrc = ui.Rect.fromLTWH(
        0, 0, mask.width.toDouble(), mask.height.toDouble(),
      );
      final _MaskPose? pose = this.pose;
      final ui.Rect maskDst = ui.Rect.fromLTWH(
        0, 0, _frameNativeSize, _frameNativeSize,
      );
      canvas.save();
      // 帧与蒙版都解码自服务端方形帧（原生 _frameNativeSize，解码放大不
      // 改变相对几何）：先映射到原生 512 空间，再施加相似变换。
      canvas.translate(dst.left, dst.top);
      canvas.scale(dst.width / _frameNativeSize, dst.height / _frameNativeSize);
      if (pose != null && !pose.isIdentity) {
        canvas.translate(pose.tx, pose.ty);
        canvas.rotate(math.atan2(pose.b, pose.a));
        final double s = math.sqrt(pose.a * pose.a + pose.b * pose.b);
        canvas.scale(s, s);
      }
      canvas.drawImageRect(
        mask,
        maskSrc,
        maskDst,
        Paint()
          ..blendMode = BlendMode.dstIn
          ..filterQuality = FilterQuality.medium,
      );
      canvas.restore();
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _MatteFramePainter oldDelegate) {
    return oldDelegate.frame != frame ||
        oldDelegate.mask != mask ||
        oldDelegate.pose != pose;
  }
}

/// 服务端渲染帧的原生边长（decoder 输出方形区），pose 平移量的参考空间。
const double _frameNativeSize = 512.0;
