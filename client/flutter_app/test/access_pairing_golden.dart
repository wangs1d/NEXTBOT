/// 「设备配对」卡效果图生成器。
///
/// 运行 `flutter test --update-goldens test/access_pairing_golden.dart`
/// 生成 test/goldens/ 下 PNG：
///  - pairing_desktop_free.png    未配对 · 云端未开鉴权（可一键配对本机）
///  - pairing_desktop_locked.png  未配对 · 云端已开鉴权且已有设备（配对码/邮箱自证）
///  - pairing_desktop_bound.png   已配对（代签配对码 + 设备列表 + 解绑）
///  - pairing_mobile.png          手机端版面里的这张卡
///
/// 版面是生产组件本身，服务端状态用注入的假客户端呈现设计里真会出现的三种。
/// 默认 `flutter test`（不带 --update-goldens）不写图也不比对。
library;

import "dart:async" show unawaited;
import "dart:convert";
import "dart:io";

import "package:flutter/foundation.dart" show debugDefaultTargetPlatformOverride;
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/services/access_auth_api.dart";
import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/settings/access_pairing_card.dart";
import "package:nextbot/mobile_ui/mobile_theme.dart";

const String _actor = "me@example.com";
const String _localToken =
    "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef";

/// 本机凭据落盘要问 path_provider 要目录；测试环境没有插件实现，钉到临时目录。
void _mockPaths(String dir) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
    const MethodChannel("plugins.flutter.io/path_provider"),
    (MethodCall call) async => dir,
  );
}

http.Response _json(Map<String, dynamic> body) => http.Response(
      jsonEncode(body),
      200,
      headers: <String, String>{"content-type": "application/json"},
    );

/// 三种服务端形态的假响应（同一套路由，只差 authRequired/bound）。
AccessAuthApi _api({required bool authRequired, required bool boundOnServer}) {
  final MockClient client = MockClient((http.Request req) async {
    final String path = req.url.path;
    if (path == "/api/auth/status") {
      return _json(<String, dynamic>{
        "ok": true,
        "authRequired": authRequired,
        "bound": boundOnServer,
      });
    }
    if (path == "/api/auth/devices") {
      return _json(<String, dynamic>{
        "ok": true,
        "userId": _actor,
        "currentTokenId": "at_local",
        "devices": <dynamic>[
          <String, dynamic>{
            "tokenId": "at_local",
            "deviceId": "dev-win-1",
            "deviceLabel": "Windows 客户端",
            "createdAt": 1762000000000,
            "lastSeenAt": 1762060000000,
          },
          <String, dynamic>{
            "tokenId": "at_phone",
            "deviceId": "dev-android-2",
            "deviceLabel": "Android 客户端",
            "createdAt": 1761900000000,
            "lastSeenAt": 1762040000000,
          },
        ],
      });
    }
    if (path == "/api/auth/pairing-code") {
      return _json(<String, dynamic>{
        "ok": true,
        "code": "K7M2QD",
        "userId": _actor,
        "expiresInMs": 600000,
      });
    }
    return _json(<String, dynamic>{"ok": true});
  });
  return AccessAuthApi(client: client);
}

Future<void> _loadFonts() async {
  const List<String> files = <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
    "assets/fonts/MiSans-Bold.otf",
  ];
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in files) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();

  try {
    final String cacheDir =
        File(Platform.resolvedExecutable).parent.parent.parent.parent.path;
    final File iconFont =
        File("$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf");
    final FontLoader icons = FontLoader("MaterialIcons")
      ..addFont(iconFont
          .readAsBytes()
          .then((Uint8List bytes) => ByteData.view(bytes.buffer)));
    await icons.load();
  } catch (_) {
    // 找不到字体时图标退化为豆腐块，不影响版面其余部分
  }
}

Widget _desktop(Widget card) => MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(AppThemeVariant.dark),
      home: Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(32, 28, 32, 40),
              child: card,
            ),
          ),
        ),
      ),
    );

/// 假客户端是 microtask 级的，两轮 pump 就把状态推进到终态。
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

/// 卸载组件树，取消内部未完的 future，避免收尾报 pending timer。
Future<void> _untangle(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 50));
  debugDefaultTargetPlatformOverride = null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await _loadFonts();
    _mockPaths(Directory.systemTemp.createTempSync("nb-pairing-").path);
    ApiConfig.runtimeUserId = _actor;
  });

  testWidgets("未配对 · 云端未开鉴权", (WidgetTester tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    tester.view.physicalSize = const Size(900, 620);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    unawaited(AccessCredentialStore.instance.clear());

    await tester.pumpWidget(_desktop(
      AccessPairingCard(api: _api(authRequired: false, boundOnServer: false)),
    ));
    await _settle(tester);

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("goldens/pairing_desktop_free.png"),
      );
    }
    await _untangle(tester);
  });

  testWidgets("未配对 · 云端已开鉴权且已有设备", (WidgetTester tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    tester.view.physicalSize = const Size(900, 620);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    unawaited(AccessCredentialStore.instance.clear());

    await tester.pumpWidget(_desktop(
      AccessPairingCard(api: _api(authRequired: true, boundOnServer: true)),
    ));
    await _settle(tester);
    // 展开邮箱自证那一层（效果图要看全三种入口）
    await tester.tap(find.textContaining("验证码发到我邮箱"));
    await _settle(tester);

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("goldens/pairing_desktop_locked.png"),
      );
    }
    await _untangle(tester);
  });

  testWidgets("已配对 · 代签配对码 + 设备列表", (WidgetTester tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    // 本机凭据是绑定时写进去的：save() 先置内存态再落盘，
    // 落盘要等 path_provider 往返，fake-async 区里 await 它会僵，这里不催它写完。
    unawaited(AccessCredentialStore.instance.save(
      const AccessDeviceBinding(
        token: _localToken,
        userId: _actor,
        tokenId: "at_local",
      ),
    ));
    expect(AccessCredentialStore.instance.hasCredentials, isTrue);

    await tester.pumpWidget(_desktop(
      AccessPairingCard(api: _api(authRequired: true, boundOnServer: true)),
    ));
    await _settle(tester);
    await tester.tap(find.text("为其他设备生成配对码"));
    await _settle(tester);

    expect(find.text("K7M2QD"), findsOneWidget);
    // 本机那台显「本机」，只有另一台给吊销钮
    expect(find.text("吊销"), findsOneWidget);
    expect(find.text("本机"), findsOneWidget);

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("goldens/pairing_desktop_bound.png"),
      );
    }
    unawaited(AccessCredentialStore.instance.clear());
    await _untangle(tester);
  });

  testWidgets("手机端版面内的配对卡", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 880);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    unawaited(AccessCredentialStore.instance.clear());

    await tester.pumpWidget(MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: MobileTheme.light,
      home: const _MockPageWithPairingCard(),
    ));
    await _settle(tester);

    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("goldens/pairing_mobile.png"),
      );
    }
    await _untangle(tester);
  });
}

/// 手机端版面校样：与真实「服务接入」页同宽同边距，只放这张卡
/// （整页要拉真实服务状态，效果图不该被网络左右）。
class _MockPageWithPairingCard extends StatelessWidget {
  const _MockPageWithPairingCard();

  @override
  Widget build(BuildContext context) {
    final MobilePalette p = MobileTheme.of(context);
    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(title: const Text("服务接入")),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 12),
        children: <Widget>[
          AccessPairingCard(
            api: _api(authRequired: true, boundOnServer: true),
            margin: const EdgeInsets.symmetric(horizontal: 16),
          ),
        ],
      ),
    );
  }
}
