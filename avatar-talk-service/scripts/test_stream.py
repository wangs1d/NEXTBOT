"""验证 Ditto 流式引擎：实时性（能否跟上播放）+ 音画同步 + 抽帧质量。

用法：
    python test_stream.py <音频wav> <输出mp4> [avatar]
"""
import subprocess
import sys
import time

sys.path.insert(0, r"E:\ws-project\NextBot\avatar-talk-service")

import cv2
import librosa
import numpy as np

from engine.ditto_engine import DittoEngine

AVATAR = sys.argv[3] if len(sys.argv) > 3 else r"D:\Ditto\sources\user_avatar.png"
WAV = sys.argv[1] if len(sys.argv) > 1 else r"D:\Ditto\sources\zh_test.wav"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"D:\Ditto\tmp\stream_test.mp4"

MOTION_FPS = 25      # 运动时间轴
RENDER_FPS = int(sys.argv[4]) if len(sys.argv) > 4 else 12   # 实际渲染/播放帧率

eng = DittoEngine(AVATAR, use_graph=True)
eng.warmup()

audio, _ = librosa.load(WAV, sr=16000)
dur = len(audio) / 16000
print(f"音频 {dur:.2f}s，渲染 {RENDER_FPS}fps", flush=True)

# 25fps 运动时间轴 -> RENDER_FPS：均匀抽帧
if RENDER_FPS >= 25:
    KEEP_ALL = True
    step = 1
else:
    KEEP_ALL = False
    step = 25 / RENDER_FPS

w, h = eng.avatar_size
tmp = OUT + ".tmp.mp4"
vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), RENDER_FPS, (w, h))

t0 = time.time()
rendered = 0
render_ms = []
first_out_at = None

for idx, xd in eng.audio_to_motions(audio, fps=MOTION_FPS):
    if not KEEP_ALL:
        if (idx % 25) not in set(int(i * step) for i in range(RENDER_FPS)):
            continue
    tr = time.time()
    fr = eng.render_frame(xd)
    render_ms.append((time.time() - tr) * 1000)
    vw.write(cv2.cvtColor(fr, cv2.COLOR_RGB2BGR))
    rendered += 1
    if first_out_at is None:
        first_out_at = time.time() - t0

vw.release()
elapsed = time.time() - t0

print("=" * 56, flush=True)
print(f"输出帧数        {rendered} (目标 {int(dur * RENDER_FPS)})", flush=True)
print(f"首帧延迟        {first_out_at:.2f}s", flush=True)
print(f"总耗时          {elapsed:.2f}s  (音频时长 {dur:.2f}s)", flush=True)
print(f"实时比          {elapsed / dur:.2f}x  (<=1.0 表示可实时跟上)", flush=True)
print(f"渲染均耗时      {np.mean(render_ms):.1f} ms/帧", flush=True)
print("=" * 56, flush=True)

cmd = (
    f'ffmpeg -loglevel error -y -i "{tmp}" -i "{WAV}" '
    f'-map 0:v -map 1:a -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -shortest "{OUT}"'
)
r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
if r.returncode != 0:
    raise RuntimeError(r.stderr[-600:])
import os
os.remove(tmp)
print(f"完成: {OUT}", flush=True)
