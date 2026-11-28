// 放大第二张截图的左上角数字人圆框头像，检查眼睛处是否有白点。
const path = require("path");
const sharp = require(path.resolve(__dirname, "..", "node_modules", "sharp"));

const SRC = "C:\\Users\\Administrator\\.zcode\\cli\\image-cache\\sess_e31b4bbd-e6a0-4f0d-93f9-d27127691a90\\image-25ad3b4d72846bc861343f888190b063.png";

(async () => {
  const meta = await sharp(SRC).metadata();
  console.log("shot2:", meta.width, "x", meta.height);
  // 左上头像圆框大致区域
  await sharp(SRC).extract({ left: 60, top: 15, width: 90, height: 90 })
    .resize({ width: 540, kernel: "nearest" })
    .png().toFile(path.resolve(__dirname, "shot2_avatar_6x.png"));

  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  // 头像区域 x60-150 y15-105：找最亮像素
  const hits = [];
  for (let y = 15; y < 105; y++) {
    for (let x = 60; x < 150; x++) {
      const i = (y * info.width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 180) hits.push({ x, y, r, g, b, lum: Math.round(lum) });
    }
  }
  hits.sort((a, b) => b.lum - a.lum);
  console.log("avatar 区亮像素 top20:");
  for (const h of hits.slice(0, 20)) console.log(`  (${h.x},${h.y}) rgb(${h.r},${h.g},${h.b}) lum=${h.lum}`);
})();
