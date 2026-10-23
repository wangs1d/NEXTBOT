// 模型接入目录真链探针（可复跑）：flutter test tool/probe_model_provider_card.dart
//
// 五腿验证（真网络，plain test() 可真连；不会混入 test/ 全量套件）：
//  L1 真链取目录：常驻 runtime GET /api/model-providers（服务端 config/model-providers.json 下发）
//  L2 回显解析：按本机真实 config（server/.env.local 的 OPENAI_* 三键）解析回目录商
//  L3 真实连通：ModelApiTester 直连 DeepSeek /models（真 key）
//  L4 chat 探针兜底：/models 404 的端点自动转最小对话探针（进程内 HttpServer 模拟 404→200）
//  L5 跨商路由：拿 DeepSeek key 打智谱端点 → 必须报「密钥无效」而不是误连
import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:nextbot/core/services/model_api_tester.dart";
import "package:nextbot/features/model_config/model_provider_catalog.dart";

const String _runtimeBase = "http://127.0.0.1:3000";

Map<String, String> _readLocalModelConfig() {
  final Map<String, String> env = <String, String>{};
  for (final String line in File("E:/ws-project/NextBot/server/.env.local").readAsLinesSync()) {
    final int eq = line.indexOf("=");
    if (eq > 0) env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  }
  return env;
}

void main() {
  // 注意：不要 TestWidgetsFlutterBinding.ensureInitialized()——它会劫持全部 HttpClient
  // 返回 400；这里 plain test() + flutter_tester 真 socket 直连。

  test("L1 目录真链下发：runtime /api/model-providers", () async {
    final http.Response res =
        await http.get(Uri.parse("$_runtimeBase/api/model-providers")).timeout(const Duration(seconds: 5));
    final dynamic cat = jsonDecode(utf8.decode(res.bodyBytes));
    expect(res.statusCode, 200);
    expect(cat["ok"], true);
    final List<ModelProviderOption> providers = (cat["providers"] as List)
        .map((dynamic e) => e is Map ? ModelProviderOption.fromJson(Map<String, dynamic>.from(e)) : null)
        .whereType<ModelProviderOption>()
        .toList();
    expect(providers.length, greaterThanOrEqualTo(6), reason: "目录应含全部服务商");
    expect(providers.map((ModelProviderOption p) => p.id), containsAll(<String>["deepseek", "moonshot", "zhipu"]));
    // ignore: avoid_print
    print("L1 · ${providers.length} 家：${providers.map((p) => p.id).join(",")}");
  });

  test("L2 真实配置回显解析（含 /v1 别名）→ DeepSeek + deepseek-flash", () async {
    final Map<String, String> cfg = _readLocalModelConfig();
    final List<ModelProviderOption> providers = ModelProviderCatalog.baked;
    final r = resolveModelSelection(
      providers: providers,
      baseUrl: cfg["OPENAI_BASE_URL"],
      model: cfg["OPENAI_MODEL"],
    );
    // ignore: avoid_print
    print("L2 · ${cfg["OPENAI_BASE_URL"]} → ${r.provider?.id ?? "自定义"} · ${r.model}");
    expect(r.custom, isFalse);
    expect(r.provider?.id, "deepseek");
    expect(r.model, "deepseek-flash");
  });

  test("L3 DeepSeek 真连（真 key）：/models 或对话探针兜底任一走通", () async {
    final Map<String, String> cfg = _readLocalModelConfig();
    // 先裸打一次 /models 留痕（flutter_tester 里若非 200，正好证明兜底的必要性）
    final http.Response raw = await http
        .get(Uri.parse("${cfg["OPENAI_BASE_URL"]}/models"),
            headers: <String, String>{"Authorization": "Bearer ${cfg["OPENAI_API_KEY"]}"})
        .timeout(const Duration(seconds: 10));
    // ignore: avoid_print
    print("L3 · 裸 /models → HTTP ${raw.statusCode} · ${raw.body.isEmpty ? "(空)" : raw.body.substring(0, raw.body.length > 80 ? 80 : raw.body.length)}");
    final ModelApiTestResult t = await ModelApiTester.test(
      cfg["OPENAI_BASE_URL"]!,
      cfg["OPENAI_API_KEY"]!,
      model: cfg["OPENAI_MODEL"] ?? "deepseek-flash",
    );
    // ignore: avoid_print
    print("L3 · ${t.summary}");
    expect(t.ok, isTrue, reason: t.summary);
    expect(t.modelIds, contains("deepseek-flash"));
  }, timeout: const Timeout(Duration(seconds: 40)));

  test("L4 /models 404 → 最小对话探针兜底", () async {
    final HttpServer fake = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final Future<void> serve = fake.listen((HttpRequest req) async {
      if (req.uri.path.endsWith("/models")) {
        req.response.statusCode = 404;
        await req.response.close();
      } else if (req.uri.path.endsWith("/chat/completions")) {
        final String body = await utf8.decoder.bind(req).join();
        final dynamic parsed = jsonDecode(body);
        req.response.headers.contentType = ContentType.json;
        req.response.write(jsonEncode(<String, dynamic>{
          "id": "chatcmpl-probe",
          "model": parsed is Map ? parsed["model"] : "?",
          "choices": <dynamic>[
            <String, dynamic>{
              "message": <String, dynamic>{"role": "assistant", "content": "pong"},
            },
          ],
        }));
        await req.response.close();
      } else {
        req.response.statusCode = 404;
        await req.response.close();
      }
    }).asFuture<void>();
    try {
      final ModelApiTestResult probe = await ModelApiTester.test(
          "http://127.0.0.1:${fake.port}/v1", "sk-probe-1234567890", model: "glm-5.3");
      // ignore: avoid_print
      print("L4 · ${probe.summary}");
      expect(probe.ok, isTrue, reason: probe.summary);
      expect(probe.viaChatProbe, isTrue);
    } finally {
      await fake.close(force: true);
      await serve.timeout(const Duration(seconds: 2), onTimeout: () {});
    }
  });

  test("L5 跨商 key 正确识别（DeepSeek key 打智谱 → 密钥无效）", () async {
    final Map<String, String> cfg = _readLocalModelConfig();
    final ModelApiTestResult wrong = await ModelApiTester.test(
        "https://open.bigmodel.cn/api/paas/v4", cfg["OPENAI_API_KEY"]!, model: "glm-5.3");
    // ignore: avoid_print
    print("L5 · ${wrong.summary}");
    expect(wrong.ok, isFalse);
    expect(wrong.summary, contains("密钥无效"));
  }, timeout: const Timeout(Duration(seconds: 30)));
}
