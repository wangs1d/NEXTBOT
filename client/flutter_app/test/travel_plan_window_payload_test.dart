import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/core/utils/agent_result_parser.dart";
import "package:nextbot/features/chat/travel_plan_window.dart";

void main() {
  test("TravelPlanWindowPayload 编解码往返：卡片与主题无损", () {
    const Map<String, dynamic> plan = <String, dynamic>{
      "planId": "p1",
      "toolName": "travel.plan-itinerary",
      "destination": "大理",
      "title": "大理2日游",
      "days": <dynamic>[
        <String, dynamic>{
          "date": "2026-09-10",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "attraction",
              "name": "洱海",
              "latitude": 25.7,
              "longitude": 100.2,
            },
          ],
        },
      ],
    };
    final AgentResultData card = AgentResultData(
      title: "大理2日游",
      items: const <AgentResultItem>[
        AgentResultItem(type: "num", text: "Day 1", depth: 1, url: "u"),
      ],
      cardType: "travel_itinerary",
      travelPlan: plan,
      autoOpen: true,
    );

    final String raw =
        TravelPlanWindowPayload(card: card, theme: AppThemeVariant.warm)
            .encode();
    final TravelPlanWindowPayload? decoded =
        TravelPlanWindowPayload.tryDecode(raw);

    expect(decoded, isNotNull);
    final TravelPlanWindowPayload payload = decoded!;
    expect(payload.theme, AppThemeVariant.warm);
    final AgentResultData decodedCard = payload.card!;
    expect(decodedCard.cardType, "travel_itinerary");
    expect(decodedCard.title, "大理2日游");
    expect(decodedCard.autoOpen, isTrue);
    expect(decodedCard.items.single.text, "Day 1");
    expect(decodedCard.items.single.depth, 1);
    expect(decodedCard.items.single.url, "u");
    expect(decodedCard.travelPlan?["destination"], "大理");
    expect(
      (decodedCard.travelPlan?["days"] as List<dynamic>).first,
      isA<Map<String, dynamic>>(),
    );
  });

  test("TravelPlanWindowPayload.tryDecode 损坏输入返回 null", () {
    expect(TravelPlanWindowPayload.tryDecode("not-json"), isNull);
    expect(TravelPlanWindowPayload.tryDecode('{"version":1}'), isNull);
    expect(TravelPlanWindowPayload.tryDecode('{"card":"oops"}'), isNull);
  });
}
