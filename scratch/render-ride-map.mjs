import sharp from "sharp";

const Z = 16, X0 = 51869, Y0 = 28051;
const tiles = [];
for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
  tiles.push(fetch(`https://webrd0${1 + ((dx + 1) % 3)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${X0 + dx}&y=${Y0 + dy}&z=${Z}`).then(r => r.arrayBuffer()));
}
const bufs = await Promise.all(tiles);
const comps = [];
for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
  comps.push({ input: Buffer.from(bufs[(dy + 1) * 3 + (dx + 1)]), left: (dx + 1) * 256, top: (dy + 1) * 256 });
}
const cropLeft = 195, cropTop = 332, cropW = 340, cropH = 190;
const base = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#f2f0eb" } })
  .composite(comps).png().toBuffer();
const cropped = await sharp(base).extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).png().toBuffer();
// 裁后坐标 = 原坐标 - crop
const pinX = 486 - cropLeft, pinY = 435 - cropTop;
const cands = [
  { name: "向阳小区-地上停车场", x: 301 - cropLeft, y: 391 - cropTop, dist: 112 },
  { name: "州体育公园停车场", x: 319 - cropLeft, y: 443 - cropTop, dist: 116 },
  { name: "大众地上停车场", x: 200 - cropLeft, y: 431 - cropTop, dist: 146 },
];
const svg = `<svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">
  ${cands.map(c => `<g><circle cx="${c.x}" cy="${c.y}" r="6" fill="#ffffff" stroke="#1a1c20" stroke-width="2"/></g>`).join("")}
  <g transform="translate(${pinX},${pinY})">
    <circle r="15" fill="rgba(0,0,0,.15)"/>
    <path d="M0 -20 C-8 -20 -12 -14 -12 -8 C-12 -1 0 12 0 12 C0 12 12 -1 12 -8 C12 -14 8 -20 0 -20 Z" fill="#000" stroke="#fff" stroke-width="2"/>
    <circle cy="-9" r="4" fill="#fff"/>
    <rect x="-46" y="16" width="92" height="20" rx="10" fill="#ffffff" stroke="#c9c7c1"/>
    <text y="30" font-size="12" font-family="sans-serif" fill="#1a1c20" text-anchor="middle" font-weight="bold">拖我选上车点</text>
  </g>
</svg>`;
await sharp(cropped).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png().toFile("../design/ride-card-real-map.png");
console.log("done");
