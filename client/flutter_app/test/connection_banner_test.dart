/// 手机端连接横幅语义锁（2026-11-22「老是连接断开」观感根修）。
///
/// 事故形态：冷启动首帧 `isConnected` 必为 false，旧实现无条件显示
/// 「连接断开，正在自动重连…」——正常首连被说成故障，用户每次打开 App
/// 都以为链路在断，把「进程被杀后的重连」误判成「频繁断连」。
///
/// 锁死三条语义：
///  1. 已连接 → 不显示横幅；
///  2. 从未连上过 → 「正在连接服务器…」，且不带 warning 语义；
///  3. 连过又掉 → 才是「连接断开…」。
library;

import "package:flutter_test/flutter_test.dart";

import "package:nextbot/mobile_ui/mobile_chat_page.dart";

void main() {
  test("已连接时不显示横幅", () {
    final state = connectionBannerState(connected: true, everConnected: true);
    expect(state.text, isEmpty);
    expect(state.dropped, isFalse);
  });

  test("冷启动首连：只说正在连接，不得出现「断开」字样", () {
    final state = connectionBannerState(connected: false, everConnected: false);
    expect(state.text, "正在连接服务器…");
    expect(state.text.contains("断开"), isFalse);
    // 中性态：UI 不按警示色渲染
    expect(state.dropped, isFalse);
  });

  test("连过之后掉线：显示断线警示文案", () {
    final state = connectionBannerState(connected: false, everConnected: true);
    expect(state.dropped, isTrue);
    expect(state.text, contains("连接断开"));
    expect(state.text, contains("恢复后送达"));
  });
}
