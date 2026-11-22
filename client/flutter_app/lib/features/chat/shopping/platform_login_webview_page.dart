import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart" show MethodChannel, PlatformException;
import "package:webview_flutter/webview_flutter.dart";

/// 平台 Web 登录页地址（App 内 WebView 登录用，2026-11-22）。
///
/// 只给「必须登录才能读价」的综合电商。拿不到映射的平台不给入口——
/// 与其打开一个登不进去的页面，不如让用户走手动导入。
const Map<String, String> kPlatformWebLoginUrls = <String, String>{
  "pdd": "https://mobile.yangkeduo.com/login.html",
  "jd": "https://passport.jd.com/new/login.aspx",
  "taobao": "https://login.taobao.com/member/login.jhtml",
  "tmall": "https://login.taobao.com/member/login.jhtml",
  "meituan": "https://passport.meituan.com/account/unitivelogin",
  "douyin": "https://www.douyin.com/",
  "suning": "https://passport.suning.com/ids/login",
  "damai": "https://passport.damai.cn/login",
  "maoyan": "https://passport.maoyan.com/",
  "ctrip": "https://passport.ctrip.com/user/login",
  "alipay": "https://auth.alipay.com/login/",
  "netease": "https://music.163.com/#/login",
};

/// Cookie 头文本 → 结构化 Cookie 列表。
///
/// `a=1; b=2` → `[{name:a,value:1,domain:host}, ...]`。值里允许出现 `=`
/// （按第一个 `=` 切），这一点和浏览器实际发出来的 Cookie 头一致。
List<Map<String, String>> parseCookieHeaderToJar(String header, String host) {
  final List<Map<String, String>> out = <Map<String, String>>[];
  final Set<String> seen = <String>{};
  for (final String part in header.split(";")) {
    final String item = part.trim();
    if (item.isEmpty) continue;
    final int eq = item.indexOf("=");
    if (eq <= 0) continue;
    final String name = item.substring(0, eq).trim();
    final String value = item.substring(eq + 1);
    if (name.isEmpty || !seen.add(name)) continue;
    out.add(<String, String>{
      "name": name,
      "value": value,
      if (host.isNotEmpty) "domain": host,
      "path": "/",
    });
  }
  return out;
}

/// App 内平台登录页：用户在这里真登录一次，点「登录好了」把 Cookie 交回。
///
/// 为什么要这一页（2026-11-22）：手机端没有桌面那种「用户自己的 WebView2」，
/// 比价跑在云端无头 Chromium 里，而拼多多这类平台不向无头浏览器兑现登录态
/// ——扫码确认再多次，云端 context 里也不会出现 PDDUserID。用户唯一能做的
/// 就是「用一个真浏览器登一次」，这一页就是那个真浏览器。
///
/// 返回值：结构化 Cookie 列表（含 HttpOnly 项）；用户取消返回 null。
class PlatformLoginWebViewPage extends StatefulWidget {
  const PlatformLoginWebViewPage({
    super.key,
    required this.platform,
    required this.platformLabel,
    this.initialUrl,
  });

  final String platform;
  final String platformLabel;
  final String? initialUrl;

  @override
  State<PlatformLoginWebViewPage> createState() => _PlatformLoginWebViewPageState();
}

class _PlatformLoginWebViewPageState extends State<PlatformLoginWebViewPage> {
  static const MethodChannel _channel = MethodChannel("nextbot/web_login_cookies");

  late final WebViewController _controller;

  String _currentUrl = "";
  bool _reading = false;
  double _progress = 0;

  String get _startUrl =>
      (widget.initialUrl ?? "").trim().isNotEmpty
          ? widget.initialUrl!.trim()
          : (kPlatformWebLoginUrls[widget.platform] ?? "");

  @override
  void initState() {
    super.initState();
    final String url = _startUrl;
    _currentUrl = url;
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFFFFFFF))
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (int p) {
            if (!mounted) return;
            setState(() => _progress = p / 100);
          },
          onPageStarted: (String u) {
            if (!mounted) return;
            setState(() => _currentUrl = u);
          },
          onPageFinished: (String u) {
            if (!mounted) return;
            setState(() => _currentUrl = u);
          },
        ),
      );
    if (url.isNotEmpty) {
      unawaited(_controller.loadRequest(Uri.parse(url)));
    }
  }

  Future<List<Map<String, String>>?> _readCookies() async {
    // 两处都读：当前页（登录完成后可能停在 passport / 落地页）与登录入口域，
    // 同一域取到的 Cookie 头是一致的；不同域则合并去重（平台常跨子域落票）。
    final Set<String> urls = <String>{
      if (_currentUrl.trim().isNotEmpty) _currentUrl.trim(),
      if (_startUrl.trim().isNotEmpty) _startUrl.trim(),
    };
    final List<Map<String, String>> out = <Map<String, String>>[];
    final Set<String> seen = <String>{};
    for (final String url in urls) {
      String header = "";
      try {
        header = await _channel.invokeMethod<String>("getCookie", <String, String>{
              "url": url,
            }) ??
            "";
      } on PlatformException {
        continue;
      }
      final String host = Uri.tryParse(url)?.host ?? "";
      for (final Map<String, String> c in parseCookieHeaderToJar(header, host)) {
        if (seen.add(c["name"]!)) out.add(c);
      }
    }
    return out;
  }

  Future<void> _submit() async {
    if (_reading) return;
    setState(() => _reading = true);
    final List<Map<String, String>> cookies =
        (await _readCookies()) ?? <Map<String, String>>[];
    if (!mounted) return;
    setState(() => _reading = false);
    if (cookies.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("还没读到${widget.platformLabel}的登录信息——先把登录页走完（验证码/密码），再点一次"),
          duration: const Duration(seconds: 4),
        ),
      );
      return;
    }
    Navigator.of(context).pop(cookies);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        title: Text("登录${widget.platformLabel}"),
        actions: <Widget>[
          TextButton(
            onPressed: _reading ? null : _submit,
            child: const Text("登录好了"),
          ),
        ],
        bottom: _progress > 0 && _progress < 1
            ? PreferredSize(
                preferredSize: const Size.fromHeight(2),
                child: LinearProgressIndicator(value: _progress, minHeight: 2),
              )
            : null,
      ),
      body: Column(
        children: <Widget>[
          Expanded(child: WebViewWidget(controller: _controller)),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
              decoration: BoxDecoration(
                color: cs.surface,
                border: Border(top: BorderSide(color: cs.outlineVariant, width: 0.6)),
              ),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      "在这页里正常登录，完成验证后点右边「登录好了」，我会把登录态交给云端保存（以后比价不用再登）。",
                      style: TextStyle(fontSize: 11, height: 1.45, color: cs.onSurfaceVariant),
                    ),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    onPressed: _reading ? null : _submit,
                    child: Text(_reading ? "读取中…" : "登录好了"),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
