import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/app_auto_start.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const MethodChannel channel = MethodChannel("pai/app_lifecycle");
  final List<MethodCall> calls = <MethodCall>[];
  bool registered = false;

  setUp(() {
    calls.clear();
    registered = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      calls.add(call);
      switch (call.method) {
        case "getAutoStart":
          return registered;
        case "setAutoStart":
          registered = (call.arguments as Map?)?["enable"] == true;
          return true;
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group("AppAutoStart.reassert", () {
    test("已启用时重写 Run 键为当前 exe 路径（setAutoStart enable:true）", () async {
      registered = true;
      await AppAutoStart.reassert();

      final List<MethodCall> setCalls =
          calls.where((MethodCall c) => c.method == "setAutoStart").toList();
      expect(setCalls, hasLength(1));
      expect((setCalls.single.arguments as Map)["enable"], isTrue);
    });

    test("未启用时不写 Run 键，不替用户打开", () async {
      registered = false;
      await AppAutoStart.reassert();

      expect(calls.map((MethodCall c) => c.method), <String>["getAutoStart"]);
    });
  });
}
