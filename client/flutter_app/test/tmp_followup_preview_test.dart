import "dart:typed_data" show ByteData, Uint8List;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show rootBundle, FontLoader;
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/chat/followup_bubbles.dart";
import "package:nextbot/mobile_ui/mobile_theme.dart";

Future<void> _loadFonts() async {
  final FontLoader sans = FontLoader("MiSans");
  for (final String f in <String>[
    "assets/fonts/MiSans-Regular.otf",
    "assets/fonts/MiSans-Medium.otf",
    "assets/fonts/MiSans-Semibold.otf",
  ]) {
    sans.addFont(rootBundle.load(f));
  }
  await sans.load();
}

const List<String> kPrompts = <String>[
  "帮我看看我手里那几只跌了多少",
  "AI这波跌到哪算底",
];

void main() {
  testWidgets("preview-desktop-dark", (WidgetTester tester) async {
    await _loadFonts();
    await tester.binding.setSurfaceSize(const Size(760, 360));
    final ThemeData theme = AppTheme.material;
    final ColorScheme cs = theme.colorScheme;
    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: Scaffold(
          backgroundColor: const Color(0xFF0F0F0F),
          body: Padding(
            padding: const EdgeInsets.all(24),
            child: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 560,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Container(
                      padding: const EdgeInsets.fromLTRB(10, 8, 12, 10),
                      decoration: BoxDecoration(
                        color: cs.surfaceContainerLow.withValues(alpha: 0.4),
                        border: Border.all(
                            color: cs.outline.withValues(alpha: 0.32)),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Text(
                        "大盘今天普跌，AI 板块回调明显，你的持仓也在回撤里。",
                        style: TextStyle(color: cs.onSurface, fontSize: 14),
                      ),
                    ),
                    FollowUpBubbles(
                      prompts: kPrompts,
                      onTap: (String _) {},
                      bubbleColor: cs.surfaceContainerHigh,
                      textColor: cs.onSurface,
                      maxWidthFactor: 0.95,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile("goldens/tmp_followup_desktop.png"),
    );
  });

  testWidgets("preview-mobile-dark", (WidgetTester tester) async {
    await _loadFonts();
    await tester.binding.setSurfaceSize(const Size(390, 420));
    final MobilePalette p = MobilePalette.dark;
    await tester.pumpWidget(
      MaterialApp(
        theme: MobileTheme.dark,
        home: Scaffold(
          backgroundColor: p.background,
          body: Padding(
            padding: const EdgeInsets.all(16),
            child: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 390 - 32,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                        margin: const EdgeInsets.symmetric(vertical: 5),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 15, vertical: 11),
                        decoration: BoxDecoration(
                          color: p.userBubble,
                          borderRadius: const BorderRadius.only(
                            topLeft: Radius.circular(MobileTheme.bubbleRadius),
                            topRight: Radius.circular(6),
                            bottomLeft:
                                Radius.circular(MobileTheme.bubbleRadius),
                            bottomRight:
                                Radius.circular(MobileTheme.bubbleRadius),
                          ),
                        ),
                        child: Text(
                          "最近 AI 跌成这样，帮我看看",
                          style: TextStyle(
                              color: p.userBubbleText, fontSize: 15),
                        ),
                      ),
                    ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.symmetric(vertical: 5),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 15, vertical: 11),
                        constraints: const BoxConstraints(maxWidth: 280),
                        decoration: BoxDecoration(
                          color: p.assistantBubble,
                          borderRadius: const BorderRadius.only(
                            topLeft: Radius.circular(6),
                            topRight: Radius.circular(MobileTheme.bubbleRadius),
                            bottomLeft:
                                Radius.circular(MobileTheme.bubbleRadius),
                            bottomRight:
                                Radius.circular(MobileTheme.bubbleRadius),
                          ),
                        ),
                        child: Text(
                          "大盘今天普跌，AI 板块回调明显，你的持仓也在回撤里。",
                          style: TextStyle(
                              color: p.assistantBubbleText, fontSize: 15),
                        ),
                      ),
                    ),
                    FollowUpBubbles(
                      prompts: kPrompts,
                      onTap: (String _) {},
                      bubbleColor: p.assistantBubble,
                      textColor: p.assistantBubbleText,
                      bubbleRadius: MobileTheme.bubbleRadius,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile("goldens/tmp_followup_mobile.png"),
    );
  });
}
