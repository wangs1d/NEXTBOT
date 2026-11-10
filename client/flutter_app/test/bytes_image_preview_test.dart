/// 字节版全屏图片查看页（用户发出照片）的跟手分页测试。
///
/// 2026-11-10 交互改版：左右切换从「阈值瞬跳」改为「跟手平移 + 吸附」——
/// 拖动时当前图与邻图同屏平移，松手按位移过半 / 横向速度吸附。
/// 这组测试验证吸附判定的四个核心分支与边界钳制。
library;

import "dart:typed_data";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/image_preview_panel.dart";

/// 标准 1x1 透明 PNG（67 字节），保证 Image.memory 可解码。
const List<int> _png1x1 = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

Uint8List _img() => Uint8List.fromList(_png1x1);

Future<void> _openPreview(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (BuildContext ctx) => Center(
            child: ElevatedButton(
              onPressed: () => showImagePreviewFullScreenFromBytes(
                ctx,
                images: <Uint8List>[_img(), _img(), _img()],
                source: "发出的照片",
              ),
              child: const Text("open"),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text("open"));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets("拖过一半 → 吸附到下一张（跟手分页）", (WidgetTester tester) async {
    await _openPreview(tester);
    expect(find.text("1 / 3"), findsOneWidget);

    // 默认测试面 800 宽，-450 超过半屏（400）→ 换图
    await tester.dragFrom(const Offset(500, 300), const Offset(-450, 0));
    await tester.pumpAndSettle();
    expect(find.text("2 / 3"), findsOneWidget);
  });

  testWidgets("未过一半 → 弹回当前图", (WidgetTester tester) async {
    await _openPreview(tester);

    // -200 不足半屏且无速度 → 回弹
    await tester.dragFrom(const Offset(500, 300), const Offset(-200, 0));
    await tester.pumpAndSettle();
    expect(find.text("1 / 3"), findsOneWidget);
  });

  testWidgets("第一张右拖 → 边界钳制不越界", (WidgetTester tester) async {
    await _openPreview(tester);

    // 在第一张上向右拖（想看上一张）→ 钳制为零位移，回弹原地
    await tester.dragFrom(const Offset(300, 300), const Offset(450, 0));
    await tester.pumpAndSettle();
    expect(find.text("1 / 3"), findsOneWidget);
  });

  testWidgets("上一张 → 拖过一半向右吸附", (WidgetTester tester) async {
    await _openPreview(tester);

    // 先到第 2 张
    await tester.dragFrom(const Offset(500, 300), const Offset(-450, 0));
    await tester.pumpAndSettle();
    expect(find.text("2 / 3"), findsOneWidget);

    // 向右拖过一半 → 回到第 1 张
    await tester.dragFrom(const Offset(300, 300), const Offset(450, 0));
    await tester.pumpAndSettle();
    expect(find.text("1 / 3"), findsOneWidget);
  });

  testWidgets("最后一张左拖 → 边界钳制不越界", (WidgetTester tester) async {
    await _openPreview(tester);

    // 到第 3 张（两次换图）
    await tester.dragFrom(const Offset(500, 300), const Offset(-450, 0));
    await tester.pumpAndSettle();
    await tester.dragFrom(const Offset(500, 300), const Offset(-450, 0));
    await tester.pumpAndSettle();
    expect(find.text("3 / 3"), findsOneWidget);

    // 再向左拖 → 无下一张，钳制回弹
    await tester.dragFrom(const Offset(500, 300), const Offset(-450, 0));
    await tester.pumpAndSettle();
    expect(find.text("3 / 3"), findsOneWidget);
  });
}
