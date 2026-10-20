#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "embedded_font.h"
#include "flutter_window.h"
#include "single_instance.h"
#include "utils.h"
#include "webview_ghost_window_guardian.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // 岛字体（HarmonyOS/Noto）必须抢在本进程第一次 GDI+ 字体操作之前以
  // AddFontResourceExW 注册进会话（本机实证 2026-10-02 开机后必现：玻璃
  // 通知预热等先行文字绘制让 GDI+ 进程级字体表提前定型，之后才注册的族
  // 对 GDI+ 永不可见——Gdiplus::Font 构造静默失败，岛上中文全部画空，
  // 只剩矢量图标和系统字体字形（MDL2）。GDI 侧不受影响，故 CreateFontW
  // 选字成功、字体文件也确在会话表里，极具迷惑性）。入口处注册即保证
  // 无论字体表在 GdiplusStartup 还是首次字体操作时定型，都已包含它们。
  LoadIslandHarmonyosFonts();
  LoadIslandNotoFonts();

  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Suppress libpng "iCCP: known incorrect sRGB profile" warnings emitted by
  // the Flutter engine's built-in PNG resources. These are harmless and only
  // clutter the console output. Critical engine errors are still reported via
  // Dart's FlutterError.onError / PlatformDispatcher.onError.
  //
  // 注意：Flutter 引擎/图片解码/GPU 等 native 层的致命错误（如 OOM、跳过
  // Dart 的 onError 直接崩溃）只会走 stderr，Dart 侧日志抓不到。若这里丢弃
  // 到 NUL，这类崩溃就完全无迹可查（表现为 flutter run 打印 "Lost connection
  // to device" 但没有对应异常）。因此持久化到 CRT 崩溃日志，便于事后排查。
  //
  // ⚠️ freopen_s 失败会把 stderr 置为「已关闭」流（fd=-1）——之后任何
  // fwprintf(stderr)（DynamicIsland/GhostGuard 的日志写点）都会触发 debug
  // CRT 断言 write.cpp:50 并 abort。2026-10-11 行程窗口「旅游界面进不去」
  // 弹 Debug Assertion 崩溃的实锤根因（dump 栈 = GhostGuard 线程 →
  // ucrtbased abort，参数校验失败于 _write 的无效句柄检查）。
  // 因此这里逐级兜底（env 指定路径 → exe 目录 → %TEMP% → nul 设备），
  // 保证 stderr 流永远有效；前三级失败一般只发生在目标盘不可写/被锁。
  FILE* stderr_sink = nullptr;
  errno_t fr_err = -1;
  {
    char* env_val = nullptr;
    size_t env_len = 0;
    const errno_t env_err = _dupenv_s(&env_val, &env_len, "PAI_STDERR_LOG");
    if (env_err == 0 && env_val != nullptr && *env_val != '\0') {
      const int wlen = ::MultiByteToWideChar(CP_UTF8, 0, env_val, -1, nullptr, 0);
      if (wlen > 0) {
        std::wstring wpath(static_cast<size_t>(wlen), L'\0');
        ::MultiByteToWideChar(CP_UTF8, 0, env_val, -1, wpath.data(), wlen);
        // 去掉 MultiByteToWideChar 的结尾 NUL
        while (!wpath.empty() && wpath.back() == L'\0') wpath.pop_back();
        fr_err = _wfreopen_s(&stderr_sink, wpath.c_str(), L"a", stderr);
      }
    }
    free(env_val);
  }
  if (fr_err != 0 || stderr_sink == nullptr) {
    // 兜底 1：exe 同目录（写入时机早于任何 chdir，绝对路径最稳）
    wchar_t exe_path[MAX_PATH] = {};
    ::GetModuleFileNameW(nullptr, exe_path, MAX_PATH);
    std::wstring fallback(exe_path);
    const size_t slash = fallback.find_last_of(L"\\/");
    fallback = (slash == std::wstring::npos) ? std::wstring()
                                             : fallback.substr(0, slash + 1);
    fallback += L"pai_app_stderr.log";
    fr_err = _wfreopen_s(&stderr_sink, fallback.c_str(), L"a", stderr);
  }
  if (fr_err != 0 || stderr_sink == nullptr) {
    // 兜底 2：%TEMP%
    wchar_t tmp_dir[MAX_PATH] = {};
    if (::GetTempPathW(MAX_PATH, tmp_dir) > 0) {
      std::wstring fallback = std::wstring(tmp_dir) + L"pai_app_stderr.log";
      fr_err = _wfreopen_s(&stderr_sink, fallback.c_str(), L"a", stderr);
    }
  }
  if (fr_err != 0 || stderr_sink == nullptr) {
    // 兜底 3：nul 设备，永远成功。宁可丢日志也不能留无效 stderr 流。
    _wfreopen_s(&stderr_sink, L"nul", L"a", stderr);
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  // 主应用单实例：同一登录会话内只允许一个主进程。
  //
  // 本 exe 还以「子窗口模式」被主应用 Process.start 拉起（行程窗 /
  // 今日简报 / 注册预览，均由环境变量门控），那些子进程必须跳过本判定——
  // 否则它们会把既有主实例当成重复实例、反而把自己杀掉。
  const bool child_window_mode =
      GetEnvironmentVariableW(L"PAI_TRAVEL_PLAN_MAILBOX", nullptr, 0) > 0 ||
      GetEnvironmentVariableW(L"PAI_DAILY_BRIEFING_WINDOW", nullptr, 0) > 0 ||
      GetEnvironmentVariableW(L"PAI_REGISTER_PREVIEW", nullptr, 0) > 0;
  // 已有主实例（点 X 后驻留在托盘里）：请求它恢复并前置主窗口，本进程
  // 立即退出，绝不再建第二个窗口/后台服务。窗口未就绪的启动竞态由模块
  // 内部的短重试兜底。
  if (!child_window_mode && !pai_single_instance::AcquirePrimaryInstance()) {
    return EXIT_SUCCESS;
  }

  // WebView2 幽灵窗防护：msedgewebview2.exe 滞留的内部顶层窗口曾以透明
  // "幽灵窗"形态拦截其他应用点击（见 webview_ghost_window_guardian.h）。
  // 在入口处启动常驻清扫，主窗口/简报/行程等所有子进程模式共用本入口，
  // 全部覆盖。
  webview_ghost_guardian::Start();

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);

  // 行程规划独立窗口（PAI_TRAVEL_PLAN_MAILBOX）：窗口「创建即最终几何」。
  //
  // 「幽灵窗」的根源是「创建几何（占位 10,10/1280×720）≠ 最终几何」：
  // Flutter 模板「首帧即 Show」会在 Dart 侧算出最终几何之前先把窗口显示出来，
  // 随后窗口才被挪到居中位置——于是"先在别处映现一下、再回到正常位置"。
  // 这里把几何在 CreateWindow 之前就定死为最终值，从源头消除了「占位几何」
  // 这个可被提前显示的错误状态：模板 Show 与 Dart 侧的尺寸设置都退化为幂等
  // 操作，无需在任何地方压制显示时机。口径与页面设计稿 1:1：1140×740 逻辑像素、
  // 主屏工作区居中。
  if (GetEnvironmentVariableW(L"PAI_TRAVEL_PLAN_MAILBOX", nullptr, 0) > 0) {
    RECT work{};
    if (SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)) {
      const double dpr = static_cast<double>(GetDpiForSystem()) / 96.0;
      const double w = 1140.0 * dpr;  // 物理宽
      const double h = 740.0 * dpr;   // 物理高
      const double x = work.left + ((work.right - work.left) - w) / 2.0;
      const double y = work.top + ((work.bottom - work.top) - h) / 2.0;
      // Win32Window::Create 内部会按目标监视器 DPI 再放大一次，故此处回传
      // 「逻辑」坐标（物理 / dpr），最终落在物理 (x, y, w, h)。
      origin = Win32Window::Point(static_cast<unsigned int>(x / dpr + 0.5),
                                  static_cast<unsigned int>(y / dpr + 0.5));
      size = Win32Window::Size(1140, 740);
    }
  }

  if (!window.Create(L"", origin, size)) {
    return EXIT_FAILURE;
  }
  // 标记主窗口：供后续启动的进程用 EnumWindows 定位并请求前置（窗口标题
  // 被刻意置空、类名又与各子窗口共用，只能靠窗口属性区分）。子窗口模式
  // 不打标，否则会被误当成主实例的窗口。
  if (!child_window_mode) {
    pai_single_instance::MarkPrimaryMainWindow(window.GetHandle());
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  // ⚠️ 引擎与插件的析构必须发生在 CoUninitialize() 之前。
  //
  // 托盘「退出」走的是 window_manager.destroy()，其原生实现只有
  // PostQuitMessage(0)——**窗口本身不会被销毁**。于是消息循环退出后，
  // Flutter 引擎要到 main 返回时的栈对象析构才释放，而那时
  // ::CoUninitialize() 已经执行过：引擎（DirectComposition/DXGI）与
  // WebView2 插件都在 COM 已卸载的线程上销毁 → flutter_windows.dll
  // 访问违例（事件日志实证：0xc0000005，偏移 0x1d7b0，随后回调二次异常
  // 0xc000041d）。WER 随即挂起全部线程并收集 dump，内存从 ~220MB 涨到
  // ~690MB，进程要 13~19 秒才消失——用户侧就是「点退出卡十几秒」。
  //
  // 官方模板之所以没这个问题，是因为正常关闭走 WM_CLOSE → DestroyWindow
  // → WM_DESTROY（OnDestroy 里已释放引擎）→ PostQuitMessage，析构天然在
  // CoUninitialize 之前。这里显式补上销毁，保证「先关窗口、再卸 COM」，
  // 与正常关闭路径一致；若窗口已被正常关闭（句柄已空）则是幂等空操作。
  window.Destroy();

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
