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
  const out = {};
  out.dpr = window.devicePixelRatio;
  out.inner = [window.innerWidth, window.innerHeight];
  const c = document.querySelector('canvas');
  const cr = c.getBoundingClientRect();
  out.canvas = {rect:[cr.left,cr.top,cr.width,cr.height], attr:[c.width,c.height],
    pos:getComputedStyle(c).position, z:getComputedStyle(c).zIndex,
    pe:getComputedStyle(c).pointerEvents, opacity:getComputedStyle(c).opacity,
    display:getComputedStyle(c).display, transform:getComputedStyle(c).transform};
  const pane = document.querySelector('.overlay-pet-pane');
  const pr = pane.getBoundingClientRect();
  out.pane = {rect:[pr.left,pr.top,pr.width,pr.height], position:getComputedStyle(pane).position,
    z:getComputedStyle(pane).zIndex, pe:getComputedStyle(pane).pointerEvents};
  const slot = document.querySelector('.overlay-attach-slot');
  const sr = slot.getBoundingClientRect();
  out.slot = {rect:[sr.left,sr.top,sr.width,sr.height], pe:getComputedStyle(slot).pointerEvents};
  // elementFromPoint at canvas center
  const ccx = cr.left + cr.width/2, ccy = cr.top + cr.height/2;
  const top = document.elementFromPoint(ccx, ccy);
  out.topAtCanvasCenter = top ? (top.className || top.tagName) : null;
  // list all children of pane with rects
  out.paneChildren = Array.from(pane.children).map(e=>{
    const r=e.getBoundingClientRect();
    return {cls:e.className, rect:[r.left,r.top,r.width,r.height], pe:getComputedStyle(e).pointerEvents,
      z:getComputedStyle(e).zIndex, position:getComputedStyle(e).position};
  });
  return out;
})()
"""
        r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        print(json.dumps(r.get("result", {}).get("result", {}).get("value"), ensure_ascii=False, indent=2))


asyncio.run(main())
