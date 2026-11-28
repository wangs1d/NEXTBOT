"""次级运动层：2D 头发物理。

思路：
1. 从源图里分出头发区域（深色像素 + 肤色凸包排除五官），后续可换成分割模型；
2. 头部偏转驱动弹簧-阻尼系统，头发跟随但滞后、带回弹；
3. 对整帧做一次小角度仿射旋转，用「头发遮罩 × 距离权重」羽化混合，
   发根不动、发梢摆幅最大。仿射 + blendLinear 比逐像素 remap 便宜很多。

这一层不依赖 Ditto 内部结构，后续可以替换成 3D 头发/布料求解，或增加衣物层。
"""

import cv2
import numpy as np


class HairPhysics:
    """2D 头发次级运动。

    frame_rgb: 源头像（RGB, HxWx3）
    face_mask: Ditto 贴回的面部区域（HxW, 0..1），用于估计头部中心/范围
    """

    def __init__(self, frame_rgb: np.ndarray, face_mask: np.ndarray):
        h, w = frame_rgb.shape[:2]
        self.src_size = (w, h)

        face_bin = (face_mask > 0.05).astype(np.uint8)
        face_dil = cv2.dilate(face_bin, np.ones((11, 11), np.uint8), iterations=2)
        ys, xs = np.nonzero(face_dil)
        if len(xs) < 50:
            raise RuntimeError("面部区域过小，无法建立头发物理")
        cx, cy = float(xs.mean()), float(ys.mean())
        fw = float(xs.max() - xs.min() + 1)
        fh = float(ys.max() - ys.min() + 1)
        R = max(fw, fh) * 0.5

        # 头发候选：深色像素
        rgb = frame_rgb.astype(np.float32)
        lum = rgb.mean(axis=2)
        mx = rgb.max(axis=2)
        dark = ((lum < 100) & (mx < 132)).astype(np.uint8)
        dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))

        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

        # 用肤色像素的凸包圈出脸部，排除眼睛/眉毛/嘴（头发在凸包外的部分保留）
        ycc = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2YCrCb)
        sy, scr, scb = ycc[:, :, 0], ycc[:, :, 1], ycc[:, :, 2]
        skin = ((sy > 70) & (scr > 130) & (scr < 180) & (scb > 75) & (scb < 132)
                & (face_dil > 0)).astype(np.uint8)
        skin = cv2.morphologyEx(skin, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        if int(skin.sum()) > 0.002 * h * w:
            pts = np.column_stack(np.nonzero(skin)[::-1]).astype(np.int32)
            hull = cv2.convexHull(pts)
            face_poly = np.zeros((h, w), np.uint8)
            cv2.fillPoly(face_poly, [hull], 1)
            face_poly = cv2.dilate(face_poly, np.ones((13, 13), np.uint8), iterations=1)
        else:
            face_poly = face_bin
        self.face_poly = face_poly

        region = ((xx > cx - 1.7 * R) & (xx < cx + 1.7 * R)
                  & (yy < cy + 3.0 * R))
        hair = (dark & region & (1 - face_poly)).astype(np.uint8)

        # 只保留足够大的连通域（眼睛/眉毛这类小块会被滤掉）
        n, lab, stats, _ = cv2.connectedComponentsWithStats(hair, 8)
        keep = np.zeros_like(hair)
        min_area = h * w * 0.003
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                keep[lab == i] = 1
        hair = keep
        if float(hair.mean()) < 0.006:
            raise RuntimeError("未检测到足够的头发区域")

        self.mask = cv2.GaussianBlur(hair.astype(np.float32), (0, 0), 6.0)
        self.face_mask = face_mask.astype(np.float32)
        self.dark_mask = dark
        self.cx, self.cy, self.R = cx, cy, R
        dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        anchor = np.clip((dist - 0.85 * R) / (1.7 * R), 0.0, 1.0) ** 1.2
        # 有效遮罩：发根不动、发梢最大
        self.mask_eff = cv2.GaussianBlur(self.mask * anchor, (0, 0), 4.0)

        self.angle = 0.0
        self.vel = 0.0
        self.last_t = None
        self._cache = {}

    def _get_cache(self, w: int, h: int):
        key = (w, h)
        if key in self._cache:
            return self._cache[key]
        if (w, h) == self.src_size:
            mask = self.mask_eff
            cx, cy = self.cx, self.cy
        else:
            mask = cv2.resize(self.mask_eff, (w, h), interpolation=cv2.INTER_AREA)
            sx = w / self.src_size[0]
            sy = h / self.src_size[1]
            cx, cy = self.cx * sx, self.cy * sy
        inv = np.ascontiguousarray(1.0 - mask)
        cache = (mask, inv, float(cx), float(cy))
        self._cache[key] = cache
        return cache

    def apply(self, frame_rgb: np.ndarray, t: float,
              head_yaw_deg: float) -> np.ndarray:
        """根据当前头部 yaw 更新头发，并把形变贴回画面。"""
        h, w = frame_rgb.shape[:2]
        mask, inv, cx, cy = self._get_cache(w, h)

        if self.last_t is None:
            self.last_t = t
        dt = min(max(t - self.last_t, 0.0), 0.12)
        self.last_t = t

        # 弹簧-阻尼跟随：ω≈6.3 rad/s，ζ≈0.6，约 0.2s 滞后 + 轻微过冲
        target = max(-10.0, min(10.0, head_yaw_deg * 0.90))
        acc = (target - self.angle) * 40.0 - self.vel * 7.6
        self.vel += acc * dt
        self.angle += self.vel * dt

        M = cv2.getRotationMatrix2D((cx, cy), self.angle, 1.0)
        warped = cv2.warpAffine(frame_rgb, M, (w, h),
                                flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_REPLICATE)
        return cv2.blendLinear(warped, frame_rgb, mask, inv)
