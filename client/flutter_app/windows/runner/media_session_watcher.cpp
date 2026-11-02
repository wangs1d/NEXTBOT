#include "media_session_watcher.h"

#include <cctype>
#include <chrono>
#include <cstdio>
#include <vector>

// C++/WinRT 要求经典 COM 接口先于投影头可见
#include <unknwn.h>

// C++/WinRT 投影（Windows SDK cppwinrt 头，见 runner/CMakeLists.txt）。
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>

namespace {

namespace wmc = winrt::Windows::Media::Control;

/// 音乐客户端名单：只有这些应用的会话算「在放歌」。
///
/// 判据只能是来源应用——实测直播间（抖音）上报的 PlaybackType 同样是 Music、
/// 还带 84s 假时长，任何「像不像一首歌」的属性判断都会漏。浏览器标签、直播间、
/// 游戏语音只是「有声音」，命中不了名单就当没有会话：岛屿不出音乐卡，Dart 也不
/// 会为它们打服务端拉歌词。新播放器要上岛，在这里加一条它 AUMID 里的稳定片段。
bool IsMusicApp(const std::string& app_id) {
  static constexpr const char* kTokens[] = {
      "soda",     "汽水",      "cloudmusic", "网易云",   "netease", "qqmusic",
      "qq音乐",   "spotify",   "itunes",     "apple music", "applemusic",
      "kugou",    "酷狗",      "kuwo",       "酷我",     "migu",    "咪咕",
      "musicbee", "foobar",    "波点",       "deezer",
  };
  if (app_id.empty()) return false;
  std::string lowered;
  lowered.reserve(app_id.size());
  for (unsigned char c : app_id) {
    lowered.push_back(
        c < 0x80 ? static_cast<char>(std::tolower(static_cast<int>(c)))
                 : static_cast<char>(c));
  }
  for (const char* token : kTokens) {
    if (lowered.find(token) != std::string::npos) return true;
  }
  return false;
}

int64_t NowEpochMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

double ToSeconds(winrt::Windows::Foundation::TimeSpan const& span) {
  return std::chrono::duration<double>(span).count();
}

std::string ToUtf8(winrt::hstring const& value) {
  return value.empty() ? std::string() : winrt::to_string(value);
}

/// 曲目标识：任一字段变化都视为换歌（时长取整秒，避免 WinRT 抖动）。
std::string TrackKey(MediaSessionSnapshot const& snapshot) {
  char duration[32] = {};
  std::snprintf(duration, sizeof(duration), "%.0f", snapshot.duration_sec);
  return snapshot.app_id + "\x1f" + snapshot.title + "\x1f" + snapshot.artist +
         "\x1f" + snapshot.album + "\x1f" + duration;
}

MediaSessionSnapshot Sample(
    wmc::GlobalSystemMediaTransportControlsSessionManager const& manager,
    MediaSessionSnapshot const& previous) {
  MediaSessionSnapshot snapshot;
  snapshot.sampled_at_epoch_ms = NowEpochMs();

  wmc::GlobalSystemMediaTransportControlsSession session{nullptr};
  try {
    session = manager.GetCurrentSession();
  } catch (...) {
    session = nullptr;
  }
  if (!session) {
    snapshot.track_changed = previous.has_session;
    snapshot.playback_changed = previous.has_session;
    return snapshot;
  }

  snapshot.has_session = true;
  try {
    snapshot.app_id = ToUtf8(session.SourceAppUserModelId());
  } catch (...) {
  }
  if (!IsMusicApp(snapshot.app_id)) {
    // 非音乐客户端：这一拍当作系统里没有媒体会话。
    snapshot = MediaSessionSnapshot{};
    snapshot.sampled_at_epoch_ms = NowEpochMs();
    snapshot.track_changed = previous.has_session;
    snapshot.playback_changed = previous.has_session;
    return snapshot;
  }

  // 同一首歌沿用上一次的封面；换歌才重新取。
  snapshot.thumbnail = previous.thumbnail;
  snapshot.thumbnail_attempted = previous.thumbnail_attempted;
  bool new_track = false;
  try {
    auto properties = session.TryGetMediaPropertiesAsync().get();
    if (properties) {
      snapshot.title = ToUtf8(properties.Title());
      snapshot.artist = ToUtf8(properties.Artist());
      snapshot.album = ToUtf8(properties.AlbumTitle());
      new_track =
          !previous.has_session || TrackKey(previous) != TrackKey(snapshot);
      if (new_track) {
        snapshot.thumbnail.clear();
        snapshot.thumbnail_attempted = false;
      }
      // SMTC 缩略图是流引用，每拍 OpenReadAsync 会把采样线程拖慢；同一首歌
      // 封面不变，每首只取一次（取不到也不重试，别 500ms 空转）。
      if (!snapshot.thumbnail_attempted) {
        snapshot.thumbnail_attempted = true;
        try {
          auto thumbnail = properties.Thumbnail();
          if (thumbnail) {
            auto stream = thumbnail.OpenReadAsync().get();
            if (stream) {
              const uint64_t size = stream.Size();
              if (size > 0 && size <= 4 * 1024 * 1024) {
                winrt::Windows::Storage::Streams::DataReader reader(stream);
                reader.LoadAsync(static_cast<uint32_t>(size)).get();
                std::vector<uint8_t> bytes(static_cast<size_t>(size));
                reader.ReadBytes(bytes);
                snapshot.thumbnail.assign(
                    reinterpret_cast<const char*>(bytes.data()), bytes.size());
              }
            }
          }
        } catch (...) {
        }
      }
    }
  } catch (...) {
  }

  try {
    const auto status = session.GetPlaybackInfo().PlaybackStatus();
    snapshot.playing =
        status == wmc::GlobalSystemMediaTransportControlsSessionPlaybackStatus::
                      Playing;
    snapshot.paused =
        status == wmc::GlobalSystemMediaTransportControlsSessionPlaybackStatus::
                      Paused;
  } catch (...) {
  }

  try {
    const auto timeline = session.GetTimelineProperties();
    snapshot.duration_sec = ToSeconds(timeline.EndTime());
    double position = ToSeconds(timeline.Position());
    // SMTC 的时间轴是「上次更新时刻」的采样值；播放中按墙钟外推，
    // 否则两次轮询之间进度会是阶梯状。
    if (snapshot.playing) {
      const auto elapsed = winrt::clock::now() - timeline.LastUpdatedTime();
      position += std::chrono::duration<double>(elapsed).count();
    }
    if (position < 0.0) position = 0.0;
    if (snapshot.duration_sec > 0.0 && position > snapshot.duration_sec) {
      position = snapshot.duration_sec;
    }
    snapshot.position_sec = position;
  } catch (...) {
  }

  snapshot.track_changed =
      !previous.has_session || TrackKey(previous) != TrackKey(snapshot);
  snapshot.playback_changed = previous.playing != snapshot.playing ||
                              previous.paused != snapshot.paused;
  return snapshot;
}

}  // namespace

MediaSessionWatcher::MediaSessionWatcher() = default;

MediaSessionWatcher::~MediaSessionWatcher() { Stop(); }

bool MediaSessionWatcher::Start(HWND notify_hwnd, UINT notify_message,
                                int poll_interval_ms) {
  Stop();
  notify_hwnd_ = notify_hwnd;
  notify_message_ = notify_message;
  poll_interval_ms_ = poll_interval_ms >= 100 ? poll_interval_ms : 500;
  stop_.store(false);
  thread_ = std::thread([this]() { Run(); });
  return true;
}

void MediaSessionWatcher::Stop() {
  stop_.store(true);
  if (thread_.joinable()) thread_.join();
}

bool MediaSessionWatcher::GetLastSnapshot(MediaSessionSnapshot* out) const {
  if (!out) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  *out = last_;
  return out->has_session;
}

void MediaSessionWatcher::Run() {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
  } catch (...) {
    return;
  }

  wmc::GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  try {
    manager =
        wmc::GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .get();
  } catch (...) {
    manager = nullptr;
  }

  MediaSessionSnapshot previous;
  while (!stop_.load()) {
    MediaSessionSnapshot snapshot;
    if (!manager) {
      try {
        manager = wmc::GlobalSystemMediaTransportControlsSessionManager::
            RequestAsync()
                .get();
      } catch (...) {
        manager = nullptr;
      }
    }
    if (manager) {
      try {
        snapshot = Sample(manager, previous);
      } catch (...) {
        snapshot = MediaSessionSnapshot{};
        snapshot.sampled_at_epoch_ms = NowEpochMs();
      }
    } else {
      snapshot.sampled_at_epoch_ms = NowEpochMs();
      snapshot.track_changed = previous.has_session;
      snapshot.playback_changed = previous.has_session;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      last_ = snapshot;
    }

    // 没会话且状态没变就不打扰窗口线程；有会话时按节拍上报进度。
    const bool worth_notifying = snapshot.has_session ||
                                 snapshot.track_changed ||
                                 snapshot.playback_changed;
    if (worth_notifying && notify_hwnd_ && notify_message_) {
      auto* payload = new MediaSessionSnapshot(snapshot);
      if (!PostMessageW(notify_hwnd_, notify_message_, 0,
                        reinterpret_cast<LPARAM>(payload))) {
        delete payload;
      }
    }

    previous = snapshot;

    const int steps = poll_interval_ms_ / 50;
    for (int i = 0; i < steps && !stop_.load(); ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  }

  try {
    winrt::uninit_apartment();
  } catch (...) {
  }
}
