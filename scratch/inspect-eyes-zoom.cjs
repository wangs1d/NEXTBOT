// 精确定位双眼区域：裁剪、放大 6x，并统计每只眼区域内最亮像素。
const path = require("path");
const sharp = require(path.resolve(__dirname, "..", "node_modules", "sharp"));

const FILE = path.resolve(__dirname, "..", "client", "flutter_app", "assets", "agent_avatars", "real_human_cutout.png");

(async () => {
  const { width, height } = await sharp(FILE).metadata();
  const raw = await sharp(FILE).ensureAlpha().raw().toBuffer();
  const stride = width * 4;

  function brightest(x0, y0, x1, y1) {
    const list = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * stride + x * 4;
        const r = raw[i], g = raw[i + 1], b = raw[i + 2], a = raw[i + 3];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        list.push({ x, y, r, g, b, a, lum });
      }
    }
    list.sort((p, q) => q.lum - p.lum);
    return list.slice(0, 10);
  }

  // 从 eyebrowband 目测：眼睛约在 y 315-370，左眼(观众左) x 240-320，右眼(观众右) x 380-470
  const zones = {
    eyeL: [230, 310, 330, 380],
    eyeR: [370, 300, 480, 380],
  };
  for (const [name, [x0, y0, x1, y1]] of Object.entries(zones)) {
    const top = brightest(x0, y0, x1, y1);
    console.log(`\n${name}: top-10 brightest`);
    for (const p of top) console.log(`  (${p.x},${p.y}) rgb(${p.r},${p.g},${p.b}) a=${p.a} lum=${p.lum.toFixed(0)}`);
    await sharp(FILE).ensureAlpha()
      .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
      .resize({ width: (x1 - x0) * 6, kernel: "nearest" })
      .png().toFile(path.resolve(__dirname, `${name}_zoom.png`));
  }
})();
