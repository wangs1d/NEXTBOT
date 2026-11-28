"""说话头动诊断：同一句音频，对比「手势层关/开」的头动幅度与画面。

用法（服务环境 python）：
    D:\\Ditto\\venv\\Scripts\\python.exe scripts/diag_head_motion.py [audio.wav]

输出：
  - scratch/diag_head_{TAG}_baseline.mp4 / diag_head_{TAG}_boosted.mp4（25fps，同一运动两遍渲染）
  - 每秒统计：LMDM 头姿角度、手势增量、能量、alpha 放大
  - scratch/diag_head_{TAG}_cmp_*.png：同时刻 基线|增强 并排帧
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "engine"))

import cv2
import numpy as np

from ditto_engine import DittoEngine, MOTION_FPS
from core.atomic_components.motion_stitch import bin66_to_degree

IMG = sys.argv[1] if len(sys.argv) > 1 else r"D:\Ditto\repo\example\image.png"
WAV = sys.argv[2] if len(sys.argv) > 2 else r"D:\Ditto\repo\example\audio.wav"
OUT_DIR = os.path.abspath(os.path.join(ROOT, "..", "scratch"))
# 输出文件带头像名后缀，不同头像的对比产物互不覆盖
TAG = "".join(c for c in os.path.splitext(os.path.basename(IMG))[0] if c.isascii() and c.isalnum()) or "avatar"
POSE_KEYS = ("yaw", "pitch", "roll")


def load_audio_16k(path: str) -> np.ndarray:
    import librosa
    import soundfile as sf

    audio, sr = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return audio.astype(np.float32)


def _ascii_safe_path(path: str) -> str:
    """cv2.imread 在 Windows 上读不了非 ASCII 路径，先复制到 ASCII 临时文件。

    返回 (实际路径, 是否临时副本)；副本在引擎加载完就删（磁盘不留头像）。
    """
    try:
        path.encode("ascii")
        return path, False
    except UnicodeEncodeError:
        tmp = os.path.join(OUT_DIR, "_diag_input.png")
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(path, "rb") as fsrc, open(tmp, "wb") as fdst:
            fdst.write(fsrc.read())
        return tmp, True


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img, img_is_tmp = _ascii_safe_path(IMG)
    audio = load_audio_16k(WAV)
    dur = len(audio) / 16000
    print(f"[diag] 头像 {IMG} | 音频 {WAV} 时长 {dur:.2f}s")

    # 档位与生产默认一致（可用环境变量覆盖，同 main.py）
    max_dim = int(os.environ.get("AVATAR_MAX_DIM") or 1920)
    jpeg_q = int(os.environ.get("AVATAR_JPEG_QUALITY") or 88)
    engine = DittoEngine(img, max_dim=max_dim, steps=50, pose_alpha=1.0,
                         gesture_gain=1.0, use_graph=True, dec_size=64,
                         jpeg_quality=jpeg_q)
    if img_is_tmp:
        os.remove(img)

    # 同一份运动渲染两遍：LMDM 输出与手势层无关，先收集再各自重挂 _ges
    motions = []
    engine.reset_stream(keep_pose=False)
    for idx, xd in engine.audio_to_motions(audio):
        ges = xd.pop("_ges", None)
        motions.append((idx, xd, ges))
    total = len(motions)
    print(f"[diag] 运动帧 {total}")

    # 每帧 LMDM 头姿角度（bin66 → 度），统计基线用
    lmdm_deg = {k: np.zeros(total, dtype=np.float32) for k in POSE_KEYS}
    for i, (_, xd, _) in enumerate(motions):
        for k in POSE_KEYS:
            lmdm_deg[k][i] = float(bin66_to_degree(
                np.asarray(xd[k], dtype=np.float32).reshape(1, -1)).reshape(-1)[0])

    records = []          # (energy, ctrl_kwargs)，顺序即帧序
    orig_gctrl = engine._speech_gesture_ctrl

    def rec_gctrl(e, tm):
        out = orig_gctrl(e, tm)
        records.append((e, out))
        return out

    def render_pass(gain: float, out_path: str) -> list:
        engine.gesture_gain = gain
        records.clear()
        engine._speech_gesture_ctrl = rec_gctrl if gain > 0 else orig_gctrl
        engine.reset_stream(keep_pose=False)
        writer = None
        t0 = time.monotonic()
        for idx, xd, ges in motions:
            d = {k: (v.copy() if isinstance(v, np.ndarray) else v)
                 for k, v in xd.items()}
            if ges is not None:
                d["_ges"] = ges
            frame = engine.render_frame(d, motion_idx=idx)
            if writer is None:
                h, w = frame.shape[:2]
                writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"),
                                         MOTION_FPS, (w, h))
            writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        if writer is not None:
            writer.release()
        print(f"[diag] {'增强' if gain > 0 else '基线'} 渲染 {total} 帧 "
              f"{time.monotonic() - t0:.1f}s → {out_path}")
        return list(records)

    rec_base = render_pass(0.0, os.path.join(OUT_DIR, f"diag_head_{TAG}_baseline.mp4"))
    rec_boost = render_pass(1.0, os.path.join(OUT_DIR, f"diag_head_{TAG}_boosted.mp4"))

    # ── 统计：每秒一行（recs 顺序即帧序，gesture 每帧恰好调用一次）──
    n_sec = int(np.ceil(total / MOTION_FPS))
    base = engine.base_ctrl.get("delta_pitch", 2.0)
    print("\n秒 | 能量  | LMDM yaw/pitch/roll(°,|均值|) | 手势 dyaw/dpitch/droll(°,峰值) | alpha")
    for s in range(n_sec):
        seg = slice(s * MOTION_FPS, min((s + 1) * MOTION_FPS, total))
        recs = rec_boost[seg.start:seg.stop]
        es = [e for e, _ in recs] or [0.0]
        alphas = [r["alpha_pitch"] for _, r in recs] or [1.0]
        dy = [abs(r["delta_yaw"] * r["alpha_pitch"]) for _, r in recs] or [0.0]
        dp = [abs(r["delta_pitch"] * r["alpha_pitch"] - base) for _, r in recs] or [0.0]
        dr = [abs(r["delta_roll"] * r["alpha_pitch"]) for _, r in recs] or [0.0]
        y = lmdm_deg["yaw"][seg]
        p = lmdm_deg["pitch"][seg]
        r_ = lmdm_deg["roll"][seg]
        print(f"{s:2d} | {np.mean(es):4.2f} | {np.mean(np.abs(y)):5.2f}/{np.mean(np.abs(p)):5.2f}/"
              f"{np.mean(np.abs(r_)):5.2f}            | {max(dy):5.2f}/{max(dp):5.2f}/"
              f"{max(dr):5.2f}            | {np.mean(alphas):.2f}")

    for name, recs in (("基线", rec_base), ("增强", rec_boost)):
        if recs:
            mult = [r["alpha_pitch"] for _, r in recs]
            dyaw = [abs(r["delta_yaw"] * r["alpha_pitch"]) for _, r in recs]
            dpit = [abs(r["delta_pitch"] * r["alpha_pitch"] - base) for _, r in recs]
            drll = [abs(r["delta_roll"] * r["alpha_pitch"]) for _, r in recs]
            print(f"[diag] {name}: alpha 均值 {np.mean(mult):.3f} 峰值 {np.max(mult):.3f} | "
                  f"手势峰值 dyaw {np.max(dyaw):.2f}° dpitch {np.max(dpit):.2f}° "
                  f"droll {np.max(drll):.2f}°")

    # ── 并排对比帧 ──
    base_cap = cv2.VideoCapture(os.path.join(OUT_DIR, f"diag_head_{TAG}_baseline.mp4"))
    boost_cap = cv2.VideoCapture(os.path.join(OUT_DIR, f"diag_head_{TAG}_boosted.mp4"))
    for s in (1, 3, 5, 7):
        f = s * MOTION_FPS
        if f >= total:
            break
        base_cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        boost_cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok1, im1 = base_cap.read()
        ok2, im2 = boost_cap.read()
        if ok1 and ok2:
            cmp_img = np.hstack([im1, im2])
            cv2.putText(cmp_img, f"baseline  t={s}s", (10, 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(cmp_img, f"boosted   t={s}s", (522, 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            out = os.path.join(OUT_DIR, f"diag_head_{TAG}_cmp_{s}s.png")
            cv2.imwrite(out, cmp_img)
            print(f"[diag] 对比帧 → {out}")
    base_cap.release()
    boost_cap.release()
    print("[diag] 完成")


if __name__ == "__main__":
    main()
