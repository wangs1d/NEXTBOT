import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/features/chat/message_body_renderer.dart";
import "package:nextbot/mobile_ui/mobile_theme.dart";

/// 手机端助手气泡宽度判定（2026-11-21）：
/// 宽度必须按「渲染器真正会画出来的正文」判，而不是只看 message.text。
/// 回归场景：信封 text 块带全文结构化正文、finalText 只剩一句开场白 →
/// 泡仍是全宽，不再缩回 73.8%。
ChatMessage _msg({
  String text = "",
  List<Map<String, dynamic>>? envelopeBlocks,
  List<Map<String, dynamic>>? renderBlocks,
  Map<String, dynamic>? summaryCard,
  List<Map<String, dynamic>>? mediaCards,
  String role = "assistant",
}) {
  return ChatMessage(
    messageId: "m1",
    sessionId: "s1",
    role: role,
    text: text,
    timestamp: DateTime(2026, 11, 21, 22, 5),
    envelopeBlocks: envelopeBlocks,
    renderBlocks: renderBlocks,
    summaryCard: summaryCard,
    mediaCards: mediaCards,
  );
}

const String _structuredBody = "**事实是这样的：**\n\n"
    "- 官方口径只有一句：2026年11月19日首发 PS5 和 Xbox Series X|S，PC 不在首发名单里。\n"
    "- 按历代规律（GTA5 主机到 PC 隔了一年半），PC 版大概率要等。\n"
    "- 独占协议是玩家自己猜的，官方从来没说过。";

void main() {
  group("assistantBodyNeedsWideWidth", () {
    test("信封 text 块带结构化全文、finalText 只剩一句 → 仍全宽", () {
      final ChatMessage m = _msg(
        text: "没这回事，大哥。",
        envelopeBlocks: <Map<String, dynamic>>[
          <String, dynamic>{"type": "text", "text": _structuredBody},
        ],
      );
      expect(assistantBodyNeedsWideWidth(m), isTrue);
    });

    test("信封 text 块是纯叙述、finalText 也纯叙述 → 设计稿泡宽", () {
      final ChatMessage m = _msg(
        text: "没这回事，大哥，官方从来没说过。",
        envelopeBlocks: <Map<String, dynamic>>[
          <String, dynamic>{
            "type": "text",
            "text": "没这回事，大哥，官方从来没说过。",
          },
        ],
      );
      expect(assistantBodyNeedsWideWidth(m), isFalse);
    });

    test("无块纯闲聊单句 → 设计稿泡宽", () {
      expect(assistantBodyNeedsWideWidth(_msg(text: "在的，大哥。")), isFalse);
    });

    test("无块结构化 markdown（标题 + 列表）→ 全宽", () {
      expect(assistantBodyNeedsWideWidth(_msg(text: _structuredBody)), isTrue);
    });

    test("纯媒体块、无卡、正文纯叙述 → 设计稿泡宽", () {
      final ChatMessage m = _msg(
        text: "给你找了几张。",
        envelopeBlocks: <Map<String, dynamic>>[
          <String, dynamic>{
            "type": "media",
            "media": <String, dynamic>{},
          },
        ],
      );
      expect(assistantBodyNeedsWideWidth(m), isFalse);
    });

    test("带卡块 → 全宽", () {
      final ChatMessage m = _msg(
        text: "办好了。",
        envelopeBlocks: <Map<String, dynamic>>[
          <String, dynamic>{
            "type": "card",
            "card": <String, dynamic>{"cardType": "reminder_confirm"},
          },
        ],
      );
      expect(assistantBodyNeedsWideWidth(m), isTrue);
    });

    test("摘要卡轮（正文被清空）→ 全宽", () {
      final ChatMessage m = _msg(
        text: "",
        summaryCard: <String, dynamic>{"title": "摘要"},
      );
      expect(assistantBodyNeedsWideWidth(m), isTrue);
    });

    test("用户消息恒按用户泡宽", () {
      expect(
        assistantBodyNeedsWideWidth(_msg(text: _structuredBody, role: "user")),
        isFalse,
      );
    });
  });

  // 宽度口径唯一源（2026-11-21）：此前页面里散着 `* 0.738` 与 `width - 16*2`
  // 多份字面量，这里把两条口径钉死，改动只能经 MobileTheme 一处。
  group("MobileTheme 宽度口径", () {
    test("宽泡 = 屏宽 − 左右各 16px", () {
      expect(MobileTheme.messageMaxWidth(1260), 1228);
    });

    test("闲聊泡 = 屏宽 × 0.738（截图实测窄泡 930px / 屏宽 1260px，取整）", () {
      expect(MobileTheme.chatBubbleMaxWidth(1260), closeTo(929.88, 0.01));
    });
  });
}
