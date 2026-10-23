import "dart:convert";
import "dart:typed_data" show Uint8List;

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/chat_page.dart";

/// 1×1 像素 PNG（测试占位图）
final Uint8List _kPng1x1 =
    base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
        "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

ChatMessage _user(String id, String text) => ChatMessage(
      messageId: id,
      sessionId: "s1",
      role: "user",
      text: text,
      timestamp: DateTime(2026, 9, 16, 10, 0),
      attachmentImageCount: 1,
    );

Widget _host({
  List<ChatMessage> messages = const <ChatMessage>[],
  List<Uint8List> pending = const <Uint8List>[],
  void Function(int index)? onRemoveGalleryImage,
  Set<String> failed = const <String>{},
  List<Uint8List>? Function(String messageId)? resolveUserGalleryImages,
}) {
  return MaterialApp(
    home: Scaffold(
      body: ChatPage(
        messages: messages,
        controller: TextEditingController(),
        onSend: () {},
        galleryPendingImages: pending,
        onRemoveGalleryImage: onRemoveGalleryImage,
        failedUserMessageIds: failed,
        resolveUserGalleryImages: resolveUserGalleryImages,
      ),
    ),
  );
}

void main() {
  testWidgets("待发缩略图：选图后在输入框内部最左侧出现缩略图",
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      pending: <Uint8List>[_kPng1x1, _kPng1x1],
    ));
    await tester.pump();

    expect(find.byType(Image), findsNWidgets(2));
  });

  testWidgets("待发缩略图：点单张 × 按索引移除，未选图时不出现提示",
      (WidgetTester tester) async {
    final List<int> removed = <int>[];
    await tester.pumpWidget(_host(
      pending: <Uint8List>[_kPng1x1, _kPng1x1],
      onRemoveGalleryImage: removed.add,
    ));
    await tester.pump();

    await tester.tap(find.byIcon(Icons.close_rounded).first);
    expect(removed, <int>[0]);

    // 清空后回到无图状态：缩略图不再出现
    await tester.pumpWidget(_host());
    await tester.pump();
    expect(find.byType(Image), findsNothing);
  });

  testWidgets("发送失败徽标：failedUserMessageIds 命中的气泡显示「未发出」",
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      messages: <ChatMessage>[_user("m-1", "带图消息")],
      failed: const <String>{"m-1"},
    ));
    await tester.pump();

    expect(find.text("未发出"), findsOneWidget);
  });

  testWidgets("已发送配图：本会话消息渲染缩略图，历史消息回退「配图 ×1」文案",
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(
      messages: <ChatMessage>[
        _user("m-1", "本会话带图"),
        _user("m-2", "历史带图"),
      ],
      resolveUserGalleryImages: (String id) =>
          id == "m-1" ? <Uint8List>[_kPng1x1] : null,
    ));
    await tester.pump();

    expect(find.text("配图 ×1"), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);
  });
}
