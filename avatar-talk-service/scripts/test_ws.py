"""WebSocket 端到端测试：连服务、发一句话、统计帧与音画时序。"""
import asyncio
import json
import struct
import sys
import time

import websockets

TEXT = sys.argv[1] if len(sys.argv) > 1 else "你好呀，我是你的专属数字人，很高兴见到你。"


async def main():
    async with websockets.connect("ws://127.0.0.1:8765/ws", max_size=8 * 1024 * 1024) as ws:
        ready = json.loads(await ws.recv())
        print("ready:", ready, flush=True)

        t0 = time.time()
        await ws.send(json.dumps({"type": "say", "text": TEXT}))

        frames = 0
        first_frame_at = None
        first_ts = None
        last_ts = None
        audio_info = None
        tts_ms = None

        while True:
            msg = await ws.recv()
            if isinstance(msg, str):
                data = json.loads(msg)
                desc = {k: v for k, v in data.items() if k not in ("type", "audio")}
                if "audio" in data and isinstance(data["audio"], dict):
                    desc["audio"] = f'{data["audio"].get("format")}@{data["audio"].get("sampleRate")}'
                print(f"[{time.time() - t0:6.2f}s] json: {data.get('type')} {desc}", flush=True)
                if data["type"] == "speak_start":
                    audio_info = data.get("audio")
                    tts_ms = data.get("tts_ms")
                if data["type"] in ("speak_end", "error"):
                    if data["type"] == "error":
                        print("ERROR:", data.get("message"), flush=True)
                    break
            else:
                buf = msg
                idx, ts = struct.unpack("<IH", buf[:6])
                if ts == 0xFFFF:
                    continue          # 跳过空闲微动帧
                frames += 1
                if first_frame_at is None:
                    first_frame_at = time.time() - t0
                    first_ts = ts
                last_ts = ts

        total = time.time() - t0
        print("=" * 56, flush=True)
        print(f"TTS 耗时         {tts_ms} ms", flush=True)
        print(f"首段音频         {audio_info and audio_info.get('format')}", flush=True)
        print(f"收到帧数         {frames}", flush=True)
        print(f"首帧到达         {first_frame_at:.2f}s (帧时间戳 {first_ts}ms)", flush=True)
        print(f"末帧时间戳       {last_ts} ms  (音频时长约 {last_ts/1000:.2f}s)", flush=True)
        print(f"总耗时           {total:.2f}s", flush=True)
        print(f"端到端实时比     {total / (last_ts/1000):.2f}x", flush=True)
        print("=" * 56, flush=True)


asyncio.run(main())
