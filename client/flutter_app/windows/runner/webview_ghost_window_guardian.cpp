#include "webview_ghost_window_guardian.h"

#include <windows.h>
#include <io.h>
#include <tlhelp32.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace webview_ghost_guardian {
namespace {

// 尺寸门槛：窗口面积 ≥ 所在显示器工作区的 25% 才视为"幽灵窗"。
// 页内下拉/日期选择等合法原生弹层都是小窗口，不会被误伤；
// 实测事故形态是"盖住左半屏"，25% 有足够裕量。
constexpr double kMinWorkAreaRatio = 0.25;
constexpr int kSweepIntervalMs = 2000;
// 进程父链回溯步数上限（msedgewebview2 树深通常 ≤3，留足裕量防绕路）。
constexpr int kMaxParentHops = 8;

bool IsChromiumWindowClass(const wchar_t* class_name) {
  return wcsncmp(class_name, L"Chrome_WidgetWin", 16) == 0 ||
         wcscmp(class_name, L"Chrome_RenderWidgetHostHWND") == 0;
}

bool GetProcessImageName(DWORD pid, wchar_t* buf, unsigned buf_len) {
  buf[0] = L'\0';
  HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  DWORD size = buf_len;
  const BOOL ok =
      QueryFullProcessImageNameW(process, 0, buf, &size);
  CloseHandle(process);
  return ok != FALSE;
}

// 当前进程 + 父链能追溯到当前进程的所有 msedgewebview2.exe 进程。
// 有了进程归属过滤，用户自己开的 Chrome/Edge 浏览器窗口（同为
// Chrome_WidgetWin 类名）永远不会被误伤。
std::unordered_set<DWORD> CollectWebView2ProcessPids() {
  std::unordered_set<DWORD> pids;
  pids.insert(GetCurrentProcessId());

  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return pids;

  std::unordered_map<DWORD, DWORD> parent_of;
  std::unordered_set<DWORD> browser_pids;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      parent_of[entry.th32ProcessID] = entry.th32ParentProcessID;
      if (_wcsicmp(entry.szExeFile, L"msedgewebview2.exe") == 0) {
        browser_pids.insert(entry.th32ProcessID);
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);

  const DWORD self_pid = GetCurrentProcessId();
  for (DWORD pid : browser_pids) {
    DWORD cursor = pid;
    for (int hop = 0; hop < kMaxParentHops && cursor != 0; ++hop) {
      if (cursor == self_pid) {
        pids.insert(pid);
        break;
      }
      const auto it = parent_of.find(cursor);
      if (it == parent_of.end()) break;
      cursor = it->second;
    }
  }
  return pids;
}

// 是否足够大（覆盖所在显示器工作区 ≥25%）。
bool CoversLargeArea(HWND hwnd) {
  RECT window_rect{};
  if (!GetWindowRect(hwnd, &window_rect)) return false;
  const unsigned long long window_area =
      static_cast<unsigned long long>(
          window_rect.right - window_rect.left) *
      static_cast<unsigned long long>(
          window_rect.bottom - window_rect.top);
  if (window_area == 0) return false;

  MONITORINFO monitor_info{};
  monitor_info.cbSize = sizeof(monitor_info);
  const HMONITOR monitor =
      MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!monitor || !GetMonitorInfoW(monitor, &monitor_info)) return false;
  const unsigned long long work_area =
      static_cast<unsigned long long>(
          monitor_info.rcWork.right - monitor_info.rcWork.left) *
      static_cast<unsigned long long>(
          monitor_info.rcWork.bottom - monitor_info.rcWork.top);
  if (work_area == 0) return false;
  return static_cast<double>(window_area) >=
         static_cast<double>(work_area) * kMinWorkAreaRatio;
}

struct SweepContext {
  const std::unordered_set<DWORD>* webview_pids;
  HWND foreground;
  int neutralized;
};

BOOL CALLBACK SweepWindow(HWND hwnd, LPARAM lparam) {
  auto* ctx = reinterpret_cast<SweepContext*>(lparam);
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
  if (hwnd == ctx->foreground) return TRUE;

  wchar_t class_name[256] = {};
  if (GetClassNameW(hwnd, class_name, 256) == 0) return TRUE;
  if (!IsChromiumWindowClass(class_name)) return TRUE;

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0 || ctx->webview_pids->find(pid) == ctx->webview_pids->end()) {
    return TRUE;
  }
  if (!CoversLargeArea(hwnd)) return TRUE;

  const LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex_style & WS_EX_TRANSPARENT) return TRUE;  // 已中和过

  // WS_EX_TRANSPARENT：鼠标命中穿透（WindowFromPoint 跳过该窗口）；
  // WS_EX_NOACTIVATE：点击不抢焦点。两者都不改变窗口的渲染与生命周期，
  // 对 WebView2 合成模式（输入全走 SendMouseInput 合成事件）零影响。
  // 注意：SetWindowLongPtrW 返回"先前样式值"，0 是合法返回值（非错误），
  // 需用 GetLastError 区分。
  SetLastError(ERROR_SUCCESS);
  const LONG_PTR prev_style = SetWindowLongPtrW(
      hwnd, GWL_EXSTYLE, ex_style | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
  if (prev_style == 0 && GetLastError() != ERROR_SUCCESS) return TRUE;
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                   SWP_FRAMECHANGED);
  ctx->neutralized++;

  wchar_t exe_name[MAX_PATH] = {};
  GetProcessImageName(pid, exe_name, MAX_PATH);
  RECT rect{};
  GetWindowRect(hwnd, &rect);
  wchar_t log[1024];
  _snwprintf_s(log, _countof(log), _TRUNCATE,
               L"[WebViewGhostGuard] neutralized ghost window: "
               L"class=%ls hwnd=0x%p pid=%lu (%ls) rect=(%ld,%ld)-(%ld,%ld)",
               class_name, hwnd, static_cast<unsigned long>(pid), exe_name,
               static_cast<long>(rect.left), static_cast<long>(rect.top),
               static_cast<long>(rect.right),
               static_cast<long>(rect.bottom));
  OutputDebugStringW(log);
  // main.cpp 已把 stderr 重定向到 pai_app_stderr.log，方便事后排查。
  // 防御：stderr 流必须有效才写——freopen 失败/流被关闭（fd=-1）时任何
  // fwprintf 都会触发 debug CRT 断言 write.cpp:50 并 abort（2026-10-11
  // 行程窗口崩溃实锤：本线程的 dump 栈止于 ucrtbased abort）。
  if (stderr != nullptr && _fileno(stderr) >= 0) {
    fwprintf(stderr, L"%ls\n", log);
    fflush(stderr);
  }
  return TRUE;
}

}  // namespace

int SweepOnce() {
  const std::unordered_set<DWORD> pids = CollectWebView2ProcessPids();
  SweepContext ctx{&pids, GetForegroundWindow(), 0};
  EnumWindows(SweepWindow, reinterpret_cast<LPARAM>(&ctx));
  return ctx.neutralized;
}

void Start() {
  static std::atomic<bool> started{false};
  bool expected = false;
  if (!started.compare_exchange_strong(expected, true)) return;

  std::thread([] {
    for (;;) {
      SweepOnce();
      std::this_thread::sleep_for(
          std::chrono::milliseconds(kSweepIntervalMs));
    }
  }).detach();
}

}  // namespace webview_ghost_guardian
