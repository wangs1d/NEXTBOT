// 手机端聊天内联规划流：意图闸门单测。
//
// 触发口径与已删除的交接入口一致：规划/安排类动词 × 出行语境，且排除
// 纯信息问询（几点/门票/天气/怎么去等）。这里只锁行为，不测网络。
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

void main() {
  group("looksLikeTravelPlanningIntent", () {
    test("规划动词 + 出行语境命中", () {
      expect(looksLikeTravelPlanningIntent("帮我规划一下去成都玩五天"), isTrue);
      expect(looksLikeTravelPlanningIntent("十一想出去玩，帮我安排下行程"), isTrue);
      expect(looksLikeTravelPlanningIntent("做个西安旅游攻略"), isTrue);
      expect(looksLikeTravelPlanningIntent("帮我做一份大理旅行攻略"), isTrue);
      expect(looksLikeTravelPlanningIntent("制定一个去北京的出行计划"), isTrue);
      expect(looksLikeTravelPlanningIntent("帮我排一下云南自驾的路线"), isTrue);
      expect(looksLikeTravelPlanningIntent("规划一下杭州三天怎么玩"), isTrue);
      expect(looksLikeTravelPlanningIntent("帮我规划去成都五天"), isTrue);
    });

    test("非出行 / 信息问询不命中", () {
      expect(looksLikeTravelPlanningIntent("帮我安排明天下午的会议"), isFalse);
      expect(looksLikeTravelPlanningIntent("计划一下这周的工作"), isFalse);
      expect(looksLikeTravelPlanningIntent("成都在哪"), isFalse);
      expect(looksLikeTravelPlanningIntent("上次旅行照片给我看看"), isFalse);
      expect(looksLikeTravelPlanningIntent("去成都几点的高铁"), isFalse);
      expect(looksLikeTravelPlanningIntent("成都景点门票多少钱"), isFalse);
      expect(looksLikeTravelPlanningIntent("成都天气怎么样"), isFalse);
      expect(looksLikeTravelPlanningIntent(""), isFalse);
    });

    test("超长文本不接管（交给 Agent 阅读）", () {
      final String long = "帮我规划一下行程${"成都" * 80}";
      expect(long.length, greaterThan(120));
      expect(looksLikeTravelPlanningIntent(long), isFalse);
    });
  });
}
