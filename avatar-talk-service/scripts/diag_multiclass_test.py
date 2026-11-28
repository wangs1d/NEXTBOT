"""验证 multiclass selfie 分割模型：人物 = hair/body_skin/face_skin/clothes/others。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_multiclass_test.py <frame.jpg> <out_dir>
"""
import os
import sys

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "models", "selfie_multiclass_256x256.tflite")


def main() -> None:
    frame_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    bgr = cv2.imread(frame_path)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    rgb_u8 = np.ascontiguousarray(rgb)

    opts = vision.ImageSegmenterOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL),
        output_category_mask=True, output_confidence_masks=False)
    seg = vision.ImageSegmenter.create_from_options(opts)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_u8)
    import time
    t0 = time.perf_counter()
    res = seg.segment(mp_img)
    dt = (time.perf_counter() - t0) * 1000
    cat = np.asarray(res.category_mask.numpy_view()).squeeze().copy()
    h, w = cat.shape
    print(f"模型输出 {w}x{h}, 推理 {dt:.0f}ms")
    print("类别占比:",
          {name: round(float((cat == i).mean()) * 100, 1)
           for i, name in enumerate(
               ["bg", "hair", "body_skin", "face_skin", "clothes", "others"])})

    if (w, h) != bgr.shape[1::-1]:
        cat = cv2.resize(cat, bgr.shape[1::-1],
                         interpolation=cv2.INTER_NEAREST)
    person = (cat > 0).astype(np.uint8) * 255
    person = cv2.morphologyEx(person, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    person = cv2.morphologyEx(person, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    # 轻外扩 + 羽化（同现有管线，吸收转头位移）
    alpha = cv2.dilate(person, np.ones((9, 9), np.uint8))
    alpha = cv2.GaussianBlur(alpha, (15, 15), 0)

    bg = np.full_like(bgr, (255, 0, 255), dtype=np.uint8)
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    comp = (bgr.astype(np.float32) * a
            + bg.astype(np.float32) * (1 - a)).astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, "multiclass_composite.png"), comp)
    cv2.imwrite(os.path.join(out_dir, "multiclass_alpha.png"), alpha)
    cv2.imwrite(os.path.join(out_dir, "multiclass_categories.png"),
                cv2.applyColorMap((cat * 40).astype(np.uint8),
                                  cv2.COLORMAP_JET))
    print(f"人物区占比(alpha>127): {(alpha > 127).mean() * 100:.1f}%  "
          f"输出: {os.path.abspath(out_dir)}")


if __name__ == "__main__":
    main()
