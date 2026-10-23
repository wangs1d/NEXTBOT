import "dart:convert";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/agent_result_parser.dart";

/// AgentResultParser：多卡片块场景下的选卡与剥离规则。
///
/// 服务端（chat-user-message.ts / tool-result-processor.ts）可能在通用列表卡
/// 之后确定性附加 travel_itinerary 行程卡，解析器必须优先取行程卡
/// （唯一携带 autoOpen 与结构化 travelPlan），并把全部卡片块从正文剥离。
void main() {
  String block(Map<String, dynamic> json) =>
      "[AGENT_RESULT_CARD_START]\n${jsonEncode(json)}\n[AGENT_RESULT_CARD_END]";

  test("single generic card parses as before", () {
    const String text =
        "前导文字\n"
        '[AGENT_RESULT_CARD_START]\n{"cardType":"media","title":"图集"}\n[AGENT_RESULT_CARD_END]\n'
        "尾随文字";
    final AgentResultParseResult result = AgentResultParser.parse(text);
    expect(result.data?.cardType, "media");
    expect(result.cleanedText.contains("AGENT_RESULT_CARD"), isFalse);
    expect(result.cleanedText.contains("前导文字"), isTrue);
    expect(result.cleanedText.contains("尾随文字"), isTrue);
  });

  test("generic card followed by travel card → travel card wins", () {
    final String text = "先出的通用卡\n"
        "${block(<String, dynamic>{"cardType": "", "title": "LLM 列表卡"})}\n"
        "${block(<String, dynamic>{
            "cardType": "travel_itinerary",
            "title": "马尔代夫2日游",
            "autoOpen": true,
            "travelPlan": <String, dynamic>{
              "destination": "马尔代夫",
              "days": <dynamic>[],
            },
          })}";
    final AgentResultParseResult result = AgentResultParser.parse(text);
    expect(result.data?.cardType, "travel_itinerary");
    expect(result.data?.autoOpen, isTrue);
    expect(result.data?.travelPlan?["destination"], "马尔代夫");
    // 全部卡片块都从正文剥离，不残留原始标记/JSON
    expect(result.cleanedText.contains("AGENT_RESULT_CARD"), isFalse);
    expect(result.cleanedText.contains("LLM 列表卡"), isFalse);
    expect(result.cleanedText, "先出的通用卡");
  });

  test("travel card first is still chosen", () {
    final String text = block(<String, dynamic>{
      "cardType": "travel_itinerary",
      "autoOpen": true,
    });
    final AgentResultParseResult result = AgentResultParser.parse(text);
    expect(result.data?.cardType, "travel_itinerary");
    expect(result.data?.autoOpen, isTrue);
    expect(result.cleanedText, isEmpty);
  });

  test("no card markers → unchanged", () {
    final AgentResultParseResult result = AgentResultParser.parse("普通回复");
    expect(result.data, isNull);
    expect(result.cleanedText, "普通回复");
  });

  test("corrupted card JSON falls back to plain text without markers", () {
    const String text =
        '[AGENT_RESULT_CARD_START]\n{"cardType":"travel_itinerary"\n[AGENT_RESULT_CARD_END]';
    final AgentResultParseResult result = AgentResultParser.parse(text);
    expect(result.data, isNull);
    expect(result.cleanedText.contains("AGENT_RESULT_CARD"), isFalse);
  });
}
