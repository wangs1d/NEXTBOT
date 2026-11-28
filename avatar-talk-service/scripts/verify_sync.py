"""走真实 WebSocket 链路抓帧并合成视频，用于验证音画是否对齐。

与 test_stream（直接调引擎）不同，这里完全模拟浏览器行为：
连 WS → 发文本 → 收二进制帧 → 按时间戳落盘 → 与 TTS 音频合成 mp4。

语音按句流式下发（speak_start / speak_chunk，裸 PCM），脚本按 offset 拼回整段音频。
"""
import asyncio
import base64
import json
import os
import struct
import subprocess
import sys
import time
import wave

import cv2
import numpy as np
import websockets

TEXT = sys.argv[1] if len(sys.argv) > 1 else "大家好，我来给大家演示一下实时口型同步的效果。我们边合成边播，开口会更快。"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"D:\Ditto\tmp\ws_verify.mp4"
FPS = 13

frames: dict[int, bytes] = {}
chunks: list[dict] = []
first_at = None
t_speak_start = None


def build_wav(path: str):
    """按每句的 offset 把 PCM 拼回整段音频（中间空档补零）。"""
    if not chunks:
        return None
    sr = chunks[0]["sampleRate"]
    total = max(int(c["offsetMs"] * sr / 1000) + len(c["pcm"]) for c in chunks)
    buf = np.zeros(total, dtype=np.int16)
    for c in chunks:
        start = int(c["offsetMs"] * sr / 1000)
        buf[start:start + len(c["pcm"])] = c["pcm"]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(buf.astype("<i2").tobytes())
    return path, total / sr


async def main():
    global first_at, t_speak_start, FPS

    async with websockets.connect("ws://127.0.0.1:8765/ws", max_size=8 * 1024 * 1024) as ws:
        ready = json.loads(await ws.recv())
        FPS = int(ready.get("fps", FPS))
        print(f"ready fps={FPS} prebuffer={ready.get('prebuffer')}", flush=True)

        t0 = time.time()
        await ws.send(json.dumps({"type": "say", "text": TEXT}))

        n_idle = 0

        while True:
            msg = await ws.recv()
            if isinstance(msg, str):
                data = json.loads(msg)
                if data["type"] == "speak_start":
                    t_speak_start = time.time() - t0
                    audio = data["audio"]
                    pcm = np.frombuffer(base64.b64decode(audio["data"]), dtype="<i2")
                    chunks.append({"offsetMs": data.get("offset_ms", 0),
                                   "sampleRate": audio["sampleRate"], "pcm": pcm})
                    print(f"speak_start tts={data.get('tts_ms')}ms chunks={data.get('chunks')} "
                          f"首句 {len(pcm) / audio['sampleRate']:.2f}s", flush=True)
                elif data["type"] == "speak_chunk":
                    audio = data["audio"]
                    pcm = np.frombuffer(base64.b64decode(audio["data"]), dtype="<i2")
                    chunks.append({"offsetMs": data.get("offset_ms", 0),
                                   "sampleRate": audio["sampleRate"], "pcm": pcm})
                    print(f"speak_chunk #{data.get('index')} offset={data.get('offset_ms')}ms "
                          f"dur={data.get('dur_ms')}ms", flush=True)
                elif data["type"] in ("speak_end", "error"):
                    if data["type"] == "error":
                        print("ERROR:", data.get("message"), flush=True)
                    break
                continue

            idx, ts = struct.unpack("<IH", msg[:6])
            if ts == 0xFFFF:
                n_idle += 1
                continue

            if first_at is None:
                first_at = time.time() - t0
                print(f"首帧 {first_at:.2f}s（speak_start {t_speak_start:.2f}s，"
                      f"合成后到首帧 {first_at - t_speak_start:.2f}s）", flush=True)
            frames[idx] = msg[6:]

        print(f"收到说话帧 {len(frames)} 个（跳过 idle {n_idle} 个），"
              f"首帧 {first_at:.2f}s，整段收完 {time.time() - t0:.2f}s", flush=True)

        audio_path = os.path.join(os.path.dirname(OUT), "ws_verify_audio.wav")
        built = build_wav(audio_path)
        if built is None:
            raise RuntimeError("没有任何语音块")
        audio_path, audio_s = built
        print(f"音频 {audio_s:.2f}s | 总耗时 {time.time() - t0:.2f}s", flush=True)

        # 按全局帧序号写入视频（时间戳严格 = idx/FPS）
        sample = cv2.imdecode(np.frombuffer(next(iter(frames.values())), np.uint8), cv2.IMREAD_COLOR)
        h, w = sample.shape[:2]
        tmp = OUT + ".tmp.mp4"
        vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (w, h))

        max_idx = max(frames)
        written = 0
        last_frame = None
        for i in range(max_idx + 1):
            buf = frames.get(i)
            if buf is not None:
                last_frame = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
            if last_frame is None:
                continue
            vw.write(last_frame)
            written += 1
        vw.release()

        cmd = (
            f'ffmpeg -loglevel error -y -i "{tmp}" -i "{audio_path}" '
            f'-map 0:v -map 1:a -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -shortest "{OUT}"'
        )
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-500:])
        os.remove(tmp)

        print(f"写入 {written}/{max_idx + 1} 帧，输出 {OUT}", flush=True)


asyncio.run(main())
