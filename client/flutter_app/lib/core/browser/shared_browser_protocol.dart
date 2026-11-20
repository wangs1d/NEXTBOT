/// 共用浏览器动作协议（framework-free）。
///
/// 服务端 `shared_browser.*` 工具、客户端执行器（BrowserActionExecutor）、
/// 注入运行时（shared_browser_runtime.js）三方的契约层：
///   - 动作名与参数结构
///   - 结构化错误码（LLM 据此决策：重试 / 换定位方式 / 先关弹窗 / 放弃）
///   - 结果构造与参数校验
///   - URL 解析等纯函数（omnibox 与 Agent navigate 共用）
///
/// 本文件与注入运行时均不依赖任何引擎/框架，可在无 Flutter 环境下测试。
library;

/// 动作名（与服务端 shared_browser.* 工具族一一对应）。
class SbActions {
  SbActions._();

  static const String navigate = "navigate";
  static const String control = "control";
  static const String click = "click";
  static const String type = "type";
  static const String scroll = "scroll";
  static const String readPage = "read_page";
  static const String getState = "get_state";
  static const String exportState = "export_state";
}

/// 结构化错误码。
class SbErrors {
  SbErrors._();

  /// 元素未找到（等待超时后仍不存在）。
  static const String notFound = "NOT_FOUND";

  /// 元素存在但禁用。
  static const String disabled = "DISABLED";

  /// 元素存在但被遮挡（需先关弹窗/滚动）。
  static const String covered = "COVERED";

  /// 输入后回读校验失败（受控组件吞值等）。
  static const String verifyFailed = "VERIFY_FAILED";

  /// 参数缺失/非法。
  static const String badParams = "BAD_PARAMS";

  /// 引擎执行异常。
  static const String engine = "ENGINE_ERROR";

  /// 用户在确认门拒绝了动作。
  static const String userDenied = "USER_DENIED";

  /// 等待页面稳定超时。
  static const String waitTimeout = "WAIT_TIMEOUT";
}

/// 动作轨迹（足迹/审计展示用）。
class SbActionTrace {
  const SbActionTrace({
    required this.action,
    required this.ok,
    required this.durationMs,
    required this.at,
    this.target,
    this.url,
    this.errorCode,
    this.error,
  });

  final String action;
  final bool ok;
  final int durationMs;
  final DateTime at;
  final String? target;
  final String? url;
  final String? errorCode;
  final String? error;
}

/// 高风险动作确认请求（服务端风险分级下发，客户端弹确认条）。
class SbConfirmRequest {
  const SbConfirmRequest({
    required this.jobId,
    required this.action,
    required this.reason,
    required this.targetSummary,
  });

  final String jobId;
  final String action;
  final String reason;
  final String targetSummary;
}

/// 统一结果构造（与服务端 SharedBrowserResult 形状一致：ok/error/retryable/code…）。
class SbResult {
  SbResult._();

  static Map<String, dynamic> ok([Map<String, dynamic>? extra]) =>
      <String, dynamic>{"ok": true, ...?extra};

  static Map<String, dynamic> fail(
    String message, {
    String? code,
    bool retryable = false,
    Map<String, dynamic>? extra,
  }) =>
      <String, dynamic>{
        "ok": false,
        "error": message,
        if (code != null) "code": code,
        if (retryable) "retryable": true,
        ...?extra,
      };
}

/// 参数校验（返回 null 表示通过，否则为错误信息）。
class SbValidate {
  SbValidate._();

  static String? click(Map<String, dynamic> p) {
    final bool hasRef = p["ref"] is String && (p["ref"] as String).isNotEmpty;
    final bool hasSelector = p["selector"] is String && (p["selector"] as String).trim().isNotEmpty;
    final bool hasText = p["text"] is String && (p["text"] as String).trim().isNotEmpty;
    if (hasRef || hasSelector || hasText || p["index"] is int) return null;
    return "ref/selector/text/index 至少传一个";
  }

  static String? type(Map<String, dynamic> p) =>
      (p["text"] ?? "").toString().isEmpty ? "缺少 text" : null;

  static String? navigate(Map<String, dynamic> p) =>
      (p["url"] ?? "").toString().trim().isEmpty ? "缺少 url" : null;
}

/// ── URL 纯函数（原 SharedBrowserHost 静态方法迁移至此）──────────────────

/// 输入是 URL 时返回补全后的 URL；否则返回 null（视为搜索词）。
String? resolveInputToUrl(String input) {
  final String s = input.trim();
  if (s.isEmpty) return null;
  if (RegExp(r'^https?://', caseSensitive: false).hasMatch(s)) return s;
  if (s.toLowerCase() == "localhost" || s.startsWith("localhost:")) {
    return "http://$s";
  }
  // 无 scheme 的域名样输入（含点、无空格）→ 补 https
  if (!s.contains(" ") && s.contains(".")) {
    final String host = s.split("/").first;
    if (RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9.\-:_]+$').hasMatch(host)) {
      return "https://$s";
    }
  }
  return null;
}

/// 搜索词 → 搜索引擎 URL（Bing 中文，与服务端 web_search 引擎选择一致）。
String searchUrlFor(String query) {
  return "https://cn.bing.com/search?q=${Uri.encodeQueryComponent(query)}";
}

/// 把 dynamic 结果安全转 Map。
Map<String, dynamic> sbAsMap(dynamic v) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.cast<String, dynamic>();
  return <String, dynamic>{};
}
