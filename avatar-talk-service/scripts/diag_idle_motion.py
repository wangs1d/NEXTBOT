"""空闲/倾听/句界演示：一段视频覆盖「说话→收势→空闲→倾听」全链路。

用法：
    python scripts/diag_idle_motion.py <avatar.png> [audio.wav]

时间线（25fps 真实节奏渲染，墙钟行为与线上一致）：
  0-4s    说话（示例音频前 4s，LMDM 运动增强）
  4s      end_speech（姿态接力种子）
  4-14s   空闲（双尺度游走 + 扫视 + 唇姿漂移 + 呼吸 scale + 长眨眼）
  14-22s  倾听（注视镜头 + 点头/双点头 + 侧倾 + 关注表情）

输出 scratch/diag_idle_<tag>.mp4 → 复制到桌面观看。
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "engine"))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import cv2
import numpy as np

from diag_head_motion import _ascii_safe_path, load_audio_16k
from ditto_engine import DittoEngine, MOTION_FPS

WAV_DEFAULT = r"D:\Ditto\repo\example\audio.wav"
OUT_DIR = os.path.abspath(os.path.join(ROOT, "..", "scratch"))
SPEECH_SEC = 4.0
IDLE_SEC = 10.0
LISTEN_SEC = 8.0


def main():
    img_arg = sys.argv[1] if len(sys.argv) > 1 else r"D:\Ditto\repo\example\image.png"
    wav = sys.argv[2] if len(sys.argv) > 2 else WAV_DEFAULT
    os.makedirs(OUT_DIR, exist_ok=True)
    img, img_is_tmp = _ascii_safe_path(img_arg)
    audio = load_audio_16k(wav)

    tag = "".join(c for c in os.path.splitext(os.path.basename(img_arg))[0]
                  if c.isascii() and c.isalnum()) or "avatar"
    out_path = os.path.join(OUT_DIR, f"diag_idle_{tag}.mp4")

    engine = DittoEngine(img, max_dim=int(os.environ.get("AVATAR_MAX_DIM") or 1920),
                         steps=50, pose_alpha=1.0, gesture_gain=1.0,
                         use_graph=True, dec_size=64,
                         jpeg_quality=int(os.environ.get("AVATAR_JPEG_QUALITY") or 88))
    if img_is_tmp:
        os.remove(img)
    print(f"[idle-diag] 唇姿方向向量: {'就绪' if engine._lip_part_vec is not None else '缺失'}", flush=True)

    fps = MOTION_FPS
    n_speech = int(SPEECH_SEC * fps)
    n_idle = int(IDLE_SEC * fps)
    n_listen = int(LISTEN_SEC * fps)
    total = n_speech + n_idle + n_listen

    # 说话运动（前 4s 音频），_ges 已由 audio_to_motions 挂好
    speech = []
    engine.reset_stream(keep_pose=False)
    for idx, xd in engine.audio_to_motions(audio[:int(SPEECH_SEC * 16000)]):
        ges = xd.pop("_ges", None)
        speech.append((idx, xd, ges))
    print(f"[idle-diag] 说话运动 {len(speech)} 帧", flush=True)

    writer = None
    t0_wall = time.monotonic()
    IDLE_T0 = time.monotonic()

    def emit(frame):
        nonlocal writer
        if writer is None:
            h, w = frame.shape[:2]
            writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"),
                                     fps, (w, h))
        writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))

    # 按 25fps 真实节奏推帧：墙钟驱动的行为（接力衰减/眨眼跳转/扫视）与线上一致
    for i in range(total):
        target = t0_wall + i / fps
        wait = target - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        if i < n_speech:
            idx, xd, ges = speech[min(i, len(speech) - 1)]
            d = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in xd.items()}
            if ges is not None:
                d["_ges"] = ges
            frame = engine.render_frame(d, motion_idx=idx)
            if i == n_speech - 1:
                engine.end_speech()
                print(f"[idle-diag] end_speech 姿态接力种子: "
                      f"{[round(c, 2) for c in (engine._idle_carry or [])]}", flush=True)
        else:
            tt = time.monotonic() - IDLE_T0
            if i == n_speech:
                engine.set_listening(False)
                print("[idle-diag] 进入空闲段", flush=True)
            if i == n_speech + n_idle:
                engine.set_listening(True)
                print("[idle-diag] 进入倾听段", flush=True)
            frame = engine.render_idle(tt)
        emit(frame)

    if writer is not None:
        writer.release()
    print(f"[idle-diag] {total} 帧 → {out_path}", flush=True)
    print(f"[idle-diag] 扫视终值 {engine._sacc_now} | 唇姿 p={engine._lip_p:.2f} | "
          f"接力残留 {engine._idle_carry}", flush=True)


if __name__ == "__main__":
    main()
