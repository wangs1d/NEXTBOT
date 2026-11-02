#ifndef RUNNER_DYNAMIC_ISLAND_WINDOW_H_
#define RUNNER_DYNAMIC_ISLAND_WINDOW_H_

#include <windows.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace Gdiplus {
class Bitmap;
class Graphics;
}  // namespace Gdiplus

/// 桌面顶部灵动岛（同进程 HWND 自绘，GDI+ 逐像素透明分层窗口）。
///
/// 设计（对齐 Apple 灵动岛语言，替代原 in-app Flutter 岛与今日安排悬浮窗）：
///   - WS_POPUP + WS_EX_LAYERED + WS_EX_TOOLWINDOW，
///     钉在主屏工作区顶部正中；岛形以外 alpha=0 自动点击穿透。
///     常态 Z 序沉底（HWND_BOTTOM），不覆盖任何窗口；仅 urgent 提醒
///     与顶边 peek 唤出临时置顶，结束落回沉底
///   - 三级渐进展开（借鉴 eisland）：胶囊 → hover（环境信息行 + 导航点）
///     → 展开卡；点击逐级下行，收起从展开先回 hover 而非一步缩回
///   - 待机态：小胶囊 + 中央金属球「镜头」（呼吸光）
///   - 内容态：胶囊横向撑开（图标 + 标题 + 尾注 / 呼吸活点 / 进度线）
///   - hover 态：360×58 环境胶囊（下一日程 · 未读数；导航点 +
///     「展开」点/滚轮进展开卡）
///   - 展开态：胶囊本体向下生长成信息总览卡（圆角连续变形），头部行保留，
///     分节：接下来（日程）/ 未读消息（摘要）
///   - 形变保护：morphing 期间吞掉点击/滚轮，避免按出半截状态
///   - 岛这块像素被全屏应用盖住时自动隐藏（D3D 全屏 / 放映模式 / 忙碌 /
///     无边框全屏铺满显示器 / 最大化盖岛）：2026-10-09 拍板应用最大化同样
///     让位，2026-10-14 根修补上无边框全屏缺口，2026-10-23 根修把判定对象
///     从「前台窗口」换成「Z 序压在岛上面的那个窗口」——底部全屏页之上再
///     开一个非全屏小应用，岛不再跟着复活；让位期间鼠标贴屏幕顶边可临时
///     唤出（peek）。录屏豁免 2026-10-24 收紧：除 Game Bar 服务外，
///     名单进程须有可见、未最小化的顶层窗口才豁免（剪映等常驻/残留
///     进程不再把豁免永久焊死）。2026-10-25 根修：抑制期间定位不再带
///     SWP_SHOWWINDOW（显示模式切换曾把岛重新弹到独占全屏游戏之上），
///     且抑制心跳每跳强制兜底隐藏；全屏判定补「前台全屏」与「跨浮层扫描」
///
/// 尺寸即声明（islandTransition 思路）：壳层只在「声明尺寸档」之间插值，
/// 不按文案实时测量——每种内容态一个标准宽度档，杜绝文案长短引起的抖动。
///
/// 通过 MethodChannel `pai/dynamic_island` 与 Dart 端通信：
///   - Dart -> C++：create / destroy / setVisible / present / dismiss /
///     dismissAll / setAgenda / expand / collapse / setDpi /
///     setAmbient（未读数）/ setUnreadPreview（未读摘要行）
///   - C++ -> Dart：onNativeEvent（expandedChanged / action / tapped）
class DynamicIslandWindow {
 public:
  enum class Kind { kTask = 0, kUpdate, kSchedule, kInbox, kVoice };

  /// 壳层三级（eisland 式渐进展开）：morph 电平 0/1/2。
  enum class Stage { kCompact = 0, kHover = 1, kExpanded = 2 };

  /// 岛上的一条信息（compact 胶囊内容）。
  struct Entry {
    std::string id;
    std::string title;
    std::string trailing;  // 右侧弱化短文案（空 = 无）
    Kind kind = Kind::kTask;
    double progress = -1.0;  // [0,1] 画进度线；<0 不画
    bool spinning = false;   // 尾部呼吸活点
  };

  /// 展开态日程卡里的一行。
  struct AgendaItem {
    std::string time_text;  // "HH:MM"
    std::string title;
    std::string hint;  // 右侧提示（"25 分钟后" / "已完成" 等）
    bool completed = false;
  };

  /// 展开卡「未读消息」摘要行（标题单行截断展示）。
  struct UnreadItem {
    std::string title;
  };

  /// 逐字时间轴的一个唱段（字/词/音节）。
  struct LyricChar {
    double t_sec = 0.0;    // 相对曲目起点秒数
    double dur_sec = 0.0;  // 持续时间，<=0 表示无时长信息
    std::string text;      // utf8
  };

  /// 一条歌词：t_sec 为相对曲目起点秒数（服务端 LRC 毫秒换算而来）。
  struct LyricLine {
    double t_sec = 0.0;
    std::string text;         // utf8
    std::string translation;  // utf8，空 = 无翻译
    /// 逐字时间轴；空 = 没有逐字歌词，绘制时按行内插值兜底。
    std::vector<LyricChar> chars;
  };

  /// 本地播放器（SMTC）快照。歌词由 Dart 侧拉取后经 setMusicLyrics 喂入，
  /// 播放进度由这里按采样点 + 墙钟插值推进。
  struct MusicPlayback {
    bool has_session = false;
    std::string app_id;
    std::string title;
    std::string artist;
    std::string album;
    double duration_sec = 0.0;
    double position_sec = 0.0;
    bool playing = false;
    int64_t sampled_at_epoch_ms = 0;
    /// SMTC 封面原始字节（PNG/JPEG）；空 = 播放器没给封面。
    std::string thumbnail;
  };

  enum class EventType {
    kExpandedChanged,  // payload: "true"/"false"（进入展开 / 回到胶囊）
    kAction,           // 岛上动作出口，payload = 动作文案（如「打开日程」）
    kTapped,           // 胶囊本体被点击（展开/收起之外的未来扩展）
  };
  using EventCallback = std::function<void(EventType type, const std::string& payload)>;

  DynamicIslandWindow();
  ~DynamicIslandWindow();

  DynamicIslandWindow(const DynamicIslandWindow&) = delete;
  DynamicIslandWindow& operator=(const DynamicIslandWindow&) = delete;

  /// 首次调用创建 HWND 并定位到主屏工作区顶部正中；后续只是 Show。
  bool Create();
  void Destroy();
  void Show();
  void Hide();
  bool IsVisible() const;
  /// 窗口是否仍存活（句柄有效且未被外部销毁）；Dart 看门狗 ping 用。
  bool IsAlive() const;

  void SetEntry(const Entry& entry);   // 空标题 = 回到待机态
  void ClearEntry();
  void SetAgenda(std::vector<AgendaItem> items);
  /// Dart 兼容入口：true = 进展开卡，false = 直接回胶囊（服务端 TTL 收回）。
  void SetExpanded(bool expanded);
  /// 三级目标态（用户点击逐级下行：胶囊→hover→展开；收起逐级回退）。
  void SetStage(Stage stage);
  /// hover 态环境行数据源：站内信未读数。
  void SetAmbient(int unread_count);
  /// 展开卡「未读消息」节：最近未读标题摘要（空 = 无未读，节整体不画）。
  void SetUnreadPreview(std::vector<UnreadItem> rows);
  /// 纯语音模式标志（对话全语音免点击）：开启后胶囊态悬停自动 glance
  /// 环境行，无需点击进 hover。
  void SetVoiceTalkMode(bool enabled);
  /// 提醒 attention 动画。hold_s = 保持高亮段时长（秒），<=0 用默认档；
  /// 到点提醒传长驻留（如 26s），点击胶囊可提前收口（并回 kAction「打开日程」）。
  /// urgent = 全屏打断白名单（2026-10-14 定调）：日程预告/到点两档均 urgent
  /// 可破屏；普通消息等非紧急档在抑制中整体跳过。
  void StartAttention(const std::string& title, const std::string& trailing,
                      double hold_s = 0.0, bool urgent = true);
  /// attention 胶囊宽度自适应（2026-10-07）：按提醒文本实测宽度取档，
  /// 钳位 [kAttentionCapsuleW, kAttentionMaxCapsuleW]（逻辑 px）。
  int MeasureAttentionCapsuleW(const std::wstring& title,
                               const std::wstring& trailing) const;
  /// 喂入播放快照（has_session=false 等价于清空）。音乐是背景态：
  /// 有更高优先级条目时胶囊仍显示条目，只有展开卡里保留歌词区。
  void SetMediaPlayback(const MusicPlayback& playback);
  /// 当前曲目的歌词（Dart 拉取后一次性喂入）。track_key 与当前播放键
  /// 对不上（换歌竞态）直接丢弃并返回 false；reason 非空 = 如实说明
  /// 没有歌词的原因。
  bool SetMusicLyrics(const std::string& track_key,
                      std::vector<LyricLine> lines,
                      const std::string& reason);
  void SetDpiScale(double scale);
  /// Dart 看门狗兜底：直推一次全屏抑制检查（原生 WM_TIMER 心跳失效时，
  /// 退出全屏后岛卡在隐藏态的恢复全靠这条）。
  void CheckSuppression();
  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_DynamicIsland_Window";
  // 窗口比岛大：给展开卡与呼吸光留余量；岛内容绘制在窗口顶部正中。
  static constexpr int kWindowW = 760;
  // 高度给展开卡留余量：日程/未读/歌词三节全满时约 700px。
  static constexpr int kWindowH = 760;
  static constexpr int kCapsuleH = 38;       // compact 胶囊高
  static constexpr int kRestCapsuleW = 108;  // 待机胶囊宽（用户拍板：长度 2 倍、高度不变）
  static constexpr int kAttentionCapsuleW = 180;  // 提醒小胶囊最小宽（用户拍板：提醒改小形态，不带 1.6 放大）
  // 提醒胶囊宽度上限（2026-10-07 定调：预告内容标题+说明全展示、宽度自适应，
  // 上限防撑爆；窗口 760 留呼吸光余量）。超限文本由渲染端 FitText 截断兜底。
  static constexpr int kAttentionMaxCapsuleW = 660;
  static constexpr int kExpandedW = 380;     // 展开卡宽
  static constexpr int kHoverW = 360;        // hover 态宽（声明档，环境信息 + 导航点）
  static constexpr int kHoverH = 58;         // hover 态高（胶囊 → 展开的中间层）
  static constexpr int kTopMargin = 5;       // 胶囊顶边距
  static constexpr int kRowH = 30;           // 日程行高
  static constexpr int kMaxRows = 5;         // 最多展示行数
  static constexpr int kUnreadRowH = 26;     // 未读摘要行高
  static constexpr int kMaxUnreadRows = 3;   // 未读摘要最多行数
  static constexpr int kMusicCapsuleW = 320;  // 音乐歌词胶囊宽（待机态专用档）
  static constexpr int kMusicCapsuleH = 50;   // 音乐胶囊高：歌名歌手一行 + 当前歌词一行
  static constexpr int kMusicExpandedW = 344;  // 音乐展开卡宽（比信息卡窄一档）
  static constexpr int kMusicArtLarge = 44;   // 展开卡封面边长
  static constexpr int kMusicArtSmall = 28;   // 胶囊封面边长
  static constexpr int kLyricPitch = 32;      // 三行歌词的行距
  static constexpr int kLyricViewportH = 96;  // 歌词窗口高（含上下遮影）
  static constexpr int kLyricEmptyH = 64;     // 无歌词说明区高
  static constexpr int kHoverDotPitch = 20;  // hover 导航点间距（逻辑 px）
  static constexpr UINT kIslandWheelMsg = WM_APP + 0x49;  // 滚轮钩子 -> 窗口
  // 全屏抑制检查心跳（id=3，窗口存活期间常开）：与动画心跳（id=1）解耦。
  // busy 隐藏岛时会停动画心跳省 CPU，恢复检查不能跟它同生死——
  // 否则退出全屏后没有任何代码再把岛唤回（曾死锁：岛一去不回）。
  static constexpr UINT kSuppressTimerId = 3;
  // 顶边唤出探针：抑制期间鼠标贴屏幕顶边临时唤回岛（200ms 轮询光标）。
  static constexpr UINT kPeekTimerId = 4;
  // attention 提醒动画：各阶段时长（秒）。2026-10-05 用户拍板：提醒不再放大，
  // 小胶囊形态（kAttentionCapsuleW）+ 脉冲细环承担注意力信号，尺寸恒为 1。
  static constexpr double kAttentionScale = 1.0;
  static constexpr double kAttnInS = 0.45;   // 入场（easeOutBack）
  static constexpr double kAttnHoldS = 4.0;  // 保持高亮脉冲（预告档默认）
  static constexpr double kAttnOutS = 0.35;  // 缩回

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message, WPARAM wparam,
                        LPARAM lparam) noexcept;
  static void EnsureClassRegistered();

  void PositionAtTopCenter();
  void RaiseTopmost();
  void UpdateAnimations();   // 定时器驱动：推进动画相位并重绘
  void Render();             // 整体重绘（GDI+ -> UpdateLayeredWindow）
  int CompactWidthFor(Kind kind) const;  // 声明档：该内容态的标准胶囊宽
  int CompactWidth() const;              // 当前条目按档取宽（待机回待机档）
  int CompactHeight() const;             // 音乐有词双行胶囊高一档，其余回常规胶囊高
  int ExpandedHeight() const;
  std::wstring BuildHoverLine() const;   // hover 态环境信息行（按当前标签页）

  // ── 音乐歌词（背景态）──
  bool MusicActive() const;
  std::string MusicTrackKey() const;  // 与 Dart 端 trackKey 同构
  double MusicPositionSec() const;    // 采样点 + 墙钟插值（暂停即冻结）
  int MusicCurrentLine() const;       // -1 = 前奏或没有歌词
  float MusicLineProgress(int index) const;  // 行内已唱比例 0..1（无词级数据时判定整行是否已唱到）
  int MusicSectionHeight() const;  // 展开卡歌词区高度（逻辑 px，无音乐 = 0）
  std::wstring MusicHeaderLine() const;  // 胶囊首行：歌名 · 歌手
  std::wstring MusicAppName() const;
  /// 音乐独占展开卡：没有更高优先级条目时，展开即音乐卡（不带日程）。
  bool MusicOnlyMode() const { return MusicActive() && !has_entry_; }
  int ExpandedWidth() const;      // 展开目标宽（音乐卡窄一档）
  int MusicCardHeight() const;    // 音乐独占卡高度（无音乐 = 0）
  void UpdateMusicRoll();         // 换行滚动动画：行位置向当前行缓动
  void UpdateMusicArt(const std::string& thumbnail);  // 封面字节 -> 位图缓存
  void ApplyPendingLyrics();  // 播放状态到位后落挂起的歌词
  // 三行歌词视口（音乐独占卡与日程卡歌词区共用）：当前行居中放大、上下遮影。
  void DrawLyricViewport(Gdiplus::Graphics& g, HDC mem_dc, float text_x,
                         float mask_x, float mask_w, float text_w, float top,
                         BYTE fade) const;
  void StartAnimTimer();
  void StopAnimTimer();
  void UpdateFullscreenSuppression();
  /// 「压在岛这块像素上面的窗口」是否盖岛：并入抑制判定（与 D3D 全屏同权）。
  /// 判定对象不是前台窗口，而是 Z 序自顶向下第一个命中岛形中心的真实窗口
  /// （2026-10-23 根修）——底部全屏页 + 上面一个非全屏小应用时，前台换了人
  /// 但岛下面仍是全屏，旧判定会翻 false 让岛复活。
  /// 路径 1：IsZoomed（命中岛中心即已盖岛，最大化应用）；
  /// 路径 2：无边框全屏——该窗口铺满岛所在显示器（浏览器 F11 / 无边框游戏
  /// 既非 IsZoomed，QUNS_BUSY 也不可靠）。
  /// 排除工具窗、点击穿透悬浮层、DWM 隐身窗、壁纸/任务栏与岛自身；
  /// 自家主窗口不豁免（2026-10-09 拍板：一视同仁）。
  bool IsIslandCoveredByApp() const;
  /// Z 序自顶向下第一个「盖住岛形中心且全屏/最大化」的真实应用窗口。
  /// 不再命中即停：全屏窗之上的小浮层不参与判定，继续往下找全屏层。
  /// nullptr = 岛上面没有全屏形态的应用（桌面/普通小窗）。
  HWND CoveringFullscreenWindow() const;
  /// 前台窗口自身是否全屏形态（铺满岛所在显示器，或最大化且盖住岛心）。
  /// 与 Z 序探测互相独立：独占全屏游戏之上的自家浮层可能挡住 Z 序探测。
  bool IsForegroundFullscreenApp() const;
  /// |hwnd| 是否铺满岛所在显示器（含任务栏区，±8px 容差）。
  bool WindowFillsIslandMonitor(HWND hwnd) const;
  /// 抑制期间的顶边唤出探针（kPeekTimerId 驱动）：鼠标贴主屏顶边临时
  /// 浮现，离开顶边且不在岛上（0.5s 宽限）即收回；不改抑制标志。
  void UpdateTopEdgePeek();
  int HoverDotAt(int client_x, int client_y) const;
  void FireEvent(EventType type, const std::string& payload);
  double AttentionScale() const;  // 当前 attention 缩放（1 = 无）

  // ── 三级形变（eisland islandTransition 思路）──
  double TargetLevel() const;            // 目标电平 0/1/2
  static double MorphDurationFor(double from_level, double to_level);
  bool IsMorphing() const { return morph_active_; }
  // 声明尺寸档之间插值：level∈[0,1] 胶囊→hover，[1,2] hover→展开（逻辑 px）。
  void StageLerpSize(double level, double* w, double* h, double* radius) const;
  RECT IslandScreenRect() const;  // 当前岛形在屏幕上的矩形（滚轮命中用）

  // ── hover 态滚轮（低级鼠标钩子：NOACTIVATE 窗口拿不到焦点轮消息）──
  void UpdateWheelHook();
  bool ConsumeWheelAt(const POINT& screen_pt, short delta);
  void OnWheelDelta(short delta);
  static LRESULT CALLBACK WheelHookProc(int code, WPARAM wparam,
                                        LPARAM lparam) noexcept;

  std::wstring Utf8ToWide(const std::string& s) const;
  int S(int v) const { return static_cast<int>(v * dpi_scale_ + 0.5); }

  HWND window_handle_ = nullptr;
  bool visible_ = false;
  bool suppressed_by_fullscreen_ = false;
  bool peek_active_ = false;        // 抑制中的顶边唤出临时显示
  ULONGLONG peek_last_in_zone_ms_ = 0;  // 鼠标最近一次位于顶边区/岛上的时刻
  double dpi_scale_ = 1.0;

  Entry entry_;
  bool has_entry_ = false;
  std::vector<AgendaItem> agenda_;
  int ambient_unread_ = 0;
  std::vector<UnreadItem> unread_rows_;  // 展开卡「未读消息」节
  // 音乐歌词（背景态）：music_ 来自 SMTC 采样，歌词按 lyric_track_key_ 归属，
  // 换歌后旧词立即失效，等 Dart 拉回新词（期间只显示歌名）。
  MusicPlayback music_;
  std::string music_lyric_track_key_;
  std::vector<LyricLine> music_lines_;
  std::string music_lyric_reason_;
  // 播放状态还没到位时挂起的歌词（按曲目键等落地，键不符即弃）。
  std::string pending_track_key_;
  std::vector<LyricLine> pending_lines_;
  std::string pending_reason_;
  // 封面按内容哈希缓存；换歌/封面补到才重新解码。
  std::unique_ptr<Gdiplus::Bitmap> music_art_;
  uint64_t music_art_hash_ = 0;
  // 歌词滚动：行位置按 320ms 缓动追当前行（暂停时目标不变，自然停住）。
  double music_roll_pos_ = -1.0;
  double music_roll_from_ = -1.0;
  double music_roll_start_s_ = -1.0;
  int music_roll_target_ = -2;  // -2 = 尚未初始化
  bool voice_talk_mode_ = false;  // 纯语音模式：对话全语音（悬停自动 glance）
  std::vector<RECT> hover_dot_rects_;  // hover 导航点命中区（物理像素）

  // 动画相位（秒）
  double now_s_ = 0.0;          // 累计时间（呼吸/活点用）
  double morph_ = 0.0;          // 0=胶囊 1=hover 2=展开，缓动后电平
  double morph_from_ = 0.0;     // 形变起点电平
  double morph_start_s_ = 0.0;  // 形变起点时刻
  double morph_duration_s_ = 0.26;  // 本次形变时长（按档位距离查表）
  bool morph_active_ = false;   // 形变进行中：吞掉点击/滚轮（形变保护）
  Stage stage_target_ = Stage::kCompact;
  bool anim_timer_on_ = false;
  ULONGLONG anim_epoch_ms_ = 0;

  // attention 提醒动画：0=无，>0 = attention 开始时刻（now_s_ 基准）
  double attention_start_s_ = -1.0;
  double attention_hold_s_ = kAttnHoldS;  // 本次保持段时长（秒），可变档
  std::wstring attention_title_;    // 高亮时显示的标题（可选，空=沿用当前 entry）
  std::wstring attention_trailing_;
  int attention_capsule_w_ = 0;  // 本次 attention 实测宽（逻辑 px；0=未测量）
  // 全屏打断白名单（2026-10-13 定调）：仅 urgent attention 豁免全屏抑制，
  // 非紧急档（预告/普通消息）在抑制中由 StartAttention 直接跳过。
  bool attention_urgent_ = true;

  // 鼠标交互
  bool hovering_ = false;
  bool tracking_mouse_ = false;
  int hover_dot_ = -1;  // hover 导航点 hover 索引

  // hover 滚轮钩子（仅悬停期间挂载，移出即卸）
  static DynamicIslandWindow* hook_instance_;
  static HHOOK wheel_hook_;

  EventCallback event_callback_;
};

#endif  // RUNNER_DYNAMIC_ISLAND_WINDOW_H_
