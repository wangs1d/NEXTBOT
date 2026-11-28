"""流式链路端到端自检：speak_start / first_frame / audible / 帧完整性。

用法：D:\\Ditto\\venv\\Scripts\\python.exe scripts/stream_e2e_test.py [句文本]
输出一行 RESULT，字段见 main 尾部。帧完整性口径：speech_frames 应等于
ceil(total_ms / 40)（25fps 每帧 40ms）。
"""
import asyncio
import json
import struct
import sys
import time

import websockets

TEXT = sys.argv[1] if len(sys.argv) > 1 else (
    "你好，这是一条流式链路测试。我们看看开口速度和整段播放的连续性，"
    "中间不要再出现定格。")


async def one_turn(ws, text):
    t0 = time.perf_counter()
    await ws.send(json.dumps({"type": "say", "text": text}))
    speak_start = first_frame = audible = None
    dur_ms = total_ms = None
    buffered = 0.0
    frames = 0
    chunks = 0
    gaps = []
    last_frame_t = None
    end = False
    loop = asyncio.get_event_loop()
    while loop.time() < t0 + 90 and not end:
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=20)
        except asyncio.TimeoutError:
            print(round((time.perf_counter() - t0) * 1000), "TIMEOUT waiting msg")
            break
        now = (time.perf_counter() - t0) * 1000
        if isinstance(msg, str):
            data = json.loads(msg)
            t = data.get("type")
            if t == "speak_start":
                speak_start = round(now)
                dur_ms = data["dur_ms"]
            elif t == "speak_chunk":
                chunks += 1
            elif t == "speak_end":
                total_ms = data.get("total_ms")
                end = True
            elif t == "error":
                print("ERR", str(data)[:300])
                end = True
        else:
            ts = struct.unpack("<H", msg[4:6])[0]
            if ts != 0xFFFF:                     # 0xFFFF = 空闲帧
                frames += 1
                if last_frame_t is not None and now - last_frame_t > 800:
                    gaps.append((round(last_frame_t), round(now - last_frame_t)))
                last_frame_t = now
                if first_frame is None:
                    first_frame = round(now)
                buffered = max(buffered, ts + 40)
                if audible is None and speak_start is not None and buffered >= dur_ms - 80:
                    audible = round(now)         # 客户端 covered 开播点
    expected = round((total_ms or 0) / 40)
    return {
        "speak_start_ms": speak_start, "first_frame_ms": first_frame,
        "audible_ms": audible, "audio_ms": total_ms,
        "speech_frames": frames, "expected_frames": expected,
        "frames_ok": frames == expected, "audio_chunks": 1 + chunks,
        "frame_gaps": gaps[:5],
    }


async def main():
    turns = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    async with websockets.connect("ws://127.0.0.1:8765/ws") as ws:
        for i in range(turns):
            r = await one_turn(ws, TEXT if i == 0 else "第二句，热机后复测一遍同样的指标。")
            print(f"turn{i + 1}:", json.dumps(r, ensure_ascii=False))


asyncio.run(main())
