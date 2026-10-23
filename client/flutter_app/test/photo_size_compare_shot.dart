/// 「工具搜出来的照片 vs 模型引用的图」尺寸/版式对比图生成器。
///
/// 运行：
///   UI_SHOT_DIR=test/photo_compare flutter test --update-goldens test/photo_size_compare_shot.dart
///
/// 左：工具照片走的真实组件链路 MediaInlineRow → MediaGallery
///    （半宽照片流 ≈262px、自然宽高比、每张带视觉模型描述）；
/// 右：模型在正文里引用的图（独占一行 → 块级 560/16:9；混在句中 → 行内 220×150）。
/// 图片经本机临时 HTTP 服务提供真实位图（测试绑定仅在 runAsync 内放行真实网络），
/// 保证看到的尺寸/裁切与真机一致。
library;

import "dart:io"
    show
        ContentType,
        Directory,
        File,
        HttpClient,
        HttpOverrides,
        HttpServer,
        Platform;
import "dart:typed_data" show ByteData, Uint8List;
import "dart:ui" as ui;

import "package:flutter/material.dart";
import "package:flutter/painting.dart" show debugNetworkImageHttpClientProvider;
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/agent_result_card.dart";
import "package:nextbot/features/chat/structured_assistant_message_body.dart";

Future<void> _loadFonts() async {
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
    "assets/fonts/MiSans-Bold.otf",
  ]) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();
  try {
    final String cacheDir = File(
      Platform.resolvedExecutable,
    ).parent.parent.parent.parent.path;
    final File iconFont = File(
      "$cacheDir/artifacts/material_fonts/MaterialIcons-Regular.otf",
    );
    await (FontLoader(
      "MaterialIcons",
    )..addFont(iconFont
                .readAsBytes()
                .then((Uint8List bytes) => ByteData.view(bytes.buffer))))
        .load();
  } catch (_) {}
}

// ignore: avoid_classes_with_only_static_members
/// 占位"照片"生成器：纯色渐变 + 角标文字，按 label 区分。
abstract final class _FakePhotos {
  static Future<Uint8List> make({
    required int width,
    required int height,
    required Color base,
    required String label,
  }) async {
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    final Canvas canvas = Canvas(recorder);
    final Rect rect = Offset.zero & Size(width.toDouble(), height.toDouble());
    final Paint paint = Paint()
      ..shader = ui.Gradient.linear(
        rect.topLeft,
        rect.bottomRight,
        <Color>[base, Color.lerp(base, Colors.black, .35)!],
      );
    canvas.drawRect(rect, paint);
    // 角标：白色半透明圆 + 标签文字，便于辨认这是占位图
    final TextPainter tp = TextPainter(
      text: TextSpan(
        text: label,
        style: TextStyle(
          fontFamily: "MiSans",
          color: Colors.white.withValues(alpha: .92),
          fontSize: width * 0.055,
          fontWeight: FontWeight.w700,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: width * 0.8);
    tp.paint(
      canvas,
      Offset(
        (width - tp.width) / 2,
        (height - tp.height) / 2,
      ),
    );
    final ui.Image image = await recorder.endRecording().toImage(width, height);
    final ByteData? bytes = await image.toByteData(
      format: ui.ImageByteFormat.png,
    );
    return bytes!.buffer.asUint8List();
  }
}

/// 极简本机图片服务：GET /<name>.png 返回预生成的 PNG。
class _PhotoServer {
  _PhotoServer._();

  static HttpServer? _server;
  static final Map<String, Uint8List> _files = <String, Uint8List>{};

  static String put(String name, Uint8List bytes) {
    _files[name] = bytes;
    return "http://127.0.0.1:${_server!.port}/$name";
  }

  static Future<void> start() async {
    // 测试绑定默认把网络替换成 400 假响应；仅 runAsync 区域放行真实 socket。
    // 双保险：绑定若经 debugNetworkImageHttpClientProvider 注入假客户端，
    // 这里换成真实 HttpClient（请求发生在 runAsync 内，访问本机服务）。
    // painting 调试变量必须在测试体返回前还原（flutter_test 退出断言）。
    HttpOverrides.global = null;
    debugNetworkImageHttpClientProvider = () => HttpClient();
    _server = await HttpServer.bind("127.0.0.1", 0);
    _server!.listen((request) async {
      final String name = request.uri.path.replaceFirst("/", "");
      final Uint8List? bytes = _files[name];
      if (bytes == null) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      request.response.headers.contentType = ContentType("image", "png");
      request.response.add(bytes);
      await request.response.close();
    });
  }
}

Future<Uint8List> _png({
  required int w,
  required int h,
  required Color c,
  required String label,
}) => _FakePhotos.make(width: w, height: h, base: c, label: label);

Widget _panel({
  required String title,
  required String note,
  required Widget child,
}) {
  return Container(
    width: 620,
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
    decoration: BoxDecoration(
      color: const Color(0xFF161616),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          title,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          note,
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.55),
            fontSize: 11.5,
            height: 1.4,
          ),
        ),
        const SizedBox(height: 10),
        child,
      ],
    ),
  );
}

Future<void> main() async {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);

  testWidgets("照片尺寸对比：工具图廊 vs 模型引用图", (WidgetTester tester) async {
    final String outDir =
        Platform.environment["UI_SHOT_DIR"] ?? "goldens/photo_compare";
    await tester.runAsync(() async {
      await _loadFonts();
      await _PhotoServer.start();
      final String landscapeUrl = _PhotoServer.put(
        "landscape.png",
        await _png(w: 960, h: 640, c: const Color(0xFF2E6E8E), label: "工具照片 · 横图"),
      );
      final String portraitUrl = _PhotoServer.put(
        "portrait.png",
        await _png(w: 600, h: 800, c: const Color(0xFF7A5C42), label: "工具照片 · 竖图"),
      );
      final String wideUrl = _PhotoServer.put(
        "wide.png",
        await _png(w: 960, h: 540, c: const Color(0xFF4C6B45), label: "工具照片 · 宽幅"),
      );
      final String blockUrl = _PhotoServer.put(
        "block.png",
        await _png(w: 1120, h: 630, c: const Color(0xFF6E4A7E), label: "模型引用 · 块级 16:9"),
      );
      final String inlineUrl = _PhotoServer.put(
        "inline.png",
        await _png(w: 440, h: 300, c: const Color(0xFF8E5A4A), label: "模型引用 · 行内"),
      );

      final ThemeData theme =
          _withFallback(AppTheme.of(AppThemeVariant.dark));
      final ColorScheme cs = theme.colorScheme;

      // 左：工具照片——真实组件链路 mediaCards → MediaInlineRow → MediaGallery
      final Widget toolPanel = _panel(
        title: "工具搜出来的照片（mediaCards 图廊）",
        note: "MediaGallery：每张 = min(可用宽,420)/2×1.25 ≈ 262px，"
            "自然宽高比（服务端下发），逐张带视觉模型描述，纵向照片流。",
        child: MediaInlineRow(
          cs: cs,
          items: <AgentResultItem>[
            AgentResultItem(
              type: "image",
              text: "鼓浪屿日光岩",
              mediaType: "image",
              thumbnailUrl: landscapeUrl,
              mediaUrl: landscapeUrl,
              width: 960,
              height: 640,
              caption: "日光岩俯瞰全岛，天气晴好时可见对岸厦门本岛。",
            ),
            AgentResultItem(
              type: "image",
              text: "曾厝垵小吃街",
              mediaType: "image",
              thumbnailUrl: portraitUrl,
              mediaUrl: portraitUrl,
              width: 600,
              height: 800,
              caption: "竖构图：夜市人流与招牌，竖版照片保持原始比例不裁切。",
            ),
            AgentResultItem(
              type: "image",
              text: "环岛路海岸线",
              mediaType: "image",
              thumbnailUrl: wideUrl,
              mediaUrl: wideUrl,
              width: 960,
              height: 540,
              caption: "宽幅海岸线全景。",
            ),
          ],
        ),
      );

      // 右：模型引用的图——正文 markdown，独占一行 → 块级；混在句中 → 行内
      const String markdown =
          "水上屋是马尔代夫的标志性住宿，直接架在泻湖之上，推门即可下水浮潜。\n"
          "![水上屋示意图](http://127.0.0.1:__PORT__/block.png)\n"
          "多数岛屿一价全包，含三餐；从马累搭乘水上飞机约 30 分钟上岛，"
          "沿途可以看到 ![行内小图](http://127.0.0.1:__PORT__/inline.png) 这样的珊瑚礁群，"
          "建议选右侧机舱靠窗的位置。\n"
          "预算有限的话可以选沙滩屋，价格约为水上屋的一半。";
      final Widget citePanel = _panel(
        title: "模型在正文里引用的图",
        note: "独占一行 → 块级：限宽 560、16:9、独占段落；"
            "混在句中 → 行内 220×150 小缩略图，随文字流排布。",
        child: StructuredAssistantMessageBody(
          text: markdown.replaceAll("__PORT__", _PhotoServer._server!.port.toString()),
          cs: cs,
          textTheme: theme.textTheme,
        ),
      );

      tester.view.physicalSize = const Size(1336 * 2, 1180 * 2);
      tester.view.devicePixelRatio = 2.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme,
          home: Scaffold(
            backgroundColor: const Color(0xFF0F0F0F),
            body: Padding(
              padding: const EdgeInsets.all(24),
              child: SingleChildScrollView(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    toolPanel,
                    const SizedBox(width: 24),
                    citePanel,
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      // 真实等待：图片经本机 HTTP 加载 + 解码
      await Future<void>.delayed(const Duration(milliseconds: 600));
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      await tester.pump();
    });

    if (autoUpdateGoldenFiles) {
      await tester.runAsync(() async {
        await Directory(outDir).create(recursive: true);
      });
      final String goldenRel =
          outDir.startsWith("test/") ? outDir.substring(5) : outDir;
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile("$goldenRel/photo-size-compare.png"),
      );
    }
    debugNetworkImageHttpClientProvider = null;
  });
}

ThemeData _withFallback(ThemeData theme) {
  TextTheme fallback(TextTheme? t) =>
      (t ?? const TextTheme()).apply(fontFamilyFallback: <String>["MiSans"]);
  return theme.copyWith(
    textTheme: fallback(theme.textTheme),
    primaryTextTheme: fallback(theme.primaryTextTheme),
  );
}
