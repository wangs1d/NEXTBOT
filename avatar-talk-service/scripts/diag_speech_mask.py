"""诊断：说话动作下的静态蒙版效果（无随头变换）。

发一条 say 驱动说话，抓全程帧，按帧间运动量排序取最大运动帧，
用服务端蒙版合成在深底上——检查人物轮廓无硬裁边（无"框"感）、
背景带不可见。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_speech_mask.py [输出目录]
"""
import asyncio
import json
import os
import sys
import urllib.request

import cv2
import numpy as np
import websockets

BASE = "http://127.0.0.1:8765"
WS = "ws://127.0.0.1:8765/ws"
DARK = np.array((16, 14, 14), dtype=np.float32)  # BGR 近黑
TEXT = "你好呀，今天我们一起出门走走，顺便聊聊最近的事情吧。"


async def run(out_dir: str) -> None:
    mask_bytes = urllib.request.urlopen(BASE + "/api/avatar/mask",
                                        timeout=10).read()
    mask = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8),
                        cv2.IMREAD_UNCHANGED)[:, :, 3]

    frames: list[np.ndarray] = []
    async with websockets.connect(WS, max_size=64 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "say", "text": TEXT}))
        loop = asyncio.get_event_loop()
        end_at = loop.time() + 20
        while loop.time() < end_at:
            try:
                data = await asyncio.wait_for(ws.recv(), timeout=15)
            except (asyncio.TimeoutError, websockets.exceptions
                    .ConnectionClosed):
                break
            if isinstance(data, bytes) and len(data) > 6:
                bgr = cv2.imdecode(np.frombuffer(data[6:], np.uint8),
                                   cv2.IMREAD_COLOR)
                if bgr is not None:
                    frames.append(bgr)
                if len(frames) >= 260:
                    break
    print(f"收到 {len(frames)} 帧")
    if len(frames) < 10:
        return

    # 帧间运动量（灰度差绝对值均值），取运动最大的 3 帧验证蒙版
    motion = [0.0]
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
    for i in range(1, len(grays)):
        motion.append(float(np.abs(grays[i].astype(np.int16)
                                   - grays[i - 1].astype(np.int16)).mean()))
    order = np.argsort(motion)[::-1][:3]
    for rank, fi in enumerate(order):
        bgr = frames[int(fi)]
        a = (mask.astype(np.float32) / 255.0)[..., None]
        comp = (bgr.astype(np.float32) * a
                + DARK * (1.0 - a)).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, f"speech_motion{rank}.png"), comp)
        cv2.imwrite(os.path.join(out_dir, f"speech_motion{rank}_raw.jpg"), bgr)
        print(f"motion{rank}: 帧#{fi} 运动量 {motion[int(fi)]:.2f}")
    print("输出:", os.path.abspath(out_dir))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    asyncio.run(run(out))
