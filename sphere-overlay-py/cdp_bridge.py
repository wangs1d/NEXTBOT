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

        await send("Runtime.enable")

        # 手动初始化 QWebChannel，看 bridge 是否注册
        expr = """
new Promise((resolve)=>{
  try {
    new QWebChannel(qt.webChannelTransport, function(channel){
      const objs = channel.objects || {};
      resolve({
        keys: Object.keys(objs),
        hasBridge: !!objs.bridge,
        bridgeType: typeof objs.bridge
      });
    });
  } catch(e) { resolve({error: String(e)}); }
  setTimeout(()=>resolve({timeout:true}), 4000);
})
"""
        r = await send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        print("CHANNEL RESULT:", json.dumps(r.get("result", {}), ensure_ascii=False))

        # 检查 channel 初始化是否抛错（再看一次 window.sphereOverlay）
        r = await send("Runtime.evaluate", {"expression": "typeof window.sphereOverlay", "returnByValue": True})
        print("sphereOverlay now:", r.get("result", {}).get("result", {}).get("value"))


asyncio.run(main())
