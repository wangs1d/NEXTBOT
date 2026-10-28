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

        expr = """
(()=>{
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2');
  const attr = gl.getContextAttributes();
  // 检查是否有 context lost
  let lost = false;
  gl.getExtension('WEBGL_lose_context');
  return {
    attributes: attr,
    renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight]
  };
})()
"""
        r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        print(json.dumps(r.get("result", {}).get("result", {}).get("value"), ensure_ascii=False, indent=2))


asyncio.run(main())
