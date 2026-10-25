#ifndef RUNNER_DYNAMIC_ISLAND_WINDOW_H_
#define RUNNER_DYNAMIC_ISLAND_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

/// 桌面顶部灵动岛（同进程 HWND 自绘，GDI+ 逐像素透明分层窗口）。
///
/// 设计（对齐 Apple 灵动岛语言，替代原 in-app Flutter 岛与今日安排悬浮窗）：
///   - WS_POPUP + WS_EX_LAYERED + WS_EX_TOPMOST + WS_EX_TOOLWINDOW，
///     钉在主屏工作区顶部正中；岛形以外 alpha=0 自动点击穿透
///   - 三级渐进展开（借鉴 eisland）：胶囊 → hover（环境信息行 + 导航点）
///     → 展开卡；点击逐级下行，收起从展开先回 hover 而非一步缩回
///   - 待机态：小胶囊 + 中央金属球「镜头」（呼吸光）
///   - 内容态：胶囊横向撑开（图标 + 标题 + 尾注 / 呼吸活点 / 进度线）
///   - hover 态：360×58 环境胶囊（日期 · 下一日程 · 未读数；导航点 +
///     滚轮切换「今日/任务」，滚到「展开」进展开卡）
///   - 展开态：胶囊本体向下生长成日程卡（圆角连续变形），头部行保留
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
///     setAmbient（未读数 + agent 状态行）
///   - C++ -> Dart：onNativeEvent（expandedChanged / action / tapped）
class DynamicIslandWindow {
 public:
  enum class Kind { kTask = 0, kUpdate, kSchedule, kInbox, kVoice };

  /// 壳层三级（eisland 式渐进展开）：morph 电平 0/1/2。
  enum class Stage { kCompact = 0, kHover = 1, kExpanded = 2 };

  /// hover 态内容标签（导航点从左到右；滚轮逐个切换）。
  enum class HoverTab { kToday = 0, kAgent = 1 };

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
  void SetAmbient(int unread_count, bool agent_active,
                  const std::string& agent_status);
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
  void SetDpiScale(double scale);
  /// Dart 看门狗兜底：直推一次全屏抑制检查（原生 WM_TIMER 心跳失效时，
  /// 退出全屏后岛卡在隐藏态的恢复全靠这条）。
  void CheckSuppression();
  void SetEventCallback(EventCallback cb) { event_callback_ = std::move(cb); }

 private:
  static constexpr const wchar_t* kClassName = L"PAI_DynamicIsland_Window";
  // 窗口比岛大：给展开卡与呼吸光留余量；岛内容绘制在窗口顶部正中。
  static constexpr int kWindowW = 760;
  static constexpr int kWindowH = 460;
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
  void UpdateAnimations();   // 定时器驱动：推进动画相位并重绘
  void Render();             // 整体重绘（GDI+ -> UpdateLayeredWindow）
  int CompactWidthFor(Kind kind) const;  // 声明档：该内容态的标准胶囊宽
  int CompactWidth() const;              // 当前条目按档取宽（待机回待机档）
  int ExpandedHeight() const;
  std::wstring BuildHoverLine() const;   // hover 态环境信息行（按当前标签页）
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
  bool agent_active_ = false;
  std::string agent_status_;  // utf8，hover「任务」页状态行
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
  HoverTab hover_tab_ = HoverTab::kToday;
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
