import "dart:io" show Platform;

import "package:flutter/foundation.dart" show kIsWeb;
import "package:flutter/services.dart";

/// 支付宝 App 支付结果（与支付宝客户端 SDK 的 resultStatus 对齐）。
///
/// 9000 支付成功；8000 处理中/结果未知；6001 用户取消；4000 失败；
/// 5000 重复请求；6002 网络异常。**支付是否到账仍需服务端查单确认**。
class AlipayPayResult {
  const AlipayPayResult({
    required this.statusCode,
    required this.memo,
    required this.raw,
  });

  final String statusCode;
  final String memo;
  final String raw;

  bool get success => statusCode == "9000";
  bool get cancelled => statusCode == "6001";
  bool get pending => statusCode == "8000";

  String get displayMessage {
    if (success) return "支付成功";
    if (pending) return "支付结果确认中";
    if (cancelled) return "已取消支付";
    if (statusCode == "4000") return memo.isEmpty ? "支付失败" : memo;
    if (statusCode == "5000") return "重复请求，请稍后查询余额";
    if (statusCode == "6002") return "网络异常，请稍后重试";
    return memo.isEmpty ? "支付未完成（$statusCode）" : memo;
  }
}

/// 支付宝原生支付通道（Android：`nextbot/alipay`）。
///
/// 只有已安装支付宝时才走这里：订单串由服务端用 `alipay.trade.app.pay`
/// 签名生成，原生层调用 `PayTask.payV2` 直接唤起收银台。iOS/桌面不提供
/// 该通道，调用方应回退到手机浏览器 wap 收银台。
class AlipayPayService {
  AlipayPayService._();

  static const MethodChannel _channel = MethodChannel("nextbot/alipay");

  /// 当前平台是否支持原生支付宝支付（目前仅 Android）。
  static bool get isPlatformSupported => !kIsWeb && Platform.isAndroid;

  /// 是否已安装支付宝客户端（Android 11+ 依赖 Manifest `<queries>`）。
  static Future<bool> isInstalled() async {
    if (!isPlatformSupported) return false;
    try {
      return await _channel.invokeMethod<bool>("isInstalled") ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  /// 调起支付宝原生收银台。失败时返回 4000，由调用方提示。
  static Future<AlipayPayResult> pay(String orderInfo) async {
    if (!isPlatformSupported || orderInfo.trim().isEmpty) {
      return const AlipayPayResult(
        statusCode: "4000",
        memo: "当前设备不支持支付宝支付",
        raw: "",
      );
    }
    try {
      final Map<dynamic, dynamic>? map = await _channel.invokeMethod<Map<dynamic, dynamic>>(
        "pay",
        <String, String>{"orderInfo": orderInfo},
      );
      final String statusCode = map?["resultStatus"]?.toString() ?? "4000";
      return AlipayPayResult(
        statusCode: statusCode,
        memo: map?["memo"]?.toString() ?? "",
        raw: map?["result"]?.toString() ?? "",
      );
    } on MissingPluginException {
      return const AlipayPayResult(
        statusCode: "4000",
        memo: "支付宝支付通道未安装",
        raw: "",
      );
    } on PlatformException catch (e) {
      return AlipayPayResult(
        statusCode: "4000",
        memo: e.message ?? "支付宝支付失败",
        raw: "",
      );
    }
  }
}
