#ifndef RUNNER_PCM_STREAM_PLAYER_H_
#define RUNNER_PCM_STREAM_PLAYER_H_

#include <windows.h>

#include <mmsystem.h>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <vector>

// 低延迟 PCM16 流式播放器（waveOut 多缓冲轮转）。
//
// 用于 MiniMax realtime 的流式语音：服务端把助手回复切成小块（24kHz 单声道
// PCM16 裸流）逐段下发，客户端边收边喂进这里——第一块到达（攒够预缓冲）即
// 出声，不必等整轮音频生成完毕。这是"首字延迟只等首包"的关键一环。
//
// 线程模型：
//   - Start/Write/Finish/Stop 由 Flutter 平台线程调用；
//   - waveOut 完成回调在音频线程，只做"回收槽位 + 尝试续填"，经 try_lock
//     拿不到锁就立即返回（避免 waveOutReset 重入死锁），绝不触碰 Flutter 对象；
//   - 播放自然结束时用 PostMessage 把通知弹回平台线程（SetNotifyTarget 绑定），
//     由平台线程安全地 InvokeMethod 给 Dart。
class PcmStreamPlayer {
 public:
  PcmStreamPlayer() = default;
  ~PcmStreamPlayer();

  PcmStreamPlayer(const PcmStreamPlayer&) = delete;
  PcmStreamPlayer& operator=(const PcmStreamPlayer&) = delete;

  // 绑定"播放自然结束"的通知目标：结束时 PostMessage(hwnd, msg, 0, 0)。
  void SetNotifyTarget(HWND hwnd, UINT msg) {
    notify_hwnd_ = hwnd;
    notify_msg_ = msg;
  }

  // 开播一段新流（会先停掉上一段）。失败返回 false（设备被占用/参数非法）。
  bool Start(int sample_rate_hz, int channels);

  // 追加一段 PCM16 LE 数据（长度应为偶数）。
  void Write(const uint8_t* data, size_t size);

  // 输入结束：播完已入队数据后自动停机并发出完成通知。
  void Finish();

  // 立即停止（打断）：丢弃全部缓冲，不发完成通知。
  void Stop();

  // 是否仍在出声（有数据已入队或在缓冲）。
  bool IsPlaying() const;

 private:
  struct Slot {
    WAVEHDR hdr{};
    std::vector<uint8_t> data;
    bool in_use = false;
  };

  static constexpr int kSlotCount = 8;
  // 每个槽位承载的音频时长：小槽位降低尾延迟，多槽位吸收网络抖动
  static constexpr int kSlotMs = 30;
  // 启动预缓冲：攒够这么多音频才开始出声，避免"播一丁点就断"的细碎感
  static constexpr int kPrebufferMs = 60;

  static void CALLBACK WaveCallback(HWAVEOUT hwo, UINT msg, DWORD_PTR inst,
                                    DWORD_PTR param1, DWORD_PTR param2);

  Slot* FindFreeSlotLocked();
  void PumpLocked();
  void MaybeNotifyDoneLocked();
  void TeardownLocked();

  mutable std::mutex mutex_;
  HWAVEOUT hwo_ = nullptr;
  HWND notify_hwnd_ = nullptr;
  UINT notify_msg_ = 0;

  Slot slots_[kSlotCount];
  std::deque<uint8_t> pending_;
  size_t slot_bytes_ = 0;
  size_t prebuffer_bytes_ = 0;
  int queued_ = 0;       // 已入队、尚未播完的槽位数
  bool running_ = false;
  bool started_ = false;  // 本流是否已首次出声
  bool eof_ = false;      // Finish 已调用
};

#endif  // RUNNER_PCM_STREAM_PLAYER_H_
