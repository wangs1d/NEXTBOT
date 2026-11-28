"""定量验证蒙版随头变换的方向/幅度：边缘对齐能量对比。

原理：蒙版边缘带（alpha 过渡区）应与帧里人物轮廓（梯度）重合。
对同一帧用不同候选变换（pose 原值 / 反向 / 双倍 / 静态）计算
「蒙版边缘带 ∩ 帧梯度」能量，正确变换应得分最高。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_pose_align_score.py <frame.jpg> <mask.png> <a> <b> <tx> <ty>
"""
import sys

import cv2
import numpy as np


def edge_energy(frame_bgr: np.ndarray, alpha: np.ndarray) -> float:
    band = (alpha > 8) & (alpha < 247)       # 蒙版羽化边缘带
    if band.sum() < 100:
        return -1.0
    grad = cv2.Sobel(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY),
                     cv2.CV_32F, 1, 0, ksize=3) ** 2 \
        + cv2.Sobel(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY),
                    cv2.CV_32F, 0, 1, ksize=3) ** 2
    return float(grad[band].mean())


def warped(mask: np.ndarray, a: float, b: float, tx: float, ty: float):
    m = np.array([[a, -b, tx], [b, a, ty]], dtype=np.float64)
    return cv2.warpAffine(mask, m, mask.shape[1::-1],
                          flags=cv2.INTER_LINEAR, borderValue=0)


def main() -> None:
    frame_path, mask_path = sys.argv[1], sys.argv[2]
    a, b, tx, ty = (float(v) for v in sys.argv[3:7])
    frame = cv2.imread(frame_path)
    mask = cv2.imdecode(np.frombuffer(open(mask_path, "rb").read(),
                                      np.uint8), cv2.IMREAD_UNCHANGED)[:, :, 3]
    cands = {
        "pose(随头)": (a, b, tx, ty),
        "pose反向(若更高则方向错)": (a, -b, -tx, -ty),
        "pose双倍(若更高则K偏小)": (1.0 + (a - 1.0) * 2, b * 2, tx * 2, ty * 2),
        "pose半值(若更高则K偏大)": (1.0 + (a - 1.0) * 0.5, b * 0.5, tx * 0.5, ty * 0.5),
        "静态(不跟)": (1.0, 0.0, 0.0, 0.0),
    }
    print(f"帧: {frame_path}")
    print(f"pose: a={a} b={b} tx={tx} ty={ty}")
    for name, (ca, cb, ctx, cty) in cands.items():
        e = edge_energy(frame, warped(mask, ca, cb, ctx, cty))
        print(f"  {name}: 能量 {e:.1f}")


if __name__ == "__main__":
    main()
