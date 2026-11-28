// 放大用户截图，定位白点，并统计该区域像素。
const path = require("path");
const sharp = require(path.resolve(__dirname, "..", "node_modules", "sharp"));

const SRC = "C:\\Users\\Administrator\\.zcode\\cli\\image-cache\\sess_e31b4bbd-e6a0-4f0d-93f9-d27127691a90\\image-04b4041dc65695f9fa76bbfeb693a816.png";

(async () => {
  const meta = await sharp(SRC).metadata();
  console.log("screenshot:", meta.width, "x", meta.height);
  await sharp(SRC).resize({ width: meta.width * 6, kernel: "nearest" }).png()
    .toFile(path.resolve(__dirname, "user_shot_6x.png"));

  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  // 找全图最亮的近白像素簇
  const hits = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.min(r, g, b) > 215) hits.push({ x, y, r, g, b });
    }
  }
  console.log("near-white(>215) pixels:", hits.length);
  for (const h of hits.slice(0, 40)) console.log(`  (${h.x},${h.y}) rgb(${h.r},${h.g},${h.b})`);
})();
