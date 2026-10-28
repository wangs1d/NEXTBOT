import asyncio
import base64
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

        await send("Page.enable")

        # 注入相关
        for name, expr in [
            ("qt", "typeof qt"),
            ("transport", "typeof qt!=='undefined' ? !!qt.webChannelTransport : 'no qt'"),
            ("QWebChannel", "typeof QWebChannel"),
            ("readyEvent", "window.__readySeen||'n/a'"),
            ("consoleLog", "window.__logs||null"),
        ]:
            r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            print(f"INJECT {name}:", r.get("result", {}).get("result", {}).get("value"))

        # 检查 Three.js 场景内对象数（通过 R3F 内部不可直接访问；改为统计 canvas 像素非空比例）
        r = await send("Runtime.evaluate", {
            "expression": """
(()=>{
  const c=document.querySelector('canvas');
  const g=c.getContext('webgl2');
  const w=c.width,h=c.height;
  const px=new Uint8Array(w*h*4);
  g.readPixels(0,0,w,h,g.RGBA,g.UNSIGNED_BYTE,px);
  let nonEmpty=0, alphaSum=0;
  for(let i=3;i<px.length;i+=4){ if(px[i]>0){nonEmpty++; alphaSum+=px[i];} }
  return {total:w*h, nonEmpty, ratio:nonEmpty/(w*h), alphaAvg: nonEmpty?alphaSum/nonEmpty:0};
})()
""",
            "returnByValue": True,
        })
        print("PIXELS:", r.get("result", {}).get("result", {}).get("value"))

        # CDP 页面截图
        shot = await send("Page.captureScreenshot", {"format": "png"})
        data = shot.get("result", {}).get("data")
        if data:
            with open("cdp-shot.png", "wb") as f:
                f.write(base64.b64decode(data))
            print("saved cdp-shot.png")


asyncio.run(main())
