"""诊断：验证「蒙版随头」相似变换 + 纯色背景源图的效果。

抓一组空闲帧（含随帧 pose JSON），挑出最大歪头帧，把服务端蒙版按
pose 变换后与帧合成在深底上——检查三项：
  1) 帧背景是否已是纯色（源头抠像生效，无照片纹理）；
  2) 歪头时变换蒙版是否贴合人物轮廓（无背景条带漏出）；
  3) 人物是否被蒙版误裁（变换过冲）。

用法: D:/Ditto/venv/Scripts/python.exe -I diag_mask_pose.py [输出目录] [秒数]
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
DARK = np.array((16, 14, 14), dtype=np.float32)  # BGR 近黑（面板底色）


async def grab(seconds: float, trigger: str | None = None) -> list[dict]:
    """收 {seconds} 秒：pose JSON 与紧随的二进制帧按 WS 顺序配对。

    trigger: "listening"=触发倾听微动（点头/侧倾，幅度大，验证用）
    """
    items: list[dict] = []
    pending_pose = None
    async with websockets.connect(WS, max_size=20 * 1024 * 1024) as ws:
        loop = asyncio.get_event_loop()
        if trigger == "listening":
            await ws.send('{"type":"listening","active":true}')
        end_at = loop.time() + seconds
        while loop.time() < end_at:
            data = await asyncio.wait_for(ws.recv(), timeout=10)
            if isinstance(data, str):
                import json
                msg = json.loads(data)
                if msg.get("type") == "pose":
                    pending_pose = msg
            elif isinstance(data, bytes) and len(data) > 6:
                items.append({"pose": pending_pose, "jpeg": data[6:]})
                pending_pose = None
        if trigger == "listening":
            try:
                await ws.send('{"type":"listening","active":false}')
            except Exception:
                pass
    return items


def apply_pose(mask: np.ndarray, pose: dict) -> np.ndarray:
    """把蒙版按 pose（512 像素空间相似变换）重采样。"""
    a, b = pose["a"], pose["b"]
    m = np.array([[a, -b, pose["tx"]], [b, a, pose["ty"]]], dtype=np.float64)
    return cv2.warpAffine(mask, m, mask.shape[1::-1],
                          flags=cv2.INTER_LINEAR, borderValue=0)


def composite_on_dark(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    return (bgr.astype(np.float32) * a
            + DARK * (1.0 - a)).astype(np.uint8)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
    trigger = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(out_dir, exist_ok=True)

    mask_bytes = urllib.request.urlopen(
        BASE + "/api/avatar/mask", timeout=10).read()
    mask = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8),
                        cv2.IMREAD_UNCHANGED)[:, :, 3]
    with open(os.path.join(out_dir, "mask.png"), "wb") as f:
        f.write(mask_bytes)

    items = asyncio.run(grab(seconds, trigger))
    print(f"收到 {len(items)} 帧，其中带 pose 的 {sum(1 for i in items if i['pose'])} 帧")
    if not items:
        print("没有帧，退出")
        return

    # 找「变换最大」的帧：旋转角与平移量的综合度量
    def tilt(it):
        p = it["pose"]
        if not p:
            return -1.0
        ang = abs(np.arctan2(p["b"], p["a"]))
        tr = np.hypot(p["tx"], p["ty"])
        return ang + tr / 512.0

    items.sort(key=tilt, reverse=True)
    for rank, it in enumerate(items[:3]):
        bgr = cv2.imdecode(np.frombuffer(it["jpeg"], np.uint8),
                           cv2.IMREAD_COLOR)
        cv2.imwrite(os.path.join(out_dir, f"frame_tilt{rank}.jpg"), bgr)
        pose = it["pose"]
        tag = "static" if pose is None else "follow"
        if pose is not None:
            print(f"tilt{rank}: a={pose['a']} b={pose['b']} "
                  f"tx={pose['tx']} ty={pose['ty']}")
        # 变换蒙版合成（随头）
        if pose is not None:
            cv2.imwrite(
                os.path.join(out_dir, f"comp_tilt{rank}_{tag}.png"),
                composite_on_dark(bgr, apply_pose(mask, pose)))
        # 静态蒙版合成（对照组：不随头会漏什么）
        cv2.imwrite(
            os.path.join(out_dir, f"comp_tilt{rank}_static.png"),
            composite_on_dark(bgr, mask))
    print("输出:", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()
