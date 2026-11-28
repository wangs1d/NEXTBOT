// 跨端历史回填载荷解析（server_history_parser）单测：
// - 真·分绿泡轮：assistant item 带 bubbles 对账数组 → 逐泡建消息、
//   时间戳逐泡 +j ms 错开、媒体卡挂末泡
// - 同文分泡是刻意形态：逐泡都保留（解析层不吞并）
// - 旧行/塌缩/单泡轮：无 bubbles 或仅一泡 → 单泡路径（升级前行为）
// - 脏结构静默降级：空 text 泡被过滤、非 List 结构忽略
// - user item 携带 clientMessageId 时 id 透传；user 的 bubbles 字段被忽略
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/models/chat_models.dart";
import "package:nextbot/core/utils/server_history_parser.dart";

Map<String, dynamic> _assistantItem({
  required String text,
  List<Map<String, dynamic>>? bubbles,
  List<Map<String, dynamic>>? mediaCards,
  int ts = 1799900000000,
}) =>
    <String, dynamic>{
      "role": "assistant",
      "text": text,
      "ts": ts,
      if (bubbles != null) "bubbles": bubbles,
      if (mediaCards != null) "mediaCards": mediaCards,
    };

void main() {
  group("parseServerHistoryMessages：分泡重建", () {
    test("带 bubbles 的 assistant item 逐泡建消息，fromBubbles 全 true", () {
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: <dynamic>[
          <String, dynamic>{
            "role": "user",
            "text": "明早叫我",
            "ts": 1799900000000,
            "clientMessageId": "msg-1"
          },
          _assistantItem(
            text: "好，到点叫你。\n\n不过你今晚得早点睡。",
            bubbles: <Map<String, dynamic>>[
              <String, dynamic>{"id": "assistant-t1-b1", "text": "好，到点叫你。"},
              <String, dynamic>{"id": "assistant-t1-b2", "text": "不过你今晚得早点睡。"},
            ],
          ),
        ],
        sessionKey: "actor-1",
      );

      expect(parsed.messages.length, 3);
      expect(parsed.fromBubbles, <bool>[false, true, true]);
      final ChatMessage b1 = parsed.messages[1];
      final ChatMessage b2 = parsed.messages[2];
      expect(b1.role, "assistant");
      expect(b1.text, "好，到点叫你。");
      expect(b2.text, "不过你今晚得早点睡。");
      // 分泡 id 独立可锚定，时间戳逐泡 +j ms 错开（排序稳定不翻序）
      expect(b1.messageId, startsWith("hist-bubble-"));
      expect(b2.messageId, startsWith("hist-bubble-"));
      expect(b1.messageId == b2.messageId, isFalse);
      expect(
        b2.timestamp.isAfter(b1.timestamp),
        isTrue,
        reason: "同轮多泡同毫秒会在时间戳排序下不稳定翻序，必须逐泡错开",
      );
      expect(b1.sessionId, "actor-1");
    });

    test("同文分泡是刻意形态：解析层逐泡保留不吞并", () {
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: <dynamic>[
          _assistantItem(
            text: "好。\n\n好。",
            bubbles: <Map<String, dynamic>>[
              <String, dynamic>{"id": "assistant-t1-b1", "text": "好。"},
              <String, dynamic>{"id": "assistant-t1-b2", "text": "好。"},
            ],
          ),
        ],
        sessionKey: "actor-1",
      );

      expect(parsed.messages.length, 2);
      expect(parsed.messages[0].text, "好。");
      expect(parsed.messages[1].text, "好。");
      expect(parsed.fromBubbles, <bool>[true, true]);
    });

    test("媒体卡挂在末泡（与实时路径媒体挂当前流式末泡同构）", () {
      final List<Map<String, dynamic>> cards = <Map<String, dynamic>>[
        <String, dynamic>{"type": "image", "url": "/agent/images/a.png"},
      ];
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: <dynamic>[
          _assistantItem(
            text: "看这两张。\n\n第二张更好看。",
            bubbles: <Map<String, dynamic>>[
              <String, dynamic>{"id": "assistant-t1-b1", "text": "看这两张。"},
              <String, dynamic>{"id": "assistant-t1-b2", "text": "第二张更好看。"},
            ],
            mediaCards: cards,
          ),
        ],
        sessionKey: "actor-1",
      );

      expect(parsed.messages[0].mediaCards, isNull);
      expect(parsed.messages[1].mediaCards, isNotNull);
    });

    test("空 text 泡被过滤；全空 → 降级单泡", () {
      final ParsedServerHistory filtered = parseServerHistoryMessages(
        raw: <dynamic>[
          _assistantItem(
            text: "只有一条真的。",
            bubbles: <Map<String, dynamic>>[
              <String, dynamic>{"id": "assistant-t1-b1", "text": "  "},
              <String, dynamic>{"id": "assistant-t1-b2", "text": "只有一条真的。"},
            ],
          ),
        ],
        sessionKey: "actor-1",
      );
      expect(filtered.messages.length, 1);
      expect(filtered.fromBubbles, <bool>[false], reason: "只剩一泡 → 单泡路径");
    });

    test("缺 bubbles / 单泡轮 / 非 List 脏结构 → 单泡路径（旧行为）", () {
      final ParsedServerHistory noField = parseServerHistoryMessages(
        raw: <dynamic>[_assistantItem(text: "整轮单泡正文。")],
        sessionKey: "actor-1",
      );
      expect(noField.messages.length, 1);
      expect(noField.messages[0].text, "整轮单泡正文。");
      expect(noField.fromBubbles, <bool>[false]);

      final ParsedServerHistory single = parseServerHistoryMessages(
        raw: <dynamic>[
          _assistantItem(
            text: "单泡。",
            bubbles: <Map<String, dynamic>>[
              <String, dynamic>{"id": "assistant-t1-b1", "text": "单泡。"},
            ],
          ),
        ],
        sessionKey: "actor-1",
      );
      expect(single.messages.length, 1);
      expect(single.fromBubbles, <bool>[false]);

      final ParsedServerHistory dirty = parseServerHistoryMessages(
        raw: <dynamic>[
          _assistantItem(text: "脏结构。", bubbles: <Map<String, dynamic>>[]),
        ],
        sessionKey: "actor-1",
      );
      expect(dirty.messages.length, 1);
      expect(dirty.fromBubbles, <bool>[false]);
    });

    test("明日预览历史透传 messageId 与结构化 digest", () {
      final Map<String, dynamic> digest = <String, dynamic>{
        "date": "2026-11-28",
        "tomorrowWeather": <String, dynamic>{
          "text": "小雨",
          "minC": 15,
          "maxC": 19,
          "alerts": <String>[],
        },
        "narrationText": "明天有小雨，记得带伞。",
      };
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: <dynamic>[
          <String, dynamic>{
            "role": "assistant",
            "text": "明天有小雨，记得带伞。",
            "ts": 1799900000000,
            "messageId": "evening-digest-2026-11-28",
            "eveningDigest": digest,
          },
        ],
        sessionKey: "actor-1",
      );
      final ChatMessage message = parsed.messages.single;
      expect(message.messageId, "evening-digest-2026-11-28");
      expect(message.contentType, "evening_digest");
      expect(message.eveningDigest, digest);
    });

    test("user item 透传 clientMessageId；user 的 bubbles 字段被忽略", () {
      final ParsedServerHistory parsed = parseServerHistoryMessages(
        raw: <dynamic>[
          <String, dynamic>{
            "role": "user",
            "text": "在吗",
            "ts": 1799900000000,
            "clientMessageId": "msg-9",
            "bubbles": <Map<String, dynamic>>[
              <String, dynamic>{"id": "x", "text": "不该拆"},
            ],
          },
        ],
        sessionKey: "actor-1",
      );
      expect(parsed.messages.length, 1);
      expect(parsed.messages[0].messageId, "msg-9");
      expect(parsed.messages[0].role, "user");
      expect(parsed.fromBubbles, <bool>[false]);
    });
  });
}
