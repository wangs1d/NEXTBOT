// 1) 找纯白高光点（min(r,g,b)>228, alpha>80）；2) 裁出脸部区域放大存图，便于肉眼检查。
const path = require("path");
const sharp = require(path.resolve(__dirname, "..", "node_modules", "sharp"));

async function scan(file, outPrefix) {
  const meta = await sharp(file).metadata();
  const { width, height } = meta;
  const raw = await sharp(file).ensureAlpha().raw().toBuffer();
  const stride = width * 4;
  console.log(`\n=== ${file}  ${width}x${height} ===`);

  const hits = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * 4;
      const r = raw[i], g = raw[i + 1], b = raw[i + 2], a = raw[i + 3];
      if (Math.min(r, g, b) > 228 && a > 80) hits.push({ x, y, r, g, b, a });
    }
  }
  console.log(`pure-white (all>228, a>80): ${hits.length}`);
  if (hits.length) {
    const clusters = new Map();
    for (const h of hits) {
      const key = `${Math.round(h.x / 12)}_${Math.round(h.y / 12)}`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(h);
    }
    const sorted = [...clusters.values()].sort((a, b) => b.length - a.length);
    for (const c of sorted.slice(0, 12)) {
      const xs = c.map(p => p.x), ys = c.map(p => p.y);
      console.log(
        `cluster x[${Math.min(...xs)}-${Math.max(...xs)}] y[${Math.min(...ys)}-${Math.max(...ys)}] ` +
        `n=${c.length} a=${Math.min(...c.map(p => p.a))}-${Math.max(...c.map(p => p.a))} ` +
        `rgb~(${c[0].r},${c[0].g},${c[0].b})`
      );
    }
  }

  // 裁脸部上半（眼睛大概在 10%-45% 高度），放大 2x 存图
  const top = Math.floor(height * 0.10);
  const h = Math.floor(height * 0.35);
  const crop = { left: 0, top, width, height: h };
  await sharp(file).ensureAlpha().extract(crop).resize({ width: width * 2, kernel: "nearest" })
    .png().toFile(`${outPrefix}_eyeband.png`);
  // alpha 可视化：alpha<250 标红，其余半亮灰
  const vis = Buffer.alloc(width * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y + top) * stride + x * 4;
      const j = (y * width + x) * 3;
      const a = raw[i + 3];
      if (a < 240) { vis[j] = 255; vis[j + 1] = raw[i] > 200 ? 40 : 0; vis[j + 2] = 40; }
      else { vis[j] = raw[i] / 2; vis[j + 1] = raw[i + 1] / 2; vis[j + 2] = raw[i + 2] / 2; }
    }
  }
  await sharp(vis, { raw: { width, height: h, channels: 3 } })
    .resize({ width: width * 2, kernel: "nearest" }).png().toFile(`${outPrefix}_alpha.png`);
  console.log(`saved ${outPrefix}_eyeband.png / ${outPrefix}_alpha.png (crop top=${top} h=${h})`);
}

(async () => {
  const base = path.resolve(__dirname, "..", "client", "flutter_app", "assets", "agent_avatars");
  await scan(path.join(base, "real_human_cutout.png"), path.resolve(__dirname, "real"));
  await scan(path.join(base, "muse_cutout.png"), path.resolve(__dirname, "muse"));
})();
