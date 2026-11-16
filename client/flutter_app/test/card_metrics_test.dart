import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/ui/card_metrics.dart";

/// 宽度口径契约（2026-11-13 P0-7）。
///
/// 用户诉求：「卡片能够直接顶满手机的横向宽度，不要太窄了」——390 是硬编码的
/// iPhone 14/15 宽，在 430pt（Pro Max）/480pt（Android）上右边空 40–90px。
///
/// 同时守住两条**不能破**的既有行为：
/// - 中屏（600–860pt）满宽不收窄：收窄会改变文字换行，进而让聊天页滚动接管
///   滑块的「总高估算」在拖动中跳变（chat_scroll_takeover_test.dart）。
/// - 桌面（≥860pt）收敛到 860：与消息流同宽，不横贯全屏。
void main() {
  testWidgets("宽度口径：手机顶满 / 中屏满宽 / 桌面收敛 860", (WidgetTester tester) async {
    Future<double> widthAt(double w) async {
      tester.view.physicalSize = Size(w, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      late double got;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (BuildContext context) {
              got = CardMetrics.maxWidth(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      return got;
    }

    // 手机：顶满（用户诉求）
    expect(await widthAt(375), 375);
    expect(await widthAt(390), 390);
    expect(await widthAt(430), 430);
    expect(await widthAt(480), 480);

    // 中屏：满宽不收窄（与改造前一致，避免换行变化引发滑块估算跳变）
    expect(await widthAt(600), 600);
    expect(await widthAt(800), 800);
    expect(await widthAt(859), 859);

    // 桌面：收敛 860
    expect(await widthAt(860), 860);
    expect(await widthAt(1440), 860);
  });

  testWidgets("聊天页内容列与卡片同口径", (WidgetTester tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    late double card;
    late double content;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (BuildContext context) {
            card = CardMetrics.maxWidth(context);
            content = CardMetrics.contentMaxWidth(context);
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    expect(card, 430);
    expect(content, card, reason: "两级收窄会互相打架，必须同口径");
  });
}
