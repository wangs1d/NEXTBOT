#include "flutter_window.h"

#include <dwmapi.h>
#include <winreg.h>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif

#include <optional>
#include <string>
#include <vector>

#include "desktop_screen_capture.h"
#include "glass_notify_window.h"
#include "window_position_store.h"
#include "flutter/generated_plugin_registrant.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  // 今日简报子进程窗口（PAI_DAILY_BRIEFING_WINDOW 环境变量门控）：
  //  1) 去掉 WS_THICKFRAME 可调边框——隐藏标题栏时边框仍占位，Flutter 视图
  //     与窗口矩形错位，左侧露出一条无圆角的窗口底色残留；
  //  2) 启用 DWM 系统圆角（DWMWCP_ROUND）——Flutter Windows 不支持逐像素
  //     透明窗口，圆角处的不透明残留由系统按圆角裁掉。
  // 必须在测量客户区（GetClientArea）之前生效，避免视图按旧边框尺寸创建。
  if (GetEnvironmentVariableW(L"PAI_DAILY_BRIEFING_WINDOW", nullptr, 0) > 0) {
    const HWND hwnd = GetHandle();
    const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~WS_THICKFRAME);
    DWM_WINDOW_CORNER_PREFERENCE corner_preference = DWMWCP_ROUND;
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                          &corner_preference, sizeof(corner_preference));
    SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                 SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                     SWP_NOACTIVATE);
  }

  RECT frame = GetClientArea();

  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  overlay_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/sphere_overlay",
      &flutter::StandardMethodCodec::GetInstance());

  overlay_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleOverlayMethodCall(call, std::move(result));
      });

  desktop_bridge_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/desktop_bridge",
      &flutter::StandardMethodCodec::GetInstance());

  desktop_bridge_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDesktopBridgeMethodCall(call, std::move(result));
      });

  // 独立来电悬浮窗 MethodChannel —— pai/incoming_call
  incoming_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/incoming_call",
      &flutter::StandardMethodCodec::GetInstance());

  incoming_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleIncomingCallMethodCall(call, std::move(result));
      });

  desktop_notification_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/desktop_notification",
      &flutter::StandardMethodCodec::GetInstance());

  desktop_notification_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDesktopNotificationMethodCall(call, std::move(result));
      });

  // pai/glass_notify —— 桌面右上角玻璃通知栈（主动性消息专属）
  glass_notify_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/glass_notify",
      &flutter::StandardMethodCodec::GetInstance());
  glass_notify_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleGlassNotifyMethodCall(call, std::move(result));
      });

  // 独立"通话中"窗口 MethodChannel —— pai/connected_call
  connected_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/connected_call",
      &flutter::StandardMethodCodec::GetInstance());

  connected_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleConnectedCallMethodCall(call, std::move(result));
      });

  outgoing_call_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/outgoing_call",
      &flutter::StandardMethodCodec::GetInstance());

  outgoing_call_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleOutgoingCallMethodCall(call, std::move(result));
      });

  // 桌面顶部灵动岛 MethodChannel —— pai/dynamic_island
  dynamic_island_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/dynamic_island",
      &flutter::StandardMethodCodec::GetInstance());

  dynamic_island_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDynamicIslandMethodCall(call, std::move(result));
      });

  // 今日简报窗口辅助通道 —— pai/daily_briefing（子进程也运行本 runner，
  // 简报窗口用它查询主屏工作区做右下角定位）
  daily_briefing_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/daily_briefing",
      &flutter::StandardMethodCodec::GetInstance());

  daily_briefing_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleDailyBriefingMethodCall(call, std::move(result));
      });

  // Agent 主页信息弹出窗 MethodChannel —— pai/agent_profile
  agent_profile_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/agent_profile",
      &flutter::StandardMethodCodec::GetInstance());

  agent_profile_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleAgentProfileMethodCall(call, std::move(result));
      });

  // pai/window_titlebar —— 动态切换 Windows 标题栏深色/亮色
  window_titlebar_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/window_titlebar",
      &flutter::StandardMethodCodec::GetInstance());

  window_titlebar_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleWindowTitleBarMethodCall(call, std::move(result));
      });

  // pai/app_lifecycle —— 开机自动启动（简报随开机播报的前提）
  app_lifecycle_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/app_lifecycle",
      &flutter::StandardMethodCodec::GetInstance());

  app_lifecycle_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleAppLifecycleMethodCall(call, std::move(result));
      });

  // pai/pcm_player —— 全双工流式语音的原生 PCM 边收边播（waveOut）
  pcm_player_channel_ = std::make_unique<
      flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "pai/pcm_player",
      &flutter::StandardMethodCodec::GetInstance());

  pcm_player_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandlePcmPlayerMethodCall(call, std::move(result));
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  flutter_controller_->ForceRedraw();

  // 清空窗口标题栏文字（Flutter 引擎会自动设置标题，需在初始化后覆盖）
  SetWindowText(GetHandle(), L"");

  return true;
}

namespace {

std::string Base64Encode(const std::vector<uint8_t>& data) {
  static const char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((data.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < data.size()) {
    const uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8) |
                       static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(n >> 18) & 63]);
    out.push_back(kTable[(n >> 12) & 63]);
    out.push_back(kTable[(n >> 6) & 63]);
    out.push_back(kTable[n & 63]);
    i += 3;
  }
  if (i < data.size()) {
    const uint32_t n = static_cast<uint32_t>(data[i]) << 16;
    out.push_back(kTable[(n >> 18) & 63]);
    if (i + 1 < data.size()) {
      const uint32_t n2 = n | (static_cast<uint32_t>(data[i + 1]) << 8);
      out.push_back(kTable[(n2 >> 12) & 63]);
      out.push_back(kTable[(n2 >> 6) & 63]);
      out.push_back('=');
    } else {
      out.push_back(kTable[(n >> 12) & 63]);
      out.push_back('=');
      out.push_back('=');
    }
  }
  return out;
}

std::string GetEncodableString(const flutter::EncodableMap* args,
                               const char* key,
                               const std::string& fallback = std::string()) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<std::string>(&it->second)) {
    return *value;
  }
  return fallback;
}

int GetEncodableInt(const flutter::EncodableMap* args,
                    const char* key,
                    int fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<int32_t>(&it->second)) {
    return static_cast<int>(*value);
  }
  if (const auto* value = std::get_if<int64_t>(&it->second)) {
    return static_cast<int>(*value);
  }
  if (const auto* value = std::get_if<double>(&it->second)) {
    return static_cast<int>(*value);
  }
  return fallback;
}

uint32_t GetEncodableUint32(const flutter::EncodableMap* args,
                            const char* key,
                            uint32_t fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<int32_t>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  if (const auto* value = std::get_if<int64_t>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  if (const auto* value = std::get_if<double>(&it->second)) {
    return static_cast<uint32_t>(*value);
  }
  return fallback;
}

bool GetEncodableBool(const flutter::EncodableMap* args,
                      const char* key,
                      bool fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<bool>(&it->second)) {
    return *value;
  }
  return fallback;
}

double GetEncodableDouble(const flutter::EncodableMap* args,
                          const char* key,
                          double fallback) {
  if (!args) return fallback;
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end() || it->second.IsNull()) return fallback;
  if (const auto* value = std::get_if<double>(&it->second)) {
    return *value;
  }
  if (const auto* value = std::get_if<int32_t>(&it->second)) {
    return static_cast<double>(*value);
  }
  if (const auto* value = std::get_if<int64_t>(&it->second)) {
    return static_cast<double>(*value);
  }
  return fallback;
}

}  // namespace

void FlutterWindow::OnDestroy() {
  incoming_call_window_.reset();
  incoming_call_channel_.reset();
  desktop_notification_window_.reset();
  desktop_notification_channel_.reset();
  glass_notify_window_.reset();
  glass_notify_channel_.reset();
  connected_call_window_.reset();
  connected_call_channel_.reset();
  outgoing_call_window_.reset();
  outgoing_call_channel_.reset();
  window_titlebar_channel_.reset();
  overlay_window_.reset();
  overlay_channel_.reset();
  desktop_bridge_channel_.reset();
  // 先关播放器（waveOutClose 会阻断后续音频线程回调），再释放 channel
  pcm_player_.reset();
  pcm_player_channel_.reset();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }
  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_SETTEXT:
      // 拦截标题设置，保持标题栏为空
      return 0;
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
    case kPcmPlayerDoneMsg:
      // PCM 流播放自然结束（音频线程 PostMessage 弹回）→ 通知 Dart 解除半双工门控
      if (pcm_player_channel_) {
        pcm_player_channel_->InvokeMethod("onComplete", nullptr);
      }
      return 0;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}

void FlutterWindow::HandleOverlayMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "create") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    std::string url;
    if (args) {
      auto it = args->find(flutter::EncodableValue("url"));
      if (it != args->end() && !it->second.IsNull()) {
        url = std::get<std::string>(it->second);
      }
    }

    if (!overlay_window_) {
      overlay_window_ = std::make_unique<SphereOverlayWindow>();
    }

    bool ok = overlay_window_->Create(GetHandle(), url);
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  if (method == "isCreated") {
    const bool created =
        overlay_window_ && overlay_window_->IsCreated();
    result->Success(flutter::EncodableValue(created));
    return;
  }

  if (method == "getAppBounds") {
    RECT rc;
    GetWindowRect(GetHandle(), &rc);
    flutter::EncodableMap app_bounds;
    app_bounds[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.left));
    app_bounds[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.top));
    app_bounds[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.right - rc.left));
    app_bounds[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.bottom - rc.top));
    result->Success(flutter::EncodableValue(app_bounds));
    return;
  }

  if (method == "destroy") {
    if (overlay_window_) {
      overlay_window_.reset();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isWebViewReady") {
    const bool ready =
        overlay_window_ && overlay_window_->IsCreated() &&
        overlay_window_->IsWebViewReady();
    result->Success(flutter::EncodableValue(ready));
    return;
  }

  if (!overlay_window_ || !overlay_window_->IsCreated()) {
    result->NotImplemented();
    return;
  }

  if (method == "show") {
    overlay_window_->Show();
    result->Success(flutter::EncodableValue(true));
  } else if (method == "hide") {
    overlay_window_->Hide();
    result->Success(flutter::EncodableValue(true));
  } else if (method == "isVisible") {
    result->Success(flutter::EncodableValue(overlay_window_->IsVisible()));
  } else if (method == "moveTo") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int x = 0, y = 0, duration = 1200;
    if (args) {
      auto it_x = args->find(flutter::EncodableValue("x"));
      if (it_x != args->end())
        x = static_cast<int>(std::get<int64_t>(it_x->second));
      auto it_y = args->find(flutter::EncodableValue("y"));
      if (it_y != args->end())
        y = static_cast<int>(std::get<int64_t>(it_y->second));
      auto it_d = args->find(flutter::EncodableValue("duration"));
      if (it_d != args->end())
        duration = static_cast<int>(std::get<int64_t>(it_d->second));
    }
    overlay_window_->MoveTo(x, y, duration);
    result->Success(nullptr);
  } else if (method == "moveBy") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int dx = 0, dy = 0;
    if (args) {
      auto it_dx = args->find(flutter::EncodableValue("dx"));
      if (it_dx != args->end())
        dx = static_cast<int>(std::get<int64_t>(it_dx->second));
      auto it_dy = args->find(flutter::EncodableValue("dy"));
      if (it_dy != args->end())
        dy = static_cast<int>(std::get<int64_t>(it_dy->second));
    }
    overlay_window_->MoveBy(dx, dy);
    result->Success(nullptr);
  } else if (method == "setBounds") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    int x = 0, y = 0, width = 300, height = 380, duration = 0;
    if (args) {
      auto it_x = args->find(flutter::EncodableValue("x"));
      if (it_x != args->end())
        x = static_cast<int>(std::get<int64_t>(it_x->second));
      auto it_y = args->find(flutter::EncodableValue("y"));
      if (it_y != args->end())
        y = static_cast<int>(std::get<int64_t>(it_y->second));
      auto it_w = args->find(flutter::EncodableValue("width"));
      if (it_w != args->end())
        width = static_cast<int>(std::get<int64_t>(it_w->second));
      auto it_h = args->find(flutter::EncodableValue("height"));
      if (it_h != args->end())
        height = static_cast<int>(std::get<int64_t>(it_h->second));
      auto it_d = args->find(flutter::EncodableValue("duration"));
      if (it_d != args->end())
        duration = static_cast<int>(std::get<int64_t>(it_d->second));
    }
    overlay_window_->SetBounds(x, y, width, height, duration);
    result->Success(nullptr);
  } else if (method == "getBounds") {
    RECT rc = overlay_window_->GetBounds();
    flutter::EncodableMap bounds;
    bounds[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.left));
    bounds[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(rc.top));
    bounds[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.right - rc.left));
    bounds[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(rc.bottom - rc.top));
    result->Success(flutter::EncodableValue(bounds));
  } else if (method == "roam") {
    overlay_window_->Roam();
    result->Success(nullptr);
  } else if (method == "setIgnoreMouseEvents") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    bool ignore = true, forward = true;
    if (args) {
      auto it_i = args->find(flutter::EncodableValue("ignore"));
      if (it_i != args->end())
        ignore = std::get<bool>(it_i->second);
      auto it_f = args->find(flutter::EncodableValue("forward"));
      if (it_f != args->end())
        forward = std::get<bool>(it_f->second);
    }
    overlay_window_->SetIgnoreMouseEvents(ignore, forward);
    result->Success(nullptr);
  } else if (method == "patchMood") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    std::string json_patch;
    if (args) {
      auto it = args->find(flutter::EncodableValue("patch"));
      if (it != args->end() && !it->second.IsNull()) {
        json_patch = std::get<std::string>(it->second);
      }
    }
    overlay_window_->PatchMood(json_patch);
    result->Success(nullptr);
  } else if (method == "getWorkArea") {
    RECT wa = overlay_window_->GetWorkArea();
    flutter::EncodableMap area;
    area[flutter::EncodableValue("x")] =
        flutter::EncodableValue(static_cast<int64_t>(wa.left));
    area[flutter::EncodableValue("y")] =
        flutter::EncodableValue(static_cast<int64_t>(wa.top));
    area[flutter::EncodableValue("width")] = flutter::EncodableValue(
        static_cast<int64_t>(wa.right - wa.left));
    area[flutter::EncodableValue("height")] = flutter::EncodableValue(
        static_cast<int64_t>(wa.bottom - wa.top));
    result->Success(flutter::EncodableValue(area));
  } else {
    result->NotImplemented();
  }
}

void FlutterWindow::HandleDesktopBridgeMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "captureScreen") {
    std::optional<int> left, top, width, height;
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    if (args) {
      auto read_int = [&](const char* key) -> std::optional<int> {
        auto it = args->find(flutter::EncodableValue(key));
        if (it == args->end() || it->second.IsNull()) return std::nullopt;
        return static_cast<int>(std::get<int64_t>(it->second));
      };
      left = read_int("left");
      top = read_int("top");
      width = read_int("width");
      height = read_int("height");
    }

    auto cap = CaptureDesktopPng(left, top, width, height);
    if (!cap || !cap->ok) {
      flutter::EncodableMap err;
      err[flutter::EncodableValue("ok")] = flutter::EncodableValue(false);
      err[flutter::EncodableValue("error")] = flutter::EncodableValue(
          cap ? cap->error : "capture failed");
      result->Success(flutter::EncodableValue(err));
      return;
    }

    flutter::EncodableMap ok;
    ok[flutter::EncodableValue("ok")] = flutter::EncodableValue(true);
    ok[flutter::EncodableValue("imageBase64")] =
        flutter::EncodableValue(Base64Encode(cap->png_bytes));
    ok[flutter::EncodableValue("mimeType")] =
        flutter::EncodableValue("image/png");
    ok[flutter::EncodableValue("width")] =
        flutter::EncodableValue(static_cast<int64_t>(cap->width));
    ok[flutter::EncodableValue("height")] =
        flutter::EncodableValue(static_cast<int64_t>(cap->height));
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::HandleIncomingCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    // 解析参数
    std::string caller_name;
    std::string subtitle = "语音提醒";
    std::string caller_initial;
    int ring_timeout_ms = 30000;
    uint32_t accent = 0xFF22C55E;  // 默认绿

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      const std::string subtitle_arg =
          GetEncodableString(args, "subtitle", subtitle);
      subtitle = subtitle_arg.empty() ? subtitle : subtitle_arg;
      caller_initial = GetEncodableString(args, "callerInitial");
      ring_timeout_ms = GetEncodableInt(args, "ringTimeoutMs", ring_timeout_ms);
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    // 首次创建 + 绑定一次性回调
    if (!incoming_call_window_) {
      incoming_call_window_ = std::make_unique<IncomingCallWindow>();
      incoming_call_window_->SetCallbacks(
          [this]() { ReportIncomingCallEvent("accept", ""); },
          [this]() { ReportIncomingCallEvent("decline", ""); },
          [this]() { ReportIncomingCallEvent("timeout", ""); });
    }

    // 唤起主窗口（用户从任务栏点了来电窗后能切回主窗）
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
      SetForegroundWindow(self);
    }

    incoming_call_window_->Show(caller_name, subtitle, caller_initial,
                                ring_timeout_ms, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (incoming_call_window_) {
      incoming_call_window_->Hide();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        incoming_call_window_ && incoming_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  if (method == "bringToFront") {
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
      SetForegroundWindow(self);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportIncomingCallEvent(const std::string& event,
                                            const std::string& detail) {
  if (!incoming_call_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] =
      flutter::EncodableValue(event);
  if (!detail.empty()) {
    payload[flutter::EncodableValue("detail")] =
        flutter::EncodableValue(detail);
  }
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  incoming_call_channel_->InvokeMethod(
      "onNativeEvent",
      std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleDesktopNotificationMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string title;
    std::string message;
    std::string priority = "normal";
    std::string confirm_text = "我知道了";
    int auto_close_ms = 0;

    // 注：Dart 端可能仍下发 showConfirmButton（稍后按钮已移除），直接忽略
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      title = GetEncodableString(args, "title");
      message = GetEncodableString(args, "message");
      priority = GetEncodableString(args, "priority", priority);
      confirm_text = GetEncodableString(args, "confirmText", confirm_text);
      auto_close_ms = GetEncodableInt(args, "autoCloseMs", auto_close_ms);
    }

    if (!desktop_notification_window_) {
      desktop_notification_window_ = std::make_unique<DesktopNotificationWindow>();
      desktop_notification_window_->SetCallbacks(
          [this]() { ReportDesktopNotificationEvent("confirm"); },
          [this]() { ReportDesktopNotificationEvent("dismiss"); },
          [this]() { ReportDesktopNotificationEvent("timeout"); });
    }

    desktop_notification_window_->Show(title, message, priority, confirm_text,
                                       auto_close_ms);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (desktop_notification_window_) desktop_notification_window_->Hide();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible = desktop_notification_window_ &&
                         desktop_notification_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportDesktopNotificationEvent(const std::string& event) {
  if (!desktop_notification_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  desktop_notification_channel_->InvokeMethod(
      "onNativeEvent", std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleGlassNotifyMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string id;
    std::string title;
    std::string message;
    std::string priority = "normal";
    std::string confirm_text;
    int duration_ms = 0;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      id = GetEncodableString(args, "id");
      title = GetEncodableString(args, "title");
      message = GetEncodableString(args, "message");
      priority = GetEncodableString(args, "priority", priority);
      confirm_text = GetEncodableString(args, "confirmText", confirm_text);
      duration_ms = GetEncodableInt(args, "durationMs", duration_ms);
    }
    if (id.empty()) {
      result->Error("args", "id is required");
      return;
    }

    if (!glass_notify_window_) {
      glass_notify_window_ = std::make_unique<GlassNotifyWindow>();
      glass_notify_window_->SetEventCallback(
          [this](const std::string& ev_id, const std::string& ev) {
            ReportGlassNotifyEvent(ev_id, ev);
          });
    }
    glass_notify_window_->Show(id, title, message, priority, confirm_text,
                               duration_ms);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      const std::string id = GetEncodableString(args, "id");
      if (glass_notify_window_ && !id.empty()) {
        glass_notify_window_->Hide(id);
      }
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hideAll") {
    if (glass_notify_window_) glass_notify_window_->HideAll();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible = glass_notify_window_ && glass_notify_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportGlassNotifyEvent(const std::string& id,
                                           const std::string& event) {
  if (!glass_notify_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("id")] = flutter::EncodableValue(id);
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  glass_notify_channel_->InvokeMethod(
      "onEvent", std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleDynamicIslandMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();
  const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());

  if (method == "create") {
    if (!dynamic_island_window_) {
      dynamic_island_window_ = std::make_unique<DynamicIslandWindow>();
      dynamic_island_window_->SetEventCallback(
          [this](DynamicIslandWindow::EventType type,
                 const std::string& payload) {
            std::string event_name;
            switch (type) {
              case DynamicIslandWindow::EventType::kExpandedChanged:
                event_name = "expandedChanged"; break;
              case DynamicIslandWindow::EventType::kAction:
                event_name = "action"; break;
              case DynamicIslandWindow::EventType::kTapped:
                event_name = "tapped"; break;
            }
            if (dynamic_island_channel_) {
              flutter::EncodableMap pl;
              pl[flutter::EncodableValue("event")] =
                  flutter::EncodableValue(event_name);
              pl[flutter::EncodableValue("payload")] =
                  flutter::EncodableValue(payload);
              dynamic_island_channel_->InvokeMethod(
                  "onNativeEvent",
                  std::make_unique<flutter::EncodableValue>(pl));
            }
          });
    }
    const bool ok = dynamic_island_window_->Create();
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  if (method == "ping") {
    // Dart 看门狗周期校验窗口活体：被外部销毁过则 false，触发重建链。
    const bool alive = dynamic_island_window_ &&
                       dynamic_island_window_->IsAlive();
    result->Success(flutter::EncodableValue(alive));
    return;
  }

  if (method == "destroy") {
    dynamic_island_window_.reset();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setVisible") {
    const bool vis = GetEncodableBool(args, "visible", true);
    if (dynamic_island_window_) {
      if (vis) {
        dynamic_island_window_->Show();
      } else {
        dynamic_island_window_->Hide();
      }
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "present") {
    DynamicIslandWindow::Entry e;
    if (args != nullptr) {
      e.id = GetEncodableString(args, "id", "");
      e.title = GetEncodableString(args, "title", "");
      e.trailing = GetEncodableString(args, "trailing", "");
      e.kind = static_cast<DynamicIslandWindow::Kind>(
          GetEncodableInt(args, "kind", 0));
      e.progress = GetEncodableDouble(args, "progress", -1.0);
      e.spinning = GetEncodableBool(args, "spinning", false);
    }
    if (dynamic_island_window_) {
      dynamic_island_window_->SetEntry(e);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "clearEntry") {
    if (dynamic_island_window_) dynamic_island_window_->ClearEntry();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setAgenda") {
    std::vector<DynamicIslandWindow::AgendaItem> items;
    if (args != nullptr) {
      auto it = args->find(flutter::EncodableValue("items"));
      if (it != args->end()) {
        if (const auto* list = std::get_if<flutter::EncodableList>(&it->second)) {
          for (const auto& elem : *list) {
            if (const auto* m = std::get_if<flutter::EncodableMap>(&elem)) {
              DynamicIslandWindow::AgendaItem item;
              item.time_text = GetEncodableString(m, "time", "");
              item.title = GetEncodableString(m, "title", "");
              item.hint = GetEncodableString(m, "hint", "");
              item.completed = GetEncodableBool(m, "completed", false);
              items.push_back(item);
            }
          }
        }
      }
    }
    if (dynamic_island_window_) {
      dynamic_island_window_->SetAgenda(std::move(items));
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setExpanded") {
    const bool expanded = GetEncodableBool(args, "expanded", false);
    if (dynamic_island_window_) {
      dynamic_island_window_->SetExpanded(expanded);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "attention") {
    const std::string title = GetEncodableString(args, "title", "");
    const std::string trailing = GetEncodableString(args, "trailing", "");
    const double hold_s = GetEncodableDouble(args, "holdS", 0.0);
    // 全屏打断白名单（2026-10-13 定调）：urgent=false 的提醒在全屏/忙碌时
    // 由原生端整体跳过；默认 true 兼容未带该参数的旧调用方（E2E 等）。
    const bool urgent = GetEncodableBool(args, "urgent", true);
    if (dynamic_island_window_) {
      dynamic_island_window_->StartAttention(title, trailing, hold_s, urgent);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setAmbient") {
    // hover 态环境信息数据源：未读数 + agent 运行状态行。
    const int unread = GetEncodableInt(args, "unread", 0);
    const bool agent_active = GetEncodableBool(args, "agentActive", false);
    const std::string status = GetEncodableString(args, "agentStatus", "");
    if (dynamic_island_window_) {
      dynamic_island_window_->SetAmbient(unread, agent_active, status);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "suppressCheck") {
    // Dart 看门狗兜底：原生 WM_TIMER 心跳失效时由 Dart 直推抑制检查，
    // 保证退出全屏后岛必然恢复（不再依赖原生定时器存活）。
    if (dynamic_island_window_) {
      dynamic_island_window_->CheckSuppression();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setVoiceTalkMode") {
    // 纯语音模式点击说话开关（取代语音唤醒）。
    const bool enabled = GetEncodableBool(args, "enabled", false);
    if (dynamic_island_window_) {
      dynamic_island_window_->SetVoiceTalkMode(enabled);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setDpi") {
    double dpi = 1.0;
    if (args != nullptr) {
      dpi = GetEncodableDouble(args, "dpi", 1.0);
    }
    if (dynamic_island_window_) {
      dynamic_island_window_->SetDpiScale(dpi);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}


void FlutterWindow::HandleDailyBriefingMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "getWorkArea") {
    // 主屏工作区（扣除任务栏），简报独立窗口做右下角定位。
    // 返回逻辑像素（除以 FlutterView 的 DPR），与 window_manager
    // setPosition 的坐标系一致。
    const RECT work = window_position_store::GetPrimaryWorkArea();
    double dpr = 1.0;
    if (flutter_controller_ && flutter_controller_->view()) {
      const HWND view_hwnd = flutter_controller_->view()->GetNativeWindow();
      if (view_hwnd) {
        const UINT dpi = GetDpiForWindow(view_hwnd);
        if (dpi != 0) dpr = static_cast<double>(dpi) / 96.0;
      }
    }
    flutter::EncodableMap m;
    m[flutter::EncodableValue("left")] =
        flutter::EncodableValue(work.left / dpr);
    m[flutter::EncodableValue("top")] =
        flutter::EncodableValue(work.top / dpr);
    m[flutter::EncodableValue("right")] =
        flutter::EncodableValue(work.right / dpr);
    m[flutter::EncodableValue("bottom")] =
        flutter::EncodableValue(work.bottom / dpr);
    result->Success(flutter::EncodableValue(m));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::HandleAgentProfileMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "create") {
    if (!agent_profile_window_) {
      agent_profile_window_ = std::make_unique<AgentProfileOverlayWindow>();
      agent_profile_window_->SetEventCallback(
          [this](AgentProfileOverlayWindow::EventType type,
                 const std::string& payload) {
            std::string event_name;
            switch (type) {
              case AgentProfileOverlayWindow::EventType::kCloseClicked:
                event_name = "close"; break;
            }
            if (agent_profile_channel_) {
              flutter::EncodableMap pl;
              pl[flutter::EncodableValue("event")] =
                  flutter::EncodableValue(event_name);
              agent_profile_channel_->InvokeMethod(
                  "onNativeEvent",
                  std::make_unique<flutter::EncodableValue>(pl));
            }
          });
    }
    const bool ok = agent_profile_window_->Create();
    result->Success(flutter::EncodableValue(ok));
    return;
  }

  if (method == "destroy") {
    agent_profile_window_.reset();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "show") {
    if (!agent_profile_window_) {
      result->Success(flutter::EncodableValue(false));
      return;
    }
    agent_profile_window_->Show();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (agent_profile_window_) agent_profile_window_->Hide();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setBounds") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    if (args && agent_profile_window_) {
      int x = 0, y = 0, w = 320, h = 160;
      auto i = args->find(flutter::EncodableValue("x"));
      if (i != args->end() && std::holds_alternative<int32_t>(i->second))
        x = std::get<int32_t>(i->second);
      i = args->find(flutter::EncodableValue("y"));
      if (i != args->end() && std::holds_alternative<int32_t>(i->second))
        y = std::get<int32_t>(i->second);
      i = args->find(flutter::EncodableValue("width"));
      if (i != args->end() && std::holds_alternative<int32_t>(i->second))
        w = std::get<int32_t>(i->second);
      i = args->find(flutter::EncodableValue("height"));
      if (i != args->end() && std::holds_alternative<int32_t>(i->second))
        h = std::get<int32_t>(i->second);
      POINT pt{x, y};
      ClientToScreen(GetHandle(), &pt);
      agent_profile_window_->SetBounds(pt.x, pt.y, w, h);
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setProfile") {
    const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
    if (args && agent_profile_window_) {
      AgentProfileOverlayWindow::ProfileData data;
      data.display_name = GetEncodableString(args, "displayName", "AI助手");
      data.handle = GetEncodableString(args, "handle", "ai_agent");
      data.signature = GetEncodableString(args, "signature", "");
      data.mood_style = GetEncodableString(args, "moodStyle", "gentle");
      data.status_text = GetEncodableString(args, "statusText", "");
      data.avatar_preset = GetEncodableString(args, "avatarPreset", "dawn");
      data.last_profile_event = GetEncodableString(args, "lastProfileEvent", "");
      agent_profile_window_->SetProfile(std::move(data));
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::HandleConnectedCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string caller_name;
    std::string caller_initial;
    uint32_t accent = 0xFF22C55E;

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      caller_initial = GetEncodableString(args, "callerInitial");
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    if (!connected_call_window_) {
      connected_call_window_ = std::make_unique<ConnectedCallWindow>();
      connected_call_window_->SetCallbacks(
          [this]() {
            flutter::EncodableMap extra;
            ReportConnectedCallEvent("hangup", extra);
          },
          [this](bool new_mute) {
            flutter::EncodableMap extra;
            extra[flutter::EncodableValue("muted")] =
                flutter::EncodableValue(new_mute);
            ReportConnectedCallEvent("muteToggle", extra);
          },
          [this](bool new_speaker) {
            flutter::EncodableMap extra;
            extra[flutter::EncodableValue("speakerOn")] =
                flutter::EncodableValue(new_speaker);
            ReportConnectedCallEvent("speakerToggle", extra);
          });
    }

    // 接通后让主窗口可被看到（如果用户没启动过主窗口就保持后台）
    HWND self = GetHandle();
    if (self) {
      if (IsIconic(self)) {
        ShowWindow(self, SW_RESTORE);
      } else {
        ShowWindow(self, SW_SHOW);
      }
      BringWindowToTop(self);
    }

    connected_call_window_->Show(caller_name, caller_initial, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (connected_call_window_) {
      connected_call_window_->Hide();
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        connected_call_window_ && connected_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  if (method == "setMute") {
    bool muted = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      muted = GetEncodableBool(args, "muted", muted);
    }
    if (connected_call_window_) connected_call_window_->SetMute(muted);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setSpeaker") {
    bool on = true;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      on = GetEncodableBool(args, "on", on);
    }
    if (connected_call_window_) connected_call_window_->SetSpeaker(on);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "setTalking") {
    bool talking = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      talking = GetEncodableBool(args, "talking", talking);
    }
    if (connected_call_window_) connected_call_window_->SetTalking(talking);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "resetDuration") {
    if (connected_call_window_) connected_call_window_->ResetDuration();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportConnectedCallEvent(
    const std::string& event, const flutter::EncodableMap& extra) {
  if (!connected_call_channel_) return;
  flutter::EncodableMap payload = extra;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  connected_call_channel_->InvokeMethod(
      "onNativeEvent",
      std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleOutgoingCallMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "show") {
    std::string caller_name;
    std::string subtitle = "正在呼叫";
    std::string caller_initial;
    uint32_t accent = 0xFF22C55E;

    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      caller_name = GetEncodableString(args, "callerName");
      subtitle = GetEncodableString(args, "subtitle", subtitle);
      caller_initial = GetEncodableString(args, "callerInitial");
      accent = GetEncodableUint32(args, "accentColor", accent);
    }

    if (!outgoing_call_window_) {
      outgoing_call_window_ = std::make_unique<OutgoingCallWindow>();
      outgoing_call_window_->SetCallbacks(
          [this]() { ReportOutgoingCallEvent("hangup"); });
    }

    outgoing_call_window_->Show(caller_name, subtitle, caller_initial, accent);
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "hide") {
    if (outgoing_call_window_) outgoing_call_window_->Hide();
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "isVisible") {
    const bool visible =
        outgoing_call_window_ && outgoing_call_window_->IsVisible();
    result->Success(flutter::EncodableValue(visible));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::ReportOutgoingCallEvent(const std::string& event) {
  if (!outgoing_call_channel_) return;
  flutter::EncodableMap payload;
  payload[flutter::EncodableValue("event")] = flutter::EncodableValue(event);
  payload[flutter::EncodableValue("timestampMs")] = flutter::EncodableValue(
      static_cast<int64_t>(GetTickCount64()));
  outgoing_call_channel_->InvokeMethod(
      "onNativeEvent", std::make_unique<flutter::EncodableValue>(payload));
}

void FlutterWindow::HandleWindowTitleBarMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "setDarkMode") {
    bool is_dark = false;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      is_dark = GetEncodableBool(args, "isDark", false);
    }
    HWND hwnd = GetHandle();
    if (hwnd) {
      BOOL enable_dark_mode = is_dark ? TRUE : FALSE;
      DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &enable_dark_mode, sizeof(enable_dark_mode));

      const COLORREF black = RGB(0, 0, 0);
      const COLORREF white = RGB(255, 255, 255);
      const COLORREF default_color = 0xFFFFFFFF;
      const COLORREF caption_color = is_dark ? black : default_color;
      const COLORREF border_color = is_dark ? black : default_color;
      const COLORREF text_color = is_dark ? white : default_color;

      DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &caption_color,
                            sizeof(caption_color));
      DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &border_color,
                            sizeof(border_color));
      DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &text_color,
                            sizeof(text_color));
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  result->NotImplemented();
}

// ---- pai/app_lifecycle：开机自动启动 ----
//
// 写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 注册表值（当前用户
// 登录即启动，无需管理员权限），值名为固定应用标识，值为当前 exe 完整路径。
// 开机自启是「简报随开机播报」的前提：应用随系统启动 → WS 连上 → 触发
// 启动简报（在座检测通过后播报）。

namespace {
constexpr wchar_t kAutoStartRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kAutoStartValueName[] = L"PrivateAIAgent";

std::wstring GetAutoStartExePath() {
  wchar_t path[MAX_PATH] = {0};
  const DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) return std::wstring();
  // 带引号包裹，兼容路径中的空格
  return L"\"" + std::wstring(path) + L"\"";
}
}  // namespace

void FlutterWindow::HandleAppLifecycleMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "setAutoStart") {
    bool enable = false;
    if (auto* args = std::get_if<bool>(call.arguments())) {
      enable = *args;
    } else if (auto* map = std::get_if<flutter::EncodableMap>(call.arguments())) {
      auto it = map->find(flutter::EncodableValue("enable"));
      if (it != map->end()) {
        if (auto* v = std::get_if<bool>(&it->second)) enable = *v;
      }
    }
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kAutoStartRunKey, 0, KEY_SET_VALUE,
                      &key) != ERROR_SUCCESS) {
      result->Error("registry_error", "open HKCU Run key failed");
      return;
    }
    LONG res;
    if (enable) {
      const std::wstring exe = GetAutoStartExePath();
      if (exe.empty()) {
        RegCloseKey(key);
        result->Error("exe_path_error", "GetModuleFileNameW failed");
        return;
      }
      res = RegSetValueExW(key, kAutoStartValueName, 0, REG_SZ,
                           reinterpret_cast<const BYTE*>(exe.c_str()),
                           static_cast<DWORD>((exe.size() + 1) * sizeof(wchar_t)));
    } else {
      res = RegDeleteValueW(key, kAutoStartValueName);
      // 值本就不存在视为成功（幂等）
      if (res == ERROR_FILE_NOT_FOUND) res = ERROR_SUCCESS;
    }
    RegCloseKey(key);
    if (res != ERROR_SUCCESS) {
      result->Error("registry_error", "write/delete Run value failed");
      return;
    }
    result->Success(flutter::EncodableValue(true));
    return;
  }

  if (method == "getAutoStart") {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kAutoStartRunKey, 0, KEY_QUERY_VALUE,
                      &key) != ERROR_SUCCESS) {
      result->Success(flutter::EncodableValue(false));
      return;
    }
    DWORD type = 0;
    BYTE buffer[MAX_PATH * 2] = {0};
    DWORD size = sizeof(buffer);
    const LONG res = RegQueryValueExW(key, kAutoStartValueName, nullptr, &type,
                                      buffer, &size);
    RegCloseKey(key);
    const bool enabled =
        res == ERROR_SUCCESS && type == REG_SZ && size > sizeof(wchar_t);
    result->Success(flutter::EncodableValue(enabled));
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::HandlePcmPlayerMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "start") {
    int sample_rate = 24000;
    int channels = 1;
    if (auto* args = std::get_if<flutter::EncodableMap>(call.arguments())) {
      sample_rate = GetEncodableInt(args, "sampleRate", sample_rate);
      channels = GetEncodableInt(args, "channels", channels);
    }
    if (!pcm_player_) {
      pcm_player_ = std::make_unique<PcmStreamPlayer>();
      pcm_player_->SetNotifyTarget(GetHandle(), kPcmPlayerDoneMsg);
    }
    result->Success(
        flutter::EncodableValue(pcm_player_->Start(sample_rate, channels)));
    return;
  }

  if (method == "write") {
    // 直接收 Uint8List：省掉 base64 编解码，逐块直写 waveOut
    const auto* bytes = std::get_if<std::vector<uint8_t>>(call.arguments());
    if (bytes && !bytes->empty() && pcm_player_) {
      pcm_player_->Write(bytes->data(), bytes->size());
    }
    result->Success();
    return;
  }

  if (method == "finish") {
    if (pcm_player_) pcm_player_->Finish();
    result->Success();
    return;
  }

  if (method == "stop") {
    if (pcm_player_) pcm_player_->Stop();
    result->Success();
    return;
  }

  if (method == "isPlaying") {
    result->Success(flutter::EncodableValue(pcm_player_ != nullptr &&
                                            pcm_player_->IsPlaying()));
    return;
  }

  result->NotImplemented();
}
