"""诊断：量化头发轮廓外的浅色残留带。

抓空闲帧 + 服务端蒙版，在蒙版外沿（alpha 过渡带外侧）统计帧亮度：
背景理论上应是 #0E0E10（灰度≈14）。若外沿带均值显著高于 14，
说明有源图白底像素被烘焙进人物区（matting 边界泄漏）。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_hair_rim.py [输出目录]
"""
import asyncio
import os
import sys
import urllib.request

import cv2
import numpy as np
import websockets

BASE = "http://127.0.0.1:8765"
WS = "ws://127.0.0.1:8765/ws"


async def grab(n: int = 20) -> list[np.ndarray]:
    frames = []
    async with websockets.connect(WS, max_size=32 * 1024 * 1024) as ws:
        while len(frames) < n:
            data = await asyncio.wait_for(ws.recv(), timeout=10)
            if isinstance(data, bytes) and len(data) > 6:
                bgr = cv2.imdecode(np.frombuffer(data[6:], np.uint8),
                                   cv2.IMREAD_COLOR)
                if bgr is not None:
                    frames.append(bgr)
    return frames


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    mask_bytes = urllib.request.urlopen(BASE + "/api/avatar/mask",
                                        timeout=10).read()
    alpha = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8),
                         cv2.IMREAD_UNCHANGED)[:, :, 3]

    frames = asyncio.run(grab(20))
    # 多帧取中位，消除单帧噪声
    med = np.median(np.stack(frames), axis=0).astype(np.uint8)
    gray = cv2.cvtColor(med, cv2.COLOR_BGR2GRAY)

    # 外沿带：alpha 在 (10,140) 的过渡区（蒙版边界外的羽化带）
    band = (alpha > 10) & (alpha < 140)
    # 对照：远离人物的纯背景区（alpha==0 且膨胀人物区 15px 之外）
    far = (alpha == 0) & (cv2.dilate((alpha > 200).astype(np.uint8),
                                     np.ones((31, 31), np.uint8)) == 0)
    print(f"外沿带亮度: 均值 {gray[band].mean():.1f} / "
          f"P90 {np.quantile(gray[band], 0.9):.1f} / "
          f"最大 {gray[band].max():.0f}   (纯背景理论 ≈14)")
    print(f"纯背景区亮度: 均值 {gray[far].mean():.1f} / "
          f"P99 {np.quantile(gray[far], 0.99):.1f}")

    # 头顶区放大图（目视白边）
    top = med[0:170, 100:420]
    a_top = alpha[0:170, 100:420]
    edge = (a_top > 10) & (a_top < 200)
    vis = top.copy()
    vis[edge] = (vis[edge] * 0.35
                 + np.array((0, 0, 255), np.float32) * 0.65).astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, "hair_edge_zoom.png"),
                np.hstack([top, vis]))
    cv2.imwrite(os.path.join(out_dir, "median_frame.png"), med)
    print("输出:", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()
