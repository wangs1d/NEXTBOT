/// 手机端连接态镜像锁（2026-11-25「一直正在连接服务器」根修）。
///
/// 事故形态：手机端首帧就 new 出 MobileChatController 并 `connect()`，而根组件
/// `_bootstrap()` 要跑完十几个 await 才 bindPlatform/attach 路由器。窗口期发出的
/// `ws_connected` 在 chat 通道被丢弃（平台标志还是桌面、甚至路由器尚未接上连接层），
/// 控制器的 `isConnected` 永久停在 false：聊天页顶部「正在连接服务器…」再也不消失，
/// 但消息其实发得出去（发送判据走连接层真值）。
///
/// 修法：控制器直连连接层原始事件流，把连接态当**状态**镜像；
/// 迁移口径收敛在纯函数 [mirroredConnectionState]，由本测试锁死。
library;

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/mobile_ui/mobile_chat_controller.dart";
import "package:nextbot/mobile_ui/mobile_chat_page.dart";

void main() {
  test("镜像收到 ws_connected：即使路由通道丢了这条事件，状态也要补上", () {
    final state = mirroredConnectionState(
      type: "ws_connected",
      connected: false,
      everConnected: false,
    );
    expect(state.connected, isTrue);
    expect(state.everConnected, isTrue);
    // 镜像连上后横幅必须消失
    final banner = connectionBannerState(
      connected: state.connected,
      everConnected: state.everConnected,
    );
    expect(banner.text, isEmpty);
  });

  test("镜像收到 ws_disconnected：只清连接态，everConnected 不回落", () {
    final state = mirroredConnectionState(
      type: "ws_disconnected",
      connected: true,
      everConnected: true,
    );
    expect(state.connected, isFalse);
    expect(state.everConnected, isTrue);
    // 连过再掉 → 必须落到「连接断开」，不能退回「正在连接服务器…」
    final banner = connectionBannerState(
      connected: state.connected,
      everConnected: state.everConnected,
    );
    expect(banner.dropped, isTrue);
    expect(banner.text, contains("连接断开"));
  });

  test("首连失败（connection_error）仍保持中性文案，不得升级成「断开」", () {
    var state = (connected: false, everConnected: false);
    state = mirroredConnectionState(
      type: "connection_error",
      connected: state.connected,
      everConnected: state.everConnected,
    );
    final banner = connectionBannerState(
      connected: state.connected,
      everConnected: state.everConnected,
    );
    expect(banner.dropped, isFalse);
    expect(banner.text, "正在连接服务器…");
  });

  test("非连接态事件不触碰连接状态", () {
    final state = mirroredConnectionState(
      type: "chat.assistant_chunk",
      connected: true,
      everConnected: true,
    );
    expect(state.connected, isTrue);
    expect(state.everConnected, isTrue);
  });
}
