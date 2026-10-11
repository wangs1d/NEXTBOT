#include "pcm_stream_player.h"

#include <algorithm>

PcmStreamPlayer::~PcmStreamPlayer() {
  Stop();
}

void CALLBACK PcmStreamPlayer::WaveCallback(HWAVEOUT /*hwo*/, UINT msg,
                                            DWORD_PTR inst, DWORD_PTR param1,
                                            DWORD_PTR /*param2*/) {
  if (msg != WOM_DONE) return;
  auto* self = reinterpret_cast<PcmStreamPlayer*>(inst);
  if (!self) return;

  // 音频线程：拿不到锁就立刻放弃。多半是 Stop/Finish 正在 Teardown，
  // 或本次回调由锁内 waveOutReset 同步触发——绝不阻塞等待，否则死锁。
  std::unique_lock<std::mutex> lock(self->mutex_, std::try_to_lock);
  if (!lock.owns_lock()) return;

  auto* hdr = reinterpret_cast<WAVEHDR*>(param1);
  if (!hdr) return;
  auto* slot = reinterpret_cast<Slot*>(hdr->dwUser);
  if (!slot || !slot->in_use) return;

  slot->in_use = false;
  if (self->queued_ > 0) self->queued_--;
  self->PumpLocked();
}

bool PcmStreamPlayer::Start(int sample_rate_hz, int channels) {
  Stop();
  std::lock_guard<std::mutex> lock(mutex_);
  if (sample_rate_hz <= 0 || channels <= 0) return false;

  WAVEFORMATEX wfx{};
  wfx.wFormatTag = WAVE_FORMAT_PCM;
  wfx.nChannels = static_cast<WORD>(channels);
  wfx.nSamplesPerSec = static_cast<DWORD>(sample_rate_hz);
  wfx.wBitsPerSample = 16;
  wfx.nBlockAlign = static_cast<WORD>(channels * 2);
  wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;
  wfx.cbSize = 0;

  MMRESULT r = waveOutOpen(
      &hwo_, WAVE_MAPPER, &wfx,
      reinterpret_cast<DWORD_PTR>(&PcmStreamPlayer::WaveCallback),
      reinterpret_cast<DWORD_PTR>(this), CALLBACK_FUNCTION);
  if (r != MMSYSERR_NOERROR) {
    hwo_ = nullptr;
    return false;
  }

  slot_bytes_ = static_cast<size_t>(wfx.nAvgBytesPerSec) * kSlotMs / 1000;
  if (slot_bytes_ < static_cast<size_t>(wfx.nBlockAlign) * 8) {
    slot_bytes_ = static_cast<size_t>(wfx.nBlockAlign) * 8;
  }
  slot_bytes_ -= slot_bytes_ % wfx.nBlockAlign;

  prebuffer_bytes_ =
      static_cast<size_t>(wfx.nAvgBytesPerSec) * kPrebufferMs / 1000;
  prebuffer_bytes_ -= prebuffer_bytes_ % wfx.nBlockAlign;
  const size_t max_prebuffer = slot_bytes_ * kSlotCount / 2;
  if (prebuffer_bytes_ > max_prebuffer) prebuffer_bytes_ = max_prebuffer;

  for (auto& s : slots_) {
    s.data.assign(slot_bytes_, 0);
    s.hdr = WAVEHDR{};
    s.hdr.lpData = reinterpret_cast<LPSTR>(s.data.data());
    s.hdr.dwBufferLength = 0;
    s.hdr.dwFlags = 0;
    s.hdr.dwUser = reinterpret_cast<DWORD_PTR>(&s);
    s.in_use = false;
    if (waveOutPrepareHeader(hwo_, &s.hdr, sizeof(WAVEHDR)) !=
        MMSYSERR_NOERROR) {
      TeardownLocked();  // 回滚半成品流（已准备的槽位会被拆掉）
      return false;
    }
  }

  pending_.clear();
  queued_ = 0;
  started_ = false;
  eof_ = false;
  running_ = true;
  return true;
}

void PcmStreamPlayer::Write(const uint8_t* data, size_t size) {
  if (!data || size == 0) return;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_ || !hwo_ || eof_) return;
  pending_.insert(pending_.end(), data, data + size);
  PumpLocked();
}

void PcmStreamPlayer::Finish() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_ || eof_) return;
  eof_ = true;
  PumpLocked();
  MaybeNotifyDoneLocked();
  // 兜底：若设备写入持续失败（pending 排不掉、又没有任何槽位在播），
  // 直接丢弃残留后收尾，避免状态悬死导致 Dart 侧 await finish() 永不返回。
  if (running_ && queued_ == 0 && !pending_.empty()) {
    pending_.clear();
    MaybeNotifyDoneLocked();
  }
}

void PcmStreamPlayer::Stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  TeardownLocked();
}

bool PcmStreamPlayer::IsPlaying() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return running_ && (queued_ > 0 || !pending_.empty());
}

PcmStreamPlayer::Slot* PcmStreamPlayer::FindFreeSlotLocked() {
  for (auto& s : slots_) {
    if (!s.in_use) return &s;
  }
  return nullptr;
}

void PcmStreamPlayer::PumpLocked() {
  if (!running_ || !hwo_) return;

  // 启动预缓冲：首次出声前先攒一小段，避免"播一丁点就断"的细碎断续。
  // eof_ 后不再等待，把剩余数据（含不足一槽的尾巴）尽快播完。
  if (!started_ && !eof_ && pending_.size() < prebuffer_bytes_) return;

  while (!pending_.empty()) {
    Slot* s = FindFreeSlotLocked();
    if (!s) break;

    size_t n = pending_.size() < slot_bytes_ ? pending_.size() : slot_bytes_;
    n -= n % 2;  // 16bit 采样不能拆半
    if (n == 0) {
      if (eof_) pending_.clear();  // 尾部残字节（异常），丢弃以免卡住收尾
      break;
    }

    std::copy(pending_.begin(), pending_.begin() + static_cast<std::ptrdiff_t>(n),
              s->data.begin());
    pending_.erase(pending_.begin(),
                   pending_.begin() + static_cast<std::ptrdiff_t>(n));

    s->hdr.dwBufferLength = static_cast<DWORD>(n);
    s->hdr.dwFlags = WHDR_PREPARED;  // 复用：保留已准备位，清掉上一轮的 DONE
    s->in_use = true;
    if (waveOutWrite(hwo_, &s->hdr, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
      s->in_use = false;
      break;
    }
    started_ = true;
    queued_++;
  }

  MaybeNotifyDoneLocked();
}

void PcmStreamPlayer::MaybeNotifyDoneLocked() {
  if (!running_) return;
  if (!eof_) return;
  if (!pending_.empty() || queued_ > 0) return;

  const HWND hwnd = notify_hwnd_;
  const UINT msg = notify_msg_;
  TeardownLocked();
  if (hwnd && msg) {
    // PostMessage 只入队不阻塞；平台线程收到后安全地 InvokeMethod 给 Dart
    ::PostMessage(hwnd, msg, 0, 0);
  }
}

void PcmStreamPlayer::TeardownLocked() {
  if (hwo_) {
    waveOutReset(hwo_);  // 会同步触发在队列槽位的 WOM_DONE，回调 try_lock 失败即返回
    for (auto& s : slots_) {
      s.in_use = false;
      if (s.hdr.dwFlags & WHDR_PREPARED) {
        waveOutUnprepareHeader(hwo_, &s.hdr, sizeof(WAVEHDR));
      }
      s.hdr.dwFlags = 0;
    }
    waveOutClose(hwo_);
  }
  hwo_ = nullptr;
  pending_.clear();
  queued_ = 0;
  started_ = false;
  eof_ = false;
  running_ = false;
}
