import "dart:async";
import "dart:convert";

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/features/chat/travel_plan_models.dart";
import "package:nextbot/features/chat/travel_web_panel_controller.dart";

/// 整页 WebView 行程面板：桥接控制器 + 载荷构建。
void main() {
  group("TravelWebPanelController 事件桥接", () {
    final List<String> scripts = <String>[];
    bool ready = false;
    late TravelWebPanelController controller;

    Future<void> execute(String script) async {
      scripts.add(script);
    }

    setUp(() {
      scripts.clear();
      ready = false;
      controller = TravelWebPanelController();
      controller.onReady = () => ready = true;
    });

    tearDown(() => controller.detach());

    testWidgets("未就绪时出站脚本入队，ready 后按序补发", (WidgetTester tester) async {
      unawaited(controller.attach(execute));
      controller.loadPlan(<String, dynamic>{"destination": "大理"});
      controller.clearRoute();
      expect(scripts, isEmpty); // 队列中，未执行

      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "ready"}));
      expect(ready, isTrue);
      expect(scripts.length, 2);
      expect(scripts[0], contains("window.__travelPanel.loadPlan"));
      expect(scripts[0], contains("大理"));
      expect(scripts[1], contains("window.__travelPanel.clearRoute()"));
    });

    testWidgets("JS → Dart 事件分发到对应回调", (WidgetTester tester) async {
      int? planDay;
      String? mode;
      String? url;
      bool hideCard = false;
      bool closed = false;
      bool fullscreen = false;
      controller.onPlanRoute = (int d) => planDay = d;
      controller.onSwitchRouteMode = (String m) => mode = m;
      controller.onOpenUrl = (String u) => url = u;
      controller.onHideRouteCard = () => hideCard = true;
      controller.onClose = () => closed = true;
      controller.onFullscreen = () => fullscreen = true;

      controller.handleWebMessage(
        jsonEncode(<String, dynamic>{"event": "planRoute", "dayIndex": 2}),
      );
      controller.handleWebMessage(
        jsonEncode(<String, dynamic>{"event": "switchRouteMode", "mode": "taxi"}),
      );
      controller.handleWebMessage(
        jsonEncode(<String, dynamic>{"event": "openUrl", "url": "https://x.dev"}),
      );
      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "hideRouteCard"}));
      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "close"}));
      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "fullscreen"}));

      expect(planDay, 2);
      expect(mode, "taxi");
      expect(url, "https://x.dev");
      expect(hideCard, isTrue);
      expect(closed, isTrue);
      expect(fullscreen, isTrue);
    });

    testWidgets("非法消息不抛异常", (WidgetTester tester) async {
      unawaited(controller.attach(execute));
      controller.handleWebMessage("not-json{{{");
      controller.handleWebMessage(null);
      controller.handleWebMessage(42);
    });

    // ── 回归：2026-10-12 实盘「行程页永远停在『行程装载中…』」的根因 ──
    // 宿主真实时序是「loadUrl → 页面发 ready → 探测到页面就绪后才 attach」。
    // 曾把 _ready=false 写在 attach 里，而页面只发一次 ready → 就绪态被抹掉，
    // loadPlan 永久滞留在队列里。
    testWidgets("ready 先于 attach 到达时，loadPlan 仍能送达", (WidgetTester tester) async {
      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "ready"}));
      expect(controller.isReady, isTrue);

      await controller.attach(execute); // 探测成功后才注入执行器
      expect(controller.isReady, isTrue, reason: "attach 不得重置已到达的就绪态");

      controller.loadPlan(<String, dynamic>{"destination": "杭州"});
      expect(scripts.length, 1);
      expect(scripts.first, contains("window.__travelPanel.loadPlan"));
      expect(scripts.first, contains("杭州"));
    });

    testWidgets("attach 之前到达的出站调用入队，attach 后补发", (WidgetTester tester) async {
      controller.loadPlan(<String, dynamic>{"destination": "兴义"});
      expect(scripts, isEmpty); // 尚无执行器：必须入队而非丢弃

      await controller.attach(execute);
      expect(scripts.length, 1);
      expect(scripts.first, contains("兴义"));
    });

    testWidgets("resetPageState 后新页面需重新 ready 才放行", (WidgetTester tester) async {
      await controller.attach(execute);
      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "ready"}));
      expect(controller.isReady, isTrue);

      controller.resetPageState(); // 新页面开始导航
      expect(controller.isReady, isFalse);
      controller.loadPlan(<String, dynamic>{"destination": "大理"});
      expect(scripts, isEmpty); // 等新页面 ready

      controller.handleWebMessage(jsonEncode(<String, dynamic>{"event": "ready"}));
      expect(scripts.length, 1);
      expect(scripts.first, contains("大理"));
    });
  });

  group("TravelWebPanelPayload 载荷构建", () {
    final TravelPlanData plan = TravelPlanData.fromPlanJson(<String, dynamic>{
      "planId": "plan-x",
      "destination": "马尔代夫",
      "title": "马代4日游",
      "startDate": "2026-09-05",
      "center": <String, dynamic>{"latitude": 4.17, "longitude": 73.51},
      "days": <dynamic>[
        <String, dynamic>{
          "date": "2026-09-05",
          "items": <dynamic>[
            <String, dynamic>{
              "type": "hotel",
              "name": "Embudu Village",
              "startTime": "15:00",
              "latitude": 4.17,
              "longitude": 73.52,
              "address": "South Malé",
              "priceInfo": "¥1,504",
              "description": "位置便利",
              "tips": <String>["提前预订"],
              "images": <String>["/travel/media/assets/a/x.jpg"],
              "splatUrl": "/travel/media/splats/a.ply",
              "reviews": <dynamic>[
                {"author": "旅友", "rating": 4.5, "text": "很棒"},
              ],
              "videos": <dynamic>[
                {"platform": "bilibili", "title": "水飞体验", "playPageUrl": "https://b23.tv/x"},
              ],
            },
          ],
        },
      ],
    });

    test("媒体地址解析为绝对地址，center/fullscreen/closable 透传", () {
      final Map<String, dynamic> payload = TravelWebPanelPayload.build(
        plan,
        fullscreen: true,
        closable: false,
      );

      expect(payload["destination"], "马尔代夫");
      expect(payload["fullscreen"], isTrue);
      expect(payload["closable"], isFalse);
      final Map<String, dynamic> center =
          payload["center"] as Map<String, dynamic>;
      expect(center["latitude"], closeTo(4.17, 1e-6));
      expect(center["longitude"], closeTo(73.51, 1e-6));

      final List<dynamic> days = payload["days"] as List<dynamic>;
      final Map<String, dynamic> entry =
          ((days.first as Map<String, dynamic>)["entries"] as List<dynamic>)
              .first as Map<String, dynamic>;
      expect(entry["name"], "Embudu Village");
      expect(entry["images"].first, startsWith("http")); // 相对路径已拼服务端地址
      expect(entry["splatUrl"], startsWith("http"));
      expect((entry["reviews"] as List).length, 1);
      expect((entry["videos"] as List).length, 1);
      expect(entry["latitude"], closeTo(4.17, 1e-6));
    });

    test("路线卡载荷字段齐全", () {
      final Map<String, dynamic> card = TravelWebPanelPayload.routeCard(
        totalDistanceText: "3.2km",
        totalDurationText: "15分钟",
        averageCrowdIndex: "4.5",
        optimizationScore: 88,
        assessment: "良好路线",
        segments: <Map<String, dynamic>>[
          <String, dynamic>{
            "instruction": "从A前往B",
            "distanceText": "3.2km",
            "durationMinutes": 15,
          },
        ],
        warnings: <Map<String, dynamic>>[
          <String, dynamic>{"message": "人流密集", "severity": "high"},
        ],
        alternatives: <Map<String, dynamic>>[
          <String, dynamic>{"mode": "taxi", "label": "网约车", "reason": "便捷"},
        ],
        links: <String, String>{"gaode": "https://uri.amap.com/x"},
      );
      expect(card["totalDistanceText"], "3.2km");
      expect((card["segments"] as List).first, containsPair("distanceText", "3.2km"));
      expect((card["links"] as Map).keys, contains("gaode"));
    });
  });
}
