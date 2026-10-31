#ifndef RUNNER_MEDIA_SESSION_WATCHER_H_
#define RUNNER_MEDIA_SESSION_WATCHER_H_

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

/// Windows 系统媒体传输控件（SMTC）当前会话快照。
///
/// 字段全部为 UTF-8 / 秒，跨线程安全（采样线程写、平台线程读）。
struct MediaSessionSnapshot {
  bool has_session = false;
  std::string app_id;
  std::string title;
  std::string artist;
  std::string album;
  double duration_sec = 0.0;
  double position_sec = 0.0;
  bool playing = false;
  bool paused = false;
  int64_t sampled_at_epoch_ms = 0;
  /// 封面原始字节（JPEG/PNG），换歌后取一次；空 = 播放器没提供。
  std::string thumbnail;
  bool thumbnail_attempted = false;
  /// 相对上一拍：曲目（app/歌名/歌手/专辑/时长）变了。
  bool track_changed = false;
  /// 相对上一拍：播放/暂停状态变了。
  bool playback_changed = false;
};

/// 采样通知：lparam 为 `new MediaSessionSnapshot`，由窗口线程接管并 delete。
constexpr UINT kMediaSessionUpdateMessage = WM_APP + 0x7B;

/// 轮询 SMTC 的当前媒体会话（Spotify / QQ 音乐 / 网易云 / 浏览器标签等）。
///
/// 单独静态库编译：runner 全局 `_HAS_EXCEPTIONS=0`，而 C++/WinRT 依赖异常，
/// 不能和 runner 同编译单元。使用方只依赖本头文件（纯标准库 + Win32）。
class MediaSessionWatcher {
 public:
  MediaSessionWatcher();
  ~MediaSessionWatcher();

  MediaSessionWatcher(const MediaSessionWatcher&) = delete;
  MediaSessionWatcher& operator=(const MediaSessionWatcher&) = delete;

  /// 启动采样线程；每次采样向 `notify_hwnd` 投递 `notify_message`。
  bool Start(HWND notify_hwnd, UINT notify_message, int poll_interval_ms = 500);
  void Stop();

  /// 最近一次采样（平台线程可随时取，用于 requestNow）。
  bool GetLastSnapshot(MediaSessionSnapshot* out) const;

 private:
  void Run();

  HWND notify_hwnd_ = nullptr;
  UINT notify_message_ = 0;
  int poll_interval_ms_ = 500;
  std::atomic<bool> stop_{false};
  std::thread thread_;

  mutable std::mutex mutex_;
  MediaSessionSnapshot last_{};
};

#endif  // RUNNER_MEDIA_SESSION_WATCHER_H_
