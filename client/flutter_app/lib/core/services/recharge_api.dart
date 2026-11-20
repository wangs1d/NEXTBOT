import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "access_auth_api.dart";
import "nb_http.dart";

/// App 内「额度充值」客户端（服务端：server/src/routes/http/recharge.ts 的
/// 统一支付接口 `/api/recharge/me`、`/api/recharge/payments`）。
///
/// 网页与 App 共用同一个下单接口：服务端按 Bearer/Cookie 识别身份，并按
/// 客户端能力选择 page / wap / app 三种收银台。App 侧直接用本机登录
/// access token 鉴权，不需要二次邮箱验证码。
class RechargeAccount {
  const RechargeAccount({
    required this.email,
    required this.masked,
    required this.balance,
  });

  final String email;
  final String masked;
  final String balance;

  static RechargeAccount fromJson(Map<String, dynamic> json) => RechargeAccount(
        email: json["email"]?.toString() ?? "",
        masked: json["masked"]?.toString() ?? "",
        balance: json["balance"]?.toString() ?? "0.00",
      );
}

/// 收银台可用的支付方式（服务端 `/api/recharge/config` 下发）。
///
/// 微信 App 支付链路尚未接入，服务端固定返回 false；客户端据此置灰，
/// 避免用户点到一个必然失败的通道。
class RechargeProviders {
  const RechargeProviders({required this.alipay, required this.wechat});

  final bool alipay;
  final bool wechat;

  static RechargeProviders fromJson(Map<String, dynamic> json) {
    final dynamic raw = json["providers"];
    final Map<dynamic, dynamic> map =
        raw is Map ? raw : const <dynamic, dynamic>{};
    return RechargeProviders(
      alipay: map["alipay"] == true,
      wechat: map["wechat"] == true,
    );
  }
}

class RechargeOrder {
  const RechargeOrder({
    required this.outTradeNo,
    required this.amount,
    required this.paymentUrl,
    required this.orderStr,
  });

  final String outTradeNo;
  final String amount;

  /// 手机浏览器收银台地址（wap 模式；外部浏览器打开）。
  final String? paymentUrl;

  /// 支付宝客户端 SDK 签名订单串（app 模式；直接唤起原生收银台）。
  final String? orderStr;

  static RechargeOrder fromJson(Map<String, dynamic> json) => RechargeOrder(
        outTradeNo: json["outTradeNo"]?.toString() ?? "",
        amount: json["amount"]?.toString() ?? "",
        paymentUrl: json["paymentUrl"]?.toString(),
        orderStr: json["orderStr"]?.toString(),
      );
}

class RechargeOrderStatus {
  const RechargeOrderStatus({
    required this.status,
    required this.amount,
    required this.balance,
    required this.paidAt,
  });

  /// paid / pending / closed
  final String status;
  final String amount;
  final String balance;
  final String? paidAt;

  static RechargeOrderStatus fromJson(Map<String, dynamic> json) =>
      RechargeOrderStatus(
        status: json["status"]?.toString() ?? "pending",
        amount: json["amount"]?.toString() ?? "0.00",
        balance: json["balance"]?.toString() ?? "0.00",
        paidAt: json["paidAt"]?.toString(),
      );
}

/// 统一结果：失败时 [message] 直接可展示给用户。
class RechargeResult<T> {
  const RechargeResult({required this.ok, this.data, this.message});

  /// 失败结果：message 直接可展示给用户。
  const RechargeResult.failure(this.message)
      : ok = false,
        data = null;

  final bool ok;
  final T? data;
  final String? message;
}

class RechargeApi {
  RechargeApi({String? baseUrl, http.Client? client})
      : _baseUrl = baseUrl ?? ApiConfig.controlPlaneBase,
        _client = client ?? NbClient();

  final String _baseUrl;
  final http.Client _client;

  static const Duration _timeout = Duration(seconds: 15);

  Map<String, String> get _headers => <String, String>{
        "Content-Type": "application/json",
        ...AccessCredentialStore.instance.authHeaders,
      };

  Future<RechargeResult<RechargeAccount>> fetchAccount() async {
    try {
      final http.Response res = await _client
          .get(Uri.parse("$_baseUrl/api/recharge/me"), headers: _headers)
          .timeout(_timeout);
      final Map<String, dynamic> data = _decode(res);
      if (res.statusCode == 200 && data["ok"] == true) {
        return RechargeResult<RechargeAccount>(
          ok: true,
          data: RechargeAccount.fromJson(data),
        );
      }
      return RechargeResult<RechargeAccount>.failure(
        _friendlyMessage(res, data, "额度余额加载失败"),
      );
    } catch (_) {
      return RechargeResult<RechargeAccount>.failure("网络错误，请稍后重试");
    }
  }

  Future<RechargeResult<RechargeProviders>> fetchProviders() async {
    try {
      final http.Response res = await _client
          .get(Uri.parse("$_baseUrl/api/recharge/config"), headers: _headers)
          .timeout(_timeout);
      final Map<String, dynamic> data = _decode(res);
      if (res.statusCode == 200 && data["ok"] == true) {
        return RechargeResult<RechargeProviders>(
          ok: true,
          data: RechargeProviders.fromJson(data),
        );
      }
      return RechargeResult<RechargeProviders>.failure(
        _friendlyMessage(res, data, "支付方式加载失败"),
      );
    } catch (_) {
      return RechargeResult<RechargeProviders>.failure("网络错误，请稍后重试");
    }
  }

  /// 下单。[payMode] 映射到统一接口的 `channel`：
  /// app = 返回 orderStr 唤起原生收银台；wap = 返回浏览器收银台地址；
  /// 不传则由服务端按 UA 自动选择（电脑 page / 手机 wap）。
  Future<RechargeResult<RechargeOrder>> createOrder(
    String amount, {
    String payMode = "wap",
  }) async {
    try {
      final http.Response res = await _client
          .post(
            Uri.parse("$_baseUrl/api/recharge/payments"),
            headers: _headers,
            body: jsonEncode(<String, dynamic>{
              "amount": amount,
              "channel": payMode,
            }),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data = _decode(res);
      if (res.statusCode == 200 && data["ok"] == true) {
        return RechargeResult<RechargeOrder>(
          ok: true,
          data: RechargeOrder.fromJson(data),
        );
      }
      return RechargeResult<RechargeOrder>.failure(
        _friendlyMessage(res, data, "下单失败，请稍后重试"),
      );
    } catch (_) {
      return RechargeResult<RechargeOrder>.failure("网络错误，请稍后重试");
    }
  }

  Future<RechargeResult<RechargeOrderStatus>> fetchOrder(String outTradeNo) async {
    try {
      final http.Response res = await _client
          .get(
            Uri.parse(
              "$_baseUrl/api/recharge/payments/${Uri.encodeComponent(outTradeNo)}",
            ),
            headers: _headers,
          )
          .timeout(_timeout);
      final Map<String, dynamic> data = _decode(res);
      if (res.statusCode == 200 && data["ok"] == true) {
        return RechargeResult<RechargeOrderStatus>(
          ok: true,
          data: RechargeOrderStatus.fromJson(data),
        );
      }
      return RechargeResult<RechargeOrderStatus>.failure(
        _friendlyMessage(res, data, "订单状态查询失败"),
      );
    } catch (_) {
      return RechargeResult<RechargeOrderStatus>.failure("网络错误，请稍后重试");
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.bodyBytes.isEmpty) return <String, dynamic>{};
    try {
      final dynamic decoded = jsonDecode(utf8.decode(res.bodyBytes));
      return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  /// Fastify 默认 404 文案（`Route GET:/... not found`）是服务端未更新到本次
  /// 接口版本时的典型表现：给用户一句可行动提示，而不是把路由字符串甩到界面上。
  String _friendlyMessage(
    http.Response res,
    Map<String, dynamic> data,
    String fallback,
  ) {
    final String server = data["message"]?.toString().trim() ?? "";
    if (server.isNotEmpty && !server.startsWith("Route ")) return server;
    if (res.statusCode == 404) return "充值服务暂未就绪，请稍后重试";
    if (res.statusCode == 401) return "登录已失效，请重新登录";
    return fallback;
  }
}
