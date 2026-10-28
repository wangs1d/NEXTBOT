import asyncio
import json
import sys

import websockets


async def main():
    async with websockets.connect(sys.argv[1]) as ws:
        mid = 0

        async def ev(expr):
            nonlocal mid
            mid += 1
            m = mid
            await ws.send(json.dumps({
                "id": m,
                "method": "Runtime.evaluate",
                "params": {"expression": expr, "returnByValue": True},
            }))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == m:
                    return r

        for label, expr in [
            ("root", "!!document.querySelector('#root')"),
            ("rootChildren", "document.querySelector('#root').children.length"),
            ("shell", "!!document.querySelector('.mode-shell')"),
            ("rootHTMLlen", "document.querySelector('#root').innerHTML.length"),
            ("bodyClasses", "document.body.className"),
            ("shellClasses", "document.querySelector('.mode-shell')?.className"),
            ("canvas", "!!document.querySelector('canvas')"),
        ]:
            r = await ev(expr)
            print(label, "=>", r.get("result", {}).get("result", {}).get("value"))


asyncio.run(main())
