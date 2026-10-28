import asyncio
import json
import sys

import websockets


async def main():
    async with websockets.connect(sys.argv[1], max_size=None) as ws:
        mid = 0

        async def send(method, params=None):
            nonlocal mid
            mid += 1
            m = mid
            await ws.send(json.dumps({"id": m, "method": method, "params": params or {}}))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == m:
                    return r

        # 先给 body 加红色背景
        await send("Runtime.evaluate", {
            "expression": "document.body.style.background='red'; document.documentElement.style.background='red';"
        })
        print("set red bg")
        await asyncio.sleep(1)


asyncio.run(main())
