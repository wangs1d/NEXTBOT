import "dart:async";
import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";
import "package:nextbot/core/presentation/update_corner_toast.dart";
import "package:nextbot/core/services/client_update_installer.dart";

/// 左下角更新胶囊（update_corner_toast.dart）widget 测试：
/// 显示即后台预下载（主流式）→ 下完「重启更新」/ 重推幂等 / dismiss 摘除。
void main() {
  Directory? tempDir;

  setUp(() async {
    UpdateCornerToast.debugReset();
    tempDir = await Directory.systemTemp.createTemp("corner-toast-test");
    // 共享流注入：mock 网络栈（HEAD/GET 均 200，流式回 1KB）+ 临时落盘目录
    debugUpdateHttpClientFactory = () => MockClient.streaming(
          (request, body) async => http.StreamedResponse(
            Stream<List<int>>.value(List<int>.filled(1024, 0)),
            200,
          ),
        );
    debugUpdateStorageDirOverride = tempDir;
  });

  tearDown(() async {
    disposeSharedUpdateFlow();
    UpdateCornerToast.debugReset();
    debugUpdateHttpClientFactory = null;
    debugUpdateStorageDirOverride = null;
    try {
      await tempDir?.delete(recursive: true);
    } catch (_) {}
    tempDir = null;
  });

  Future<void> pumpHost(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: UpdateCornerToastHost(child: SizedBox.expand()),
      ),
    );
    // 入场动画 280ms
    await tester.pumpAndSettle();
  }

  /// 触发 showUpdate 并等待共享流真实完成下载（文件 I/O 在 fake async
  /// 环境外，必须 runAsync 等待），回到普通 zone 后由 pumpAndSettle 刷 UI
  Future<void> showAndWaitDownloaded(WidgetTester tester, String url) async {
    await tester.runAsync(() async {
      UpdateCornerToast.showUpdate(latestVersion: "5.9.3", downloadUrl: url);
      final ClientUpdateFlowController flow = activeSharedUpdateFlow!;
      final Stopwatch sw = Stopwatch()..start();
      while (flow.phase != ClientUpdatePhase.downloaded &&
          sw.elapsed < const Duration(seconds: 10)) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
    await tester.pumpAndSettle();
  }

  testWidgets("显示即后台预下载：下完自动变「重启更新」", (tester) async {
    await pumpHost(tester);
    await showAndWaitDownloaded(
      tester,
      "https://x/Nextbot-Setup-5.9.3.exe",
    );

    // 版本文案常驻；下载完成后主按钮为「重启更新」（预下载无需用户点下载）
    expect(find.text("新版本 5.9.3"), findsOneWidget);
    expect(find.text("重启更新"), findsOneWidget);
    // 胶囊锚定窗口左下角（x 贴左缘，y 靠底）
    final Rect box = tester.getRect(
      find.ancestor(
        of: find.text("新版本 5.9.3"),
        matching: find.byType(Container),
      ).first,
    );
    expect(box.left, lessThanOrEqualTo(24));
    expect(box.bottom, greaterThanOrEqualTo(400));
  });

  testWidgets("同版本重复推送幂等：不打断已完成的下载", (tester) async {
    await pumpHost(tester);
    await showAndWaitDownloaded(
      tester,
      "https://x/Nextbot-Setup-5.9.3.exe",
    );
    expect(find.text("重启更新"), findsOneWidget);

    // 服务端重推同版本（不同 url 也不应触发换流重启下载）
    UpdateCornerToast.showUpdate(
      latestVersion: "5.9.3",
      downloadUrl: "https://y/Nextbot-Setup-5.9.3.exe",
    );
    await tester.pumpAndSettle();

    expect(find.text("新版本 5.9.3"), findsOneWidget);
    expect(find.text("重启更新"), findsOneWidget);
  });

  testWidgets("dismiss 后退场动画播完胶囊摘除，共享流一并终止", (tester) async {
    await pumpHost(tester);
    await showAndWaitDownloaded(
      tester,
      "https://x/Nextbot-Setup-5.9.3.exe",
    );
    expect(find.text("新版本 5.9.3"), findsOneWidget);

    UpdateCornerToast.dismiss();
    await tester.pumpAndSettle();
    expect(find.text("新版本 5.9.3"), findsNothing);
    expect(activeSharedUpdateFlow, isNull);
  });
}
