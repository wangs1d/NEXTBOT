#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>
#include <flutter/method_result_functions.h>
#include <flutter/standard_method_codec.h>

#include <memory>

#include "win32_window.h"
#include "sphere_overlay_window.h"
#include "agent_profile_overlay_window.h"
#include "glass_notify_window.h"
#include "incoming_call_window.h"
#include "connected_call_window.h"
#include "outgoing_call_window.h"
#include "dynamic_island_window.h"
#include "pcm_stream_player.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM wparam,
                         LPARAM lparam) noexcept override;

 private:
  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // Desktop overlay window for 3D Agent sphere.
  std::unique_ptr<SphereOverlayWindow> overlay_window_;

  // 独立来电悬浮窗（脱离主窗口存在）
  std::unique_ptr<IncomingCallWindow> incoming_call_window_;

  // 桌面右上角玻璃通知栈（主动性消息专属，脱离主窗口存在）
  std::unique_ptr<GlassNotifyWindow> glass_notify_window_;

  // 桌面顶部灵动岛（同进程 HWND + GDI+ 分层窗口自绘）
  std::unique_ptr<DynamicIslandWindow> dynamic_island_window_;

  // Agent 主页信息弹出窗
  std::unique_ptr<AgentProfileOverlayWindow> agent_profile_window_;

  // 独立"通话中"悬浮窗（接通后展示，仿电脑微信电话）
  std::unique_ptr<ConnectedCallWindow> connected_call_window_;
  std::unique_ptr<OutgoingCallWindow> outgoing_call_window_;

  // Method channel for overlay control.
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      overlay_channel_;

  void HandleOverlayMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      desktop_bridge_channel_;

  void HandleDesktopBridgeMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // pai/incoming_call MethodChannel —— 控制独立来电悬浮窗
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      incoming_call_channel_;

  // pai/glass_notify MethodChannel —— 控制桌面右上角玻璃通知栈
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      glass_notify_channel_;

  // pai/dynamic_island MethodChannel —— 控制桌面顶部灵动岛
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      dynamic_island_channel_;

  // pai/daily_briefing MethodChannel —— 简报独立窗口工作区查询
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      daily_briefing_channel_;

  // pai/agent_profile MethodChannel —— 控制 Agent 主页弹出窗
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      agent_profile_channel_;

  void HandleIncomingCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleGlassNotifyMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void ReportGlassNotifyEvent(const std::string& id,
                              const std::string& event);
  void HandleDynamicIslandMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleDailyBriefingMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleAgentProfileMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // 把 IncomingCallWindow 的回调以 EventChannel / invokeMethod 方式回报给 Dart
  void ReportIncomingCallEvent(const std::string& event,
                               const std::string& detail);

  // pai/connected_call MethodChannel —— 控制独立"通话中"窗口
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      connected_call_channel_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      outgoing_call_channel_;

  void HandleConnectedCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);
  void HandleOutgoingCallMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // 把 ConnectedCallWindow 的回调以 invokeMethod 方式回报给 Dart
  void ReportConnectedCallEvent(const std::string& event,
                                const flutter::EncodableMap& extra);
  void ReportOutgoingCallEvent(const std::string& event);

  // pai/window_titlebar —— 动态切换 Windows 标题栏深色/亮色
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      window_titlebar_channel_;

  void HandleWindowTitleBarMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // pai/app_lifecycle —— 开机自动启动（HKCU Run 注册表键读写）
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      app_lifecycle_channel_;

  void HandleAppLifecycleMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // pai/pcm_player MethodChannel —— 全双工流式语音的原生 PCM 边收边播
  // （服务端逐块下发 24kHz PCM，这里 waveOut 直写，不必等整轮音频生成完）
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      pcm_player_channel_;
  std::unique_ptr<PcmStreamPlayer> pcm_player_;

  void HandlePcmPlayerMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // PCM 播放自然结束：音频线程 PostMessage 弹回平台线程后再通知 Dart
  static constexpr UINT kPcmPlayerDoneMsg = WM_APP + 0x7A;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
