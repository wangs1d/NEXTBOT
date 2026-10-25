import "dart:convert";
import "dart:typed_data";

import "package:http/http.dart" as http;

import "../config/api_config.dart";

/// 模型接入连通测试：客户端直连 OpenAI 兼容端点。
///
/// 桌面端无 CORS 限制（dart:io 直连）；key 不经自家服务端，不落任何日志。
/// 首选 `GET {base}/models`（一次验证「网络可达 + 密钥有效」并带回模型清单）；
/// 端点不支持 /models（404/405，如智谱）时以 [model] 发一次最小对话请求兜底
/// （max_tokens 压到 16，成本可忽略），同样能验出「密钥/模型/base URL」是否真的可用。
class ModelApiTestResult {
  const ModelApiTestResult({
    required this.ok,
    required this.latencyMs,
    this.modelCount = 0,
    this.sampleModels = const <String>[],
    this.modelIds = const <String>[],
    this.viaChatProbe = false,
    this.error,
  });

  final bool ok;
  final int latencyMs;
  final int modelCount;
  final List<String> sampleModels;
  /// 端点返回的完整模型清单（供下拉合并，最多 50 个）。
  final List<String> modelIds;
  /// true = /models 不可用，走了最小对话探针。
  final bool viaChatProbe;
  final String? error;

  String get summary {
    if (ok) {
      if (viaChatProbe) {
        return "已连接（对话测试通过）· ${sampleModels.first} · ${latencyMs}ms";
      }
      final String models = sampleModels.isEmpty
          ? "$modelCount 个模型"
          : sampleModels.take(2).join("、") + (modelCount > 2 ? " 等 $modelCount 个模型" : "");
      return "已连接 · $models · ${latencyMs}ms";
    }
    return error ?? "连接失败";
  }
}

class ModelApiTester {
  static const int _timeoutMs = 8000;
  static const int _chatProbeTimeoutMs = 20000;

  /// [baseUrl] 约定为「纯 base」（如 https://api.deepseek.com/v1）；
  /// [model] 传入用户所选模型：/models 不可用时用它做对话探针兜底。
  static Future<ModelApiTestResult> test(String baseUrl, String apiKey, {String? model}) async {
    final String base = baseUrl.trim().replaceAll(RegExp(r"/+$"), "");
    if (base.isEmpty) {
      return const ModelApiTestResult(ok: false, latencyMs: 0, error: "请先填写 API Base URL");
    }
    if (apiKey.trim().length < 8) {
      return const ModelApiTestResult(ok: false, latencyMs: 0, error: "API Key 看起来不完整");
    }
    final String url = base.endsWith("/models") ? base : "$base/models";
    final Stopwatch sw = Stopwatch()..start();
    try {
      final http.Response res = await http
          .get(
            Uri.parse(url),
            headers: <String, String>{"Authorization": "Bearer ${apiKey.trim()}"},
          )
          .timeout(const Duration(milliseconds: _timeoutMs));
      sw.stop();
      if (res.statusCode == 401 || res.statusCode == 403) {
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: "密钥无效（${res.statusCode}）：请核对 API Key",
        );
      }
      if (res.statusCode == 200) {
        final dynamic parsed = jsonDecode(utf8.decode(res.bodyBytes));
        final List<dynamic> data = (parsed is Map ? parsed["data"] : null) as List<dynamic>? ?? <dynamic>[];
        final List<String> ids = data
            .map((dynamic m) => m is Map ? m["id"]?.toString() : null)
            .whereType<String>()
            .toList(growable: false);
        return ModelApiTestResult(
          ok: true,
          latencyMs: sw.elapsedMilliseconds,
          modelCount: ids.length,
          sampleModels: ids.take(3).toList(growable: false),
          modelIds: ids.take(50).toList(growable: false),
        );
      }
      // 其余 /models 失败（404/405 不支持，或智谱这类 400 无响应体）：
      // 有所选模型就走最小对话探针兜底，给出的结论更真（能验出 key/模型到底行不行）
      final String? m = model?.trim();
      if (m != null && m.isNotEmpty) {
        return _chatProbe(base: base, apiKey: apiKey.trim(), model: m, elapsedMs: sw.elapsedMilliseconds);
      }
      return ModelApiTestResult(
        ok: false,
        latencyMs: sw.elapsedMilliseconds,
        error: res.statusCode == 404 || res.statusCode == 405
            ? "端点不支持 /models（${res.statusCode}）：请核对 Base URL"
            : "HTTP ${res.statusCode}：${_shortBody(res.body)}",
      );
    } catch (e) {
      sw.stop();
      String hint;
      final String msg = e.toString();
      if (msg.contains("TimeoutException") || msg.contains("timed out")) {
        hint = "连接超时：检查网络或 Base URL 是否可达";
      } else if (msg.contains("Failed host lookup") || msg.contains("SocketException")) {
        hint = "无法建立连接：检查 Base URL 拼写与网络";
      } else if (msg.contains("FormatException") || msg.contains("Invalid argument")) {
        hint = "URL 格式不正确：应形如 https://api.deepseek.com/v1";
      } else {
        hint = msg.replaceFirst(RegExp(r"^[A-Za-z:]+\s*"), "").split("\n").first;
      }
      return ModelApiTestResult(ok: false, latencyMs: sw.elapsedMilliseconds, error: hint);
    }
  }

  /// 最小对话探针：/models 不支持时的兜底（智谱等）。max_tokens 16 压成本；
  /// 部分思考型模型会嫌小，报错时放大到 2048 重试一次。
  static Future<ModelApiTestResult> _chatProbe({
    required String base,
    required String apiKey,
    required String model,
    required int elapsedMs,
  }) async {
    Future<ModelApiTestResult> call(int maxTokens) async {
      final Stopwatch sw = Stopwatch()..start();
      try {
        final http.Response res = await http
            .post(
              Uri.parse("$base/chat/completions"),
              headers: <String, String>{
                "Authorization": "Bearer $apiKey",
                "Content-Type": "application/json",
              },
              body: jsonEncode(<String, dynamic>{
                "model": model,
                "messages": <Map<String, String>>[
                  <String, String>{"role": "user", "content": "ping"},
                ],
                "max_tokens": maxTokens,
                "stream": false,
              }),
            )
            .timeout(const Duration(milliseconds: _chatProbeTimeoutMs));
        sw.stop();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return ModelApiTestResult(
            ok: true,
            latencyMs: elapsedMs + sw.elapsedMilliseconds,
            modelCount: 1,
            sampleModels: <String>[model],
            modelIds: <String>[model],
            viaChatProbe: true,
          );
        }
        if (res.statusCode == 401 || res.statusCode == 403) {
          return ModelApiTestResult(
            ok: false,
            latencyMs: sw.elapsedMilliseconds,
            error: "密钥无效（${res.statusCode}）：请核对 API Key",
          );
        }
        final String body = _shortBody(res.body);
        final bool tokensTooSmall =
            res.statusCode == 400 || res.statusCode == 404 || res.statusCode == 422;
        if (tokensTooSmall &&
            maxTokens < 2048 &&
            (body.toLowerCase().contains("max_tokens") || body.toLowerCase().contains("max tokens"))) {
          return call(2048);
        }
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: "模型 $model 请求失败（HTTP ${res.statusCode}）：$body",
        );
      } catch (e) {
        sw.stop();
        final String msg = e.toString();
        if (msg.contains("TimeoutException") || msg.contains("timed out")) {
          return ModelApiTestResult(
            ok: false,
            latencyMs: sw.elapsedMilliseconds,
            error: "对话测试超时：端点可达但 $model 响应过慢，可先保存稍后再试",
          );
        }
        return ModelApiTestResult(
          ok: false,
          latencyMs: sw.elapsedMilliseconds,
          error: msg.replaceFirst(RegExp(r"^[A-Za-z:]+\s*"), "").split("\n").first,
        );
      }
    }

    return call(16);
  }

  static String _shortBody(String body) {
    try {
      final dynamic parsed = jsonDecode(body);
      if (parsed is Map && parsed["error"] is Map) {
        final String? msg = parsed["error"]["message"]?.toString();
        if (msg != null && msg.isNotEmpty) return msg;
      }
    } catch (_) {/* 非 JSON */}
    final String flat = body.replaceAll(RegExp(r"\s+"), " ").trim();
    return flat.isEmpty ? "无响应体" : (flat.length > 80 ? "${flat.substring(0, 80)}…" : flat);
  }
}

/// 声纹 HTTP 客户端（首启向导注册 + 语音闸验证共用）。
class VoiceprintApi {
  static Map<String, String> get _headers => <String, String>{"Content-Type": "application/json"};

  static Uri _uri(String path) => Uri.parse("${ApiConfig.httpBase}$path");

  static String get _userId => ApiConfig.effectiveActorId;

  static Future<Map<String, dynamic>> status() async {
    try {
      final http.Response res = await http
          .get(
            _uri("/api/voice/voiceprint/status?userId=${Uri.encodeComponent(_userId)}"),
          )
          .timeout(const Duration(seconds: 5));
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{"ok": false, "registered": false, "engineReady": false};
    }
  }

  /// [samples]：PCM16 单声道 16k 字节（每段 ≥0.5s，建议 3-4s）。
  static Future<Map<String, dynamic>> register(List<Uint8List> samples) async {
    final http.Response res = await http
        .post(
          _uri("/api/voice/voiceprint/register"),
          headers: _headers,
          body: jsonEncode(<String, dynamic>{
            "userId": _userId,
            "samples": samples.map((Uint8List s) => base64Encode(s)).toList(),
          }),
        )
        .timeout(const Duration(seconds: 30));
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// 验证一段音频是否为已录入用户本人；命中返回 speakerToken。
  static Future<Map<String, dynamic>> verify(Uint8List audio) async {
    final http.Response res = await http
        .post(
          _uri("/api/voice/voiceprint/verify"),
          headers: _headers,
          body: jsonEncode(<String, dynamic>{
            "userId": _userId,
            "audioBase64": base64Encode(audio),
          }),
        )
        .timeout(const Duration(seconds: 15));
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  static Future<bool> unregister() async {
    try {
      final http.Response res = await http
          .delete(
            _uri("/api/voice/voiceprint?userId=${Uri.encodeComponent(_userId)}"),
          )
          .timeout(const Duration(seconds: 5));
      final dynamic parsed = jsonDecode(utf8.decode(res.bodyBytes));
      return parsed is Map && parsed["ok"] == true;
    } catch (_) {
      return false;
    }
  }
}

/// 邮箱接入（邮箱盯梢）API：状态查询 + IMAP 授权码提交（「服务接入」页邮箱胶囊）。
/// 授权码经 PUT /api/service-config（mail 块）落盘到服务端 data/service-config.json 并
/// 即刻启动轮询；已接入的授权码经 GET 回显 keyValue，供输入框回填（客户端默认打码）。
class MailWatchApi {
  static Uri _uri(String path) => Uri.parse("${ApiConfig.httpBase}$path");

  static Future<Map<String, dynamic>> status() async {
    try {
      final http.Response res = await http
          .get(_uri("/api/mail-watch/status"))
          .timeout(const Duration(seconds: 5));
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{"ok": false};
    }
  }

  /// 服务接入回显（GET /api/service-config）：mail.keyValue 为已存授权码全文，
  /// 供「已接入 → 回填输入框（默认打码）」；读取失败返回 ok:false。
  static Future<Map<String, dynamic>> serviceConfig() async {
    try {
      final http.Response res = await http
          .get(_uri("/api/service-config"))
          .timeout(const Duration(seconds: 5));
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{"ok": false};
    }
  }

  /// 保存 IMAP 授权码（即刻生效 + 服务端持久化）。返回服务端响应（ok/error）。
  static Future<Map<String, dynamic>> savePass(String pass) async {
    try {
      final http.Response res = await http
          .put(
            _uri("/api/service-config"),
            headers: <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "mail": <String, dynamic>{"pass": pass},
            }),
          )
          .timeout(const Duration(seconds: 10));
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (e) {
      return <String, dynamic>{"ok": false, "error": "保存请求失败：$e"};
    }
  }
}

/// 邮箱授权码获取引导（按登录邮箱域给分步说明 + 官方入口直达）。
/// 两端「服务接入」页共用同一份文案，避免各写一份走偏。
String mailGuideSteps(String email) {
  final String domain = email.split("@").last.toLowerCase();
  if (domain == "qq.com" || domain == "foxmail.com") {
    return "① 电脑浏览器登录 mail.qq.com → 设置 → 账号与安全；\n"
        "② 找到「IMAP/SMTP 服务」点开启，按提示用绑定手机发短信验证；\n"
        "③ 验证通过后生成 16 位授权码（只显示一次），复制填到下面。";
  }
  if (domain == "163.com" || domain == "126.com" || domain == "yeah.net") {
    return "① 电脑浏览器登录 mail.163.com → 设置（顶部）→ POP3/SMTP/IMAP；\n"
        "② 开启 IMAP/SMTP 服务，按提示短信验证；\n"
        "③ 生成授权码（只显示一次），复制填到下面。";
  }
  if (domain == "gmail.com") {
    return "① Google 账号 → 安全性 → 应用专用密码（需先开两步验证）；\n"
        "② 生成应用密码（16 位），复制填到下面。";
  }
  return "① 登录邮箱网页版 → 设置里找「IMAP/SMTP 服务」；\n"
      "② 开启并生成授权码，复制填到下面。";
}

/// 按域返回官方入口页链接（设置页需登录后跳转，故落官网首页/帮助中心——
/// 已实测 200 稳定可达；三步说明卡片内嵌，链接只是辅助）。未知域返回 null。
String? mailGuideUrl(String email) {
  switch (email.split("@").last.toLowerCase()) {
    case "qq.com":
    case "foxmail.com":
      return "https://service.mail.qq.com/";
    case "163.com":
    case "126.com":
    case "yeah.net":
      return "https://help.mail.163.com/";
    case "gmail.com":
      return "https://myaccount.google.com/security";
    case "outlook.com":
    case "hotmail.com":
      return "https://account.microsoft.com/security";
    default:
      return null;
  }
}
