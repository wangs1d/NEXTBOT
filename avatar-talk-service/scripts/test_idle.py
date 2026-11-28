"""验证空闲微动推流：连接后不说话，看是否持续收到 idle 帧且画面在变。"""
import asyncio
import hashlib
import json
import struct
import time

import websockets


async def main():
    async with websockets.connect("ws://127.0.0.1:8765/ws", max_size=8 * 1024 * 1024) as ws:
        ready = json.loads(await ws.recv())
        print("ready:", ready, flush=True)

        idle_frames = 0
        hashes = set()
        sizes = []
        t0 = time.time()

        while time.time() - t0 < 6.0:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                break
            if isinstance(msg, str):
                continue

            idx, ts = struct.unpack("<IH", msg[:6])
            if ts != 0xFFFF:
                print(f"非 idle 帧 idx={idx} ts={ts}", flush=True)
                continue

            idle_frames += 1
            sizes.append(len(msg) - 6)
            hashes.add(hashlib.md5(msg[6:]).hexdigest())

        dur = time.time() - t0
        print("=" * 50, flush=True)
        print(f"idle 帧数        {idle_frames}  ({idle_frames / dur:.1f} fps)", flush=True)
        print(f"不同画面帧数     {len(hashes)}  (说明画面在变化)" , flush=True)
        print(f"单帧大小         {sum(sizes)//max(len(sizes),1)//1024} KB", flush=True)
        print("=" * 50, flush=True)


asyncio.run(main())
