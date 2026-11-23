import "package:flutter_test/flutter_test.dart";
import "package:nextbot/mobile_ui/mobile_home.dart";

/// 桌面小组件各区域的落点（2026-11-23 PRD §5.3「各区域深链到对应页面」）。
///
/// 这里能证的是纯逻辑那半段：路由值 → tab 的映射表，和重复点按的去重闸。
/// 原生侧那半段（`TodayWidgetRenderer.launch` 把 route 写在 intent 上 →
/// `MainActivity.forwardIntake` 落进 ShareIntakeStore 队列 → Dart `take` 取走）
/// 要真机点按才验得了，所以路由字符串在这里逐个钉死——它们是原生
/// `ROUTE_SCHEDULE / ROUTE_PARCEL / ROUTE_BILL / ROUTE_NOTE` 的常量值，
/// 改了任何一边，这张表就得跟着改，测试会先叫。
void main() {
  group("WidgetNav.tabFor：路由值 → 主壳 tab", () {
    test("schedule（2×2 整卡 / 4×2「下一件事」那一行）→ 行程表 tab", () {
      expect(WidgetNav.tabFor("schedule"), WidgetNav.tabSchedule);
      expect(WidgetNav.tabSchedule, 1);
    });

    test("bill（4×2「今天到期」）与 parcel（4×2「待取件」）→ 动态页 tab", () {
      // 账单区块与快递区块本来就是动态页同屏的两个 section，没有分节锚点 API，
      // 所以两者落同一屏——不是漏接，是这一屏就是它们的最近既存页面。
      expect(WidgetNav.tabFor("bill"), WidgetNav.tabDynamics);
      expect(WidgetNav.tabFor("parcel"), WidgetNav.tabDynamics);
      expect(WidgetNav.tabDynamics, 2);
    });

    test("note 不切页：它是「记一下」，弹半屏速记卡，走 entry 那条队", () {
      expect(WidgetNav.tabFor("note"), isNull);
    });

    test("未知 / 空路由一律不跳页：宁可只把 App 带到前台，也别乱跳", () {
      expect(WidgetNav.tabFor(null), isNull);
      expect(WidgetNav.tabFor(""), isNull);
      expect(WidgetNav.tabFor("whatever"), isNull);
      // 大小写与空白不做容错：原生给的是写死的常量，对不上就是不跳
      expect(WidgetNav.tabFor("Schedule"), isNull);
    });

    test("2×2 与 4×2 共用同一张表：同一区域在两个尺寸落点一致", () {
      // 原生两个尺寸都调同一个 launch(ctx, ROUTE_*, REQ_*)，路由值同源
      for (final String route in <String>["schedule", "bill", "parcel"]) {
        expect(WidgetNav.tabFor(route), isNotNull, reason: route);
      }
    });
  });

  group("WidgetNavGate.accept：重复点按幂等", () {
    test("不在目标页时切页，并记下生效的路由", () {
      final WidgetNavGate gate = WidgetNavGate();
      expect(gate.accept("schedule", currentTab: 0), 1);
      expect(gate.lastApplied, "schedule");
      expect(gate.accept("bill", currentTab: 0), 2);
    });

    test("已经在目标页：返回 null，不补第二次切页（切页会连带 refresh 那一屏）", () {
      final WidgetNavGate gate = WidgetNavGate();
      expect(gate.accept("schedule", currentTab: 0), 1);
      // 同一条点按再来一次，此时人已经在行程表 tab 上
      expect(gate.accept("schedule", currentTab: 1), isNull);
      expect(gate.accept("bill", currentTab: 2), isNull);
      expect(gate.accept("parcel", currentTab: 2), isNull);
    });

    test("用户自己切走了再点小组件：照样能切回来，去重不是拉黑", () {
      final WidgetNavGate gate = WidgetNavGate();
      expect(gate.accept("schedule", currentTab: 0), 1);
      expect(gate.accept("schedule", currentTab: 3), 1); // 人去资料库了，再点仍生效
    });

    test("note / 未知路由永不产生切页动作", () {
      final WidgetNavGate gate = WidgetNavGate();
      expect(gate.accept("note", currentTab: 0), isNull);
      expect(gate.accept("nope", currentTab: 0), isNull);
      expect(gate.lastApplied, isNull);
    });

    test("reset（登出）后闸只清诊断量，判定仍只看当前 tab", () {
      final WidgetNavGate gate = WidgetNavGate();
      expect(gate.accept("schedule", currentTab: 0), 1);
      gate.reset();
      expect(gate.lastApplied, isNull);
      expect(gate.accept("schedule", currentTab: 2), 1);
    });
  });
}
