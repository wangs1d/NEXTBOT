"""语音合成：Breeze Blue 优先 → edge-tts 句级回退，文本 → 分句 → 每句 (16kHz wav, 24kHz PCM)。

分句合成是为了「边合成边播」：第一句合成完就立刻驱动口型并开始播放，
后面的句子在播放期间继续合成，不必等整段回复合成完。

- wav(16k 单声道) 给 Ditto 引擎做口型特征提取
- PCM(24k 单声道 s16le) 直接塞给浏览器 WebAudio，按绝对时间轴背靠背调度，
  比 mp3 少一次解码、时长精确（不会因为 mp3 编码延迟导致音画逐句漂移）

Breeze 的接入口径与 server/src/services/tts-service.ts 保持一致：
HTTP POST /v1/text-to-speech/{voice_id}，xi-api-key 鉴权。配置先读进程 env，
缺的从 ../server/.env 补（同一份密钥，单一来源）。

为什么默认 pcm_16000 而不是 mp3_44100_128（2026-11-28 实测）：
- Breeze 没有 /stream 端点（404），整句合成是硬约束，且 mp3 有 ~3s 的
  固定编码开销（2 个字也要 3.2s）；pcm_16000 2 字 2.2s / 22 字 2.9s，
  显著更快，还省掉本地 mp3 解码
- 代价是浏览器侧只有 8kHz 带宽（16k 源上采样），想回音质用
  BREEZE_TTS_OUTPUT_FORMAT=mp3_44100_128 覆盖
"""

import asyncio
import json
import os
import re
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import quote

import edge_tts
import httpx
import numpy as np
from pydub import AudioSegment
import websockets

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
ENGINE_SR = 16000     # 引擎特征提取采样率
BROWSER_SR = 24000    # 浏览器播放采样率（PCM 16bit 单声道）

# server/.env 相对定位（avatar-talk-service/tts.py → E:\ws-project\NextBot\server\.env）
_SERVER_ENV_PATH = Path(__file__).resolve().parent.parent / "server" / ".env"

_BREEZE_ENV_KEYS = (
    "BREEZE_API_KEY", "BREEZE_TTS_VOICE", "BREEZE_TTS_MODEL",
    "BREEZE_TTS_OUTPUT_FORMAT", "BREEZE_TTS_BASE_URL", "BREEZE_TTS_ENABLED",
    "BREEZE_TTS_LANGUAGE",
)


def _read_server_env() -> dict[str, str]:
    """解析 server/.env 的 BREEZE_* 键；注释行跳过，只读不写。"""
    env: dict[str, str] = {}
    try:
        if not _SERVER_ENV_PATH.exists():
            return env
        for line in _SERVER_ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if key in _BREEZE_ENV_KEYS and not env.get(key):
                env[key] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def _breeze_config() -> dict | None:
    """Breeze Blue 配置；未配置 key 或显式关闭（BREEZE_TTS_ENABLED=0）时返回 None。

    与 tts-service.ts 同口径：默认音色 voc_u3nxkd5578wc、breeze-tts-2、
    mp3_44100_128（音质门禁要求 ≥32kHz，不要降到 24kHz）。
    """
    env = {k: os.environ.get(k, "") for k in _BREEZE_ENV_KEYS}
    for key, val in _read_server_env().items():
        if not env.get(key):
            env[key] = val

    enabled = (env.get("BREEZE_TTS_ENABLED") or "1").strip().lower() \
        not in ("0", "false", "no", "off")
    api_key = (env.get("BREEZE_API_KEY") or "").strip()
    if not enabled or not api_key:
        return None
    return {
        "api_key": api_key,
        "base_url": ((env.get("BREEZE_TTS_BASE_URL") or "https://api.breeze.blue/v1")
                     .strip().rstrip("/")),
        "voice_id": (env.get("BREEZE_TTS_VOICE") or "voc_u3nxkd5578wc").strip(),
        "model_id": (env.get("BREEZE_TTS_MODEL") or "breeze-tts-2").strip(),
        "output_format": (env.get("BREEZE_TTS_OUTPUT_FORMAT") or "pcm_16000").strip(),
        "language_code": (env.get("BREEZE_TTS_LANGUAGE") or "").strip(),
    }


async def _breeze_synth(text: str, cfg: dict) -> bytes:
    """Breeze Blue 合成一句，返回 mp3 bytes。任何失败抛异常（由调用方回退 edge-tts）。"""
    url = (f"{cfg['base_url']}/text-to-speech/{quote(cfg['voice_id'])}"
           f"?output_format={quote(cfg['output_format'])}")
    body: dict = {"text": text, "model_id": cfg["model_id"]}
    if cfg["language_code"]:
        body["language_code"] = cfg["language_code"]

    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.post(
            url,
            headers={"xi-api-key": cfg["api_key"], "Content-Type": "application/json"},
            json=body,
        )

    # 非 2xx / 非音频（key 无效、额度用尽时 Breeze 会回 JSON）必须显式判错，
    # 否则错误文本会被当成音频送进引擎，嘴动但没有声音。
    if resp.status_code != 200:
        raise RuntimeError(f"Breeze TTS HTTP {resp.status_code}: {resp.text[:300]}")
    ctype = resp.headers.get("content-type", "")
    if "audio" not in ctype and "octet-stream" not in ctype:
        raise RuntimeError(f"Breeze TTS 返回非音频 ({ctype}): {resp.text[:300]}")
    if len(resp.content) < 128:
        raise RuntimeError(f"Breeze TTS 音频过短 ({len(resp.content)} bytes)")
    return resp.content


class BreezeRealtimeTTS:
    """Breeze Realtime TTS 持久会话（wss .../stream-input，PCM 24k 连续出声）。

    实测（2026-11-28）：TTFA ~0.3s、吞吐 ~1.2× 实时、音频帧 ~0.5-1s 一片连续到达；
    连接建立 ~2.2s，所以跨回复复用同一条连接（服务端空闲 180s 断开，断线后
    下次 ensure 自动重连）。协议见 docs.breezeblue.ai/guides/realtime-text-to-speech。
    """

    def __init__(self, cfg: dict):
        self._cfg = cfg
        self._ws = None
        self._lock = asyncio.Lock()
        self._turn_seq = 0

    async def ensure(self) -> None:
        """建立（或重连）realtime 连接并等到 session.ready。

        连接可能已被服务端关闭（空闲 180s 断开，1001 going away）：
        先 ping 探活，死了就丢弃重连。
        """
        async with self._lock:
            if self._ws is not None:
                try:
                    await asyncio.wait_for(self._ws.ping(), timeout=5.0)
                    return
                except Exception:  # noqa: BLE001
                    try:
                        await self._ws.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._ws = None
            cfg = self._cfg
            uri = (f"wss://api.breeze.blue/v1/text-to-speech/{quote(cfg['voice_id'])}"
                   f"/stream-input?model_id={quote(cfg['model_id'])}"
                   f"&inactivity_timeout_seconds=180")
            ws = await websockets.connect(
                uri, additional_headers={"xi-api-key": cfg["api_key"]},
                open_timeout=15, max_size=None,
            )
            try:
                while True:
                    ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if ev.get("type") == "session.ready":
                        self._ws = ws
                        return
                    if ev.get("type") == "error":
                        raise RuntimeError(f"Breeze realtime: {ev.get('message', ev)}")
            except Exception:
                await ws.close()
                raise

    async def start_turn(self) -> str:
        self._turn_seq += 1
        turn_id = f"turn_{self._turn_seq}_{int(time.time() * 1000) % 100000}"
        await self.ensure()
        await self._ws.send(json.dumps({"type": "turn.start", "turn_id": turn_id}))
        return turn_id

    async def say_sentence(self, text: str) -> None:
        """append 一句并 flush：服务端在句界自然合成。"""
        await self._ws.send(json.dumps({"type": "text.append", "text": text}))
        await self._ws.send(json.dumps({"type": "text.flush"}))

    async def end_turn(self) -> None:
        await self._ws.send(json.dumps({"type": "turn.end"}))

    async def cancel_turn(self) -> None:
        """异常中断时取消当前 turn，保持会话可继续（best-effort）。"""
        if self._ws is None:
            return
        try:
            await self._ws.send(json.dumps({"type": "turn.cancel"}))
        except Exception:  # noqa: BLE001
            pass

    async def recv(self, timeout: float = 30.0):
        """收一条消息：('audio', bytes) 或 ('event', dict)。超时/断线抛异常。"""
        msg = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
        if isinstance(msg, (bytes, bytearray)):
            return ("audio", bytes(msg))
        return ("event", json.loads(msg))

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "session.close"}))
            except Exception:  # noqa: BLE001
                pass
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None


_realtime: BreezeRealtimeTTS | None = None


def get_realtime() -> BreezeRealtimeTTS | None:
    """进程级 realtime 会话单例；Breeze 未配置时返回 None。"""
    global _realtime
    cfg = _breeze_config()
    if cfg is None:
        return None
    if _realtime is None:
        _realtime = BreezeRealtimeTTS(cfg)
    return _realtime


def split_sentences(text: str, min_len: int = 3, max_len: int = 48) -> list[str]:
    """按句末标点切分，极短碎片合并、过长再按逗号切。

    切得太碎会让 edge-tts 每段都重新起调，句间语感不自然；切得太长又起不到
    「首句先播」的效果。这里以句末标点为主，仅在单句超过 max_len 时才动逗号。
    min_len 只合并「好。」「嗯！」这种一两个字的碎片，避免把一句短短的「好的。」
    和后面很长的句子捆在一起、白白拖慢开口时间。
    """
    text = (text or "").strip()
    if not text:
        return []

    parts = re.findall(r"[^。！？!?；;…\n]+[。！？!?；;…]*", text)
    merged: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # 「好。」「嗯！」这类极短句并入上一句，避免出现 0.3s 的碎片音频
        if merged and len(merged[-1]) < min_len:
            merged[-1] += p
        else:
            merged.append(p)

    out: list[str] = []
    for p in merged:
        while len(p) > max_len:
            cut = max(
                p.rfind("，", 0, max_len),
                p.rfind(",", 0, max_len),
                p.rfind("、", 0, max_len),
            )
            if cut < min_len:
                cut = max_len - 1
            out.append(p[: cut + 1].strip())
            p = p[cut + 1:].strip()
        if p:
            out.append(p)
    return out or [text]


def split_speech_chunks(text: str, max_len: int = 64) -> list[str]:
    """合并短句，让 edge-tts 在一段内保留自然语调，长回复仍分块流式合成。"""
    chunks: list[str] = []
    for part in split_sentences(text, max_len=max_len):
        if chunks and len(chunks[-1]) + len(part) <= max_len:
            chunks[-1] += part
        else:
            chunks.append(part)
    return chunks


def _trim_leading_silence_pcm(samples: np.ndarray, sr: int) -> np.ndarray:
    """PCM（int16 单声道）版开头静音裁剪，逻辑与 mp3 路径的 _trim_leading_silence 一致。

    口型运动从音频第 0 秒开始算，不裁会导致画面比声音「早」，口型对不上。
    """
    if samples.size == 0:
        return samples
    f32 = samples.astype(np.float32)
    peak = float(np.max(np.abs(f32)))
    if peak <= 0:
        return samples
    idx = int(np.argmax(np.abs(f32) > peak * 0.02))
    if 0 < idx < sr // 2:      # 最多裁 0.5s
        return samples[idx:]
    return samples


def _resample_int16(samples: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """线性插值重采样（int16）。语音场景足够，无额外依赖。"""
    if src_sr == dst_sr or samples.size == 0:
        return samples
    n_out = int(round(samples.size * dst_sr / src_sr))
    pos = np.linspace(0.0, samples.size - 1.0, num=n_out)
    out = np.interp(pos, np.arange(samples.size, dtype=np.float64),
                    samples.astype(np.float64))
    return np.clip(np.round(out), -32768, 32767).astype(np.int16)


def _write_wav16(path: str, samples: np.ndarray) -> None:
    """写 16kHz 单声道 s16 wav，供引擎 wav2feat 提取口型特征。"""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(ENGINE_SR)
        wf.writeframes(samples.astype("<i2").tobytes())


def _trim_leading_silence(audio: AudioSegment) -> AudioSegment:
    """裁掉开头静音。

    edge-tts 的 mp3 一般有 50~200ms 静音，而口型运动从音频第 0 秒开始算，
    不裁会导致画面比声音「早」，看起来口型对不上。

    注意：numpy 得到的是「采样点数」，pydub 切片用的是「毫秒」，必须换算，
    否则会把整段音频裁掉。
    """
    samples = np.array(audio.get_array_of_samples(), dtype=np.float32)
    if samples.size == 0:
        return audio
    peak = float(np.max(np.abs(samples)))
    if peak <= 0:
        return audio
    idx = int(np.argmax(np.abs(samples) > peak * 0.02))
    if 0 < idx < audio.frame_rate // 2:      # 最多裁 0.5s
        ms = int(idx * 1000 / audio.frame_rate)
        if 0 < ms < len(audio):
            return audio[ms:]
    return audio


# 清扫参数可用环境变量覆盖（12-Factor：部署相关边界值走环境配置）
_PRUNE_INTERVAL_S = float(os.getenv("TTS_PRUNE_INTERVAL_S", "600"))       # 节流：默认 10 分钟一次
_PRUNE_MAX_AGE_S = float(os.getenv("TTS_PRUNE_MAX_AGE_S", "3600"))        # 默认保留 1 小时（引擎整段语音渲染期间还要读它）
_prune_last_ts = 0.0


def _prune_tts_wavs(out_dir: str):
    """周期性清扫历史 TTS wav。

    每句落盘一个 tts_*.wav，原来从不删除，目录只增不减（2C2G 小盘会被吃满）。
    引擎只在本次语音渲染期间读取该文件，保留期远超最长语音；按
    TTS_PRUNE_INTERVAL_S（默认 10 分钟）节流 listdir，摊薄开销。
    """
    global _prune_last_ts
    now = time.monotonic()
    if now - _prune_last_ts < _PRUNE_INTERVAL_S:
        return
    _prune_last_ts = now
    try:
        cutoff = time.time() - _PRUNE_MAX_AGE_S
        removed = 0
        for name in os.listdir(out_dir):
            if not (name.startswith("tts_") or name.startswith("tmp_")):
                continue
            path = os.path.join(out_dir, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue  # 文件正在被引擎读取等情况，下轮再清
        if removed:
            print(f"[tts] 清扫历史 wav：删除 {removed} 个", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[tts] wav 清扫失败: {exc}", flush=True)


async def synth_sentence(text: str, out_dir: str, voice: str = DEFAULT_VOICE,
                         tag: str | None = None) -> dict:
    """合成一句，返回 {"wav", "pcm", "sample_rate", "dur_ms", "text", "provider"}。

    pcm 是 24k/16bit/单声道裸流，前端直接用 WebAudio 建 AudioBuffer 播放。
    provider 是实际使用的引擎（"breeze" / "edge"）；Breeze 生效时音色固定用
    BREEZE_TTS_VOICE，voice 参数只对 edge-tts 回退生效。
    """
    _prune_tts_wavs(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    tag = tag or f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
    tmp_mp3 = os.path.join(out_dir, f"tmp_{tag}.mp3")

    provider = "edge"
    audio_bytes: bytes | None = None
    fmt = ""
    cfg = _breeze_config()
    if cfg is not None:
        try:
            audio_bytes = await _breeze_synth(text, cfg)
            fmt = cfg["output_format"]
            provider = "breeze"
        except Exception as exc:  # noqa: BLE001
            # 单句失败不打断整段回复，按句回退 edge-tts
            print(f"[tts] Breeze 失败，本句回退 edge-tts: {exc}", flush=True)

    if provider == "breeze" and fmt.startswith("pcm_"):
        # PCM 直出快速路径：无 mp3 编解码开销，引擎拿重采样后的 16k，
        # 浏览器拿 24k（16k 源上采样，带宽 8kHz；要音质用 mp3_44100_128 覆盖）
        src_sr = int(fmt[4:])
        samples = np.frombuffer(audio_bytes, dtype=np.int16)
        samples = _trim_leading_silence_pcm(samples, src_sr)
        wav_path = os.path.join(out_dir, f"tts_{tag}.wav")
        _write_wav16(wav_path, _resample_int16(samples, src_sr, ENGINE_SR))
        if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 1000:
            raise RuntimeError("TTS 合成结果异常（wav 过小）")
        return {
            "wav": wav_path,
            "pcm": _resample_int16(samples, src_sr, BROWSER_SR).tobytes(),
            "sample_rate": BROWSER_SR,
            "dur_ms": int(round(samples.size * 1000 / src_sr)),
            "text": text,
            "provider": "breeze",
        }

    if provider == "breeze":
        # mp3/wav 等容器格式：落盘走 pydub 解码（原逻辑，兼顾音质档）
        with open(tmp_mp3, "wb") as f:
            f.write(audio_bytes or b"")
    else:
        await edge_tts.Communicate(text, voice).save(tmp_mp3)

    # 保留原始采样率（edge 一般 24k，Breeze 44.1k），先裁头静音，再分别给引擎和浏览器
    audio = AudioSegment.from_file(tmp_mp3).set_channels(1)
    audio = _trim_leading_silence(audio)
    os.remove(tmp_mp3)

    wav_path = os.path.join(out_dir, f"tts_{tag}.wav")
    with open(wav_path, "wb") as f:
        audio.set_frame_rate(ENGINE_SR).export(f, format="wav")

    pcm = audio.set_frame_rate(BROWSER_SR).raw_data   # s16le 单声道
    dur_ms = int(round(len(audio)))

    if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 1000:
        raise RuntimeError("TTS 合成结果异常（wav 过小）")

    return {
        "wav": wav_path,
        "pcm": pcm,
        "sample_rate": BROWSER_SR,
        "dur_ms": dur_ms,
        "text": text,
        "provider": provider,
    }
