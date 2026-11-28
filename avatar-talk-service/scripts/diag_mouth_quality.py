"""嘴部画质基准：同一音频/头像，多组渲染档位测耗时与嘴部清晰度。

用法：
    python scripts/diag_mouth_quality.py <avatar.png> [audio.wav]

档位维度：max_dim（源图/warp 特征分辨率）、dec_size（decoder 输入特征，
64=官方原生）、jpeg q。输出每档位：帧均耗时(warp/dec/编码拆分)、嘴部
Laplacian 清晰度、JPEG 体积，并保存嘴部特写对比条。
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "engine"))

import cv2
import numpy as np
import torch

from diag_head_motion import _ascii_safe_path, load_audio_16k  # 复用
from ditto_engine import DittoEngine, MOTION_FPS

WAV_DEFAULT = r"D:\Ditto\repo\example\audio.wav"
OUT_DIR = os.path.abspath(os.path.join(ROOT, "..", "scratch"))
N_BENCH = 90            # 每档位计时帧数
MOUTH_BOX = (0.30, 0.52, 0.70, 0.78)   # 512 输出里的嘴部区域 x0,y0,x1,y1（比例）


def mouth_crop(frame: np.ndarray) -> np.ndarray:
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = MOUTH_BOX
    return frame[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]


def mouth_sharpness(frame: np.ndarray) -> float:
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def bench_config(engine: DittoEngine, motions, tag: str, jpeg_q: int) -> dict:
    engine.jpeg_quality = jpeg_q
    # 预热
    for idx, xd, ges in motions[:10]:
        d = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in xd.items()}
        if ges is not None:
            d["_ges"] = ges
        engine.render_frame(d, motion_idx=idx)
    torch.cuda.synchronize()

    # 计时：render（stitch+GPU）+ JPEG 编码，统计嘴部清晰度与体积
    sharp, sizes = [], []
    t_all0 = time.perf_counter()
    t_jpeg = 0.0
    for idx, xd, ges in motions[:N_BENCH]:
        d = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in xd.items()}
        if ges is not None:
            d["_ges"] = ges
        frame = engine.render_frame(d, motion_idx=idx)
        tj = time.perf_counter()
        jpeg = engine.encode_jpeg(frame)
        t_jpeg += time.perf_counter() - tj
        sharp.append(mouth_sharpness(frame))
        sizes.append(len(jpeg))
    torch.cuda.synchronize()
    total = (time.perf_counter() - t_all0) / N_BENCH * 1000
    t_jpeg_ms = t_jpeg / N_BENCH * 1000
    # GPU 内部拆分：单独跑 stitch+warp/decoder 计时（手势私有键必须弹出）
    from ditto_engine import DEV
    xd0 = {k: (v.copy() if isinstance(v, np.ndarray) else v)
           for k, v in motions[5][1].items()}
    xs, xd = engine.stitch(engine.source_info["x_s_info_lst"][0], xd0)
    xs_t = torch.from_numpy(xs).to(DEV, dtype=engine.dtype)
    xd_t = torch.from_numpy(xd).to(DEV, dtype=engine.dtype)
    for _ in range(5):
        engine._forward_gpu(xs_t, xd_t)
    torch.cuda.synchronize()
    t_gpu0 = time.perf_counter()
    n_gpu = 30
    for _ in range(n_gpu):
        engine._forward_gpu(xs_t, xd_t)
    torch.cuda.synchronize()
    t_infer = (time.perf_counter() - t_gpu0) / n_gpu * 1000

    result = {
        "tag": tag, "jpeg_ms": t_jpeg_ms,
        "infer_ms": t_infer, "total_ms": total,
        "sharp": float(np.mean(sharp)), "jpeg_kb": float(np.mean(sizes)) / 1024,
    }
    print(f"[bench] {tag}: 总 {total:.1f}ms | GPU推理 {t_infer:.1f}ms | "
          f"JPEG {result['jpeg_ms']:.1f}ms q={jpeg_q} {result['jpeg_kb']:.0f}KB | "
          f"嘴部清晰度 {result['sharp']:.0f}")
    return result


def save_mouth_strip(engine: DittoEngine, motions, path: str):
    """连续 6 帧嘴部特写横排（说话中段），供肉眼对比。"""
    crops = []
    start = 100
    for idx, xd, ges in motions[start:start + 6]:
        d = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in xd.items()}
        if ges is not None:
            d["_ges"] = ges
        frame = engine.render_frame(d, motion_idx=idx)
        c = mouth_crop(frame)
        crops.append(cv2.cvtColor(c, cv2.COLOR_RGB2BGR))
    strip = np.hstack(crops)
    strip = cv2.resize(strip, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(path, strip)
    print(f"[bench] 嘴部特写条 → {path}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img_arg = sys.argv[1] if len(sys.argv) > 1 else r"D:\Ditto\repo\example\image.png"
    wav = sys.argv[2] if len(sys.argv) > 2 else WAV_DEFAULT
    img, img_is_tmp = _ascii_safe_path(img_arg)
    audio = load_audio_16k(wav)

    configs = [
        # (tag, max_dim, dec_size, jpeg_q)
        ("768/dec64/q82(现状)", 768, 64, 82),
        ("1280/dec64/q88", 1280, 64, 88),
        ("1920/dec64/q88", 1920, 64, 88),
    ]
    results = []
    engine = DittoEngine(img, max_dim=configs[0][1], steps=50,
                         pose_alpha=1.0, gesture_gain=1.0, use_graph=True,
                         dec_size=configs[0][2])

    try:
        for tag, max_dim, dec_size, q in configs:
            if engine.max_dim != max_dim or engine.dec_size != dec_size:
                engine.max_dim = max_dim
                engine.dec_size = dec_size
                # 非 ASCII 路径用临时副本重载（副本在整个基准期间保留）
                engine.load_avatar(img)
            torch.manual_seed(42)
            engine.reset_stream(keep_pose=False)
            motions = []
            for idx, xd in engine.audio_to_motions(audio):
                ges = xd.pop("_ges", None)
                motions.append((idx, xd, ges))
            res = bench_config(engine, motions, tag, q)
            res["max_dim"], res["dec_size"], res["q"] = max_dim, dec_size, q
            results.append(res)
            save_mouth_strip(engine, motions,
                             os.path.join(OUT_DIR, f"mouth_strip_{tag.replace('/', '_').replace('(', '').replace(')', '')}.png"))
    finally:
        if img_is_tmp and os.path.exists(img):
            os.remove(img)   # 基准结束才删临时头像副本（磁盘不留头像）

    print("\n=== 汇总 ===")
    print(f"{'档位':<20} {'总ms':>6} {'推理ms':>7} {'jpegms':>7} {'清晰度':>8} {'KB/帧':>6}")
    for r in results:
        print(f"{r['tag']:<20} {r['total_ms']:>6.1f} {r['infer_ms']:>7.1f} "
              f"{r['jpeg_ms']:>7.1f} {r['sharp']:>8.0f} {r['jpeg_kb']:>6.0f}")


if __name__ == "__main__":
    main()
