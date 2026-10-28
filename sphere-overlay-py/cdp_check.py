import asyncio
import json
import sys

import websockets


async def main():
    page_ws = sys.argv[1]
    async with websockets.connect(page_ws, max_size=None) as ws:
        msg_id = 0

        async def send(method, params=None):
            nonlocal msg_id
            msg_id += 1
            mid = msg_id
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == mid:
                    return resp

        await send("Runtime.enable")
        await send("Log.enable")
        await send("Console.enable")

        # 收集几秒内的事件
        async def drain(seconds):
            evs = []
            end = asyncio.get_event_loop().time() + seconds
            while asyncio.get_event_loop().time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    m = json.loads(raw)
                    if "method" in m:
                        evs.append(m)
                except asyncio.TimeoutError:
                    pass
            return evs

        evs = await drain(2)
        for m in evs:
            meth = m["method"]
            p = m.get("params", {})
            if meth in ("Runtime.consoleAPICalled", "Log.entryAdded", "Runtime.exceptionThrown"):
                print("EVENT:", meth, json.dumps(p, ensure_ascii=False)[:600])

        # 主动查询页面状态
        checks = [
            ("canvas", "(()=>{const c=document.querySelector('canvas');return c?{w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight}:null})()"),
            ("canvasCount", "document.querySelectorAll('canvas').length"),
            ("petPane", "(()=>{const e=document.querySelector('.overlay-pet-pane');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()"),
            ("bridge", "!!window.sphereOverlay"),
            ("paiPet", "!!window.__paiPet"),
            ("errors", "window.__errs||null"),
            ("bodyChildren", "document.querySelector('.mode-overlay')?.children.length"),
            ("gl", "(()=>{const c=document.querySelector('canvas');if(!c)return null;const g=c.getContext('webgl2')||c.getContext('webgl');return g?{ver:g.getParameter(g.VERSION)}:null})()"),
        ]
        for name, expr in checks:
            r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            val = r.get("result", {}).get("result", {}).get("value")
            print(f"CHECK {name}: {json.dumps(val, ensure_ascii=False)}")


asyncio.run(main())
