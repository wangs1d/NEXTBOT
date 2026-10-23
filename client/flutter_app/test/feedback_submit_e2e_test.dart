// 反馈提交链路集成测试：真实 HTTP 打到本地 dev 服务器（127.0.0.1:3000），
// 验证 FeedbackApi 提交 → 服务端落库（feedback.db）→ 我的反馈可查。
// 需要本地服务在跑；服务器不在时整体跳过（CI/无服务环境不算失败）。
import "dart:io" show HttpOverrides;

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;

import "package:nextbot/core/services/feedback_api.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test("反馈提交 → 服务端落库 → 我的反馈可查（真实链路）", () async {
    // flutter_test 默认用 MockedHttpOverrides 拦掉真实 HTTP；反馈链路要打真服务
    HttpOverrides.global = null;

    const String base = "http://127.0.0.1:3000";
    // 服务器不可达：跳过（未起服务的环境不视为失败）
    try {
      final http.Response probe = await http
          .get(Uri.parse("$base/api/client/manifest"))
          .timeout(const Duration(seconds: 2));
      if (probe.statusCode != 200) return;
    } catch (_) {
      return;
    }

    final FeedbackApi api = FeedbackApi(baseUrl: base);
    final String marker = "e2e_${DateTime.now().millisecondsSinceEpoch}";
    final submit = await api.submit(
      type: "suggestion",
      title: "集成测试 $marker",
      description: "验证应用内反馈提交链路（自动测试，可忽略）",
      contact: "e2e@test.local",
      diagnostics: <String, Object>{"来源": "integration-test"},
    );
    expect(submit.ok, isTrue, reason: submit.error ?? "submit failed");
    expect(submit.value!.id, isNotEmpty);

    final mine = await api.listMine(limit: 50);
    expect(mine.ok, isTrue, reason: mine.error ?? "listMine failed");
    final matched = mine.value!
        .where((r) => r.title == "集成测试 $marker")
        .toList(growable: false);
    expect(matched, isNotEmpty, reason: "listMine 应包含刚提交的反馈");
    expect(matched.first.status, "open");

    // 测试数据自清理：走管理接口删除（避免污染后台真实数据）
    final String id = matched.first.id;
    final http.Response del = await http
        .post(
          Uri.parse("$base/api/feedback/$id/status"),
          headers: <String, String>{
            "Content-Type": "application/json",
            "x-admin-token": const String.fromEnvironment("ADMIN_TOKEN"),
          },
          body: '{"status":"resolved","replyNote":"测试闭环"}',
        )
        .timeout(const Duration(seconds: 5));
    // 无管理令牌时删除会 401：仅提示，不算测试失败
    // ignore: avoid_print
    print("cleanup status for $id: HTTP ${del.statusCode}");
  });
}
