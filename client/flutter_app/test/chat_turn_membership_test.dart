// 删除「这一轮」的范围判定：按消息 id 里的轮次锚点归集，不按位置窗口。
//
// 覆盖：
// - 本轮 user + 回复气泡（单泡 / 分泡 / 跨端回填行）都在范围内
// - 夹在一轮里的主动推送 / 睡前备忘不带锚点，不得被连带删除
// - 点主动推送本身 → 只删它自己
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";

ChatMessage _msg(String id, String role) => ChatMessage(
      messageId: id,
      sessionId: "actor-1",
      role: role,
      text: id,
      timestamp: DateTime(2026, 10, 30, 9),
    );

void main() {
  group("turnAnchorOfMessage", () {
    test("user 消息自身即锚点", () {
      expect(turnAnchorOfMessage(_msg("msg-1", "user")), "msg-1");
    });

    test("单泡 / 分泡 / 回填行都归到 user 锚点", () {
      expect(turnAnchorOfMessage(_msg("assistant-msg-1", "assistant")), "msg-1");
      expect(
        turnAnchorOfMessage(_msg("assistant-msg-1-b2", "assistant")),
        "msg-1",
      );
      expect(
        turnAnchorOfMessage(_msg("assistant-msg-1-hist-0", "assistant")),
        "msg-1",
      );
    });

    test("主动推送类消息没有轮次归属", () {
      for (final String id in <String>[
        "assistant-proactive-1700000000000000",
        "assistant-evening-digest-1700000000000000",
        "assistant-task-1700000000000000",
      ]) {
        final ChatMessage m = _msg(id, "assistant");
        // 无归属的判据是「与任何 user 消息 id 都不相等」，此处锚点取其自身
        // 内嵌的 trace，调用方按全等比较；用它参与 turnMessageIdsFor 只会
        // 命中它自己。
        expect(turnMessageIdsFor(m, <ChatMessage>[m]), <String>[id]);
      }
    });
  });

  group("turnMessageIdsFor", () {
    final ChatMessage user1 = _msg("msg-1", "user");
    final ChatMessage bubble = _msg("assistant-msg-1", "assistant");
    final ChatMessage split = _msg("assistant-msg-1-b2", "assistant");
    final ChatMessage proactive = _msg("assistant-proactive-1", "assistant");
    final ChatMessage digest = _msg("assistant-evening-digest-1", "assistant");
    final ChatMessage user2 = _msg("msg-2", "user");
    final ChatMessage bubble2 = _msg("assistant-msg-2", "assistant");
    final List<ChatMessage> all = <ChatMessage>[
      user1,
      bubble,
      proactive,
      split,
      digest,
      user2,
      bubble2,
    ];

    test("本轮 user + 回复，夹带的主动消息不入选", () {
      expect(
        turnMessageIdsFor(user1, all),
        <String>["msg-1", "assistant-msg-1", "assistant-msg-1-b2"],
      );
    });

    test("从回复气泡反查同一轮", () {
      expect(
        turnMessageIdsFor(split, all),
        <String>["msg-1", "assistant-msg-1", "assistant-msg-1-b2"],
      );
    });

    test("主动推送 / 睡前备忘只删自己", () {
      expect(turnMessageIdsFor(proactive, all), <String>["assistant-proactive-1"]);
      expect(
        turnMessageIdsFor(digest, all),
        <String>["assistant-evening-digest-1"],
      );
      expect(
        turnMessageIdsFor(proactive, all).contains(user1.messageId),
        isFalse,
      );
    });

    test("相邻轮次互不牵连", () {
      expect(
        turnMessageIdsFor(bubble2, all),
        <String>["msg-2", "assistant-msg-2"],
      );
    });
  });
}
