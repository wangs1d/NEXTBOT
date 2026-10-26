#include "dynamic_island_window.h"

#include <windowsx.h>
#include <io.h>

#include <dwmapi.h>
#include <gdiplus.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <thread>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <tuple>

#include "embedded_font.h"

#ifndef USER_DEFAULT_SCREEN_DPI
#define USER_DEFAULT_SCREEN_DPI 96
#endif

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "winmm.lib")

namespace {

// ── 岛窗口生死日志 ──
// stderr 已被 main.cpp 重定向到 pai_app_stderr.log（追加写，失败时兜底到
// exe 目录 / %TEMP% / nul，保证流永远有效）。
// 取证「谁在销毁岛窗口」：外部 WM_CLOSE 与直接 DestroyWindow 的路径不同。
// 防御：流无效（fd=-1）时绝不写——debug CRT 的 fwprintf 会断言 write.cpp:50
// 并 abort（2026-10-11 行程窗口崩溃同款机制）。
void IslandLifecycleLog(HWND hwnd, const wchar_t* event) {
  if (stderr != nullptr && _fileno(stderr) >= 0) {
    fwprintf(stderr, L"[DynamicIsland] %ls hwnd=0x%p tick=%llu\n", event, hwnd,
             static_cast<unsigned long long>(GetTickCount64()));
    fflush(stderr);
  }
}

// ── 「谁压在岛这块像素上面」的候选窗口筛选 ──
// 壁纸层（Progman/WorkerW）与任务栏永远铺满屏幕，但它们不是「应用占着
// 全屏」，不剔掉的话光站在桌面上岛就会让位。
bool IsShellLayerWindow(HWND hwnd) {
  wchar_t cls[64] = {};
  if (GetClassNameW(hwnd, cls, _countof(cls)) <= 0) return false;
  return _wcsicmp(cls, L"Progman") == 0 || _wcsicmp(cls, L"WorkerW") == 0 ||
         _wcsicmp(cls, L"SHELLDLL_DefView") == 0 ||
         _wcsicmp(cls, L"Shell_TrayWnd") == 0 ||
         _wcsicmp(cls, L"Shell_SecondaryTrayWnd") == 0 ||
         _wcsicmp(cls, L"NotifyIconOverflowWindow") == 0;
}

// DWM 隐身：最小化的 UWP、被切到别的虚拟桌面的窗口，IsWindowVisible 依旧
// 返回真——不靠 cloak 标志识破，一个切走的满屏 UWP 就能把岛永久按住。
bool IsDwmCloaked(HWND hwnd) {
  int cloaked = 0;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked,
                                   sizeof(cloaked))))
    return false;
  return cloaked != 0;
}

// 参与「盖岛」竞争的顶层窗口。过滤按代价从低到高排，DWM 查询放最后。
bool IsCoverCandidate(HWND hwnd, HWND island, const RECT& rc) {
  if (hwnd == nullptr || hwnd == island) return false;
  if (!IsWindowVisible(hwnd)) return false;
  // 工具窗（岛自己那类悬浮层）与点击穿透层都不算「占住这块地方」：
  // 待机光球（Qt Tool + click-through）、webview 幽灵窗全在这条被挡掉。
  const LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)) return false;
  if (rc.right - rc.left <= 1 || rc.bottom - rc.top <= 1) return false;
  if (IsShellLayerWindow(hwnd)) return false;
  return !IsDwmCloaked(hwnd);
}

// ── 录屏豁免全屏抑制 ──
// 拍摄灵动岛（录屏演示）是核心场景：录制期间即使系统上报 QUNS_BUSY
// 也让岛保持显示；非录制态的全屏视频/游戏/演示模式照旧让位。
// 注意 ffmpeg.exe 绝不能入列——服务端代码沙箱会拉起 ffmpeg，会把
// 「全屏视频 + 后台跑任务」误判成录制。
//
// 2026-10-24 收紧豁免条件：名单类应用（OBS/剪映/ShareX…）常驻托盘或
// 关窗后残留后台进程，「进程在跑」≠「在录屏」——剪映残留 10 个后台
// 进程就把全屏抑制永久关掉（本机实证）。除 gamebarftserver.exe（无
// 窗口、只在 Game Bar 录制会话期间存在，保留纯存在判定）外，改为
// 「该进程存在可见、未最小化的顶层窗口」才豁免。代价：录制时把 OBS
// 最小化到托盘则不豁免，录制期间保持窗口打开即可。
//
// 2026-10-26 剪映（jianyingpro.exe）移出名单：「有可见顶层窗口」对剪辑器
// 恒真——剪映一开就最大化占满整屏，而压住岛的那个全屏窗口正是被认成
// 「在录屏」的那个进程自己，全屏让位被它自己豁免掉了（本机实证：
// COVERED=1 且 rec=1 → busy=0，岛骑在剪映全屏画面上）。名单只留专职录屏
// 工具；拍灵动岛演示用 OBS 或 Win+Alt+R（Game Bar），二者行为不变。
constexpr const wchar_t* kRecorderBareProcessNames[] = {
    L"gamebarftserver.exe",  // Xbox Game Bar 录制服务（Win+Alt+R）
};

// 需「存在可见顶层窗口」才豁免的名单（大小写不敏感）。
constexpr const wchar_t* kRecorderWindowedProcessNames[] = {
    L"obs64.exe",
    L"obs32.exe",
    L"snippingtool.exe",  // Win11 剪切工具录屏
    L"screenclip.exe",
    L"evcapture.exe",  // EV 录屏
    L"bdcam.exe",      // Bandicam
    L"camtasiarecorder.exe",
    L"camtasiastudio.exe",
    L"sharex.exe",
    L"apowerrec.exe",    // 傲软录屏
    L"cap.exe",          // Cap（cap.so 开源录屏，2026-10-14 实证其选区
                         // 全屏遮罩会盖住岛触发让位，入列豁免）
};

template <size_t N>
bool ExeNameInList(const wchar_t* exe, const wchar_t* const (&names)[N]) {
  for (size_t i = 0; i < N; ++i) {
    if (_wcsicmp(exe, names[i]) == 0) return true;
  }
  return false;
}

// |pid| 是否拥有「真在用」的顶层窗口：可见、未最小化、非工具/穿透窗、
// 未被 DWM cloak、有实际面积——托盘常驻与关窗残留的后台进程全在此挡掉。
struct RecorderWindowProbe {
  DWORD pid = 0;
  bool found = false;
};

BOOL CALLBACK RecorderWindowEnumProc(HWND hwnd, LPARAM lparam) {
  auto* probe = reinterpret_cast<RecorderWindowProbe*>(lparam);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != probe->pid) return TRUE;
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
  const LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)) return TRUE;
  RECT rc = {};
  if (!GetWindowRect(hwnd, &rc) || rc.right - rc.left <= 1 ||
      rc.bottom - rc.top <= 1) {
    return TRUE;
  }
  if (IsDwmCloaked(hwnd)) return TRUE;
  probe->found = true;
  return FALSE;  // 命中即停
}

bool ProcessHasVisibleTopLevelWindow(DWORD pid) {
  RecorderWindowProbe probe{pid, false};
  EnumWindows(RecorderWindowEnumProc, reinterpret_cast<LPARAM>(&probe));
  return probe.found;
}

// |matched_exe| 非空时回填命中的进程名——豁免误命中会把全屏抑制永久关掉，
// 日志必须能直接指认是谁（2026-10-25 取证）。
bool IsScreenRecordingActive(std::wstring* matched_exe) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool found = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      const bool bare =
          ExeNameInList(entry.szExeFile, kRecorderBareProcessNames);
      const bool windowed =
          ExeNameInList(entry.szExeFile, kRecorderWindowedProcessNames);
      if (!bare && !windowed) continue;
      if (bare || ProcessHasVisibleTopLevelWindow(entry.th32ProcessID)) {
        found = true;
        if (matched_exe != nullptr) *matched_exe = entry.szExeFile;
        break;
      }
    } while (!found && Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}


// ── GDI+ 进程级初始化 ──
ULONG_PTR g_gdiplus_token = 0;

void EnsureGdiplusIsland() {
  if (g_gdiplus_token != 0) return;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&g_gdiplus_token, &input, nullptr);
}

// Gdiplus::Font(hdc, hfont) 只在构造时读一次 LOGFONT，不接管 HFONT。
// 动画态 60fps 渲染、每帧多处字体构造——若每次 CreateFontW 都不释放，
// 约 1 分钟就打满进程 GDI 句柄上限（默认 1 万），此后 CreateDIBSection
// 失败、premultiply 循环读空位图直接 0xc0000005。字体组合有限
// （族 × 字号 × 字重 × 删除线），进程级缓存复用，句柄数有界。
HFONT CachedIslandFont(const wchar_t* family, int size, int weight,
                       bool strike) {
  static std::map<std::tuple<std::wstring, int, int, bool>, HFONT> cache;
  const auto key = std::make_tuple(std::wstring(family), size, weight, strike);
  const auto it = cache.find(key);
  if (it != cache.end()) return it->second;
  HFONT font = CreateFontW(size, 0, 0, 0, weight, FALSE, strike ? TRUE : FALSE,
                           FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                           CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, family);
  cache[key] = font;
  return font;
}

HFONT MakeIslandFont(int size, int weight, bool strike = false) {
  // 字重路由：基础族只有 Regular/Bold 两面，<600 的请求会掉回 Regular；
  // Medium 是独立族名，须显式点名（probe-island-fonts-final.ps1 实证）。
  const wchar_t* family =
      weight < 600 ? IslandFontFamilyMedium() : IslandFontFamily();
  return CachedIslandFont(family, size, weight, strike);
}

// 状态图标专用：Segoe MDL2 Assets 字形不在 MiSans 里，必须独立字族。
HFONT MakeIslandGlyphFont(int size) {
  return CachedIslandFont(L"Segoe MDL2 Assets", size, 400, false);
}

// 字形（Segoe MDL2 Assets）：task/update/schedule/inbox/voice
const wchar_t* KindGlyph(DynamicIslandWindow::Kind kind) {
  switch (kind) {
    case DynamicIslandWindow::Kind::kTask: return L"\uE9D9";     // Diagnostic
    case DynamicIslandWindow::Kind::kUpdate: return L"\uE74E";   // Download
    case DynamicIslandWindow::Kind::kSchedule: return L"\uE787"; // Calendar
    case DynamicIslandWindow::Kind::kInbox: return L"\uE896";    // Mail
    case DynamicIslandWindow::Kind::kVoice: return L"\uE720";    // Microphone
  }
  return L"\uE787";
}

// 自绘状态图标（字体字形在 MDL2 里缺失的类别用矢量画，杜绝豆腐块）。
// task：进度圆环（spinning 时旋转）；briefing：文档；inbox：信封。
void DrawTaskIcon(Gdiplus::Graphics& g, float cx, float cy, float r,
                  double phase_s, BYTE alpha = 190) {
  Gdiplus::Pen pen(Gdiplus::Color(alpha, 255, 255, 255), 1.6f);
  const float d = r * 2;
  const float start = static_cast<float>(std::fmod(phase_s * 240.0, 360.0));
  Gdiplus::RectF ring(cx - r, cy - r, d, d);
  g.DrawArc(&pen, ring, start, 300);
}

void DrawMailIcon(Gdiplus::Graphics& g, float cx, float cy, float w,
                  float h) {
  Gdiplus::Pen pen(Gdiplus::Color(190, 255, 255, 255), 1.4f);
  Gdiplus::RectF body(cx - w / 2, cy - h / 2, w, h);
  g.DrawRectangle(&pen, body);
  g.DrawLine(&pen, cx - w / 2, cy - h / 2, cx, cy + h * 0.08f);
  g.DrawLine(&pen, cx + w / 2, cy - h / 2, cx, cy + h * 0.08f);
}

// 步骤状态勾/叉（展开卡「任务动态」行首）：勾=成功，叉=失败。
void DrawCheckMark(Gdiplus::Graphics& g, float cx, float cy, float s,
                   BYTE alpha) {
  Gdiplus::Pen pen(Gdiplus::Color(alpha, 150, 235, 165), 1.7f);
  g.DrawLine(&pen, cx - 3.5f * s, cy + 0.4f * s, cx - 0.8f * s, cy + 3.1f * s);
  g.DrawLine(&pen, cx - 0.8f * s, cy + 3.1f * s, cx + 4.2f * s, cy - 3.2f * s);
}

void DrawCrossMark(Gdiplus::Graphics& g, float cx, float cy, float s,
                   BYTE alpha) {
  Gdiplus::Pen pen(Gdiplus::Color(alpha, 255, 130, 120), 1.7f);
  g.DrawLine(&pen, cx - 3.1f * s, cy - 3.1f * s, cx + 3.1f * s, cy + 3.1f * s);
  g.DrawLine(&pen, cx - 3.1f * s, cy + 3.1f * s, cx + 3.1f * s, cy - 3.1f * s);
}

double EaseOutCubic(double t) { return 1.0 - std::pow(1.0 - t, 3.0); }

double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// 声明宽度下的文案兜底：超出档宽按字符截断加省略号（每帧少量 MeasureString，
// 与既有头部排版同量级）。
std::wstring FitText(Gdiplus::Graphics& g, const std::wstring& text,
                     const Gdiplus::Font& font, float max_w) {
  if (text.empty() || max_w <= 0) return L"";
  Gdiplus::RectF m;
  g.MeasureString(text.c_str(), -1, &font, Gdiplus::PointF(0, 0), &m);
  if (m.Width <= max_w) return text;
  std::wstring t = text;
  while (!t.empty()) {
    t.pop_back();
    const std::wstring cand = t + L"…";
    g.MeasureString(cand.c_str(), -1, &font, Gdiplus::PointF(0, 0), &m);
    if (m.Width <= max_w) return cand;
  }
  return L"";
}

// 轻提醒音（随 attention 动画）：waveOut 现场合成。
// 用户从三候选中选定 C：A4 低钟单音——钟体泛音（1/2/2.92 倍频）、
// 长衰减 tau=0.45、30ms 柔和起音，沉稳不刺耳。振幅 0.15。
// 播放异步收尾：钟声 1.4s，留余量 2.1s 后释放资源。
void PlayAttentionChime() {
  static bool failed = false;
  if (failed) return;
  const int kSampleRate = 44100;
  const int kSamples = static_cast<int>(kSampleRate * 1.4);
  std::vector<short> buf(kSamples);
  for (int i = 0; i < kSamples; i++) {
    const double t = i / static_cast<double>(kSampleRate);
    const double env = std::exp(-t / 0.45) * std::min(t / 0.03, 1.0);
    const double tone = std::sin(6.2831853 * 440.0 * t) +
                        std::sin(6.2831853 * 880.0 * t) * 0.20 +
                        std::sin(6.2831853 * 1284.8 * t) * 0.10;
    buf[i] = static_cast<short>(0.15 * env * tone * 32767.0);
  }
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 1;
  fmt.nSamplesPerSec = kSampleRate;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  HWAVEOUT out = nullptr;
  if (waveOutOpen(&out, WAVE_MAPPER, &fmt, 0, 0, CALLBACK_NULL) !=
      MMSYSERR_NOERROR) {
    failed = true;  // 无可用输出设备：静默降级（动画照常）
    return;
  }
  WAVEHDR* hdr = new WAVEHDR{};
  hdr->lpData = reinterpret_cast<LPSTR>(buf.data());
  hdr->dwBufferLength = static_cast<DWORD>(buf.size() * sizeof(short));
  waveOutPrepareHeader(out, hdr, sizeof(WAVEHDR));
  waveOutWrite(out, hdr, sizeof(WAVEHDR));
  std::thread([out, hdr, b = std::move(buf)]() {
    Sleep(2100);
    waveOutUnprepareHeader(out, hdr, sizeof(WAVEHDR));
    delete hdr;
    waveOutClose(out);
  }).detach();
}

void RoundedPath(Gdiplus::GraphicsPath* path, const Gdiplus::RectF& r,
                 float radius) {
  path->Reset();
  const float d = radius * 2;
  path->AddArc(r.X, r.Y, d, d, 180, 90);
  path->AddArc(r.X + r.Width - d, r.Y, d, d, 270, 90);
  path->AddArc(r.X + r.Width - d, r.Y + r.Height - d, d, d, 0, 90);
  path->AddArc(r.X, r.Y + r.Height - d, d, d, 90, 90);
  path->CloseFigure();
}

}  // namespace

DynamicIslandWindow* DynamicIslandWindow::hook_instance_ = nullptr;
HHOOK DynamicIslandWindow::wheel_hook_ = nullptr;

DynamicIslandWindow::DynamicIslandWindow() = default;

DynamicIslandWindow::~DynamicIslandWindow() { Destroy(); }

bool DynamicIslandWindow::IsVisible() const {
  return visible_ && !suppressed_by_fullscreen_;
}

bool DynamicIslandWindow::IsAlive() const {
  return window_handle_ != nullptr && IsWindow(window_handle_) != FALSE;
}

std::wstring DynamicIslandWindow::Utf8ToWide(const std::string& s) const {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

void DynamicIslandWindow::EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = DynamicIslandWindow::WndProc;
  wc.hInstance = GetModuleHandle(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_HAND);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = kClassName;
  RegisterClassExW(&wc);
  registered = true;
}

bool DynamicIslandWindow::Create() {
  EnsureGdiplusIsland();
  if (window_handle_ != nullptr) {
    if (IsWindow(window_handle_)) return true;
    // 悬空句柄：窗口曾被外部销毁而成员未同步，归零后走重建（自愈）。
    IslandLifecycleLog(window_handle_, L"create-stale-handle");
    window_handle_ = nullptr;
  }
  EnsureClassRegistered();
  const DWORD ex_style =
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  window_handle_ = CreateWindowExW(
      ex_style, kClassName, L"", WS_POPUP, 0, 0, S(kWindowW), S(kWindowH),
      nullptr, nullptr, GetModuleHandle(nullptr), this);
  if (window_handle_ == nullptr) return false;
  IslandLifecycleLog(window_handle_, L"created");
  const UINT dpi = GetDpiForWindow(window_handle_);
  if (dpi != 0) dpi_scale_ = static_cast<double>(dpi) / USER_DEFAULT_SCREEN_DPI;
  // Create 即落屏（PositionAtTopCenter 带 SWP_SHOWWINDOW），标志必须对齐
  // 真实状态——否则全屏抑制的恢复分支被 visible_=false 卡死：忙碌结束后
  // 岛再也不出现（2026-09-28「灵动岛自己消失」终局根因）。
  // 先置位再定位：定位是否附带 SWP_SHOWWINDOW 以 visible_/抑制态为前提。
  visible_ = true;
  PositionAtTopCenter();
  Render();
  // 动画心跳随即启动：待机呼吸灯依赖它。
  // （真实数据版待机不再有 present/Show 调用，若不在此启动则呼吸冻结。）
  StartAnimTimer();
  // 全屏抑制检查走独立常开心跳（kSuppressTimerId）：busy 分支会停动画心跳，
  // 恢复检查必须独立存活，否则退出全屏后岛再也不出现。
  SetTimer(window_handle_, kSuppressTimerId, 2000, nullptr);
  // 顶边唤出探针（kPeekTimerId）：抑制期间鼠标贴屏幕顶边临时唤回岛。
  SetTimer(window_handle_, kPeekTimerId, 200, nullptr);
  // 创建/重建瞬间就可能已经处在全屏应用里（游戏内自愈重建、开机自启）：
  // 立即复核一次，别让岛在游戏画面上挂到下一跳。
  UpdateFullscreenSuppression();
  return true;
}

void DynamicIslandWindow::Destroy() {
  if (window_handle_ == nullptr) return;
  DestroyWindow(window_handle_);
  window_handle_ = nullptr;
}

void DynamicIslandWindow::PositionAtTopCenter() {
  RECT wa = {};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0)) {
    wa = {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
  }
  const int w = S(kWindowW);
  const int h = S(kWindowH);
  const int x = wa.left + ((wa.right - wa.left) - w) / 2;
  const int y = wa.top;
  UINT flags = SWP_NOACTIVATE;
  // 抑制期间（或 Dart 已把岛藏起时）绝不借定位露头：显示模式切换 / DPI 变化
  // 都会走到这里，SWP_SHOWWINDOW 曾把已让位的岛重新弹到全屏游戏画面之上，
  // 而抑制标志没变、下一跳直接早退，岛就再也收不回去（2026-10-25 根因）。
  // peek 唤出是唯一例外（用户主动贴顶边要岛）。
  if (peek_active_ || (visible_ && !suppressed_by_fullscreen_)) {
    flags |= SWP_SHOWWINDOW;
  }
  SetWindowPos(window_handle_, HWND_TOPMOST, x, y, w, h, flags);
}

void DynamicIslandWindow::Show() {
  visible_ = true;
  if (window_handle_ == nullptr) {
    Create();
    return;
  }
  if (!suppressed_by_fullscreen_) {
    PositionAtTopCenter();
    ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
  }
  StartAnimTimer();
}

void DynamicIslandWindow::Hide() {
  visible_ = false;
  hovering_ = false;
  UpdateWheelHook();
  if (window_handle_ != nullptr) {
    ShowWindow(window_handle_, SW_HIDE);
  }
  StopAnimTimer();
}

void DynamicIslandWindow::SetEntry(const Entry& entry) {
  entry_ = entry;
  has_entry_ = !entry.title.empty();
  if (window_handle_ != nullptr) {
    Render();
    if (has_entry_ && !IsVisible()) Show();
  }
}

void DynamicIslandWindow::ClearEntry() {
  // attention 进行中的临时条目不许被外部清：30s 日程 ticker 会推 clearEntry
  // 把它抹掉，胶囊缩回 108px 待机光球档再放大——「放大态变 1/4 大小」根因。
  // 临时条目由 attention 时间线走完时自清（见 Render 复位点）。
  if (attention_start_s_ >= 0 && entry_.id == "attention") return;
  has_entry_ = false;
  entry_ = Entry{};
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetAgenda(std::vector<AgendaItem> items) {
  agenda_ = std::move(items);
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetAmbient(int unread_count, bool agent_active,
                                     const std::string& agent_status) {
  ambient_unread_ = unread_count;
  agent_active_ = agent_active;
  agent_status_ = agent_status;
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetAgentSteps(std::vector<AgentStep> steps) {
  if (steps.size() > static_cast<size_t>(kMaxSteps)) {
    steps.erase(steps.begin(), steps.end() - kMaxSteps);
  }
  agent_steps_ = std::move(steps);
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetUnreadPreview(std::vector<UnreadItem> rows) {
  if (rows.size() > static_cast<size_t>(kMaxUnreadRows)) {
    rows.erase(rows.begin(), rows.end() - kMaxUnreadRows);
  }
  unread_rows_ = std::move(rows);
  if (window_handle_ != nullptr) Render();
}

void DynamicIslandWindow::SetVoiceTalkMode(bool enabled) {
  // 纯语音模式标志：对话全语音（免点击），这里只负责悬停自动 glance。
  if (voice_talk_mode_ == enabled) return;
  voice_talk_mode_ = enabled;
  if (window_handle_ != nullptr) Render();
}

// ── 三级形变（eisland islandTransition 思路）──

double DynamicIslandWindow::TargetLevel() const {
  switch (stage_target_) {
    case Stage::kExpanded: return 2.0;
    case Stage::kHover: return 1.0;
    case Stage::kCompact: return 0.0;
  }
  return 0.0;
}

// 形变时长随目标距离查表：hover 档过渡轻快，跨两级（胶囊⇄展开）稍缓。
double DynamicIslandWindow::MorphDurationFor(double from_level,
                                             double to_level) {
  const double d = std::abs(to_level - from_level);
  if (d <= 0.01) return 0.16;
  if (d <= 1.0) return 0.16 + 0.10 * d;   // 邻级：≤0.26s
  return 0.26 + 0.20 * (d - 1.0);         // 跨级：≤0.46s
}

void DynamicIslandWindow::SetStage(Stage stage) {
  if (stage_target_ == stage) return;
  morph_from_ = morph_;
  stage_target_ = stage;
  morph_duration_s_ = MorphDurationFor(morph_from_, TargetLevel());
  morph_start_s_ = now_s_;
  morph_active_ = true;
  if (stage == Stage::kHover) hover_tab_ = HoverTab::kToday;
  // 滚轮钩子的挂载条件含 stage——点击进 hover 后光标可能不再移动，
  // 不 here 补挂的话首次滚轮会丢失（WM_MOUSEMOVE 不会再来）。
  UpdateWheelHook();
  if (window_handle_ != nullptr) StartAnimTimer();
}

void DynamicIslandWindow::SetExpanded(bool expanded) {
  if (!expanded) {
    // Dart 侧不知道 hover 这个原生中间态（原生点击 compact→hover 不上报），
    // 这里只负责「从展开卡退场」；若岛在 hover 态收到同步 false，保持不动，
    // 否则任意一次控制器通知都会把用户的 hover 态拽回胶囊（镜像打架）。
    if (stage_target_ == Stage::kExpanded) SetStage(Stage::kCompact);
    return;
  }
  SetStage(Stage::kExpanded);
}

void DynamicIslandWindow::StartAttention(const std::string& title,
                                         const std::string& trailing,
                                         double hold_s, bool urgent) {
  // 全屏打断白名单（2026-10-13 定调）：只有「需要立马知道」的事（外卖等
  // 高优消息、日程到点）可在全屏/忙碌时破屏展报；非紧急档（预告/普通
  // 消息）在抑制中整体跳过——不响铃、不上屏、不注入条目。
  attention_urgent_ = urgent;
  if (!urgent) {
    // 2s 心跳可能滞后：跳过判定前直推一次抑制检查（幂等）。
    UpdateFullscreenSuppression();
    if (suppressed_by_fullscreen_) return;
  }
  PlayAttentionChime();
  attention_title_ = Utf8ToWide(title);
  attention_trailing_ = Utf8ToWide(trailing);
  attention_hold_s_ = hold_s > 0 ? hold_s : kAttnHoldS;
  // 展开态来提醒：瞬时收起（不播收缩动画），attention 恒以小胶囊为基准。
  if (stage_target_ != Stage::kCompact) {
    stage_target_ = Stage::kCompact;
    morph_ = 0.0;
    morph_from_ = 0.0;
    morph_start_s_ = now_s_ - 1.0;
    morph_active_ = false;
  }
  // 提醒豁免全屏抑制：抑制中上提醒立即唤回（busy 已被 attention_active
  // 豁免，恢复分支重新 ShowWindow+定位），不等 2s 心跳。
  if (suppressed_by_fullscreen_) {
    UpdateFullscreenSuppression();
    // now_s_ 冻结在抑制前而时间轴连续——就地重算。attention 保持期必须
    // 从「可见」起算，否则抑制期间消耗的秒数吃掉 hold（预告档 6s 唤回
    // 时会只剩 1s）。
    now_s_ = static_cast<double>(GetTickCount64() - anim_epoch_ms_) / 1000.0;
  }
  attention_start_s_ = now_s_;
  // 宽度自适应（2026-10-07）：按本次提醒文本实测取档，attention 激活
  // 期间 CompactWidth 以此为准（含覆盖在常规条目上的情况）。
  attention_capsule_w_ = MeasureAttentionCapsuleW(attention_title_,
                                                  attention_trailing_);
  // 待机态来提醒：注入临时条目让胶囊有内容可显（结束由 Dart 侧收口）。
  if (!has_entry_ && !attention_title_.empty()) {
    Entry e;
    e.id = "attention";
    e.title = title;
    e.trailing = trailing;
    e.kind = Kind::kSchedule;
    entry_ = e;
    has_entry_ = true;
  }
  if (window_handle_ != nullptr) {
    if (!IsVisible()) Show();
    StartAnimTimer();
  }
}

// attention 胶囊宽度自适应（2026-10-07 定调：预告标题+说明全展示，
// 宽度随文本伸缩；上限防撑爆）。与渲染端头部行排版同构：
// pad*2 + 图标块 + 标题 + 8s 间隔 (+ 尾注)，钳位 [最小档, 上限]。
// 返回逻辑 px；测量失败回落 kAttentionCapsuleW（行为同旧固定档）。
int DynamicIslandWindow::MeasureAttentionCapsuleW(
    const std::wstring& title, const std::wstring& trailing) const {
  EnsureGdiplusIsland();
  HDC hdc = GetDC(window_handle_ != nullptr ? window_handle_ : nullptr);
  if (hdc == nullptr) return kAttentionCapsuleW;
  int result = kAttentionCapsuleW;
  do {
    const float s = static_cast<float>(dpi_scale_);
    Gdiplus::Graphics g(hdc);
    Gdiplus::Font icon_font(hdc, MakeIslandGlyphFont(S(15)));
    Gdiplus::Font title_font(hdc, MakeIslandFont(S(18), 650));
    Gdiplus::Font trail_font(hdc, MakeIslandFont(S(15), 650));
    Gdiplus::RectF m_icon, m_title, m_trail;
    if (g.MeasureString(KindGlyph(Kind::kSchedule), -1, &icon_font,
                        Gdiplus::PointF(0, 0), &m_icon) != Gdiplus::Ok) {
      break;
    }
    if (g.MeasureString(title.c_str(), -1, &title_font,
                        Gdiplus::PointF(0, 0), &m_title) != Gdiplus::Ok) {
      break;
    }
    float trail_w = 0.0f;
    if (!trailing.empty() &&
        g.MeasureString(trailing.c_str(), -1, &trail_font,
                        Gdiplus::PointF(0, 0), &m_trail) == Gdiplus::Ok) {
      trail_w = m_trail.Width;
    }
    const float pad_x = 14.0f * s;
    const float gap = 7.0f * s;
    const float title_gap = 8.0f * s;
    const float icon_block = m_icon.Width + gap;
    // 8 逻辑 px 安全余量：测量值落库取整（+0.5f 截断）会丢亚像素零头，渲染端
    // title_cap 由本值反推，零头为负时 FitText 把末字符换成省略号——用户看到的
    // 是「…吃饭」而非全部内容（2026-10-21 实证根修）。渲染端叠画图标块均不宽于
    // 此处实测的 kSchedule 字形，余量同时覆盖该偏差。
    const float fit_slack = 8.0f * s;
    const float needed =
        pad_x * 2.0f + icon_block + m_title.Width + title_gap + trail_w +
        fit_slack;
    const int logical =
        static_cast<int>(needed / dpi_scale_ + 0.5f);
    result = std::clamp(logical, kAttentionCapsuleW, kAttentionMaxCapsuleW);
  } while (false);
  ReleaseDC(window_handle_ != nullptr ? window_handle_ : nullptr, hdc);
  return result;
}

// attention 时间线：放大入(easeOutBack) -> 保持高亮脉冲 -> 缩回。
// 返回当前缩放；attention 未激活/已结束返回 1。
double DynamicIslandWindow::AttentionScale() const {
  if (attention_start_s_ < 0) return 1.0;
  const double t = now_s_ - attention_start_s_;
  if (t < 0) return 1.0;
  if (t < kAttnInS) {
    const double x = t / kAttnInS;
    // easeOutBack：略微过冲再回弹，强调「看这里」
    const double c1 = 1.70158;
    const double c3 = c1 + 1;
    const double e = 1 + c3 * std::pow(x - 1, 3) + c1 * std::pow(x - 1, 2);
    return 1.0 + (kAttentionScale - 1.0) * e;
  }
  if (t < kAttnInS + attention_hold_s_) return kAttentionScale;
  if (t < kAttnInS + attention_hold_s_ + kAttnOutS) {
    const double x = (t - kAttnInS - attention_hold_s_) / kAttnOutS;
    return kAttentionScale + (1.0 - kAttentionScale) * EaseOutCubic(x);
  }
  return 1.0;  // 已结束（调用方负责清 attention_start_s_）
}

void DynamicIslandWindow::SetDpiScale(double scale) {
  if (scale <= 0.1 || scale >= 10.0 || scale == dpi_scale_) return;
  dpi_scale_ = scale;
  if (window_handle_ != nullptr) {
    PositionAtTopCenter();
    Render();
    UpdateFullscreenSuppression();
  }
}

void DynamicIslandWindow::StartAnimTimer() {
  if (window_handle_ == nullptr || anim_timer_on_) return;
  anim_timer_on_ = true;
  // epoch 只在首次赋值：抑制唤回（SW_HIDE+StopAnimTimer→再启）若重置
  // epoch，now_s_ 时间轴清零，attention_start_s_/morph_start_s_ 这些旧轴
  // 锚点全部错位——全屏提醒先 t<0 不播、再延迟开演、hold 完才复位，
  // 「提醒播完不消失」即此根因。
  if (anim_epoch_ms_ == 0) anim_epoch_ms_ = GetTickCount64();
  SetTimer(window_handle_, 1, 16, nullptr);
}

void DynamicIslandWindow::StopAnimTimer() {
  if (!anim_timer_on_) return;
  anim_timer_on_ = false;
  if (window_handle_ != nullptr) KillTimer(window_handle_, 1);
}

void DynamicIslandWindow::UpdateAnimations() {
  const ULONGLONG now = GetTickCount64();
  now_s_ = static_cast<double>(now - anim_epoch_ms_) / 1000.0;
  // 从形变起点电平向目标（0/1/2）插值；时长走完后精确停在目标并解除
  // 形变保护，避免起点过期后 morph 漂移（曾致所有胶囊被画成展开卡尺寸）。
  const double target = TargetLevel();
  const double raw = Clamp01((now_s_ - morph_start_s_) / morph_duration_s_);
  morph_ = morph_from_ + (target - morph_from_) * EaseOutCubic(raw);
  if (raw >= 1.0) morph_active_ = false;
  if (window_handle_ != nullptr) Render();
}

// Dart 看门狗兜底入口：直推一次抑制检查。本机实证（2026-10-01）：岛在
// 全屏游戏期间创建后，原生 WM_TIMER 心跳会永久停摆（75 分钟零心跳），
// 退出全屏后恢复分支再无人执行——岛卡死隐藏。看门狗每 15s 直推本方法，
// 保证退出全屏 ≤15s 内必然恢复。
void DynamicIslandWindow::CheckSuppression() {
  UpdateFullscreenSuppression();
}

// 取 |hwnd| 所属进程的 exe 全路径（失败回 "?"），仅供取证日志。
void ExeNameOfWindow(HWND hwnd, wchar_t* buf, size_t cch) {
  buf[0] = L'?';
  buf[1] = L'\0';
  DWORD pid = 0;
  if (hwnd == nullptr || !IsWindow(hwnd) ||
      GetWindowThreadProcessId(hwnd, &pid) == 0 || pid == 0)
    return;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (h == nullptr) return;
  DWORD size = static_cast<DWORD>(cch);
  if (QueryFullProcessImageNameW(h, 0, buf, &size) == FALSE) buf[0] = L'?';
  CloseHandle(h);
}

// suppress-on 取证：记录触发让位时刻「压在岛上面的窗口」与前台窗口的进程
// exe 名（仅抑制转向瞬间打一条，零稳态开销）。cov=? 表示这次让位不是窗口
// 几何触发的（D3D 全屏 / 放映模式 / QUNS 忙碌）。录屏豁免名单再遇漏网工具
// 时，日志直接给出增补依据。
void LogSuppressSource(HWND covering, bool fg_fullscreen, int quns_state) {
  wchar_t cov[MAX_PATH] = L"?";
  wchar_t fg[MAX_PATH] = L"?";
  ExeNameOfWindow(covering, cov, MAX_PATH);
  ExeNameOfWindow(GetForegroundWindow(), fg, MAX_PATH);
  wchar_t line[MAX_PATH * 2 + 64];
  _snwprintf_s(line, _countof(line), _TRUNCATE,
               L"suppress-on cov=%ls fg=%ls fill=%d quns=%d", cov, fg,
               fg_fullscreen ? 1 : 0, quns_state);
  IslandLifecycleLog(nullptr, line);
}

// 由 kSuppressTimerId 常开心跳驱动（与动画心跳无关，窗口存活期间一直跑）。
// 注意：窗口定时器随窗口同死——窗口被销毁后本心跳也随之消失，
// 「窗口失活后的重建」由 Dart 侧看门狗（周期 ping）负责，不在这里。
// 录屏豁免命中时（IsScreenRecordingActive，规则见上文「录屏豁免」段）
// 豁免三种忙碌态，忙碌判定本身不变：录制一停，全屏/忙碌仍照常抑制。
// 提醒豁免（2026-10-05 拍板，2026-10-13 收紧）：仅 urgent attention 进行中
// 即使全屏也上屏——「现在不看会错过」的唯一强打断态（外卖等高优消息、
// 日程到点）；非紧急档在抑制中由 StartAttention 整体跳过。urgent attention
// 播完/点击收口后由各结束点回推一次本函数立即让位，心跳 2s 兜底。
void DynamicIslandWindow::UpdateFullscreenSuppression() {
  // QUNS 只是三条独立证据之一，查询失败（独占全屏 / DWM 合成关闭时 shell
  // 偶尔给不出状态）绝不能连几何判定一起丢——旧代码直接 return，那一刻
  // 起岛就再没人管了。
  QUERY_USER_NOTIFICATION_STATE state = QUNS_ACCEPTS_NOTIFICATIONS;
  const bool state_ok = SUCCEEDED(SHQueryUserNotificationState(&state));
  std::wstring recorder;
  const bool recording = IsScreenRecordingActive(&recorder);
  // 录屏豁免命中/解除各打一条：豁免误命中会把全屏抑制永久关掉，日志要能
  // 直接指认是哪个进程（2026-10-25 取证）。
  static bool rec_prev = false;
  if (recording != rec_prev) {
    rec_prev = recording;
    if (recording) {
      wchar_t rec_line[96];
      _snwprintf_s(rec_line, _countof(rec_line), _TRUNCATE,
                   L"rec-on exe=%ls", recorder.c_str());
      IslandLifecycleLog(nullptr, rec_line);
    } else {
      IslandLifecycleLog(nullptr, L"rec-off");
    }
  }
  // 提醒豁免收紧（2026-10-13 定调）：只有 urgent attention（外卖等高优
  // 消息、日程到点）可豁免全屏抑制；非紧急档由 StartAttention 在抑制中
  // 整体跳过，不破屏。
  const bool attention_active = attention_start_s_ >= 0 && attention_urgent_;
  // 压在岛上面的窗口与全屏同权：盖住岛就让位（2026-10-09 拍板最大化让位，
  // 自家主窗口一视同仁；2026-10-23 根修：判定对象换成 Z 序命中岛形的那个
  // 窗口，不再盯前台）——否则待机光球悬浮遮挡应用顶部内容。
  const HWND covering = CoveringFullscreenWindow();
  const bool covered = covering != nullptr;
  // 前台全屏是独立第二条证据：全屏窗之上再挂小浮层时 Z 序探测可能被挡，
  // 但前台仍是那个全屏应用（独占全屏游戏最典型）。
  const bool fg_fullscreen = IsForegroundFullscreenApp();
  const bool quns_busy =
      state_ok && (state == QUNS_RUNNING_D3D_FULL_SCREEN ||
                   state == QUNS_PRESENTATION_MODE || state == QUNS_BUSY);
  const bool busy = !recording && !attention_active &&
                    (covered || fg_fullscreen || quns_busy);
  // 取证日志：每 ~150s 一次心跳证明本心跳活着；转向时必记（含 visible_ 快照）。
  static int tick_count = 0;
  const bool heartbeat = (++tick_count % 75) == 1;
  if (heartbeat) {
    wchar_t hb[200];
    _snwprintf_s(
        hb, _countof(hb), _TRUNCATE,
        L"suppress-tick busy=%d rec=%d cov=%d fill=%d quns=%d suppressed=%d "
        L"visible=%d winvis=%d",
        busy ? 1 : 0, recording ? 1 : 0, covered ? 1 : 0,
        fg_fullscreen ? 1 : 0, quns_busy ? 1 : 0,
        suppressed_by_fullscreen_ ? 1 : 0, visible_ ? 1 : 0,
        (window_handle_ != nullptr && IsWindowVisible(window_handle_)) ? 1 : 0);
    IslandLifecycleLog(window_handle_, hb);
  }
  if (busy == suppressed_by_fullscreen_) {
    // 标志没变不代表窗口没被露出来：定位（显示模式/DPI 切换）、重建、
    // 外部 ShowWindow 都可能在抑制期间把岛重新弹回全屏画面之上，而旧代码
    // 到这里直接早退，永远收不回去（2026-10-25 独占全屏游戏根因）。
    // 每跳强制兜底隐藏；peek 是用户主动唤出，免收。
    if (busy && window_handle_ != nullptr && !peek_active_) {
      if (IsWindowVisible(window_handle_)) {
        IslandLifecycleLog(window_handle_, L"suppress-enforce-hide");
        ShowWindow(window_handle_, SW_HIDE);
      }
      StopAnimTimer();
    }
    return;
  }
  if (busy) {
    LogSuppressSource(covering, fg_fullscreen, state_ok ? state : 0);
  } else {
    IslandLifecycleLog(window_handle_, L"suppress-off");
  }
  suppressed_by_fullscreen_ = busy;
  if (window_handle_ == nullptr) return;
  if (busy) {
    peek_active_ = false;  // 抑制开始：顶边唤出态一并收回
    ShowWindow(window_handle_, SW_HIDE);
    StopAnimTimer();
  } else if (visible_) {
    peek_active_ = false;  // 抑制解除：回到常驻显示，探针退位
    PositionAtTopCenter();
    ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
    StartAnimTimer();
  }
}

// Z 序自顶向下走顶层窗口，返回第一个「盖住岛形中心且呈全屏形态」的真实
// 应用窗口。
// 2026-10-23 根修的核心：旧判定拿 GetForegroundWindow() 当「岛上面是谁」，
// 底部一个 F11 全屏页 + 上面再开一个非全屏小应用，前台一换人判定就翻 false，
// 岛在全屏体验里复活。按 Z 序命中就不受前台归属影响：岛这块像素下面还是全屏
// 页 → 继续让位；用户把普通窗口挪到岛上面 → 才恢复显示。
// 走 GetWindow 链（桌面窗口的 GW_CHILD 是 Z 序最顶，GW_HWNDNEXT 依次向下，
// 这是唯一有 Z 序保证的走法；EnumWindows 的顺序不作保证）。
// 探测点取岛形中心：全屏页之上叠一个只盖住岛一侧的小窗时，中心仍落在全屏页
// 上，判定保持让位——与用户诉求同向（宁可少弹，不可打断全屏）。
// 判定失败一律返回 nullptr（宁可多显示，不可误隐藏）。
HWND DynamicIslandWindow::CoveringFullscreenWindow() const {
  if (window_handle_ == nullptr) return nullptr;
  const RECT island = IslandScreenRect();
  if (island.right <= island.left || island.bottom <= island.top) return nullptr;
  const POINT probe = {(island.left + island.right) / 2,
                       (island.top + island.bottom) / 2};
  for (HWND w = GetWindow(GetDesktopWindow(), GW_CHILD); w != nullptr;
       w = GetWindow(w, GW_HWNDNEXT)) {
    RECT rc = {};
    if (!GetWindowRect(w, &rc)) continue;
    if (!IsCoverCandidate(w, window_handle_, rc)) continue;
    if (PtInRect(&rc, probe) == FALSE) continue;
    // 2026-10-25：不再「命中第一个窗口就收手」。游戏/播放器常在全屏窗之上
    // 再挂一个很小的顶层浮层（提示条、输入窗、叠加控件），旧逻辑命中浮层后
    // 判它不是全屏就翻 false，岛在全屏里复活。继续往下走，任一层盖住岛心
    // 且呈全屏形态就让位。
    if (IsZoomed(w) || WindowFillsIslandMonitor(w)) return w;
  }
  return nullptr;
}

// |hwnd| 是否铺满岛所在显示器（含任务栏区）。多显示器下按岛所在那块取界：
// 副屏的全屏窗口不盖岛屏就不触发。
bool DynamicIslandWindow::WindowFillsIslandMonitor(HWND hwnd) const {
  RECT fr = {};
  if (!GetWindowRect(hwnd, &fr)) return false;
  const HMONITOR mon =
      MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {};
  mi.cbSize = sizeof(mi);
  if (!GetMonitorInfoW(mon, &mi)) return false;
  constexpr int kSlack = 8;  // DWM 隐形边框 / 取整容差
  return fr.left <= mi.rcMonitor.left + kSlack &&
         fr.top <= mi.rcMonitor.top + kSlack &&
         fr.right >= mi.rcMonitor.right - kSlack &&
         fr.bottom >= mi.rcMonitor.bottom - kSlack;
}

// 岛这块像素是否被「全屏形态」的应用占着（2026-10-14 两条路径原样保留，
// 只是判定对象从「前台窗口」换成「Z 序里盖住岛心且全屏形态的窗口」）：
//   1) 最大化（IsZoomed）——命中岛形中心即视为盖岛；
//   2) 无边框全屏——铺满岛所在显示器（浏览器 F11 / 无边框游戏既非 IsZoomed，
//      shell 的 QUNS_BUSY 启发式对这类窗口也时灵时不灵）。
bool DynamicIslandWindow::IsIslandCoveredByApp() const {
  return CoveringFullscreenWindow() != nullptr;
}

// 前台窗口自身的全屏判定（与 Z 序探测互相独立）：独占全屏游戏/播放器之上
// 常挂着自家小浮层，Z 序探测有可能被挡在前面；而「谁在前台」是系统给的
// 确定答案，全屏应用在前台时岛必然被盖住。最大化按老规则只认盖住岛心的
// （多显示器下副屏的最大化窗口不误伤）。
bool DynamicIslandWindow::IsForegroundFullscreenApp() const {
  const HWND fg = GetForegroundWindow();
  if (fg == nullptr || fg == window_handle_ || !IsWindowVisible(fg)) {
    return false;
  }
  const LONG_PTR ex = GetWindowLongPtrW(fg, GWL_EXSTYLE);
  if (ex & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)) return false;
  if (IsShellLayerWindow(fg) || IsDwmCloaked(fg)) return false;
  if (IsZoomed(fg)) {
    const RECT island = IslandScreenRect();
    if (island.right <= island.left || island.bottom <= island.top) {
      return false;
    }
    RECT fr = {};
    if (!GetWindowRect(fg, &fr)) return false;
    const POINT probe = {(island.left + island.right) / 2,
                         (island.top + island.bottom) / 2};
    return PtInRect(&fr, probe) != FALSE;
  }
  return WindowFillsIslandMonitor(fg);
}

// 顶边唤出探针（kPeekTimerId 200ms，窗口存活期间常开）：
// 抑制期间鼠标贴主屏顶边（工作区顶部 ≤3px）→ 临时浮现。不改
// suppressed_by_fullscreen_ 标志——peek 只是视觉临时放行，收回零成本；
// attention 不走 peek：它有自己的豁免与唤回链路（StartAttention）。
// 收回条件：离开顶边且不在岛上（0.5s 宽限，容忍顶边→岛的移动间隙）。
void DynamicIslandWindow::UpdateTopEdgePeek() {
  if (window_handle_ == nullptr) return;
  if (!suppressed_by_fullscreen_) {
    peek_active_ = false;
    return;
  }
  if (attention_start_s_ >= 0) return;
  RECT wa = {};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0)) return;
  POINT p = {};
  if (!GetCursorPos(&p)) return;
  const bool in_zone = p.y >= wa.top && p.y <= wa.top + 3 &&
                       p.x >= wa.left && p.x < wa.right;
  const ULONGLONG now = GetTickCount64();
  if (in_zone || hovering_) peek_last_in_zone_ms_ = now;
  if (!peek_active_) {
    if (!in_zone) return;
    peek_active_ = true;
    PositionAtTopCenter();
    ShowWindow(window_handle_, SW_SHOWNOACTIVATE);
    StartAnimTimer();
    IslandLifecycleLog(window_handle_, L"peek-on");
    return;
  }
  if (!in_zone && !hovering_ && now - peek_last_in_zone_ms_ > 500) {
    peek_active_ = false;
    if (stage_target_ != Stage::kCompact) SetStage(Stage::kCompact);
    ShowWindow(window_handle_, SW_HIDE);
    StopAnimTimer();
    hovering_ = false;
    UpdateWheelHook();
    IslandLifecycleLog(window_handle_, L"peek-off");
  }
}

// ── 声明尺寸档（islandTransition 思路）：每种状态一个设计好的尺寸 ──
// 胶囊宽不按文案实时测量，杜绝文案长短引起的大小抖动；超档文案渲染时
// 截断加省略号。例外：attention 提醒档按文本实测自适应（2026-10-07 定调，
// 预告内容全展示），见 MeasureAttentionCapsuleW / CompactWidth。

int DynamicIslandWindow::CompactWidthFor(Kind kind) const {
  switch (kind) {
    case Kind::kTask: return 200;      // 「后台任务进行中」+ 活点
    case Kind::kUpdate: return 200;    // 「更新下载中 64%」+ 进度线
    case Kind::kSchedule: return 230;  // 「设计评审 · 25 分钟后」
    case Kind::kInbox: return 200;     // 「站内信 · 3 条未读」
    case Kind::kVoice: return 210;     // 「等待唤醒 · 说「小助手」」
  }
  return 200;
}

int DynamicIslandWindow::CompactWidth() const {
  if (!has_entry_) return kRestCapsuleW;
  // attention 宽度自适应（2026-10-07 定调：预告内容全展示）：attention
  // 激活期间（含覆盖在常规条目上）以实测提醒文本宽为准，播完回落声明档。
  if (attention_capsule_w_ > 0 &&
      (attention_start_s_ >= 0 || entry_.id == "attention")) {
    return attention_capsule_w_;
  }
  // attention 提醒走独立小胶囊档（用户拍板：提醒=小形态，不用 kSchedule 的 230 档）
  if (entry_.id == "attention") return kAttentionCapsuleW;
  return CompactWidthFor(entry_.kind);
}

int DynamicIslandWindow::ExpandedHeight() const {
  const int rows = std::clamp(static_cast<int>(agenda_.size()), 0, kMaxRows);
  int h = 30 + 12 + 20 + rows * kRowH + (rows > 0 ? 6 : 0);
  if (rows == 0) h += kRowH;  // 空态「今日无日程」占位行
  const int step_rows =
      std::min(static_cast<int>(agent_steps_.size()), kMaxSteps);
  if (step_rows > 0) h += 6 + 20 + step_rows * kStepRowH + 4;
  const int unread_rows =
      std::min(static_cast<int>(unread_rows_.size()), kMaxUnreadRows);
  if (unread_rows > 0) h += 6 + 20 + unread_rows * kUnreadRowH + 4;
  return h + 10;
}

void DynamicIslandWindow::StageLerpSize(double level, double* w, double* h,
                                        double* radius) const {
  const double lv = std::max(0.0, std::min(2.0, level));
  // 端点均为声明档：compact（按当前条目档）→ hover → expanded。
  const double cw = CompactWidth();
  const double ch = static_cast<double>(kCapsuleH);
  const double cr = 15.0;
  const double hw = static_cast<double>(kHoverW);
  const double hh = static_cast<double>(kHoverH);
  const double hr = static_cast<double>(kHoverH) / 2.0;  // 胶囊圆角
  const double ew = static_cast<double>(kExpandedW);
  const double eh = static_cast<double>(ExpandedHeight());
  const double er = 26.0;
  if (lv <= 1.0) {
    *w = cw + (hw - cw) * lv;
    *h = ch + (hh - ch) * lv;
    *radius = cr + (hr - cr) * lv;
  } else {
    const double t = lv - 1.0;
    *w = hw + (ew - hw) * t;
    *h = hh + (eh - hh) * t;
    *radius = hr + (er - hr) * t;
  }
}

RECT DynamicIslandWindow::IslandScreenRect() const {
  RECT rc = {};
  if (window_handle_ == nullptr) return rc;
  double lw = 0, lh = 0, lr = 0;
  StageLerpSize(morph_, &lw, &lh, &lr);
  RECT wr;
  if (!GetWindowRect(window_handle_, &wr)) return rc;
  const int w = S(static_cast<int>(lw + 0.5));
  const int h = S(static_cast<int>(lh + 0.5));
  const int left = wr.left + (S(kWindowW) - w) / 2;
  const int top = wr.top + S(kTopMargin);
  rc = {left, top, left + w, top + h};
  return rc;
}

// ── hover 态滚轮：低级鼠标钩子 ──
// WS_EX_NOACTIVATE 窗口拿不到键盘焦点，收不到 WM_MOUSEWHEEL；
// 悬停期间挂 WH_MOUSE_LL 钩子，光标落在岛形内且处于 hover 态时
// 消费滚轮（切环境页 / 滚进展开态），其余一律放行。

void DynamicIslandWindow::UpdateWheelHook() {
  const bool want = hovering_ && window_handle_ != nullptr &&
                    stage_target_ != Stage::kCompact;
  if (want && wheel_hook_ == nullptr) {
    hook_instance_ = this;
    wheel_hook_ = SetWindowsHookExW(WH_MOUSE_LL, WheelHookProc,
                                    GetModuleHandle(nullptr), 0);
    if (wheel_hook_ == nullptr) hook_instance_ = nullptr;
  } else if (!want && wheel_hook_ != nullptr) {
    UnhookWindowsHookEx(wheel_hook_);
    wheel_hook_ = nullptr;
    hook_instance_ = nullptr;
  }
}

LRESULT CALLBACK DynamicIslandWindow::WheelHookProc(int code, WPARAM wparam,
                                                    LPARAM lparam) noexcept {
  if (code == HC_ACTION && hook_instance_ != nullptr &&
      wparam == WM_MOUSEWHEEL) {
    const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lparam);
    if (hook_instance_->ConsumeWheelAt(
            info->pt, static_cast<short>(HIWORD(info->mouseData)))) {
      return 1;  // 已消费，不传给下层窗口
    }
  }
  return CallNextHookEx(wheel_hook_, code, wparam, lparam);
}

bool DynamicIslandWindow::ConsumeWheelAt(const POINT& screen_pt, short delta) {
  if (window_handle_ == nullptr || IsMorphing() ||
      stage_target_ != Stage::kHover) {
    return false;
  }
  const RECT rc = IslandScreenRect();
  if (!PtInRect(&rc, screen_pt)) return false;
  // 钩子回调里只投递，滚动逻辑回到窗口消息循环执行（保持钩子轻快）。
  PostMessageW(window_handle_, kIslandWheelMsg, 0,
               static_cast<LPARAM>(static_cast<short>(delta)));
  return true;
}

void DynamicIslandWindow::OnWheelDelta(short delta) {
  if (IsMorphing() || stage_target_ != Stage::kHover) return;
  if (delta < 0) {
    // 下滚 = 下一个；滚过「任务」页即进展开态（零点击成本）。
    if (hover_tab_ == HoverTab::kToday) {
      hover_tab_ = HoverTab::kAgent;
      Render();
      return;
    }
    SetStage(Stage::kExpanded);
    FireEvent(EventType::kExpandedChanged, "true");
    return;
  }
  // 上滚 = 上一个，「今日」是头档。
  if (hover_tab_ == HoverTab::kAgent) {
    hover_tab_ = HoverTab::kToday;
    Render();
  }
}

// hover 态环境信息行：今日页 = 下一日程 · 未读数；任务页 = agent 状态。
// （日期已删，2026-10-26 用户拍板：任务栏右下角已有时钟，纯重复信息。）
std::wstring DynamicIslandWindow::BuildHoverLine() const {
  if (hover_tab_ == HoverTab::kAgent) {
    if (agent_active_) {
      std::wstring line = L"Agent";
      if (!agent_status_.empty()) line += L" · " + Utf8ToWide(agent_status_);
      return line;
    }
    std::wstring line = L"暂无进行中任务";
    if (ambient_unread_ > 0) {
      line += L" · " + std::to_wstring(ambient_unread_) + L" 未读";
    }
    return line;
  }
  std::wstring line;
  for (const AgendaItem& it : agenda_) {
    if (it.completed) continue;
    line = L"下一节 " + Utf8ToWide(it.time_text) + L" " +
           Utf8ToWide(it.title);
    break;
  }
  if (line.empty()) line = L"今日无日程";
  if (ambient_unread_ > 0) {
    line += L" · " + std::to_wstring(ambient_unread_) + L" 未读";
  }
  return line;
}

void DynamicIslandWindow::Render() {
  if (window_handle_ == nullptr) return;

  const int phys_w = S(kWindowW);
  const int phys_h = S(kWindowH);
  const float s = static_cast<float>(dpi_scale_);

  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);

  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = phys_w;
  bmi.bmiHeader.biHeight = -phys_h;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (dib == nullptr || bits == nullptr) {
    // GDI 资源临时枯竭兜底：跳过本帧，绝不能拿空位图往下画（越界读必崩）。
    DeleteDC(mem_dc);
    ReleaseDC(nullptr, screen_dc);
    return;
  }
  HBITMAP old_bmp = static_cast<HBITMAP>(SelectObject(mem_dc, dib));

  hover_dot_rects_.clear();

  {
    Gdiplus::Graphics g(mem_dc);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
    g.Clear(Gdiplus::Color(0, 0, 0, 0));

    // ── 胶囊几何：三级声明档之间连续变形（0 胶囊 / 1 hover / 2 展开）──
    double lw = 0, lh = 0, lr = 0;
    StageLerpSize(morph_, &lw, &lh, &lr);
    const float cur_w = static_cast<float>(lw) * s;
    const float cur_h = static_cast<float>(lh) * s;
    const float radius = static_cast<float>(lr) * s;
    // attention 缩放：提醒时刻整体放大（几何 + 内容统一经变换缩放）。
    // 2026-10-05 起 kAttentionScale=1.0（提醒=小胶囊形态），脉冲环闸门
    // 不能再看 att 数值——改按 attention 是否激活判定。
    double att = AttentionScale();
    bool attention_active = attention_start_s_ >= 0;
    if (attention_start_s_ >= 0 &&
        now_s_ - attention_start_s_ >
            kAttnInS + attention_hold_s_ + kAttnOutS) {
      attention_start_s_ = -1;  // 动画播完自动复位
      att = 1.0;
      attention_active = false;
      if (entry_.id == "attention") {
        // 临时条目随提醒结束退场（就地清，勿调 ClearEntry——本帧正在 Render，
        // 递归重入；且此处 attention 已复位，ClearEntry 的进行中守卫也不适用）。
        has_entry_ = false;
        entry_ = Entry{};
      }
      // 提醒结束立即让位：全屏环境仍在时回抑制态（幂等），不等下一跳。
      UpdateFullscreenSuppression();
    }
    // 基座几何（不含 attention）；attention 靠围绕胶囊中心的变换放大。
    const float cap_x = (phys_w - cur_w) / 2.0f;
    const float cap_y = static_cast<float>(S(kTopMargin));
    const float base_cx = cap_x + cur_w / 2.0f;
    const float base_cy = cap_y + cur_h / 2.0f;

    // attention 时整体放大后顶缘固定在 2px：反解放变换中心的 Y。
    // 顶缘映射 t = P + att*(cap_y - P)  =>  P = (t - att*cap_y)/(1-att)。
    float att_cy = base_cy;
    float att_top = cap_y;
    if (att > 1.0) {
      // 展开态底片过高时钳制缩放，保证放大后不越出窗口底。
      const float max_att =
          cur_h > 1.0f
              ? std::min(2.0f, (static_cast<float>(phys_h) - 4.0f) / cur_h)
              : 2.0f;
      if (att > max_att) att = max_att;
      att_top = 2.0f * s;
      att_cy = (att_top - static_cast<float>(att) * cap_y) /
               (1.0f - static_cast<float>(att));
    }

    // attention 变换：围绕（下移后的）中心放大，内容照常画在基座坐标。
    if (att != 1.0) {
      g.TranslateTransform(base_cx, att_cy);
      g.ScaleTransform(static_cast<float>(att), static_cast<float>(att));
      g.TranslateTransform(-base_cx, -att_cy);
    }

    Gdiplus::GraphicsPath cap_path;
    RoundedPath(&cap_path, Gdiplus::RectF(cap_x, cap_y, cur_w, cur_h), radius);

    // ── 沿边缘的细环光（呼吸灯 / attention 强脉冲共用画法）──
    // 贴着胶囊轮廓描三圈白环（内亮外淡、渐宽），随后不透明填充盖住
    // 每圈的内半，露出的部分就是精确沿轮廓的细光边（Apple 式 rim
    // light），不再是整片糊状光斑。描边受当前变换作用，attention
    // 放大时光环随之等比放大。
    auto drawRimRings = [&g, &cap_path, s](BYTE core_alpha) {
      const struct Ring {
        float width;      // 描边宽（逻辑 px）
        float alpha_scale;  // 相对核心 alpha
      } rings[] = {{3.0f, 1.0f}, {7.0f, 0.45f}, {13.0f, 0.18f}};
      for (const Ring& ring : rings) {
        Gdiplus::Pen pen(
            Gdiplus::Color(static_cast<BYTE>(core_alpha * ring.alpha_scale),
                           255, 255, 255),
            ring.width * s);
        g.DrawPath(&pen, &cap_path);
      }
    };

    if (attention_active) {
      // attention：强脉冲 rim（0.9s 周期）。
      const double pulse = 0.5 + 0.5 * std::sin(now_s_ * 6.2832 / 0.9);
      drawRimRings(static_cast<BYTE>(110 + 110 * pulse));
    } else if (morph_ < 0.3) {
      // 呼吸灯分档（仅 compact；hover/展开卡静态不呼吸）：
      // 待机 4s/30-70；任务进行中 2.8s/60-130；更新下载 3.5s/45-100；
      // 日程/简报/未读静态。
      double period = 0.0, a0 = 0.0, a1 = 0.0;
      if (!has_entry_) {
        period = 4.0; a0 = 30; a1 = 70;
      } else if (entry_.spinning) {
        period = 2.8; a0 = 60; a1 = 130;
      } else if (entry_.progress >= 0 && entry_.progress <= 1) {
        period = 3.5; a0 = 45; a1 = 100;
      }
      if (period > 0.0) {
        const double ph = 0.5 + 0.5 * std::sin(now_s_ * 6.2831853 / period);
        drawRimRings(static_cast<BYTE>(a0 + (a1 - a0) * ph));
      }
    }

    Gdiplus::SolidBrush cap_brush(Gdiplus::Color(255, 2, 2, 2));
    g.FillPath(&cap_brush, &cap_path);

    // 内容全部裁剪在胶囊内。
    g.SetClip(&cap_path);

    // 三段内容交叉淡化（渐进展开的梯子）：
    //   compact 内容 0→0.5 淡出；hover 内容仅在 [0.5,1.5] 区间可见；
    //   展开区 morph>1 淡入，展开卡头部行沿用 compact 内容（1→2 淡入）。
    const float mf = static_cast<float>(morph_);
    const float entry_alpha =
        std::max(1.0f - static_cast<float>(Clamp01(mf * 2.0f)),
                 static_cast<float>(Clamp01(mf - 1.0f)));
    const float hover_alpha =
        1.0f - static_cast<float>(Clamp01(std::abs(mf - 1.0f) * 2.0f));
    const BYTE ea = static_cast<BYTE>(entry_alpha * 255.0f + 0.5f);

    // ── 头部行（compact 内容 / 展开态保留为头部）──
    const float header_h = static_cast<float>(kCapsuleH) * s;
    const float header_cy = cap_y + header_h / 2.0f;

    if (ea > 5) {
      if (!has_entry_) {
        // 待机：金属球镜头 + 呼吸光。
        const float r = 5.0f * s * (1.0f - 0.25f * mf);
        const float cx = phys_w / 2.0f;
        const double breath = 0.5 + 0.5 * std::sin(now_s_ * 2.2439948);  // 2.8s 周期
        const float glow_r = r * (2.2f + 0.5f * static_cast<float>(breath));
        Gdiplus::GraphicsPath glow_path;
        glow_path.AddEllipse(cx - glow_r, header_cy - glow_r, glow_r * 2,
                             glow_r * 2);
        Gdiplus::PathGradientBrush glow_brush(&glow_path);
        glow_brush.SetCenterColor(Gdiplus::Color(
            static_cast<BYTE>((20 + 55 * breath) * ea / 255), 255, 255, 255));
        const Gdiplus::Color glow_surround(0, 255, 255, 255);
        INT sc = 1;
        glow_brush.SetSurroundColors(&glow_surround, &sc);
        g.FillPath(&glow_brush, &glow_path);

        Gdiplus::GraphicsPath sphere_path;
        sphere_path.AddEllipse(cx - r, header_cy - r, r * 2, r * 2);
        Gdiplus::PathGradientBrush sphere_brush(&sphere_path);
        sphere_brush.SetCenterPoint(
            Gdiplus::PointF(cx - r * 0.35f, header_cy - r * 0.4f));
        sphere_brush.SetCenterColor(Gdiplus::Color(ea, 244, 245, 247));
        const Gdiplus::Color sphere_surround(ea, 20, 21, 25);
        sphere_brush.SetSurroundColors(&sphere_surround, &sc);
        g.FillPath(&sphere_brush, &sphere_path);

        Gdiplus::SolidBrush hl(Gdiplus::Color(ea * 150 / 255, 255, 255, 255));
        g.FillEllipse(&hl, cx - r * 0.55f, header_cy - r * 0.62f, r * 0.5f,
                      r * 0.42f);
      } else {
        // 内容头部：图标 + 标题 + 尾注/活点，整体在头部行居中。
        // attention 提醒期间胶囊内容整体让位给提醒文案：标题切换为提醒
        // 标题，尾注同步取提醒尾注（空即不显示——条目旧尾注如「25 分钟后」
        // 会与提醒标题里的时间信息重复/过期，2026-10-07 随宽度自适应一并收口）。
        std::wstring title =
            attention_start_s_ >= 0 && !attention_title_.empty()
                ? attention_title_
                : Utf8ToWide(entry_.title);
        std::wstring trailing =
            attention_start_s_ >= 0 && !attention_title_.empty()
                ? attention_trailing_
                : Utf8ToWide(entry_.trailing);
        Gdiplus::Font icon_font(mem_dc, MakeIslandGlyphFont(S(15)));
        Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(18), 650));
        Gdiplus::Font trail_font(mem_dc, MakeIslandFont(S(15), 650));

        // 声明档宽下排版：尾注封顶 40%，标题吃剩余，超档截断加省略号。
        Gdiplus::RectF m_icon, m_title, m_trail;
        const wchar_t* glyph = KindGlyph(entry_.kind);
        g.MeasureString(glyph, -1, &icon_font, Gdiplus::PointF(0, 0), &m_icon);
        const float pad_x = 14.0f * s;
        const float gap = 7.0f * s;
        const float avail = cur_w - pad_x * 2;
        const float icon_w = entry_.spinning ? 0.0f : m_icon.Width;
        const float icon_block = icon_w + gap;
        const float tail_base = entry_.spinning
                                    ? 5.0f * s
                                    : (trailing.empty()
                                           ? 0.0f
                                           : ([&]() {
                                               Gdiplus::RectF mm;
                                               g.MeasureString(
                                                   trailing.c_str(), -1,
                                                   &trail_font,
                                                   Gdiplus::PointF(0, 0), &mm);
                                               return mm.Width;
                                             })());
        const float tail_use = std::min(tail_base, avail * 0.40f);
        const float title_cap =
            std::max(30.0f * s, avail - icon_block - tail_use - 8.0f * s);
        title = FitText(g, title, title_font, title_cap);
        g.MeasureString(title.c_str(), -1, &title_font, Gdiplus::PointF(0, 0),
                        &m_title);
        if (!entry_.spinning && !trailing.empty() && tail_use > 0.0f) {
          trailing = FitText(g, trailing, trail_font, tail_use);
          g.MeasureString(trailing.c_str(), -1, &trail_font,
                          Gdiplus::PointF(0, 0), &m_trail);
        }
        const float trail_w = entry_.spinning ? 5.0f * s : m_trail.Width;
        const float total = icon_block + m_title.Width + 8.0f * s +
                            (entry_.spinning || !trailing.empty() ? trail_w : 0.0f);
        float x = cap_x + (cur_w - total) / 2.0f;

        const float icon_cy = header_cy;
        if (!entry_.spinning) {
          // task/inbox 用矢量图标（对应字形在 MDL2 缺失或为豆腐块）。
          if (entry_.kind == DynamicIslandWindow::Kind::kTask) {
            DrawTaskIcon(g, x + m_icon.Width / 2.0f, icon_cy, 6.5f * s,
                         now_s_, ea);
          } else if (entry_.kind == DynamicIslandWindow::Kind::kInbox) {
            DrawMailIcon(g, x + m_icon.Width / 2.0f, icon_cy, 13.0f * s,
                         10.0f * s);
            } else {
              Gdiplus::SolidBrush icon_brush(
                  Gdiplus::Color(ea * 230 / 255, 255, 255, 255));
            g.DrawString(glyph, -1, &icon_font,
                         Gdiplus::PointF(x, header_cy - m_icon.Height / 2.0f),
                         &icon_brush);
          }
        }
        x += icon_block;
        // 标题满白（纯黑胶囊上对比拉满；原 236 灰 + 三参 Color 让 R 通道
        // 背着 alpha——淡入淡出中段会泛青）。
        Gdiplus::SolidBrush title_brush(Gdiplus::Color(ea, 255, 255, 255));
        g.DrawString(title.c_str(), -1, &title_font,
                     Gdiplus::PointF(x, header_cy - m_title.Height / 2.0f),
                     &title_brush);
        x += m_title.Width + 8.0f * s;
        if (entry_.spinning) {
          // 呼吸活点
          const double pulse = 0.5 + 0.5 * std::sin(now_s_ * 4.4879895);  // 1.4s 周期
          const float dot_r = 2.5f * s;
          Gdiplus::SolidBrush dot_brush(
              Gdiplus::Color(static_cast<BYTE>((64 + 165 * pulse) * ea / 255),
                             255, 255, 255));
          g.FillEllipse(&dot_brush, x, header_cy - dot_r, dot_r * 2, dot_r * 2);
        } else if (!trailing.empty()) {
          // 尾注数字（「N 条未读」「25 分钟后」）全白：两轮加深 150→220→255。
          Gdiplus::SolidBrush trail_brush(
              Gdiplus::Color(ea, 255, 255, 255));
          g.DrawString(trailing.c_str(), -1, &trail_font,
                       Gdiplus::PointF(x, header_cy - m_trail.Height / 2.0f),
                       &trail_brush);
        }

        // 进度线（贴头部行底缘，仅 compact 态；展开后无意义）
        if (entry_.progress >= 0 && entry_.progress <= 1 && morph_ < 0.5) {
          const float line_y = cap_y + header_h - 3.0f * s;
          const float inset = 14.0f * s;
          const float track_w = cur_w - inset * 2;
          const float line_h = 2.0f * s;
          Gdiplus::SolidBrush track_brush(
              Gdiplus::Color(ea * 26 / 255, 255, 255, 255));
          g.FillRectangle(&track_brush, cap_x + inset, line_y, track_w, line_h);
          Gdiplus::SolidBrush fill_brush(
              Gdiplus::Color(ea * 230 / 255, 255, 255, 255));
          g.FillRectangle(&fill_brush, cap_x + inset, line_y,
                          track_w * static_cast<float>(entry_.progress), line_h);
        }
      }
    }

    // ── hover 态：导航点 + 环境信息行 ──
    if (hover_alpha > 0.02f) {
      const BYTE ha = static_cast<BYTE>(hover_alpha * 255.0f + 0.5f);
      const float dot_cy = cap_y + cur_h / 2.0f;
      float dx = cap_x + 22.0f * s;
      for (int i = 0; i < 3; i++) {
        const bool expand_pt = i == 2;
        const bool active = !expand_pt && i == static_cast<int>(hover_tab_);
        const bool hov = hovering_ && hover_dot_ == i;
        if (expand_pt) {
          // 「展开」点画下箭头（点击/滚进都进展开卡）。
          Gdiplus::Font glyph_font(mem_dc, MakeIslandGlyphFont(S(11)));
          const wchar_t* chev = L"\uE96E";  // ChevronDownSmall
          Gdiplus::RectF m_c;
          g.MeasureString(chev, -1, &glyph_font, Gdiplus::PointF(0, 0), &m_c);
          Gdiplus::SolidBrush cb(Gdiplus::Color(
              static_cast<BYTE>(ha * (active || hov ? 90 : 42) / 100), 255,
              255, 255));
          g.DrawString(chev, -1, &glyph_font,
                       Gdiplus::PointF(dx - m_c.Width / 2.0f,
                                       dot_cy - m_c.Height / 2.0f),
                       &cb);
        } else {
          const float r = (active ? 4.2f : 3.1f) * s;
          Gdiplus::SolidBrush db(Gdiplus::Color(
              static_cast<BYTE>(ha * (active ? 100 : (hov ? 75 : 34)) / 100),
              255, 255, 255));
          g.FillEllipse(&db, dx - r, dot_cy - r, r * 2, r * 2);
          if (active) {
            Gdiplus::Pen ring_pen(Gdiplus::Color(
                static_cast<BYTE>(ha * 30 / 100), 255, 255, 255), 1.2f * s);
            g.DrawEllipse(&ring_pen, dx - r - 2.5f * s, dot_cy - r - 2.5f * s,
                          (r + 2.5f * s) * 2, (r + 2.5f * s) * 2);
          }
        }
        RECT drc = {static_cast<LONG>(dx - 10.0f * s),
                    static_cast<LONG>(dot_cy - 12.0f * s),
                    static_cast<LONG>(dx + 10.0f * s),
                    static_cast<LONG>(dot_cy + 12.0f * s)};
        hover_dot_rects_.push_back(drc);
        dx += static_cast<float>(kHoverDotPitch) * s;
      }
      const std::wstring line = BuildHoverLine();
      Gdiplus::Font line_font(mem_dc, MakeIslandFont(S(16), 650));
      const float line_x = dx - 4.0f * s;
      const float line_max = cap_x + cur_w - 18.0f * s - line_x;
      const std::wstring fitted = FitText(g, line, line_font, line_max);
      Gdiplus::RectF m_line;
      g.MeasureString(fitted.c_str(), -1, &line_font, Gdiplus::PointF(0, 0),
                      &m_line);
      Gdiplus::SolidBrush line_brush(
          Gdiplus::Color(ha, 255, 255, 255));
      g.DrawString(fitted.c_str(), -1, &line_font,
                   Gdiplus::PointF(line_x, dot_cy - m_line.Height / 2.0f),
                   &line_brush);
    }

    // ── 展开区：日程卡（随 morph 越过 hover 档淡入）──
    if (morph_ > 1.01) {
      const BYTE fade = static_cast<BYTE>(255 * Clamp01((morph_ - 1.0) * 1.2));
      const float pad = 18.0f * s;
      float y = cap_y + header_h + 6.0f * s;

      Gdiplus::SolidBrush div_brush(
          Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
      g.FillRectangle(&div_brush, cap_x + pad, y, cur_w - pad * 2, 1.0f * s);
      y += 6.0f * s;

      Gdiplus::Font label_font(mem_dc, MakeIslandFont(S(14), 700));
      const std::wstring label = L"接下来";
      Gdiplus::SolidBrush label_brush(
          Gdiplus::Color(static_cast<BYTE>(fade * 85 / 100), 255, 255, 255));
      g.DrawString(label.c_str(), -1, &label_font,
                   Gdiplus::PointF(cap_x + pad, y), &label_brush);
      y += 20.0f * s;

      if (!agenda_.empty()) {
        Gdiplus::Font time_font(mem_dc, MakeIslandFont(S(15), 700));
        Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(18), 650));
        Gdiplus::Font done_font(mem_dc, MakeIslandFont(S(18), 600, true));
        Gdiplus::Font hint_font(mem_dc, MakeIslandFont(S(15), 650));
        const int rows = std::min(static_cast<int>(agenda_.size()), kMaxRows);
        for (int i = 0; i < rows; i++) {
          const AgendaItem& it = agenda_[i];
          const std::wstring time_w = Utf8ToWide(it.time_text);
          const std::wstring title_w = Utf8ToWide(it.title);
          const std::wstring hint_w = Utf8ToWide(it.hint);
          const bool is_near = !it.completed;
          Gdiplus::RectF m_t;
          g.MeasureString(time_w.c_str(), -1, &time_font,
                          Gdiplus::PointF(0, 0), &m_t);
          Gdiplus::SolidBrush time_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * (is_near ? 95 : 36) / 100), 255, 255, 255));
          g.DrawString(time_w.c_str(), -1, &time_font,
                       Gdiplus::PointF(cap_x + pad, y), &time_brush);
          Gdiplus::SolidBrush title_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * (is_near ? 100 : 44) / 100), 255, 255, 255));
          g.DrawString(title_w.c_str(), -1, is_near ? &title_font : &done_font,
                       Gdiplus::PointF(cap_x + pad + m_t.Width + 10.0f * s, y),
                       &title_brush);
          if (!hint_w.empty()) {
            Gdiplus::RectF m_hint;
            g.MeasureString(hint_w.c_str(), -1, &hint_font,
                            Gdiplus::PointF(0, 0), &m_hint);
            Gdiplus::SolidBrush hint_brush(Gdiplus::Color(
                static_cast<BYTE>(fade * 75 / 100), 255, 255, 255));
            g.DrawString(
                hint_w.c_str(), -1, &hint_font,
                Gdiplus::PointF(cap_x + cur_w - pad - m_hint.Width, y),
                &hint_brush);
          }
          y += static_cast<float>(kRowH) * s;
        }
        y += 6.0f * s;
      } else {
        // 空态占位：展开卡只有「接下来」标签会显得断档，补一行弱文案。
        Gdiplus::Font empty_font(mem_dc, MakeIslandFont(S(15), 650));
        Gdiplus::SolidBrush empty_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 55 / 100), 255, 255, 255));
        g.DrawString(L"今日无日程", -1, &empty_font,
                     Gdiplus::PointF(cap_x + pad, y + 5.0f * s), &empty_brush);
        y += static_cast<float>(kRowH) * s + 6.0f * s;
      }

      // ── 任务动态：agent 工具步骤流（进行中转圈 / 成功勾 / 失败叉）──
      const int step_rows =
          std::min(static_cast<int>(agent_steps_.size()), kMaxSteps);
      if (step_rows > 0) {
        Gdiplus::SolidBrush step_div_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
        g.FillRectangle(&step_div_brush, cap_x + pad, y, cur_w - pad * 2,
                        1.0f * s);
        y += 6.0f * s;

        Gdiplus::Font step_label_font(mem_dc, MakeIslandFont(S(14), 700));
        Gdiplus::SolidBrush step_label_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 85 / 100), 255, 255, 255));
        g.DrawString(L"任务动态", -1, &step_label_font,
                     Gdiplus::PointF(cap_x + pad, y), &step_label_brush);
        y += 20.0f * s;

        Gdiplus::Font step_font(mem_dc, MakeIslandFont(S(15), 650));
        for (int i = 0; i < step_rows; i++) {
          const AgentStep& st = agent_steps_[i];
          const float glyph_cx = cap_x + pad + 5.0f * s;
          const float glyph_cy = y + 9.0f * s;
          if (st.state == 0) {
            DrawTaskIcon(g, glyph_cx, glyph_cy, 4.5f * s, now_s_,
                         static_cast<BYTE>(fade * 80 / 100));
          } else if (st.state == 1) {
            DrawCheckMark(g, glyph_cx, glyph_cy, s,
                          static_cast<BYTE>(fade * 70 / 100));
          } else {
            DrawCrossMark(g, glyph_cx, glyph_cy, s,
                          static_cast<BYTE>(fade * 80 / 100));
          }
          const std::wstring step_text = FitText(
              g, Utf8ToWide(st.label), step_font,
              cur_w - pad * 2 - 16.0f * s);
          Gdiplus::SolidBrush step_brush(
              Gdiplus::Color(static_cast<BYTE>(fade), 255, 255, 255));
          g.DrawString(step_text.c_str(), -1, &step_font,
                       Gdiplus::PointF(cap_x + pad + 14.0f * s, y),
                       &step_brush);
          y += static_cast<float>(kStepRowH) * s;
        }
        y += 4.0f * s;
      }

      // ── 未读消息：最近未读标题摘要（行首未读圆点，点击出口暂无）──
      const int unread_rows =
          std::min(static_cast<int>(unread_rows_.size()), kMaxUnreadRows);
      if (unread_rows > 0) {
        Gdiplus::SolidBrush unread_div_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
        g.FillRectangle(&unread_div_brush, cap_x + pad, y, cur_w - pad * 2,
                        1.0f * s);
        y += 6.0f * s;

        Gdiplus::Font unread_label_font(mem_dc, MakeIslandFont(S(14), 700));
        Gdiplus::SolidBrush unread_label_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 85 / 100), 255, 255, 255));
        g.DrawString(L"未读消息", -1, &unread_label_font,
                     Gdiplus::PointF(cap_x + pad, y), &unread_label_brush);
        y += 20.0f * s;

        Gdiplus::Font unread_font(mem_dc, MakeIslandFont(S(15), 650));
        for (int i = 0; i < unread_rows; i++) {
          const UnreadItem& row = unread_rows_[i];
          Gdiplus::SolidBrush dot_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * 90 / 100), 255, 255, 255));
          g.FillEllipse(&dot_brush, cap_x + pad + 2.0f * s, y + 8.0f * s,
                        4.0f * s, 4.0f * s);
          const std::wstring unread_text = FitText(
              g, Utf8ToWide(row.title), unread_font,
              cur_w - pad * 2 - 16.0f * s);
          Gdiplus::SolidBrush unread_brush(Gdiplus::Color(
              static_cast<BYTE>(fade * 92 / 100), 255, 255, 255));
          g.DrawString(unread_text.c_str(), -1, &unread_font,
                       Gdiplus::PointF(cap_x + pad + 14.0f * s, y),
                       &unread_brush);
          y += static_cast<float>(kUnreadRowH) * s;
        }
        y += 4.0f * s;
      }
    }

    g.ResetClip();
  }

  // GDI+ 写入的是 straight alpha；UpdateLayeredWindow 需要 premultiplied。
  {
    DWORD* px = static_cast<DWORD*>(bits);
    const int total = phys_w * phys_h;
    for (int i = 0; i < total; i++) {
      const DWORD v = px[i];
      const BYTE a = static_cast<BYTE>(v >> 24);
      if (a == 255 || a == 0) continue;
      const BYTE r = static_cast<BYTE>((v & 0xFF) * a / 255);
      const BYTE gr = static_cast<BYTE>(((v >> 8) & 0xFF) * a / 255);
      const BYTE b = static_cast<BYTE>(((v >> 16) & 0xFF) * a / 255);
      px[i] = (static_cast<DWORD>(a) << 24) | (static_cast<DWORD>(b) << 16) |
              (static_cast<DWORD>(gr) << 8) | r;
    }
  }

  RECT wr;
  GetWindowRect(window_handle_, &wr);
  POINT dst = {wr.left, wr.top};
  POINT src = {0, 0};
  SIZE size = {phys_w, phys_h};
  BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(window_handle_, screen_dc, &dst, &size, mem_dc, &src, 0,
                      &blend, ULW_ALPHA);

  SelectObject(mem_dc, old_bmp);
  DeleteObject(dib);
  DeleteDC(mem_dc);
  ReleaseDC(nullptr, screen_dc);
}

int DynamicIslandWindow::HoverDotAt(int client_x, int client_y) const {
  for (size_t i = 0; i < hover_dot_rects_.size(); i++) {
    const RECT& rc = hover_dot_rects_[i];
    if (client_x >= rc.left && client_x <= rc.right && client_y >= rc.top &&
        client_y <= rc.bottom) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

LRESULT CALLBACK DynamicIslandWindow::WndProc(HWND hwnd, UINT message,
                                              WPARAM wparam,
                                              LPARAM lparam) noexcept {
  DynamicIslandWindow* self = nullptr;
  if (message == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCTW*>(lparam);
    self = static_cast<DynamicIslandWindow*>(cs->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(self));
  } else {
    self = reinterpret_cast<DynamicIslandWindow*>(
        GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  }
  if (self == nullptr) return DefWindowProcW(hwnd, message, wparam, lparam);
  return self->HandleMessage(hwnd, message, wparam, lparam);
}

LRESULT DynamicIslandWindow::HandleMessage(HWND hwnd, UINT message,
                                            WPARAM wparam,
                                            LPARAM lparam) noexcept {
  switch (message) {
    case WM_PAINT: {
      ValidateRect(hwnd, nullptr);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (wparam == 1) {
        UpdateAnimations();
      } else if (wparam == kSuppressTimerId) {
        UpdateFullscreenSuppression();
      } else if (wparam == kPeekTimerId) {
        UpdateTopEdgePeek();
      } else if (wparam == 2) {
        KillTimer(hwnd, 2);
        if (!hovering_ && attention_start_s_ < 0) {
          // 分级自动收回：展开先退回 hover（环境信息），hover 再静默回胶囊。
          if (stage_target_ == Stage::kExpanded) {
            SetStage(Stage::kHover);
            // 鼠标仍不在岛上：续排 hover 段收回，否则会卡死在 hover 层。
            SetTimer(hwnd, 2, 2500, nullptr);
          } else if (stage_target_ == Stage::kHover) {
            SetStage(Stage::kCompact);
            FireEvent(EventType::kExpandedChanged, "false");
          }
        }
      }
      return 0;
    case WM_NCHITTEST:
      return HTCLIENT;  // 岛形以外 alpha=0，系统自动穿透
    case WM_LBUTTONDOWN: {
      // 形变保护（eisland morphing guard）：动画未完成时吞掉点击，
      // 避免连点按出半截状态。
      if (IsMorphing()) return 0;
      const int cx = GET_X_LPARAM(lparam);
      const int cy = GET_Y_LPARAM(lparam);
      // attention 进行中点击 = 知道了：提前收口（临时条目一并清），
      // 并让 Dart 打开日程页（到点提醒的确认出口，2026-10-05 定调）。
      if (attention_start_s_ >= 0) {
        attention_start_s_ = -1;
        if (entry_.id == "attention") ClearEntry();
        else Render();
        FireEvent(EventType::kAction, "打开日程");
        // 提前收口后立即让位：全屏环境仍在时回抑制态，不等下一跳。
        UpdateFullscreenSuppression();
        return 0;
      }
      // hover 导航点：今日/任务切页，「展开」点进展开卡。
      if (std::abs(morph_ - 1.0) < 0.45) {
        const int dot = HoverDotAt(cx, cy);
        if (dot == 2) {
          SetStage(Stage::kExpanded);
          FireEvent(EventType::kExpandedChanged, "true");
          return 0;
        }
        if (dot >= 0) {
          hover_tab_ = static_cast<HoverTab>(dot);
          Render();
          return 0;
        }
      }
      // 三级渐进展开：胶囊→hover→展开；收起从展开先回 hover。
      switch (stage_target_) {
        case Stage::kCompact:
          SetStage(Stage::kHover);
          break;
        case Stage::kHover:
          SetStage(Stage::kExpanded);
          FireEvent(EventType::kExpandedChanged, "true");
          break;
        case Stage::kExpanded:
          SetStage(Stage::kHover);
          // hover 不是 Dart 已知的展开态：必须同步，否则 Dart 残留
          // expanded=true，下次同步会把岛强行拉回展开层。
          FireEvent(EventType::kExpandedChanged, "false");
          break;
      }
      return 0;
    }
    case WM_MOUSEWHEEL:
      OnWheelDelta(GET_WHEEL_DELTA_WPARAM(wparam));
      return 0;
    case kIslandWheelMsg:
      OnWheelDelta(static_cast<short>(LOWORD(lparam)));
      return 0;
    case WM_MOUSEMOVE: {
      const int cx = GET_X_LPARAM(lparam);
      const int cy = GET_Y_LPARAM(lparam);
      hovering_ = true;
      if (stage_target_ != Stage::kCompact) {
        KillTimer(hwnd, 2);  // 鼠标回到岛上：取消分级自动收回
      } else if (voice_talk_mode_ && !IsMorphing()) {
        // 纯语音模式：悬停自动 glance 环境行（无需点击进 hover）。
        SetStage(Stage::kHover);
      }
      UpdateWheelHook();

      if (!tracking_mouse_) {
        TRACKMOUSEEVENT tme = {sizeof(TRACKMOUSEEVENT), TME_LEAVE, hwnd, 0};
        TrackMouseEvent(&tme);
        tracking_mouse_ = true;
      }
      const int dot = std::abs(morph_ - 1.0) < 0.45 ? HoverDotAt(cx, cy) : -1;
      if (dot != hover_dot_) {
        hover_dot_ = dot;
        Render();
      }
      return 0;
    }
    case WM_MOUSELEAVE:
      hovering_ = false;
      tracking_mouse_ = false;
      hover_dot_ = -1;
      UpdateWheelHook();
      Render();
      // 分级自动收回：展开 3 秒退回 hover，hover 2.5 秒回胶囊
      // （attention 期间不收）。
      if (stage_target_ != Stage::kCompact && attention_start_s_ < 0) {
        SetTimer(hwnd, 2, stage_target_ == Stage::kExpanded ? 3000 : 2500,
                 nullptr);
      }
      return 0;
    case WM_DPICHANGED: {
      const UINT dpi = static_cast<UINT>(HIWORD(wparam));
      if (dpi != 0) {
        dpi_scale_ = static_cast<double>(dpi) / USER_DEFAULT_SCREEN_DPI;
        PositionAtTopCenter();
        Render();
        UpdateFullscreenSuppression();
      }
      return 0;
    }
    case WM_DISPLAYCHANGE:
      // 显示模式切换（独占全屏游戏进出、改分辨率/刷新率）后立即复核抑制：
      // 定位本身已不会再硬露头，这里再兜一层，保证切换瞬间的岛状态正确。
      PositionAtTopCenter();
      Render();
      UpdateFullscreenSuppression();
      return 0;
    case WM_CLOSE:
      // HUD 不响应关闭请求：外部 WM_CLOSE 走 DefWindowProc 会直接销毁岛，
      // 一旦销毁（此前悬空句柄还会让 create 空转返回 true）便「自己消失」。
      IslandLifecycleLog(hwnd, L"wm-close-swallowed");
      return 0;
    case WM_DESTROY:
      IslandLifecycleLog(hwnd, L"wm-destroy");
      StopAnimTimer();
      hovering_ = false;
      UpdateWheelHook();
      return 0;
    case WM_NCDESTROY:
      // 句柄即将失效：立即归零，杜绝悬空句柄让后续 create 全部空转。
      IslandLifecycleLog(hwnd, L"wm-ncdestroy");
      window_handle_ = nullptr;
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

void DynamicIslandWindow::FireEvent(EventType type, const std::string& payload) {
  if (event_callback_) event_callback_(type, payload);
}
