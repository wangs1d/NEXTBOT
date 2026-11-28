"""蒙版收紧实验：在真实帧上对比不同分割后处理策略。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_mask_tuning.py <frame.jpg> <out_dir>
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 复用服务端的分割器加载逻辑（models/selfie_segmenter.tflite）
from diag_mask_residue import BASE  # noqa: E402  (仅占位避免误删；真正 import 在下)

import urllib.request  # noqa: E402
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "ditto_engine",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "engine", "ditto_engine.py"))
# 不整体 import ditto_engine（会拉起 torch/GPU），这里手工复制分割器加载：
import mediapipe as mp  # noqa: E402
from mediapipe.tasks import python as mp_python  # noqa: E402
from mediapipe.tasks.python import vision  # noqa: E402

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "models", "selfie_segmenter.tflite")
opts = vision.ImageSegmenterOptions(
    base_options=mp_python.BaseOptions(model_asset_path=MODEL),
    output_category_mask=False, output_confidence_masks=True)
seg = vision.ImageSegmenter.create_from_options(opts)


def segment(rgb_u8: np.ndarray) -> np.ndarray:
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_u8)
    res = seg.segment(mp_img)
    return np.asarray(
        res.confidence_masks[0].numpy_view())[:, :, 0].copy()


def border_flood_bg(bgr: np.ndarray, tol: float = 12) -> np.ndarray:
    """从四边种子做颜色容差洪泛 → 背景区（True=背景）。"""
    h, w = bgr.shape[:2]
    small = cv2.resize(bgr, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    hh, ww = small.shape[:2]
    seeds = [(0, 0), (0, ww - 1), (hh - 1, 0), (hh - 1, ww - 1),
             (0, ww // 2), (hh - 1, ww // 2),
             (hh // 2, 0), (hh // 2, ww - 1)]
    mask = np.zeros((hh + 2, ww + 2), np.uint8)  # floodFill 要求 +2 圈边
    for y, x in seeds:
        if mask[y, x] == 0:
            b, g, r = (int(v) for v in small[y, x])
            cv2.floodFill(small.copy(), mask, (x, y), 0,
                           (max(0, b - tol), max(0, g - tol), max(0, r - tol)),
                           (min(255, b + tol), min(255, g + tol),
                            min(255, r + tol)),
                           cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    bg = mask[1:-1, 1:-1].astype(bool)
    bg = cv2.dilate(bg.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    return cv2.resize(bg.astype(np.uint8), (w, h),
                      interpolation=cv2.INTER_NEAREST).astype(bool)


def feather(m: np.ndarray, dilate_k: int = 9, blur_k: int = 15) -> np.ndarray:
    m = cv2.dilate(m, np.ones((dilate_k, dilate_k), np.uint8))
    return cv2.GaussianBlur(m, (blur_k, blur_k), 0)


def composite(frame_bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    bg = np.full_like(frame_bgr, (255, 0, 255), dtype=np.uint8)
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    return (frame_bgr.astype(np.float32) * a
            + bg.astype(np.float32) * (1 - a)).astype(np.uint8)


def main() -> None:
    frame_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    bgr = cv2.imread(frame_path)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = bgr.shape[:2]

    conf = segment(rgb)
    print("conf 分位:", {q: round(float(np.quantile(conf, q)), 3)
                        for q in (0.05, 0.25, 0.5, 0.75, 0.9)})

    bg_flood = border_flood_bg(bgr)
    print(f"flood 背景占比: {bg_flood.mean() * 100:.1f}%")

    variants: dict[str, np.ndarray] = {}

    # a) 现状：0.5 阈值 + close/open + dilate9 + blur15
    m = (conf > 0.5).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    variants["a_current"] = feather(m)

    # b) 高阈值扫扫（无洪泛）
    for th in (0.7, 0.85, 0.95):
        variants[f"b_th{th}"] = feather((conf > th).astype(np.uint8) * 255)

    # c) 0.5 阈值 ∧ 非洪泛背景（洪泛切掉灰底带）
    m = (conf > 0.5).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m[bg_flood] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    variants["c_flood"] = feather(m)

    # d) 高阈值 ∧ 非洪泛
    m = (conf > 0.7).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m[bg_flood] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    variants["d_th07_flood"] = feather(m)

    # e) c + 收紧羽化（dilate5 + blur9）：残留带更窄
    m = (conf > 0.5).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m[bg_flood] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    variants["e_flood_tight"] = feather(m, dilate_k=5, blur_k=9)

    for name, alpha in variants.items():
        cov = (alpha > 127).mean() * 100
        cv2.imwrite(os.path.join(out_dir, f"{name}.png"), composite(bgr, alpha))
        cv2.imwrite(os.path.join(out_dir, f"{name}_alpha.png"), alpha)
        print(f"{name}: >127 占比 {cov:.1f}%")
    print("输出目录:", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()
