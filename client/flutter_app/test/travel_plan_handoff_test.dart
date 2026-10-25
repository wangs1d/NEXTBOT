import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/travel_plan_archive.dart";

void main() {
  test("规划类诉求交接给旅游入口", () {
    expect(looksLikeTravelPlanningRequest("帮我规划三亚3天行程"), isTrue);
    expect(looksLikeTravelPlanningRequest("下个月去丽江玩五天"), isTrue);
    expect(looksLikeTravelPlanningRequest("做一份成都两日游攻略"), isTrue);
  });

  test("单点查询留在主对话", () {
    expect(looksLikeTravelPlanningRequest("三亚明天天气"), isFalse);
    expect(looksLikeTravelPlanningRequest("三亚门票多少钱"), isFalse);
    expect(looksLikeTravelPlanningRequest("今天吃什么"), isFalse);
  });

  test("空文本与超长文本不交接", () {
    expect(looksLikeTravelPlanningRequest("   "), isFalse);
    expect(looksLikeTravelPlanningRequest("规划${"很长的描述" * 60}"), isFalse);
  });
}
