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
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
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
                           CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, family);
  cache[key] = font;
  return font;
}

HFONT MakeIslandFont(int size, int weight, bool strike = false) {
  // 分层选面：GDI 只在 RIBBI 范围内做字重匹配，Medium/Semibold 是独立
  // 族名，必须按档点名；点名后 lfWeight 固定为该面本身，避免合成加粗。
  const wchar_t* family = IslandFontFamilyRegular();
  int face_weight = 400;
  if (weight >= 700) {
    family = IslandFontFamily();
    face_weight = 700;
  } else if (weight >= 600) {
    family = IslandFontFamilySemibold();
  } else if (weight >= 450) {
    family = IslandFontFamilyMedium();
  }
  return CachedIslandFont(family, size, face_weight, strike);
}

// 字形必须落在整像素上：GDI+ 亚像素原点会把整行重采样，小字号直接糊掉。
Gdiplus::PointF SnapText(float x, float y) {
  return Gdiplus::PointF(std::floor(x + 0.5f), std::floor(y + 0.5f));
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

// 音符图标（MDL2 没有稳定可用的音符字形，直接矢量画：符头 + 符干 + 旗）。
void DrawMusicNote(Gdiplus::Graphics& g, float cx, float cy, float s,
                   BYTE alpha) {
  Gdiplus::SolidBrush brush(Gdiplus::Color(alpha, 255, 255, 255));
  Gdiplus::Pen pen(Gdiplus::Color(alpha, 255, 255, 255), 1.4f * s);
  const float rx = 3.2f * s;
  const float ry = 2.4f * s;
  const float head_cy = cy + 3.0f * s;
  g.FillEllipse(&brush, cx - rx, head_cy - ry, rx * 2, ry * 2);
  const float stem_x = cx + rx - 0.4f * s;
  g.DrawLine(&pen, stem_x, head_cy, stem_x, cy - 6.0f * s);
  g.DrawLine(&pen, stem_x, cy - 6.0f * s, stem_x + 2.6f * s,
             cy - 2.2f * s);
}

int64_t NowEpochMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// 播放进度显示（m:ss；一小时以上回退到 h:mm:ss 的 mm:ss 尾部）。
std::wstring FormatClock(double seconds) {
  if (seconds < 0 || !std::isfinite(seconds)) seconds = 0;
  const int total = static_cast<int>(seconds + 0.5);
  wchar_t buf[32];
  if (total >= 3600) {
    _snwprintf_s(buf, _countof(buf), _TRUNCATE, L"%d:%02d:%02d", total / 3600,
                 (total / 60) % 60, total % 60);
  } else {
    _snwprintf_s(buf, _countof(buf), _TRUNCATE, L"%d:%02d", total / 60,
                 total % 60);
  }
  return buf;
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

uint64_t Fnv1a64(const std::string& bytes) {
  uint64_t hash = 1469598103934665603ull;
  for (unsigned char c : bytes) {
    hash ^= c;
    hash *= 1099511628211ull;
  }
  return hash;
}

// SMTC 封面字节 -> GDI+ 位图。播放器给的多为 JPEG/PNG，走内存流解码，
// 失败返回空（界面回落到占位音符，不编造封面）。
std::unique_ptr<Gdiplus::Bitmap> DecodeImageBytes(const std::string& bytes) {
  if (bytes.empty()) return nullptr;
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes.size());
  if (mem == nullptr) return nullptr;
  void* dst = GlobalLock(mem);
  if (dst == nullptr) {
    GlobalFree(mem);
    return nullptr;
  }
  memcpy(dst, bytes.data(), bytes.size());
  GlobalUnlock(mem);
  IStream* stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(mem, TRUE, &stream)) || stream == nullptr) {
    GlobalFree(mem);
    return nullptr;
  }
  std::unique_ptr<Gdiplus::Bitmap> bitmap(
      Gdiplus::Bitmap::FromStream(stream));
  stream->Release();
  if (!bitmap || bitmap->GetLastStatus() != Gdiplus::Ok) return nullptr;
  if (bitmap->GetWidth() == 0 || bitmap->GetHeight() == 0) return nullptr;
  return bitmap;
}

// 封面：圆角方形、等比裁中；没有封面时画占位底 + 音符。
void DrawCoverArt(Gdiplus::Graphics& g, Gdiplus::Bitmap* art,
                  const Gdiplus::RectF& rect, float radius, BYTE alpha,
                  float s) {
  Gdiplus::GraphicsPath path;
  RoundedPath(&path, rect, radius);
  Gdiplus::SolidBrush placeholder(
      Gdiplus::Color(static_cast<BYTE>(alpha * 14 / 255), 255, 255, 255));
  g.FillPath(&placeholder, &path);
  if (art != nullptr && art->GetLastStatus() == Gdiplus::Ok) {
    const float iw = static_cast<float>(art->GetWidth());
    const float ih = static_cast<float>(art->GetHeight());
    const float scale = std::max(rect.Width / iw, rect.Height / ih);
    const float dw = iw * scale;
    const float dh = ih * scale;
    Gdiplus::GraphicsState state = g.Save();
    g.SetClip(&path);
    Gdiplus::ColorMatrix cm = {};
    cm.m[0][0] = 1.0f;
    cm.m[1][1] = 1.0f;
    cm.m[2][2] = 1.0f;
    cm.m[3][3] = static_cast<float>(alpha) / 255.0f;
    cm.m[4][4] = 1.0f;
    Gdiplus::ImageAttributes attrs;
    attrs.SetColorMatrix(&cm);
    g.DrawImage(art,
                Gdiplus::RectF(rect.X + (rect.Width - dw) / 2.0f,
                               rect.Y + (rect.Height - dh) / 2.0f, dw, dh),
                0.0f, 0.0f, iw, ih, Gdiplus::UnitPixel, &attrs);
    g.Restore(state);
  } else {
    DrawMusicNote(g, rect.X + rect.Width / 2.0f,
                  rect.Y + rect.Height / 2.0f - 0.5f * s, s * 0.8f,
                  static_cast<BYTE>(alpha * 80 / 100));
  }
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
  // 常态沉底（HWND_BOTTOM，见 PositionAtTopCenter）：不盖任何窗口。
  const DWORD ex_style = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
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
  // peek 唤出只在「没有几何证据」时算例外（2026-11-04：全屏应用压住岛形时
  // peek 一律不得借定位露头）。
  if ((peek_active_ && !suppress_by_geometry_) ||
      (visible_ && !suppressed_by_fullscreen_)) {
    flags |= SWP_SHOWWINDOW;
  }
  // 常态沉底：任何普通窗口都盖在岛之上。仅 urgent 提醒临时置顶，
  // 结束/收回后经这里（LowerToBottom）落回沉底。
  SetWindowPos(window_handle_, HWND_BOTTOM, x, y, w, h, flags);
}

void DynamicIslandWindow::RaiseTopmost() {
  if (window_handle_ == nullptr) return;
  SetWindowPos(window_handle_, HWND_TOPMOST, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// 落回常态沉底（不改位置/尺寸）。urgent 提醒或 peek 曾临时置顶，隐藏时必须
// 一并落底——否则「隐藏 + 顶层」的窗口经任意 Show 路径复活都会骑在全屏应用之上。
void DynamicIslandWindow::LowerToBottom() {
  if (window_handle_ == nullptr) return;
  SetWindowPos(window_handle_, HWND_BOTTOM, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
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
    LowerToBottom();
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

void DynamicIslandWindow::SetAmbient(int unread_count) {
  ambient_unread_ = unread_count;
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

// ── 音乐歌词（背景态）──

void DynamicIslandWindow::SetMediaPlayback(const MusicPlayback& playback) {
  const std::string previous_key = MusicActive() ? MusicTrackKey() : "";
  const bool had_track = MusicActive();
  music_ = playback;
  const bool track_changed = had_track && previous_key != MusicTrackKey();
  if (track_changed || (MusicActive() && !had_track)) {
    wchar_t probe[96] = {};
    _snwprintf_s(probe, _countof(probe), _TRUNCATE,
                 L"music-track dur=%.0f thumb=%d lines=%d",
                 playback.duration_sec, playback.thumbnail.empty() ? 0 : 1,
                 static_cast<int>(music_lines_.size()));
    IslandLifecycleLog(window_handle_, probe);
  }
  if (!playback.has_session || playback.title.empty()) {
    music_lines_.clear();
    music_lyric_reason_.clear();
    music_lyric_track_key_.clear();
  } else if (!music_lyric_track_key_.empty() &&
             music_lyric_track_key_ != MusicTrackKey()) {
    // 换歌：旧歌词立即失效（期间只显示歌名），等 Dart 拉回新词。
    music_lines_.clear();
    music_lyric_reason_.clear();
    music_lyric_track_key_.clear();
  }
  if (!playback.has_session || playback.title.empty() || track_changed ||
      !had_track) {
    // 换歌/收尾：歌词回到未初始化位置，封面按新曲目重新解码。
    music_roll_target_ = -2;
    music_roll_from_ = -1.0;
    music_roll_pos_ = -1.0;
    music_roll_start_s_ = -1.0;
    music_art_.reset();
    music_art_hash_ = 0;
  }
  UpdateMusicArt(playback.thumbnail);
  ApplyPendingLyrics();
  if (window_handle_ != nullptr) {
    // 心跳可能已停（暂停/无词态）：恢复播放且有词时重新拉起，卡拉OK才能逐帧推进。
    if (music_.playing && !music_lines_.empty()) StartAnimTimer();
    Render();
  }
}

// 歌词载荷可能早于播放状态到达（岛刚建好、首帧 SMTC 采样还没进来）：
// 先按曲目键挂起，等播放状态到位且键对上再落；键对不上说明已是别的歌，丢弃。
void DynamicIslandWindow::ApplyPendingLyrics() {
  if (pending_track_key_.empty()) return;
  if (!MusicActive()) return;
  if (pending_track_key_ != MusicTrackKey()) {
    pending_track_key_.clear();
    pending_lines_.clear();
    pending_reason_.clear();
    return;
  }
  const bool had_lines = !music_lines_.empty();
  music_lyric_track_key_ = pending_track_key_;
  music_lines_ = std::move(pending_lines_);
  music_lyric_reason_ = pending_reason_;
  pending_track_key_.clear();
  pending_lines_.clear();
  pending_reason_.clear();
  if (!had_lines && !music_lines_.empty()) music_roll_target_ = -2;
}

void DynamicIslandWindow::UpdateMusicArt(const std::string& thumbnail) {
  const uint64_t hash = Fnv1a64(thumbnail);
  if (hash == music_art_hash_) return;
  music_art_hash_ = hash;
  music_art_.reset();
  if (thumbnail.empty()) return;
  music_art_ = DecodeImageBytes(thumbnail);
}

// 文件级辅助：DrawKaraokeText 是自由函数，不能调用类成员 Utf8ToWide。
std::wstring KaraokeUtf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  const int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                      static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      out.data(), len);
  return out;
}

// 唱到哪亮到哪：整句先画弱化底字，再截出亮字部分。
// 只有拿到逐字时间轴（chars）才做卡拉OK推进；没有词级数据的 LRC 不做假填充，
// 唱到这一行就整行高亮（AMLL / Lyricify 等开源实现的通行做法）。
void DrawKaraokeText(
    Gdiplus::Graphics& g, const Gdiplus::Font& font, const std::wstring& text,
    const std::vector<DynamicIslandWindow::LyricChar>* chars, float x, float y,
    float text_w, float text_h, BYTE fade, double position_sec,
    float progress) {
  Gdiplus::SolidBrush base_brush(
      Gdiplus::Color(static_cast<BYTE>(fade * 34 / 100), 255, 255, 255));
  g.DrawString(text.c_str(), -1, &font, Gdiplus::PointF(x, y), &base_brush);

  Gdiplus::SolidBrush lit_brush(Gdiplus::Color(fade, 255, 255, 255));
  if (chars == nullptr || chars->empty()) {
    // 没唱到这一行（滚动中滑入的下一行）保持弱化底字；唱到了就整行亮。
    if (progress <= 0.0f) return;
    g.DrawString(text.c_str(), -1, &font, Gdiplus::PointF(x, y), &lit_brush);
    return;
  }

  // 用前缀测量得到每个唱段的横向区间，再由唱段自己的起止时间决定亮到哪。
  std::wstring prefix;
  float prev_w = 0.0f;
  float lit = 0.0f;
  bool started = false;
  for (const DynamicIslandWindow::LyricChar& ch : *chars) {
    prefix += KaraokeUtf8ToWide(ch.text);
    Gdiplus::RectF m;
    g.MeasureString(prefix.c_str(), -1, &font, Gdiplus::PointF(0, 0), &m);
    const float span = m.Width - prev_w;
    if (position_sec >= ch.t_sec) {
      double frac = 1.0;
      if (ch.dur_sec > 0.0 && position_sec < ch.t_sec + ch.dur_sec) {
        frac = (position_sec - ch.t_sec) / ch.dur_sec;
      }
      lit = prev_w + span * static_cast<float>(Clamp01(frac));
      started = true;
    }
    prev_w = m.Width;
  }
  const float lit_w = std::min(started ? lit : 0.0f, text_w);
  if (lit_w <= 0.0f) return;
  Gdiplus::RectF lit_clip(x, y - 2.0f, lit_w, text_h + 4.0f);
  g.SetClip(lit_clip);
  g.DrawString(text.c_str(), -1, &font, Gdiplus::PointF(x, y), &lit_brush);
  g.ResetClip();
}

// 歌词视口（音乐独占卡与日程卡的歌词区共用同一画法）：三行、当前行居中放大，
// 上下 22px 渐隐遮影；行位置取 music_roll_pos_，换行时整体滚过去。
void DynamicIslandWindow::DrawLyricViewport(Gdiplus::Graphics& g, HDC mem_dc,
                                            float text_x, float mask_x,
                                            float mask_w, float text_w,
                                            float top, BYTE fade) const {
  const float s = static_cast<float>(dpi_scale_);
  if (music_lines_.empty()) {
    // 没有歌词就如实写原因（伴奏 / 未收录 / 没找到同歌手版本），不拿翻唱顶替。
    const std::wstring reason = music_lyric_reason_.empty()
                                    ? L"正在找歌词"
                                    : Utf8ToWide(music_lyric_reason_);
    Gdiplus::Font reason_font(mem_dc, MakeIslandFont(S(13), 500));
    const std::wstring fitted = FitText(g, reason, reason_font, text_w);
    Gdiplus::RectF m;
    g.MeasureString(fitted.c_str(), -1, &reason_font, Gdiplus::PointF(0, 0), &m);
    Gdiplus::SolidBrush reason_brush(Gdiplus::Color(
        static_cast<BYTE>(fade * 74 / 100), 255, 255, 255));
    g.DrawString(fitted.c_str(), -1, &reason_font,
                 SnapText(text_x,
                          top + (static_cast<float>(kLyricEmptyH) * s - m.Height) /
                                    2.0f),
                 &reason_brush);
    return;
  }

  const int total = static_cast<int>(music_lines_.size());
  const double pos = music_roll_pos_;
  const double sung_sec = MusicPositionSec();
  const float center_y = top + static_cast<float>(kLyricViewportH) * s / 2.0f;
  const int first = static_cast<int>(std::floor(pos)) - 1;
  const int last = static_cast<int>(std::ceil(pos)) + 1;
  auto drawLine = [&](int i, bool emphasized) {
    if (i < 0 || i >= total) return;
    const double d = static_cast<double>(i) - pos;
    const double cur_t = std::max(0.0, 1.0 - std::abs(d));
    if ((cur_t > 0.5) != emphasized) return;
    const int weight = emphasized ? 600 : 500;
    const int base_size = static_cast<int>(std::lround(15.0 + 5.0 * cur_t));
    const std::wstring text = Utf8ToWide(music_lines_[i].text);
    if (text.empty()) return;
    // 当前行先降档再截断：长歌词宁可小一号也要整句可读。
    std::wstring fitted;
    int draw_size = base_size;
    for (int sz = base_size; sz >= 14; --sz) {
      Gdiplus::Font probe(mem_dc, MakeIslandFont(S(sz), weight));
      fitted = FitText(g, text, probe, text_w);
      draw_size = sz;
      if (fitted == text) break;
    }
    Gdiplus::Font font(mem_dc, MakeIslandFont(S(draw_size), weight));
    Gdiplus::RectF m;
    g.MeasureString(fitted.c_str(), -1, &font, Gdiplus::PointF(0, 0), &m);
    const float line_center = center_y + static_cast<float>(d * kLyricPitch) * s;
    const float origin_y = line_center - m.Height / 2.0f;
    if (emphasized) {
      // 当前行卡拉OK：弱化底字 + 已唱部分亮字（唱到哪亮到哪）。
      // 长句被 FitText 截断后逐字时间轴与显示文本不再对应，退回行内线性裁剪。
      const Gdiplus::PointF origin = SnapText(text_x, origin_y);
      const std::vector<LyricChar>* chars =
          fitted == text && !music_lines_[i].chars.empty()
              ? &music_lines_[i].chars
              : nullptr;
      DrawKaraokeText(g, font, fitted, chars, origin.X, origin.Y, m.Width,
                      m.Height, fade, sung_sec, MusicLineProgress(i));
    } else {
      Gdiplus::SolidBrush brush(Gdiplus::Color(
          static_cast<BYTE>(fade * (0.34 + 0.66 * cur_t)), 255, 255, 255));
      g.DrawString(fitted.c_str(), -1, &font, SnapText(text_x, origin_y),
                   &brush);
    }
  };
  // 先画弱化行再画当前行：滚动中两行交叠时当前行压在上面。
  for (int i = first; i <= last; ++i) drawLine(i, false);
  for (int i = first; i <= last; ++i) drawLine(i, true);

  const float mask_h = 22.0f * s;
  const float bottom_y = top + static_cast<float>(kLyricViewportH) * s - mask_h;
  Gdiplus::LinearGradientBrush top_mask(
      Gdiplus::RectF(mask_x, top, mask_w, mask_h), Gdiplus::Color(fade, 2, 2, 2),
      Gdiplus::Color(0, 2, 2, 2), Gdiplus::LinearGradientModeVertical);
  g.FillRectangle(&top_mask, mask_x, top, mask_w, mask_h);
  Gdiplus::LinearGradientBrush bottom_mask(
      Gdiplus::RectF(mask_x, bottom_y, mask_w, mask_h),
      Gdiplus::Color(0, 2, 2, 2), Gdiplus::Color(fade, 2, 2, 2),
      Gdiplus::LinearGradientModeVertical);
  g.FillRectangle(&bottom_mask, mask_x, bottom_y, mask_w, mask_h);
}

bool DynamicIslandWindow::SetMusicLyrics(const std::string& track_key,
                                         std::vector<LyricLine> lines,
                                         const std::string& reason) {
  // 换歌竞态防护：请求回来时已经在放下一首，这份词不属于当前曲目。
  // 播放状态还没到位（启动竞态）时挂起，由 ApplyPendingLyrics 落地。
  if (!MusicActive() || track_key != MusicTrackKey()) {
    pending_track_key_ = track_key;
    pending_lines_ = std::move(lines);
    pending_reason_ = reason;
    wchar_t hold[96] = {};
    _snwprintf_s(hold, _countof(hold), _TRUNCATE, L"lyric-hold active=%d lines=%d",
                 MusicActive() ? 1 : 0, static_cast<int>(pending_lines_.size()));
    IslandLifecycleLog(window_handle_, hold);
    return false;
  }
  const bool had_lines = !music_lines_.empty();
  music_lyric_track_key_ = track_key;
  music_lines_ = std::move(lines);
  music_lyric_reason_ = reason;
  // 从「没有歌词」到「有歌词」是首次出现，不跨行滚动，直接定位到当前行。
  if (!had_lines && !music_lines_.empty()) music_roll_target_ = -2;
  wchar_t ok[64] = {};
  _snwprintf_s(ok, _countof(ok), _TRUNCATE, L"lyric-ok lines=%d reason=%d",
               static_cast<int>(music_lines_.size()),
               static_cast<int>(music_lyric_reason_.size()));
  IslandLifecycleLog(window_handle_, ok);
  if (window_handle_ != nullptr) {
    if (music_.playing && !music_lines_.empty()) StartAnimTimer();
    Render();
  }
  return true;
}

bool DynamicIslandWindow::MusicActive() const {
  return music_.has_session && !music_.title.empty();
}

std::string DynamicIslandWindow::MusicTrackKey() const {
  char duration[32] = {};
  _snprintf_s(duration, sizeof(duration), _TRUNCATE, "%lld",
              static_cast<long long>(std::llround(music_.duration_sec)));
  return music_.app_id + "\x1f" + music_.title + "\x1f" + music_.artist + "\x1f" +
         music_.album + "\x1f" + duration;
}

double DynamicIslandWindow::MusicPositionSec() const {
  if (!MusicActive()) return 0.0;
  double position = music_.position_sec;
  if (music_.playing && music_.sampled_at_epoch_ms > 0) {
    const int64_t elapsed_ms = NowEpochMs() - music_.sampled_at_epoch_ms;
    if (elapsed_ms > 0) position += static_cast<double>(elapsed_ms) / 1000.0;
  }
  if (music_.duration_sec > 0) {
    position = std::min(position, music_.duration_sec);
  }
  return std::max(0.0, position);
}

int DynamicIslandWindow::MusicCurrentLine() const {
  if (music_lines_.empty()) return -1;
  const double position = MusicPositionSec();
  int index = -1;
  for (size_t i = 0; i < music_lines_.size(); i++) {
    if (music_lines_[i].t_sec <= position) {
      index = static_cast<int>(i);
    } else {
      break;
    }
  }
  return index;
}

// 行内已唱比例：本行时间戳起、下一行时间戳止；末行用曲目总长兜底。
float DynamicIslandWindow::MusicLineProgress(int index) const {
  if (index < 0 || index >= static_cast<int>(music_lines_.size())) return 0.0f;
  const double start = music_lines_[index].t_sec;
  double end = index + 1 < static_cast<int>(music_lines_.size())
                   ? music_lines_[index + 1].t_sec
                   : 0.0;
  if (end <= start) {
    end = music_.duration_sec > start ? music_.duration_sec : start + 8.0;
  }
  return static_cast<float>(
      Clamp01((MusicPositionSec() - start) / (end - start)));
}

// 展开卡歌词区高度与 Render 的绘制序列一一对应（改一处必须改另一处）。
int DynamicIslandWindow::MusicSectionHeight() const {
  if (!MusicActive()) return 0;
  int h = 6 + 1 + 8;   // 间距 + 分隔线 + 线后间距
  h += 2 + 10;         // 进度条 + 间距
  h += 20;             // 「歌词」+ 进度时间 标签行
  h += music_lines_.empty() ? kLyricEmptyH : kLyricViewportH;
  h += 8 + 1 + 8;  // 间距 + 页脚上边线 + 线后间距
  h += 16;         // 页脚行
  return h;
}

std::wstring DynamicIslandWindow::MusicHeaderLine() const {
  if (!MusicActive()) return L"";
  std::wstring line = Utf8ToWide(music_.title);
  const std::wstring artist = Utf8ToWide(music_.artist);
  if (!artist.empty()) {
    if (!line.empty()) line += L" · ";
    line += artist;
  }
  return line;
}

std::wstring DynamicIslandWindow::MusicAppName() const {
  std::string name = music_.app_id;
  // AUMID 形如 "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"：取
  // 感叹号后的真实应用名；可执行名去掉 .exe。
  const size_t bang = name.find('!');
  if (bang != std::string::npos) name = name.substr(bang + 1);
  if (name.size() > 4) {
    const std::string tail = name.substr(name.size() - 4);
    if (_stricmp(tail.c_str(), ".exe") == 0) name.resize(name.size() - 4);
  }
  return Utf8ToWide(name);
}

int DynamicIslandWindow::ExpandedWidth() const {
  return MusicOnlyMode() ? kMusicExpandedW : kExpandedW;
}

int DynamicIslandWindow::MusicCardHeight() const {
  if (!MusicOnlyMode()) return 0;
  const int lyric_h =
      music_lines_.empty() ? kLyricEmptyH : kLyricViewportH;
  return 16 + kMusicArtLarge + 12 + 2 + 10 + lyric_h + 14;
}

// 当前行变化时把行位置缓动到新行（320ms ease-out）；换歌由
// SetMediaPlayback 复位成「直接就位」，不跨曲目滚动。
void DynamicIslandWindow::UpdateMusicRoll() {
  if (!MusicActive()) {
    music_roll_target_ = -2;
    music_roll_from_ = -1.0;
    music_roll_pos_ = -1.0;
    music_roll_start_s_ = -1.0;
    return;
  }
  const int target = MusicCurrentLine();
  if (music_roll_target_ == -2) {
    music_roll_target_ = target;
    music_roll_pos_ = target;
    return;
  }
  if (target != music_roll_target_) {
    if (anim_epoch_ms_ == 0) StartAnimTimer();
    if (anim_epoch_ms_ != 0) {
      now_s_ = static_cast<double>(GetTickCount64() - anim_epoch_ms_) / 1000.0;
    }
    music_roll_from_ = music_roll_pos_;
    music_roll_target_ = target;
    music_roll_start_s_ = now_s_;
    StartAnimTimer();
  }
  if (music_roll_start_s_ >= 0) {
    const double t = Clamp01((now_s_ - music_roll_start_s_) / 0.32);
    music_roll_pos_ = music_roll_from_ + (target - music_roll_from_) *
                                             EaseOutCubic(t);
    if (t >= 1.0) {
      music_roll_pos_ = target;
      music_roll_start_s_ = -1.0;
    }
  }
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
    // urgent 是唯一破屏档（2026-10-13 白名单）：沉底常态下临时置顶，
    // 结束/点击收口处落回沉底。
    if (attention_urgent_) RaiseTopmost();
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
  // 音乐独占卡没有呼吸光/活点；但有词且播放中时卡拉OK亮字逐帧推进，
  // 心跳必须常开，停了逐字高亮就只剩低频重绘（卡顿感即此）。
  const bool karaoke_live =
      MusicOnlyMode() && MusicActive() && music_.playing &&
      !music_lines_.empty();
  if (!morph_active_ && music_roll_start_s_ < 0 && attention_start_s_ < 0 &&
      MusicOnlyMode() && !karaoke_live) {
    StopAnimTimer();
  }
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
  // 2026-11-04：把「几何证据」（真实应用铺满/最大化盖住岛形）与「启发式忙碌」
  // 拆开。几何证据在时，岛这块像素后面就是别人的全屏画面，任何二次唤出
  // （顶边 peek）都属于「除提醒外破屏」——peek 以本标志为硬闸（见
  // UpdateTopEdgePeek）。
  const bool geometry_covered = covered || fg_fullscreen;
  const bool busy = !recording && !attention_active &&
                    (geometry_covered || quns_busy);
  suppress_by_geometry_ = busy && geometry_covered;
  // 取证日志：每 ~150s 一次心跳证明本心跳活着；转向时必记（含 visible_ 快照）。
  static int tick_count = 0;
  const bool heartbeat = (++tick_count % 75) == 1;
  if (heartbeat) {
    wchar_t hb[220];
    _snwprintf_s(
        hb, _countof(hb), _TRUNCATE,
        L"suppress-tick busy=%d rec=%d cov=%d fill=%d quns=%d geom=%d "
        L"suppressed=%d visible=%d winvis=%d",
        busy ? 1 : 0, recording ? 1 : 0, covered ? 1 : 0,
        fg_fullscreen ? 1 : 0, quns_busy ? 1 : 0,
        suppress_by_geometry_ ? 1 : 0,
        suppressed_by_fullscreen_ ? 1 : 0, visible_ ? 1 : 0,
        (window_handle_ != nullptr && IsWindowVisible(window_handle_)) ? 1 : 0);
    IslandLifecycleLog(window_handle_, hb);
  }
  if (busy == suppressed_by_fullscreen_) {
    // 标志没变不代表窗口没被露出来：定位（显示模式/DPI 切换）、重建、
    // 外部 ShowWindow 都可能在抑制期间把岛重新弹回全屏画面之上，而旧代码
    // 到这里直接早退，永远收不回去（2026-10-25 独占全屏游戏根因）。
    // 每跳强制兜底隐藏；peek 是用户主动唤出，仅在「没有几何证据」时免收
    // （几何证据 = 真实全屏应用压在岛这块像素上，唤出必破屏，见 2026-11-04）。
    if (busy && window_handle_ != nullptr &&
        (!peek_active_ || suppress_by_geometry_)) {
      if (peek_active_ && suppress_by_geometry_) {
        // 唤出态被全屏应用接管：收回 peek，避免它带着顶层态继续挂在画面上。
        peek_active_ = false;
        hovering_ = false;
        UpdateWheelHook();
      }
      if (IsWindowVisible(window_handle_)) {
        IslandLifecycleLog(window_handle_, L"suppress-enforce-hide");
        ShowWindow(window_handle_, SW_HIDE);
      }
      // 抑制期间不保留任何顶层态：urgent 提醒/peek 遗留的置顶在这里落回沉底，
      // 后续任何 Show 路径都不会再骑到全屏应用之上。
      LowerToBottom();
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
    LowerToBottom();
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
//
// 2026-11-04 漏出根修：peek 曾无条件「Show + RaiseTopmost」，而全屏游戏里
// 鼠标贴顶边（FPS 抬枪、菜单、Alt+Tab 手势）是常态动作——一贴边岛就置顶
// 冒到游戏画面上，成为「除 urgent 提醒外唯一破屏口」。现在两道闸：
//   1) suppress_by_geometry_（真实全屏/最大化应用压住岛形）在时一律不唤；
//      此时岛下面是人家的画面，任何唤出都是遮挡。
//   2) peek 只 Show 不置顶：岛仍按常态沉底，没有窗口盖住时照常可见，
//      盖住时不至于骑到别人窗口之上。
void DynamicIslandWindow::UpdateTopEdgePeek() {
  if (window_handle_ == nullptr) return;
  if (!suppressed_by_fullscreen_) {
    peek_active_ = false;
    return;
  }
  if (attention_start_s_ >= 0) return;
  if (suppress_by_geometry_) {
    if (peek_active_) {
      // 全屏应用接管了岛这块像素：唤出态立即收回。
      peek_active_ = false;
      if (stage_target_ != Stage::kCompact) SetStage(Stage::kCompact);
      ShowWindow(window_handle_, SW_HIDE);
      StopAnimTimer();
      hovering_ = false;
      UpdateWheelHook();
      LowerToBottom();
      IslandLifecycleLog(window_handle_, L"peek-off-geometry");
    }
    return;
  }
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
    // 不置顶（2026-11-04）：沉底即可见，置顶会把岛骑到盖住它的窗口之上。
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
  if (!has_entry_) {
    // 待机态有本地播放时撑到歌词胶囊档；音乐让位给任何条目。
    return MusicActive() ? kMusicCapsuleW : kRestCapsuleW;
  }
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

int DynamicIslandWindow::CompactHeight() const {
  // 音乐有词才用双行高胶囊；无词只显示歌名，回常规胶囊高。
  if (!MusicOnlyMode()) return kCapsuleH;
  return MusicActive() && !music_lines_.empty() ? kMusicCapsuleH : kCapsuleH;
}

// 与 Render 展开区的绘制序列逐项对齐（头部 → 分隔线 → 各节）；
// 少算会裁掉最后一行（歌词页脚曾整个掉出卡片）。
int DynamicIslandWindow::ExpandedHeight() const {
  if (MusicOnlyMode()) return MusicCardHeight();
  const int rows = std::clamp(static_cast<int>(agenda_.size()), 0, kMaxRows);
  int h = kCapsuleH + 6;  // 头部行 + 分隔线间距
  h += 6 + 20;            // 分隔线后的间距 +「接下来」标签行
  if (rows > 0) {
    h += rows * kRowH + 6;
  } else {
    h += kRowH + 6;  // 空态「今日无日程」占位行
  }
  const int unread_rows =
      std::min(static_cast<int>(unread_rows_.size()), kMaxUnreadRows);
  if (unread_rows > 0) h += 6 + 20 + unread_rows * kUnreadRowH + 4;
  h += MusicSectionHeight();
  return h + 10;
}

void DynamicIslandWindow::StageLerpSize(double level, double* w, double* h,
                                        double* radius) const {
  const double lv = std::max(0.0, std::min(2.0, level));
  // 端点均为声明档：compact（按当前条目档）→ hover → expanded。
  const double cw = CompactWidth();
  const double ch = static_cast<double>(CompactHeight());
  const double cr = 15.0;
  const double hw = static_cast<double>(kHoverW);
  const double hh = static_cast<double>(kHoverH);
  const double hr = static_cast<double>(kHoverH) / 2.0;  // 胶囊圆角
  const double ew = static_cast<double>(ExpandedWidth());
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
    // 下滚 = 进展开态（零点击成本）。
    SetStage(Stage::kExpanded);
    FireEvent(EventType::kExpandedChanged, "true");
  }
  // 上滚在 hover 头档无上一页：忽略。
}

// hover 态环境信息行：下一日程 · 未读数。
// （日期已删，2026-10-26 用户拍板：任务栏右下角已有时钟，纯重复信息。
// 2026-11-01 用户拍板：进行中任务不再上岛播报，「任务」页整体退役。）
std::wstring DynamicIslandWindow::BuildHoverLine() const {
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
  UpdateMusicRoll();

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
    // 胶囊内部是不透明黑底（alpha=255），合成时 RGB 原样输出到屏幕，
    // 次像素渲染在分层窗口上成立；灰度 AA 在小字号上明显发虚。
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
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
      // urgent 曾临时置顶，这里落回常态沉底（抑制时窗口已藏，落位幂等）。
      UpdateFullscreenSuppression();
      if (attention_urgent_) PositionAtTopCenter();
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
      if (!has_entry_ && !MusicActive()) {
        period = 4.0; a0 = 30; a1 = 70;
      } else if (has_entry_ && entry_.spinning) {
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
    const float header_h = static_cast<float>(CompactHeight()) * s;
    const float header_cy = cap_y + header_h / 2.0f;

    if (ea > 5) {
      if (!has_entry_ && MusicActive()) {
        // 音乐胶囊：封面 +「歌名 · 歌手」+ 当前歌词（随 roll 位滑动）；
        // 展开后内容交给独占卡（单独排版，见下）。
        if (morph_ < 1.01) {
          const float pad_x = 10.0f * s;
          const float art_size = static_cast<float>(kMusicArtSmall) * s;
          Gdiplus::RectF art_rect(
              cap_x + pad_x, cap_y + (header_h - art_size) / 2.0f, art_size,
              art_size);
          DrawCoverArt(g, music_art_.get(), art_rect, 7.0f * s, ea, s);
          const float text_x = art_rect.X + art_size + 10.0f * s;
          const float text_max =
              std::max(40.0f * s, cap_x + cur_w - 12.0f * s - text_x);

          Gdiplus::Font head_font(mem_dc, MakeIslandFont(S(12), 500));

          if (music_lines_.empty()) {
            // 无词：不写任何无词文案，只显示歌名（高度已随 CompactHeight 回常规档）。
            // 单行独占整条胶囊，字号提到与歌词行同级，避免 12px 头部小字看不清。
            Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(15), 600));
            const std::wstring head =
                FitText(g, Utf8ToWide(music_.title), title_font, text_max);
            Gdiplus::RectF m_head;
            g.MeasureString(head.c_str(), -1, &title_font, Gdiplus::PointF(0, 0),
                            &m_head);
            Gdiplus::SolidBrush head_brush(
                Gdiplus::Color(static_cast<BYTE>(ea), 255, 255, 255));
            g.DrawString(head.c_str(), -1, &title_font,
                         SnapText(text_x,
                                  cap_y + (header_h - m_head.Height) / 2.0f),
                         &head_brush);
          } else {
            const std::wstring head =
                FitText(g, MusicHeaderLine(), head_font, text_max);
            Gdiplus::RectF m_head;
            g.MeasureString(head.c_str(), -1, &head_font, Gdiplus::PointF(0, 0),
                            &m_head);

            Gdiplus::Font lyric_font(mem_dc, MakeIslandFont(S(15), 600));
            const float lyric_h = lyric_font.GetHeight(&g);

            const float gap = 1.0f * s;
            const float block_y =
                cap_y + (header_h - (m_head.Height + gap + lyric_h)) / 2.0f;
            Gdiplus::SolidBrush head_brush(Gdiplus::Color(
                static_cast<BYTE>(ea * 72 / 100), 255, 255, 255));
            g.DrawString(head.c_str(), -1, &head_font,
                         SnapText(text_x, block_y), &head_brush);

            // 歌词行与展开卡共用 music_roll_pos_ 位相，整行滑动裁剪在行框内。
            const float ly_y = block_y + m_head.Height + gap;
            const int cur = MusicCurrentLine();
            const double sung_sec = MusicPositionSec();
            if (cur < 0) {
              // 前奏：展示下一句（弱化），不亮。
              const std::wstring t0 = FitText(
                  g, Utf8ToWide(music_lines_.front().text), lyric_font,
                  text_max);
              Gdiplus::SolidBrush dim_brush(Gdiplus::Color(
                  static_cast<BYTE>(ea * 50 / 100), 255, 255, 255));
              g.DrawString(t0.c_str(), -1, &lyric_font, SnapText(text_x, ly_y),
                           &dim_brush);
            } else {
              const float roll = static_cast<float>(
                  music_roll_pos_ >= 0.0 ? music_roll_pos_ : cur);
              int ia = static_cast<int>(std::floor(roll));
              float f = roll - static_cast<float>(ia);
              ia = std::max(0, std::min(ia,
                  static_cast<int>(music_lines_.size()) - 1));
              const int ib = std::min(ia + 1,
                  static_cast<int>(music_lines_.size()) - 1);
              Gdiplus::RectF clip_rect(text_x, ly_y - 2.0f * s,
                  cap_x + cur_w - 12.0f * s - text_x, lyric_h + 4.0f * s);
              g.SetClip(clip_rect);
              if (ia >= 0 && ia < static_cast<int>(music_lines_.size())) {
                const std::wstring full_a = Utf8ToWide(music_lines_[ia].text);
                const std::wstring ta =
                    FitText(g, full_a, lyric_font, text_max);
                Gdiplus::RectF ma;
                g.MeasureString(ta.c_str(), -1, &lyric_font,
                                Gdiplus::PointF(0, 0), &ma);
                const Gdiplus::PointF oa = SnapText(text_x, ly_y - f * lyric_h);
                const std::vector<LyricChar>* chars_a =
                    ta == full_a && !music_lines_[ia].chars.empty()
                        ? &music_lines_[ia].chars
                        : nullptr;
                DrawKaraokeText(g, lyric_font, ta, chars_a, oa.X, oa.Y,
                                ma.Width, ma.Height, ea, sung_sec,
                                MusicLineProgress(ia));
              }
              if (ib != ia && f > 0.0f) {
                const std::wstring full_b = Utf8ToWide(music_lines_[ib].text);
                const std::wstring tb =
                    FitText(g, full_b, lyric_font, text_max);
                Gdiplus::RectF mb;
                g.MeasureString(tb.c_str(), -1, &lyric_font,
                                Gdiplus::PointF(0, 0), &mb);
                const Gdiplus::PointF ob =
                    SnapText(text_x, ly_y + (1.0f - f) * lyric_h);
                const std::vector<LyricChar>* chars_b =
                    tb == full_b && !music_lines_[ib].chars.empty()
                        ? &music_lines_[ib].chars
                        : nullptr;
                DrawKaraokeText(g, lyric_font, tb, chars_b, ob.X, ob.Y,
                                mb.Width, mb.Height, ea, sung_sec,
                                MusicLineProgress(ib));
              }
              g.ResetClip();
            }
          }
        }
      } else if (!has_entry_) {
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
      for (int i = 0; i < 2; i++) {
        const bool expand_pt = i == 1;
        const bool active = !expand_pt;  // 唯一环境页恒亮
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

      if (MusicOnlyMode()) {
        // 音乐独占卡：封面 + 歌名 + 进度 + 三行歌词（上下遮影）；
        // 不插日程/未读，卡高与 MusicCardHeight() 对齐。
        const float m_pad = 16.0f * s;
        const float art_size = static_cast<float>(kMusicArtLarge) * s;
        const float art_x = cap_x + m_pad;
        const float art_y = cap_y + m_pad;
        DrawCoverArt(g, music_art_.get(),
                     Gdiplus::RectF(art_x, art_y, art_size, art_size),
                     12.0f * s, fade, s);

        const float meta_x = art_x + art_size + 12.0f * s;
        const float meta_w = cap_x + cur_w - m_pad - meta_x;
        Gdiplus::Font title_font(mem_dc, MakeIslandFont(S(16), 600));
        const std::wstring title =
            FitText(g, Utf8ToWide(music_.title), title_font, meta_w);
        Gdiplus::SolidBrush title_brush(Gdiplus::Color(
            static_cast<BYTE>(fade * 100 / 100), 255, 255, 255));
        g.DrawString(title.c_str(), -1, &title_font,
                     SnapText(meta_x, art_y), &title_brush);

        Gdiplus::Font sub_font(mem_dc, MakeIslandFont(S(13), 500));
        const std::wstring clock = FormatClock(MusicPositionSec()) + L" / " +
                                   FormatClock(music_.duration_sec);
        Gdiplus::RectF m_clock;
        g.MeasureString(clock.c_str(), -1, &sub_font, Gdiplus::PointF(0, 0),
                        &m_clock);
        Gdiplus::SolidBrush sub_brush(Gdiplus::Color(
            static_cast<BYTE>(fade * 58 / 100), 255, 255, 255));
        g.DrawString(clock.c_str(), -1, &sub_font,
                     SnapText(cap_x + cur_w - m_pad - m_clock.Width,
                              art_y + art_size - m_clock.Height),
                     &sub_brush);
        std::wstring sub = Utf8ToWide(music_.artist);
        const std::wstring app = MusicAppName();
        if (!sub.empty() && !app.empty()) sub += L" · ";
        sub += app;
        const float sub_max = meta_w - m_clock.Width - 10.0f * s;
        const std::wstring sub_fit =
            FitText(g, sub, sub_font, std::max(20.0f * s, sub_max));
        g.DrawString(sub_fit.c_str(), -1, &sub_font,
                     SnapText(meta_x, art_y + art_size - m_clock.Height),
                     &sub_brush);

        const float bar_y = art_y + art_size + 12.0f * s;
        const float bar_w = cur_w - m_pad * 2;
        Gdiplus::SolidBrush bar_track(Gdiplus::Color(
            static_cast<BYTE>(fade * 10 / 100), 255, 255, 255));
        g.FillRectangle(&bar_track, cap_x + m_pad, bar_y, bar_w, 2.0f * s);
        const float frac =
            music_.duration_sec > 0
                ? static_cast<float>(
                      Clamp01(MusicPositionSec() / music_.duration_sec))
                : 0.0f;
        Gdiplus::SolidBrush bar_fill(Gdiplus::Color(
            static_cast<BYTE>(fade * 55 / 100), 255, 255, 255));
        g.FillRectangle(&bar_fill, cap_x + m_pad, bar_y, bar_w * frac,
                        2.0f * s);

        const float lyric_top = bar_y + 2.0f * s + 10.0f * s;
        DrawLyricViewport(g, mem_dc, cap_x + m_pad, cap_x, cur_w,
                          cur_w - m_pad * 2, lyric_top, fade);
      } else {

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

      // ── 歌词：本地播放器曲目（背景态，排在日程/任务/未读之后）──
      // 与音乐独占卡同一视口画法；几何与 MusicSectionHeight() 一一对应。
      if (MusicActive()) {
        y += 6.0f * s;
        Gdiplus::SolidBrush music_div_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
        g.FillRectangle(&music_div_brush, cap_x + pad, y, cur_w - pad * 2,
                        1.0f * s);
        y += 1.0f * s + 8.0f * s;

        const float bar_h = 2.0f * s;
        const float bar_w = cur_w - pad * 2;
        const float frac =
            music_.duration_sec > 0
                ? static_cast<float>(
                      Clamp01(MusicPositionSec() / music_.duration_sec))
                : 0.0f;
        Gdiplus::SolidBrush bar_track(
            Gdiplus::Color(static_cast<BYTE>(fade * 10 / 100), 255, 255, 255));
        g.FillRectangle(&bar_track, cap_x + pad, y, bar_w, bar_h);
        Gdiplus::SolidBrush bar_fill(
            Gdiplus::Color(static_cast<BYTE>(fade * 55 / 100), 255, 255, 255));
        g.FillRectangle(&bar_fill, cap_x + pad, y, bar_w * frac, bar_h);
        y += bar_h + 10.0f * s;

        Gdiplus::Font lyric_label_font(mem_dc, MakeIslandFont(S(14), 700));
        Gdiplus::SolidBrush lyric_label_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 85 / 100), 255, 255, 255));
        g.DrawString(L"歌词", -1, &lyric_label_font,
                     Gdiplus::PointF(cap_x + pad, y), &lyric_label_brush);
        Gdiplus::Font clock_font(mem_dc, MakeIslandFont(S(13), 650));
        const std::wstring clock = FormatClock(MusicPositionSec()) + L" / " +
                                   FormatClock(music_.duration_sec);
        Gdiplus::RectF m_clock;
        g.MeasureString(clock.c_str(), -1, &clock_font, Gdiplus::PointF(0, 0),
                        &m_clock);
        Gdiplus::SolidBrush clock_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 42 / 100), 255, 255, 255));
        g.DrawString(clock.c_str(), -1, &clock_font,
                     Gdiplus::PointF(cap_x + cur_w - pad - m_clock.Width,
                                     y + 1.0f * s),
                     &clock_brush);
        y += 20.0f * s;

        DrawLyricViewport(g, mem_dc, cap_x + pad, cap_x, cur_w,
                          cur_w - pad * 2, y, fade);
        y += static_cast<float>(music_lines_.empty() ? kLyricEmptyH
                                                    : kLyricViewportH) *
             s;

        y += 8.0f * s;
        Gdiplus::SolidBrush foot_div(
            Gdiplus::Color(static_cast<BYTE>(fade * 6 / 100), 255, 255, 255));
        g.FillRectangle(&foot_div, cap_x + pad, y, cur_w - pad * 2, 1.0f * s);
        y += 1.0f * s + 8.0f * s;
        Gdiplus::Font foot_font(mem_dc, MakeIslandFont(S(11), 400));
        Gdiplus::SolidBrush foot_brush(
            Gdiplus::Color(static_cast<BYTE>(fade * 34 / 100), 255, 255, 255));
        std::wstring right = Utf8ToWide(music_.artist);
        const std::wstring app = MusicAppName();
        if (!right.empty() && !app.empty()) right += L" · ";
        right += app;
        Gdiplus::RectF m_right;
        g.MeasureString(right.c_str(), -1, &foot_font, Gdiplus::PointF(0, 0),
                        &m_right);
        g.DrawString(right.c_str(), -1, &foot_font,
                     Gdiplus::PointF(cap_x + cur_w - pad - m_right.Width, y),
                     &foot_brush);
      }
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
            if (MusicOnlyMode()) {
              // 音乐独占卡没有 hover 层：直接回胶囊。
              SetStage(Stage::kCompact);
              FireEvent(EventType::kExpandedChanged, "false");
            } else {
              SetStage(Stage::kHover);
              // 鼠标仍不在岛上：续排 hover 段收回，否则会卡死在 hover 层。
              SetTimer(hwnd, 2, 2500, nullptr);
            }
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
        // urgent 曾临时置顶，落回常态沉底。
        UpdateFullscreenSuppression();
        if (attention_urgent_) PositionAtTopCenter();
        return 0;
      }
      // 音乐独占：单击直达展开卡，不再走 hover 中间层（收起也一步回胶囊）。
      if (MusicOnlyMode()) {
        if (stage_target_ == Stage::kExpanded) {
          SetStage(Stage::kCompact);
          FireEvent(EventType::kExpandedChanged, "false");
        } else {
          SetStage(Stage::kExpanded);
          FireEvent(EventType::kExpandedChanged, "true");
        }
        return 0;
      }
      // hover 导航点：「展开」点进展开卡（今日点为恒亮指示，点击无操作）。
      if (std::abs(morph_ - 1.0) < 0.45) {
        const int dot = HoverDotAt(cx, cy);
        if (dot == 1) {
          SetStage(Stage::kExpanded);
          FireEvent(EventType::kExpandedChanged, "true");
          return 0;
        }
        if (dot >= 0) {
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
