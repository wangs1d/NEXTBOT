/// 多会话并发（2026-11-12 P1 根治）：旁聊生成中可自由切换会话。
///
/// 事故形态：旁聊回复生成中，顶栏返回按钮被 `canSwitchSession => !isProcessing`
/// 锁死，用户必须等回复收口才能回主会话（2026-11-12 用户反馈）。
/// 根治后 turn 运行态按线程隔离（[_ThreadTurnState]），流式事件按 threadId
/// 落回各自线程，切换不再被锁。
/// 覆盖：
/// - 旁聊生成中 returnToMain 立即成功，主线程不被占位泡/正文污染
/// - 切走后旁聊线程的 chunk / done 仍落旁聊线程（threadId 路由）
/// - 主会话生成中 enterSideChat 返回 true（旧版此处被拒绝）
/// - 两线程各自独立收口，互不窜泡
library;

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/db/local_history_store.dart";
import "package:nextbot/mobile_ui/mobile_chat_controller.dart";

import "mobile_chat_intro_pacing_test.dart" show EmptyHistoryStoreForTest;

void main() {
  const String sideKey = "side:test-actor:abc123";

  Future<MobileChatController> controllerInSideChat(
    EmptyHistoryStoreForTest store,
  ) async {
    final MobileChatController c = MobileChatController(
        wsBaseUrl: "ws://127.0.0.1:1", historyStore: store);
    // 进入旁聊（本地空历史；服务端历史拉取在测试环境连接失败被静默吞掉）。
    await c.enterSideChat(sessionId: sideKey);
    return c;
  }

  test("旁聊生成中可切回主会话，主线程不被旁聊流污染", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = await controllerInSideChat(store);
    addTearDown(c.dispose);

    // 旁聊轮开始生成（服务端 2026-11-12 起载荷带 threadId）。
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.turn_started",
      "payload": <String, dynamic>{"traceId": "t1", "threadId": sideKey},
    });
    expect(c.isProcessing, isTrue, reason: "旁聊线程进入生成态");

    // 生成中直接切回主会话：P1 后不再被锁。
    await c.returnToMain();
    expect(c.isSideChatActive, isFalse, reason: "生成中也能切回主会话");
    expect(
      c.messages.any((m) => m.streaming),
      isFalse,
      reason: "主线程不能出现旁聊的流式占位泡",
    );

    // 切走后旁聊 chunk 照常到达：必须落旁聊线程，不窜主线程。
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_chunk",
      "payload": <String, dynamic>{
        "traceId": "t1",
        "threadId": sideKey,
        "chunk": "你好呀",
      },
    });
    expect(
      c.messages.any((m) => m.role == "assistant"),
      isFalse,
      reason: "主线程不能收到旁聊的 chunk",
    );

    // 旁聊 done 收口：落旁聊线程。
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_done",
      "payload": <String, dynamic>{
        "traceId": "t1",
        "threadId": sideKey,
        "finalText": "你好呀，我在",
      },
    });
    expect(
      c.messages.any((m) => m.text.contains("我在")),
      isFalse,
      reason: "主线程不能收到旁聊的 done 收口",
    );

    // 切回旁聊：整轮回复完整在旁聊线程里。
    final bool ok = await c.enterSideChat(sessionId: sideKey);
    expect(ok, isTrue);
    expect(
      c.messages.any((m) => m.text.contains("我在")),
      isTrue,
      reason: "旁聊回复必须完整落在旁聊线程",
    );
    expect(c.isProcessing, isFalse, reason: "done 收口后旁聊线程退出生成态");
  });

  test("主会话生成中可进入旁聊（旧版此处被拒绝）", () async {
    final EmptyHistoryStoreForTest store = EmptyHistoryStoreForTest();
    final MobileChatController c = MobileChatController(
        wsBaseUrl: "ws://127.0.0.1:1", historyStore: store);
    addTearDown(c.dispose);

    // 主会话轮开始（无 threadId 的旧服务端载荷 → 退回激活线程 = 主线程）。
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.turn_started",
      "payload": <String, dynamic>{"traceId": "t0"},
    });
    expect(c.isProcessing, isTrue);

    // 生成中进入旁聊：P1 后放行（旧版 enterSideChat 返回 false）。
    final bool ok = await c.enterSideChat(sessionId: sideKey);
    expect(ok, isTrue, reason: "主会话生成中必须能进入旁聊");
    expect(c.isSideChatActive, isTrue);
    expect(
      c.messages.any((m) => m.streaming),
      isFalse,
      reason: "旁聊线程不能出现主会话的流式占位泡",
    );

    // 主会话继续生成的事件（新服务端带 threadId = 主线程键）落到主线程，
    // 不得窜进旁聊线程。
    c.debugHandleWsEvent(<String, dynamic>{
      "type": "chat.assistant_chunk",
      "payload": <String, dynamic>{
        "traceId": "t0",
        "threadId": ApiConfig.effectiveActorId,
        "chunk": "主线回复",
      },
    });
    expect(
      c.messages.any((m) => m.text.contains("主线回复")),
      isFalse,
      reason: "旁聊激活时主会话 chunk 不得窜进旁聊线程",
    );
    // 切回主会话：chunk 已按 threadId 落主线程。
    await c.returnToMain();
    expect(
      c.messages.any((m) => m.text.contains("主线回复")),
      isTrue,
      reason: "主会话 chunk 必须落在主线程",
    );
  });
}
