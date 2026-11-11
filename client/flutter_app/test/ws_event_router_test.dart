import "dart:async";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/ws_event_router.dart"
    show
        WsBusSubscription,
        WsEventCatalog,
        WsEventRoute,
        WsEventRouter,
        WsSubscribeScope,
        wsEventPayload;

/// WS 事件路由器（2026-11-10 单分发改造）单测。
///
/// 守护的核心不变量：**同一条业务事件只能有一个 owner**。
/// 之前两处分发器各写一份 `if (type == ...)`，改一处漏一处（normal/high/
/// critical 门槛就漏在手机分发器里）。归属表现在是唯一事实源，这里逐条钉住。
void main() {
  late WsEventRouter router;
  late List<String> rootTypes;
  late List<String> chatTypes;
  late List<StreamSubscription<Map<String, dynamic>>> subs;

  void collect() {
    rootTypes = <String>[];
    chatTypes = <String>[];
    subs = <StreamSubscription<Map<String, dynamic>>>[
      router.rootEvents.listen((e) => rootTypes.add(e["type"] as String)),
      router.chatEvents.listen((e) => chatTypes.add(e["type"] as String)),
    ];
  }

  Future<void> dispatchOne(String type) async {
    router.dispatch(<String, dynamic>{"type": type, "payload": <String, dynamic>{}});
    // 两轮事件循环：信箱链（微任务）+ 同步 handler 完成都能收敛
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  setUp(() {
    router = WsEventRouter.instance;
    // 单例跨测试共享：清掉遥测与状态缓存（含 last-value 连接态），否则
    // 前一个用例 dispatch 过的 ws_connected 会被后一个用例的新订阅者补投。
    router.resetTelemetry();
    subs = <StreamSubscription<Map<String, dynamic>>>[];
  });

  tearDown(() async {
    for (final StreamSubscription<Map<String, dynamic>> s in subs) {
      await s.cancel();
    }
  });

  test("手机端：chatOnly 事件只进聊天通道，根分发器收不到", () async {
    router.bindPlatform(isMobile: true);
    collect();

    for (final String type in <String>[
      "agent.proactive_message",
      "reminder_popup",
      "agent.voice.alarm",
      "agent.location_request",
      "schedule.reminder_fired",
      "chat.assistant_done",
      "evening.digest",
      "card.update",
    ]) {
      await dispatchOne(type);
    }

    expect(rootTypes, isEmpty, reason: "chatOnly 事件不得再被根分发器处理（会重复落盘/双通知/双 ack）");
    expect(chatTypes.length, 8);
  });

  test("手机端：rootOnly 事件只进根通道（闹钟/浏览器/来电等全局动作）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    for (final String type in <String>[
      "alarm.sync",
      "alarm.trigger",
      "reminder.deliver",
      "shared.browser.busy",
      "update.available",
      "inbox.message",
      "agent.phone.ringing_start",
    ]) {
      await dispatchOne(type);
    }

    expect(chatTypes, isEmpty);
    expect(rootTypes.length, 7);
  });

  test("手机端：both 事件两端各收一次（连接状态/工具进度）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    await dispatchOne("ws_connected");
    await dispatchOne("ws_disconnected");
    await dispatchOne("connection_error");
    await dispatchOne("tool.call");
    await dispatchOne("tool.result");

    expect(rootTypes, <String>[
      "ws_connected",
      "ws_disconnected",
      "connection_error",
      "tool.call",
      "tool.result",
    ]);
    expect(chatTypes, rootTypes);
  });

  test("桌面端：chatOnly 回落根通道（桌面没有聊天控制器）", () async {
    router.bindPlatform(isMobile: false);
    collect();

    await dispatchOne("agent.proactive_message");
    await dispatchOne("chat.assistant_done");

    expect(rootTypes, <String>["agent.proactive_message", "chat.assistant_done"]);
    expect(chatTypes, isEmpty);
  });

  test("桌面端：both 只进根通道（不投无人订阅的 chat 通道）", () async {
    router.bindPlatform(isMobile: false);
    collect();

    await dispatchOne("ws_connected");
    await dispatchOne("tool.call");

    expect(rootTypes, <String>["ws_connected", "tool.call"]);
    expect(chatTypes, isEmpty);
  });

  test("未登记的事件默认 rootOnly（忘记登记不会丢事件）", () async {
    router.bindPlatform(isMobile: true);
    collect();

    await dispatchOne("brand.new.event");

    expect(rootTypes, <String>["brand.new.event"]);
    expect(chatTypes, isEmpty);
  });

  test("归属表自身完整性：不存在空 type / 重复登记冲突", () {
    for (final MapEntry<String, WsEventRoute> e in WsEventRouter.routes.entries) {
      expect(e.key.trim(), isNotEmpty);
      expect(e.key, e.key.trim(), reason: "事件名不得带空白：${e.key}");
      // rootOnly 是默认值，登记它等于冗余（容易让人误以为已经特殊处理）
      expect(e.value, isNot(WsEventRoute.rootOnly),
          reason: "\"${e.key}\" 无需登记 rootOnly，未登记即为 rootOnly");
    }
  });

  group("模块级总线订阅（单连接 + 事件总线，2026-11-10）", () {
    final List<WsBusSubscription> handles = <WsBusSubscription>[];
    final List<String> got = <String>[];

    setUp(() => got.clear());
    tearDown(() {
      for (final WsBusSubscription h in handles) {
        h.cancel();
      }
      handles.clear();
    });

    test("root 域：手机端 chatOnly 不投（归属表单 owner 不变量不被订阅破坏）", () async {
      router.bindPlatform(isMobile: true);
      handles.add(router.subscribe(
        module: "t",
        types: const {"agent.location_request", "alarm.sync", "tool.call"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("agent.location_request"); // chatOnly：手机端归聊天控制器
      await dispatchOne("alarm.sync"); // rootOnly
      await dispatchOne("tool.call"); // both

      expect(got, <String>["alarm.sync", "tool.call"]);
    });

    test("root 域：桌面端全量（含 chatOnly 回落，等同原根监听器）", () async {
      router.bindPlatform(isMobile: false);
      handles.add(router.subscribe(
        module: "t",
        types: const {"agent.location_request"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("agent.location_request");

      expect(got, <String>["agent.location_request"]);
    });

    test("auto 域：本端路由到哪里就收哪里，每端至多一次", () async {
      router.bindPlatform(isMobile: true);
      handles.add(router.subscribe(
        module: "t",
        types: const {"schedule.reminder_fired", "ws_connected", "alarm.sync"},
        scope: WsSubscribeScope.auto,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("schedule.reminder_fired"); // chatOnly：手机端投一次
      await dispatchOne("ws_connected"); // both：通道投两次（root+chat），订阅者只一次
      await dispatchOne("alarm.sync"); // rootOnly：投一次

      expect(got, <String>["schedule.reminder_fired", "ws_connected", "alarm.sync"]);
    });

    test("auto 域：桌面端 chatOnly 回落也归订阅者（AmbientFeeds 形态）", () async {
      router.bindPlatform(isMobile: false);
      handles.add(router.subscribe(
        module: "t",
        types: const {"schedule.tasks_changed"},
        scope: WsSubscribeScope.auto,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("schedule.tasks_changed");

      expect(got, <String>["schedule.tasks_changed"]);
    });

    test("types=null：scope 语义内全量直投（SharedBrowserHost 形态）", () async {
      router.bindPlatform(isMobile: true);
      handles.add(router.subscribe(
        module: "t",
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("alarm.sync"); // rootOnly
      await dispatchOne("tool.result"); // both
      await dispatchOne("agent.proactive_message"); // chatOnly：不投 root 域

      expect(got, <String>["alarm.sync", "tool.result"]);
    });

    test("订阅者异常被隔离：不影响其他订阅者、不影响 UI 通道", () async {
      router.bindPlatform(isMobile: true);
      collect();
      handles.add(router.subscribe(
        module: "boom",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (_) => throw StateError("boom"),
      ));
      handles.add(router.subscribe(
        module: "ok",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      await dispatchOne("alarm.sync");

      expect(got, <String>["alarm.sync"], reason: "boom 抛异常不得拦住 ok");
      expect(rootTypes, <String>["alarm.sync"], reason: "UI 通道照常收到");
    });

    test("订阅者不依赖 UI 通道监听在场（服务单例常驻语义）", () async {
      router.bindPlatform(isMobile: true);
      handles.add(router.subscribe(
        module: "t",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      ));

      // 不 listen 任何通道，直接 dispatch：模块订阅者必须照常收到
      //（信箱异步执行，让出一轮事件循环后必然可达）
      router.dispatch(<String, dynamic>{"type": "alarm.sync", "payload": <String, dynamic>{}});
      await Future<void>.delayed(Duration.zero);
      expect(got, <String>["alarm.sync"]);
    });

    test("cancel 后不再投递（模块销毁/测试隔离）", () async {
      router.bindPlatform(isMobile: true);
      final WsBusSubscription h = router.subscribe(
        module: "t",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => got.add(e["type"] as String),
      );

      await dispatchOne("alarm.sync");
      h.cancel();
      await dispatchOne("alarm.sync");

      expect(got, <String>["alarm.sync"]);
    });
  });

  group("异步信箱（dispatch 零阻塞 + 同模块保序 + 异常隔离）", () {
    final List<WsBusSubscription> handles = <WsBusSubscription>[];

    tearDown(() {
      for (final WsBusSubscription h in handles) {
        h.cancel();
      }
      handles.clear();
    });

    test("dispatch 立即返回：慢 handler 不阻塞 WS 接收路径与 UI 通道", () async {
      router.bindPlatform(isMobile: true);
      collect();
      final List<String> rootSeen = <String>[];
      final StreamSubscription<Map<String, dynamic>> uiSub =
          router.rootEvents.listen((e) => rootSeen.add(e["type"] as String));
      final Completer<void> handlerDone = Completer<void>();
      handles.add(router.subscribe(
        module: "slow",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          handlerDone.complete();
        },
      ));

      final Stopwatch sw = Stopwatch()..start();
      router.dispatch(<String, dynamic>{"type": "alarm.sync", "payload": <String, dynamic>{}});
      final int dispatchMs = sw.elapsedMilliseconds;
      // dispatch 本身同步返回（远小于 handler 的 50ms 睡眠）
      expect(dispatchMs, lessThan(40), reason: "dispatch 不得等待模块 handler");
      // UI 通道（异步 broadcast）在微任务轮就派发，远早于慢 handler 的 50ms 完成
      await Future<void>.delayed(Duration.zero);
      expect(rootSeen, <String>["alarm.sync"]);

      await handlerDone.future;
      await uiSub.cancel();
    });

    test("同模块事件按到达顺序串行执行（async handler 不乱序）", () async {
      router.bindPlatform(isMobile: true);
      final List<String> processed = <String>[];
      final List<Completer<void>> gates = <Completer<void>>[];
      handles.add(router.subscribe(
        module: "ordered",
        types: const {"alarm.sync", "alarm.trigger"},
        scope: WsSubscribeScope.root,
        onEvent: (e) async {
          // 每个 handler 等待自己的 gate：若不保序，第二个事件会在第一个
          // 仍被挂起时先执行完，processed 顺序就乱了
          final Completer<void> gate = Completer<void>();
          gates.add(gate);
          await gate.future;
          processed.add(e["type"] as String);
        },
      ));

      router.dispatch(<String, dynamic>{"type": "alarm.sync", "payload": <String, dynamic>{}});
      router.dispatch(<String, dynamic>{"type": "alarm.trigger", "payload": <String, dynamic>{}});
      await Future<void>.delayed(Duration.zero);
      expect(processed, isEmpty, reason: "第一件在 gate 挂起，谁都不该被记为已完成");
      gates[0].complete();
      await Future<void>.delayed(Duration.zero);
      expect(processed, <String>["alarm.sync"], reason: "gate 放行同轮只应推进一件");
      gates[1].complete();
      await Future<void>.delayed(Duration.zero);
      expect(processed, <String>["alarm.sync", "alarm.trigger"]);
    });

    test("async handler 抛出的异常被总线捕获：链不断、后续事件照常", () async {
      router.bindPlatform(isMobile: true);
      final List<String> processed = <String>[];
      handles.add(router.subscribe(
        module: "async-boom",
        types: const {"alarm.sync", "alarm.trigger"},
        scope: WsSubscribeScope.root,
        onEvent: (e) async {
          final String type = e["type"] as String;
          if (type == "alarm.sync") {
            await Future<void>.delayed(Duration.zero);
            throw StateError("async boom");
          }
          processed.add(type);
        },
      ));

      await dispatchOne("alarm.sync"); // async 异常
      await dispatchOne("alarm.trigger"); // 必须照常执行

      expect(processed, <String>["alarm.trigger"], reason: "单次异步失败不得吞掉后续事件");
    });

    test("不同订阅者之间并行：慢订阅者不推迟其他模块的处理", () async {
      router.bindPlatform(isMobile: true);
      final List<String> fastSeen = <String>[];
      final Completer<void> slowDone = Completer<void>();
      handles.add(router.subscribe(
        module: "slow",
        types: const {"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) async {
          await Future<void>.delayed(const Duration(milliseconds: 30));
          slowDone.complete();
        },
      ));
      handles.add(router.subscribe(
        module: "fast",
        types: const {"alarm.sync", "alarm.trigger"},
        scope: WsSubscribeScope.root,
        onEvent: (e) => fastSeen.add(e["type"] as String),
      ));

      router.dispatch(<String, dynamic>{"type": "alarm.sync", "payload": <String, dynamic>{}});
      router.dispatch(<String, dynamic>{"type": "alarm.trigger", "payload": <String, dynamic>{}});
      await Future<void>.delayed(Duration.zero);

      expect(fastSeen, <String>["alarm.sync", "alarm.trigger"],
          reason: "fast 模块不被 slow 模块挂起的 handler 阻塞");
      await slowDone.future;
    });
  });

  group("状态型事件 last-value 补投（2026-11-11「假断开」根治）", () {
    final List<WsBusSubscription> handles = <WsBusSubscription>[];
    tearDown(() {
      for (final WsBusSubscription h in handles) {
        h.cancel();
      }
      handles.clear();
    });

    test("连接早于订阅者建立：晚到订阅者订阅即补投当前连接态", () async {
      router.bindPlatform(isMobile: true);
      // 连接在 app 启动早期就建好，此时业务模块还没订阅（旧实现里这条
      // ws_connected 会被 no-listener 保护丢弃，模块永久以为没连上）
      await dispatchOne("ws_connected");

      final List<String> seen = <String>[];
      handles.add(router.subscribe(
        module: "late",
        types: WsEventCatalog.connectionState,
        scope: WsSubscribeScope.auto,
        onEvent: (e) => seen.add(e["type"] as String),
      ));
      await Future<void>.delayed(Duration.zero);

      expect(seen, <String>["ws_connected"], reason: "订阅后必须立刻拿到连接态，不能等下一次重连");
    });

    test("只补最新那条：先连后断不会补出自相矛盾的序列", () async {
      router.bindPlatform(isMobile: true);
      await dispatchOne("ws_connected");
      await dispatchOne("ws_disconnected");

      final List<String> seen = <String>[];
      handles.add(router.subscribe(
        module: "late",
        types: WsEventCatalog.connectionState,
        scope: WsSubscribeScope.auto,
        onEvent: (e) => seen.add(e["type"] as String),
      ));
      await Future<void>.delayed(Duration.zero);

      expect(seen, <String>["ws_disconnected"], reason: "只补当前值，不重放历史");
    });

    test("不关心连接态的订阅者不受补投打扰", () async {
      router.bindPlatform(isMobile: true);
      await dispatchOne("ws_connected");

      final List<String> seen = <String>[];
      handles.add(router.subscribe(
        module: "alarm",
        types: WsEventCatalog.alarmEngine,
        scope: WsSubscribeScope.root,
        onEvent: (e) => seen.add(e["type"] as String),
      ));
      await Future<void>.delayed(Duration.zero);

      expect(seen, isEmpty);
    });

    test("无历史状态时不伪造补投（新启动的干净进程）", () async {
      router.bindPlatform(isMobile: true);
      final List<String> seen = <String>[];
      handles.add(router.subscribe(
        module: "late",
        types: WsEventCatalog.connectionState,
        scope: WsSubscribeScope.auto,
        onEvent: (e) => seen.add(e["type"] as String),
      ));
      await Future<void>.delayed(Duration.zero);

      expect(seen, isEmpty, reason: "没有任何状态事件时不得伪造「已连接」");
    });
  });

  group("信箱有界与可合并（2026-11-11 背压）", () {
    final List<WsBusSubscription> handles = <WsBusSubscription>[];
    tearDown(() {
      for (final WsBusSubscription h in handles) {
        h.cancel();
      }
      handles.clear();
    });

    test("队列有界：handler 挂起时超限丢最旧，不无界增长", () async {
      router.bindPlatform(isMobile: true);
      final Completer<void> gate = Completer<void>();
      final List<int> ids = <int>[];
      handles.add(router.subscribe(
        module: "cap",
        types: const <String>{"alarm.trigger"},
        scope: WsSubscribeScope.root,
        onEvent: (e) async {
          await gate.future;
          ids.add((wsEventPayload(e)["id"] as num?)?.toInt() ?? -1);
        },
      ));

      // 第一条占住信箱（挂起），后续全部进队列
      for (int i = 0; i < WsBusSubscription.maxPending + 10; i++) {
        router.dispatch(<String, dynamic>{
          "type": "alarm.trigger",
          "payload": <String, dynamic>{"id": i},
        });
      }
      await Future<void>.delayed(Duration.zero);

      expect(handles.first.pendingCount,
          lessThanOrEqualTo(WsBusSubscription.maxPending),
          reason: "待执行队列必须有上限，否则 handler 挂起时内存/延迟无界增长");

      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(ids, isNotEmpty);
    });

    test("可合并类型积压时只保留最新一条（alarm.sync 幂等全量同步）", () async {
      router.bindPlatform(isMobile: true);
      final Completer<void> gate = Completer<void>();
      final List<int> ids = <int>[];
      handles.add(router.subscribe(
        module: "coalesce",
        types: const <String>{"alarm.sync"},
        scope: WsSubscribeScope.root,
        coalesceTypes: const <String>{"alarm.sync"},
        onEvent: (e) async {
          if (ids.isEmpty) await gate.future; // 第一条占住信箱
          ids.add((wsEventPayload(e)["id"] as num?)?.toInt() ?? -1);
        },
      ));

      router.dispatch(<String, dynamic>{
        "type": "alarm.sync",
        "payload": <String, dynamic>{"id": 0},
      });
      await Future<void>.delayed(Duration.zero);
      for (int i = 1; i <= 5; i++) {
        router.dispatch(<String, dynamic>{
          "type": "alarm.sync",
          "payload": <String, dynamic>{"id": i},
        });
      }

      expect(handles.first.pendingCount, 1, reason: "同类积压应合并成一条，只留最新");
      gate.complete();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(ids, <int>[0, 5], reason: "在途的跑完 + 合并后的最新一条");
    });

    test("pendingCount 不泄漏：正常处理完归零", () async {
      router.bindPlatform(isMobile: true);
      handles.add(router.subscribe(
        module: "plain",
        types: const <String>{"alarm.sync"},
        scope: WsSubscribeScope.root,
        onEvent: (e) {},
      ));

      await dispatchOne("alarm.sync");
      expect(handles.first.pendingCount, 0);
    });
  });

  group("遥测（排查「为什么没反应」）", () {
    test("按类型计数 + 最近事件环形缓冲", () async {
      router.bindPlatform(isMobile: true);
      await dispatchOne("alarm.sync");
      await dispatchOne("alarm.sync");
      await dispatchOne("tool.call");

      expect(router.typeCounts["alarm.sync"], 2);
      expect(router.typeCounts["tool.call"], 1);
      expect(router.recentTypes,
          <String>["alarm.sync", "alarm.sync", "tool.call"]);
    });

    test("无监听丢弃计数：手机端首帧前 chatOnly 事件", () {
      router.bindPlatform(isMobile: true);
      router.dispatch(
          <String, dynamic>{"type": "chat.assistant_chunk", "payload": <String, dynamic>{}});
      expect(router.droppedNoListener, 1);
    });

    test("最近事件缓冲不超过上限", () async {
      router.bindPlatform(isMobile: true);
      for (int i = 0; i < 80; i++) {
        router.dispatch(<String, dynamic>{
          "type": "alarm.sync",
          "payload": <String, dynamic>{"i": i},
        });
      }
      expect(router.recentTypes.length, lessThanOrEqualTo(50));
    });
  });

  group("事件目录 WsEventCatalog（单一事实源）", () {
    const Map<String, Set<String>> groups = <String, Set<String>>{
      "alarmEngine": WsEventCatalog.alarmEngine,
      "ambientFeeds": WsEventCatalog.ambientFeeds,
      "mediaPlayback": WsEventCatalog.mediaPlayback,
      "locationResponder": WsEventCatalog.locationResponder,
      "scheduleToolResultSync": WsEventCatalog.scheduleToolResultSync,
      "pureVoiceSpeech": WsEventCatalog.pureVoiceSpeech,
      "connectionState": WsEventCatalog.connectionState,
    };

    test("各分组互不重叠：同一事件只能有一个 owner", () {
      final Map<String, String> owner = <String, String>{};
      groups.forEach((String name, Set<String> set) {
        for (final String type in set) {
          expect(owner.containsKey(type), isFalse,
              reason: "「$type」同时属于 ${owner[type]} 和 $name");
          owner[type] = name;
        }
      });
    });

    test("目录内每个类型都已分类：归属表登记，或确认默认 rootOnly", () {
      // 未登记即 rootOnly 是合法默认，但必须是「有意识的默认」：新增事件
      // 出现在这里说明有人加了订阅却没想清楚两端归属，需要显式确认。
      const Set<String> knownDefaultRootOnly = <String>{
        "alarm.sync",
        "alarm.trigger",
        "reminder.deliver",
        "agent.media.play",
        "agent.media.pause",
        "agent.media.resume",
        "agent.media.stop",
        "chat.assistant_speech",
        "inbox.message",
        "agent.peer_message",
      };
      for (final Set<String> set in groups.values) {
        for (final String type in set) {
          if (WsEventRouter.routes.containsKey(type)) continue;
          expect(knownDefaultRootOnly, contains(type),
              reason: "「$type」既没在归属表分类、也不在已知默认清单——新增事件请先想清楚两端归属");
        }
      }
    });

    test("root 域订阅的类型在手机端必须可达（否则静默漏收）", () {
      // 例外：agent.location_request 在手机端有意归聊天控制器（走手机 GPS），
      // 桌面端 chatOnly 回落 root 才由 AgentLocationResponder 回包。
      const Set<String> mobileUnreachableByDesign = <String>{
        "agent.location_request",
      };
      final Set<String> rootScopeTypes = <String>{
        ...WsEventCatalog.alarmEngine,
        ...WsEventCatalog.mediaPlayback,
        ...WsEventCatalog.scheduleToolResultSync,
        ...WsEventCatalog.pureVoiceSpeech,
      };
      for (final String type in rootScopeTypes) {
        if (mobileUnreachableByDesign.contains(type)) continue;
        expect(WsEventRouter.routes[type], isNot(WsEventRoute.chatOnly),
            reason: "「$type」被 root 域模块订阅，但手机端被判给聊天通道 → 手机端静默漏收");
      }
    });
  });
}
