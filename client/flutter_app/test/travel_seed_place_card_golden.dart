// 种草卡设计稿（2026-11-14）：
// 「简短介绍 + 三张地点实拍图 + 右上角圆形勾选」的手机端版式。
//
// 生成/更新设计稿 PNG：
//   flutter test --update-goldens test/travel_seed_place_card_golden.dart
// 产物：test/goldens/travel_seed_place_card_selected.png / _unselected.png
//
// 图片通过 photoBuilder 注入本地 fixtures 的三张实拍裁切图（都来自
// fixtures/maldives_poster.jpg 的不同取景），不依赖真实网络。
library;

import "dart:io" show File, Platform;
import "dart:typed_data" show Uint8List, ByteData;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/travel_seed_place_card.dart";

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
    final String cacheDir = File(Platform.resolvedExecutable)
        .parent
        .parent
        .parent
        .parent
        .path;
    final File iconFont = File(
        "$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf");
    await (FontLoader("MaterialIcons")
          ..addFont(iconFont
              .readAsBytes()
              .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {
    // 找不到图标字体时只影响勾选图标，不影响版式取证。
  }
}

// ── 设计稿数据：与用户给的参考图同款文案 ──

const TravelSeedPlace _silverBeach = TravelSeedPlace(
  id: "silver-beach",
  name: "银滩 · 侨港",
  intro:
      "下午抵达后直奔银滩，别走正门，搜「银沙逐浪区」进去左拐，沙子细到像面粉，退潮后石头缝还能抓小螃蟹。傍晚沿沙滩往西走到侨港海滩看日落，人比银滩少、环境更 chill，有沙滩椅和小酒馆，度假感直接拉满。",
  images: <String>[
    "https://example.com/seed/1.jpg",
    "https://example.com/seed/2.jpg",
    "https://example.com/seed/3.jpg",
  ],
);

Widget _harness(bool selected, Map<String, Uint8List> photos) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      fontFamily: "MiSans",
      scaffoldBackgroundColor: const Color(0xFF121214),
    ),
    home: Scaffold(
      backgroundColor: const Color(0xFF121214),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Align(
          alignment: Alignment.topCenter,
          child: TravelSeedPlaceCard(
            place: _silverBeach,
            selected: selected,
            onChanged: (_) {},
            photoBuilder: (BuildContext context, String url) {
              final Uint8List? bytes = photos[url.split("/").last];
              if (bytes == null) return const SizedBox.shrink();
              return Image.memory(bytes, fit: BoxFit.cover);
            },
          ),
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadFonts);

  Future<void> pumpAndCapture(
    WidgetTester tester,
    bool selected,
    String golden,
  ) async {
    final Map<String, Uint8List> photos = <String, Uint8List>{
      "1.jpg": File("test/fixtures/seed_place_1.jpg").readAsBytesSync(),
      "2.jpg": File("test/fixtures/seed_place_2.jpg").readAsBytesSync(),
      "3.jpg": File("test/fixtures/seed_place_3.jpg").readAsBytesSync(),
    };
    tester.view.physicalSize = const Size(780, 1520);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_harness(selected, photos));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    if (autoUpdateGoldenFiles) {
      await expectLater(
        find.byType(TravelSeedPlaceCard),
        matchesGoldenFile("goldens/$golden"),
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets("种草卡 · 未选中", (WidgetTester tester) async {
    await pumpAndCapture(
        tester, false, "travel_seed_place_card_unselected.png");
  });

  testWidgets("种草卡 · 选中", (WidgetTester tester) async {
    await pumpAndCapture(tester, true, "travel_seed_place_card_selected.png");
  });

  testWidgets("点卡片切换选中", (WidgetTester tester) async {
    bool? got;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TravelSeedPlaceCard(
          place: _silverBeach,
          selected: false,
          onChanged: (bool v) => got = v,
          photoBuilder: (_, __) => const SizedBox.shrink(),
        ),
      ),
    ));
    await tester.tap(find.byType(TravelSeedPlaceCard));
    expect(got, isTrue);
  });
}
