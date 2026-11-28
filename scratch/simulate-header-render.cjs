// 模拟桌面头部 78px 圆内的降采样渲染：683x900 → 78x102.8（FilterQuality.high ≈ cubic），
// 再放大回去看眼睛处变成了什么；同时对比 300px 大图（双面板）的样子。
const path = require("path");
const sharp = require(path.resolve(__dirname, "..", "node_modules", "sharp"));

const FILE = path.resolve(__dirname, "..", "client", "flutter_app", "assets", "agent_avatars", "real_human_cutout.png");
const OUT = path.resolve(__dirname);

(async () => {
  // 头部圆内：宽 78，高 78*900/683=102.78
  const small = await sharp(FILE).resize(78, 103, { fit: "fill", kernel: "cubic" }).png().toBuffer();
  // 眼部区域在 78px 小图里：源 y315-380 → 小图 y36-44；x230-480 → x26-55
  await sharp(small).extract({ left: 20, top: 30, width: 40, height: 20 })
    .resize({ width: 480, kernel: "nearest" })
    .png().toFile(path.join(OUT, "sim_small_eyes.png"));
  // 整个小图放大
  await sharp(small).resize({ width: 312, kernel: "nearest" }).png().toFile(path.join(OUT, "sim_small_full.png"));

  // 双面板大图（~300 宽）
  const big = await sharp(FILE).resize(300, 395, { fit: "fill", kernel: "cubic" }).png().toBuffer();
  await sharp(big).extract({ left: 90, top: 120, width: 150, height: 70 })
    .resize({ width: 480, kernel: "nearest" })
    .png().toFile(path.join(OUT, "sim_big_eyes.png"));

  // 统计：小图眼部区域最亮像素
  const { data, info } = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let best = null;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (!best || lum > best.lum) best = { x, y, r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3], lum };
    }
  }
  console.log("78px 全图最亮像素:", JSON.stringify(best));
  console.log("面部在 78px 图中 x 范围约 20-58，眼区约 y36-44");
})();
