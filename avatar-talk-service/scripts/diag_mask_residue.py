"""诊断：抓运行中服务的蒙版 + 一帧，模拟客户端 dstIn 合成，定位背景残留。

用法: D:/Ditto/venv/Scripts/python.exe diag_mask_residue.py [输出目录]
"""
import asyncio
import io
import os
import sys
import urllib.request

import cv2
import numpy as np
import websockets

BASE = "http://127.0.0.1:8765"
WS = "ws://127.0.0.1:8765/ws"


async def grab_frames(n: int = 3) -> list[bytes]:
    frames = []
    async with websockets.connect(WS, max_size=20 * 1024 * 1024) as ws:
        while len(frames) < n:
            data = await asyncio.wait_for(ws.recv(), timeout=10)
            if isinstance(data, bytes) and len(data) > 6:
                frames.append(data[6:])
            elif isinstance(data, str):
                print("ctrl:", data[:120])
    return frames


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)

    # 1) 蒙版
    mask_bytes = urllib.request.urlopen(BASE + "/api/avatar/mask", timeout=10).read()
    mask_path = os.path.join(out_dir, "mask.png")
    with open(mask_path, "wb") as f:
        f.write(mask_bytes)
    png = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    alpha = png[:, :, 3]
    h, w = alpha.shape
    print(f"mask: {w}x{h}, alpha>0: {(alpha > 0).mean() * 100:.1f}%  "
          f"alpha>127: {(alpha > 127).mean() * 100:.1f}%  "
          f"alpha==255: {(alpha == 255).mean() * 100:.1f}%")

    # 2) 实时帧
    frames = asyncio.run(grab_frames(3))
    for i, jpeg in enumerate(frames):
        with open(os.path.join(out_dir, f"frame{i}.jpg"), "wb") as f:
            f.write(jpeg)
    frame = cv2.imdecode(np.frombuffer(frames[0], np.uint8), cv2.IMREAD_COLOR)
    fh, fw = frame.shape[:2]
    print(f"frame0: {fw}x{fh}")
    if (fw, fh) != (w, h):
        print(f"!! 尺寸不一致 frame {fw}x{fh} vs mask {w}x{h} → 客户端拉伸错位")
        alpha = cv2.resize(alpha, (fw, fh), interpolation=cv2.INTER_LINEAR)

    # 3) 模拟客户端合成：帧 + 蒙版 alpha，垫在亮品红底上——
    #    成品里凡是"非品红"的像素都是蒙版漏掉/多保住的区域。
    bg = np.full_like(frame, (255, 0, 255), dtype=np.uint8)  # BGR 品红
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    comp = (frame.astype(np.float32) * a + bg.astype(np.float32) * (1 - a))
    comp = comp.astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, "composite_on_magenta.png"), comp)

    # 3b) 深色底合成：复现客户端面板深色场景，检验轮廓白描边是否残留。
    dark = np.full_like(frame, (14, 14, 16), dtype=np.uint8)  # BGR 近黑
    comp_dark = (frame.astype(np.float32) * a
                 + dark.astype(np.float32) * (1 - a)).astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, "composite_on_dark.png"), comp_dark)

    # 4) 蒙版可视化：半透明红盖在 alpha>127 区域外(保留区红=人物区)
    vis = frame.copy()
    vis[alpha <= 127] = (vis[alpha <= 127] * 0.4
                         + np.array((0, 0, 255), dtype=np.float32) * 0.6
                         ).astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, "mask_region_overlay.png"), vis)
    print("输出:", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()
