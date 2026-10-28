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

        # 1) 给 #root 加半透明红色背景
        r = await send("Runtime.evaluate", {
            "expression": """
(()=>{
  const root = document.querySelector('#root');
  root.style.background = 'rgba(255,0,0,0.5)';
  const rr = root.getBoundingClientRect();
  const shell = document.querySelector('.mode-shell');
  const sr = shell.getBoundingClientRect();
  const cs = getComputedStyle(shell);
  return {
    rootRect: [rr.left,rr.top,rr.width,rr.height],
    shellRect: [sr.left,sr.top,sr.width,sr.height],
    shellDisplay: cs.display, shellOpacity: cs.opacity,
    shellVisibility: cs.visibility, shellTransform: cs.transform,
    shellPos: cs.position
  };
})()
""",
            "returnByValue": True,
        })
        print("DIAG:", json.dumps(r.get("result", {}).get("result", {}).get("value"), ensure_ascii=False, indent=2))
        await asyncio.sleep(2)


asyncio.run(main())
