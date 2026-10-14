#ifndef RUNNER_GLASS_NOTIFY_WINDOW_H_
#define RUNNER_GLASS_NOTIFY_WINDOW_H_

#include <windows.h>
#include <gdiplus.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

// ── 桌面右上角玻璃通知栈（主动性消息专属通道） ──
//    本窗口浮在屏幕工作区右上角，与应用主窗口可见性无关（应用最小化也可见）。
//    视觉 = Meoo 玻璃态设计：恒定半透明深卡（逐像素 alpha，DWM 实时合成，
//    背后内容永远透出当下画面；旧版抓拍桌面自绘毛玻璃已废） +
//    图标徽章 + 白色确认胶囊 + 底部倒计时进度线；多条通知同窗层叠，
//    后卡逐级缩小/上移/降透明（景深），同屏上限 4 条。
//    渲染走 UpdateLayeredWindow 逐像素 alpha：卡片间空隙真实透明，
//    圆角由 GDI+ 抗锯齿路径给出（不依赖 DWM 圆角）。
class GlassNotifyWindow {
 public:
  // event: "confirm" / "dismiss" / "timeout"（含被新通知挤出的 "timeout"）
  using EventCallback = std::function<void(const std::string& id,
                                           const std::string& event)>;

  GlassNotifyWindow();
  ~GlassNotifyWindow();

  void SetEventCallback(EventCallback callback);

  // 同 id 重复 Show = 置顶刷新；超出上限时最旧卡以 "timeout" 事件退出
  void Show(const std::string& id,
            const std::string& title,
            const std::string& message,
            const std::string& priority,
            const std::string& confirm_text,
            int duration_ms);
  void Hide(const std::string& id);
  void HideAll();
  bool IsVisible() const;

 private:
  struct Card {
    std::string id;
    std::wstring title;
    std::wstring message;
    std::wstring confirm_text;
    int duration_ms = 0;
    ULONGLONG start_tick = 0;
    // 悬停暂停的倒计时记账
    bool hover_paused = false;
    ULONGLONG pause_begin_tick = 0;
    ULONGLONG paused_total_ms = 0;
    // 图标字形（按 priority 选择）
    wchar_t icon_char = L'\uE946';
    // 布局缓存（窗口坐标；rc_card 为未缩放外接矩形）
    int card_height = 0;
    int msg_lines = 0;
    RECT rc_card{};
    RECT rc_close{};
    RECT rc_confirm{};
  };

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(HWND hwnd, UINT message, WPARAM wparam,
                        LPARAM lparam) noexcept;

  void EnsureClassRegistered();
  bool CreateWindowIfNeeded();
  void DestroyNativeWindow();

  int CardElapsedMs(const Card& card, ULONGLONG now) const;
  void PauseCard(Card* card, ULONGLONG now);
  void ResumeCard(Card* card, ULONGLONG now);

  int MeasureMsgLines(const Card& card) const;
  int MeasurePillWidth(const Card& card) const;
  void ComputeLayout();
  POINT TopRightOrigin() const;
  void EnsureNoiseTile();

  // 将整栈绘制进 ARGB DIB 并 UpdateLayeredWindow 上屏；
  // debug 环境变量 GLASS_NOTIFY_DUMP=1 时把首帧存 PNG 到 %TEMP%。
  void Repaint();

  void PaintStack(Gdiplus::Graphics& g);
  void PaintCard(Gdiplus::Graphics& g, const Card& card, int index);
  void DrawIconGlyph(Gdiplus::Graphics& g, const Gdiplus::RectF& rc,
                     wchar_t ch, float alpha);
  // 命中测试（含缩放逆变换）：HitTestCard 返回卡下标，HitTestPart 的
  // part: 0=卡面 1=关闭 2=确认，卡下标经 out_card 返回
  int  HitTestCard(const POINT& pt) const;
  int  HitTestPart(const POINT& pt, int* part) const;

  HWND window_handle_ = nullptr;
  EventCallback event_callback_;

  std::vector<Card> cards_;  // 下标 0 = 最前（最新）
  static constexpr int kMaxCards = 4;

  // 玻璃噪点纹理（首帧懒生成）
  std::unique_ptr<Gdiplus::Bitmap> noise_tile_;
  int dump_shots_ = 0;  // 调试出图计数（每次 Show 重置）
  ULONG_PTR gdiplus_token_ = 0;

  int hover_card_ = -1;
  bool mouse_tracking_ = false;

  static constexpr UINT_PTR kTickTimerId = 3102;
  static constexpr int kCardWidth = 384;
  static constexpr int kStackMargin = 20;   // 距工作区右上角外边距
  static constexpr int kDepthY = 6;         // 每级上移像素
  static constexpr float kDepthScale = 0.022f;  // 每级缩幅
  static constexpr float kDepthFade = 0.16f;    // 每级内容透明衰减
  static constexpr const wchar_t* kClassName = L"PAI_GlassNotify_Window";
};

#endif  // RUNNER_GLASS_NOTIFY_WINDOW_H_
