import { loadSharp, type SharpInstance } from "./sharp-lazy.js";

import { randomBytes } from "node:crypto";

/**
 * 照片风格化服务（picture.stylize 的执行层）。
 *
 * 把一张照片变成另一种视觉风格，输出仍是图片（入库即自动贴墙）。
 * 全部风格都是**程序合成**（sharp + SVG 蒙版/排版），无模型、无网络、
 * 毫秒级、确定性（同图同参数同输出）——"撕纸海报"这类设计感效果来自
 * 设计规则而非 AI，社区通用做法即噪声撕边蒙版 + 分层合成。
 *
 * AI 风格迁移（动漫/油画，AnimeGANv3 / ONNX fast-neural-style，本地 CPU）
 * 是规划中的第二档，待拍板是否引入 onnxruntime-node 依赖后再接。
 *
 * 注意：文字排版依赖系统字体（Windows 有 Segoe/Consolas 系列）；
 * 无字体环境下文字层可能退化为默认字体，不影响图像本体。
 */

export type PhotoStyleId = "poster_torn" | "polaroid" | "noir" | "print_duotone";

export interface PhotoStyleResult {
  buffer: Buffer;
  style: PhotoStyleId;
  label: string;
  width: number;
  height: number;
}

export interface PhotoStyleSpec {
  id: PhotoStyleId;
  label: string;
  description: string;
}

export const PHOTO_STYLES: PhotoStyleSpec[] = [
  { id: "poster_torn", label: "撕纸海报", description: "撕纸拼贴海报：纸张底纹 + 撕边照片 + 红色饰带 + 打字机标题" },
  { id: "polaroid", label: "拍立得", description: "白框拍立得：暖调褪色 + 手写区签名" },
  { id: "noir", label: "黑白胶片", description: "黑白胶片：高对比暗房调 + 颗粒 + 暗角" },
  { id: "print_duotone", label: "双色版画", description: "印刷版画：纸面双色 + 强对比网点感" },
];

/** 确定性 PRNG（mulberry32）：同 seed 同撕边，重启不跳 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(seed?: string): number {
  if (seed && seed.length > 0) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  return randomBytes(4).readUInt32BE(0);
}

/** k 个控制点的余弦插值噪声场，输出 0..1（撕边的自然感来源） */
function makeNoiseField(rand: () => number, k: number): (t: number) => number {
  const points = Array.from({ length: k }, () => rand());
  return (t: number) => {
    const clamped = Math.max(0, Math.min(1, t));
    const pos = clamped * (k - 1);
    const i = Math.min(k - 2, Math.floor(pos));
    const f = pos - i;
    const a = points[i]!;
    const b = points[i + 1]!;
    const s = (1 - Math.cos(f * Math.PI)) / 2;
    return a * (1 - s) + b * s;
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** SVG 稀疏颗粒（确定性）：胶片/纸面的物理感 */
function grainSvg(width: number, height: number, count: number, rand: () => number, dark: boolean): string {
  const dots: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round(rand() * width);
    const y = Math.round(rand() * height);
    const r = rand() < 0.85 ? 1 : 2;
    const o = (0.03 + rand() * 0.06).toFixed(3);
    dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${dark ? "#000" : "#fff"}" opacity="${o}"/>`);
  }
  return dots.join("");
}

// ──────────────────────────── 风格一：撕纸海报 ────────────────────────────

async function applyPosterTorn(
  photo: SharpInstance,
  meta: { width: number; height: number },
  opts: { title?: string; seed?: string },
): Promise<Buffer> {
  const sharp = await loadSharp();
  const W = 900;
  const H = 1200;
  const rand = mulberry32(seedFrom(opts.seed));
  const noise = makeNoiseField(rand, 9);

  // 照片区：右侧偏中，撕掉左缘
  const photoW = 640;
  const photoH = 840;
  const photoX = 170;
  const photoY = 150;

  // 撕边：沿照片左缘的抖动竖线（低频摆动 + 高频毛边），照片局部坐标系
  const localJagged: string[] = [];
  const steps = 56;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = t * photoH;
    const lowFreq = noise(t) * 44;
    const highFreq = (rand() - 0.5) * 7;
    const x = lowFreq + highFreq;
    localJagged.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  // 照片预处理：轻微降饱和（印刷感）+ 撕边蒙版（feTurbulence 位移做纤维毛边）
  const maskedPhoto = await photo
    .clone()
    .resize(photoW, photoH, { fit: "cover" })
    .modulate({ saturation: 0.9, brightness: 1.03 })
    .toBuffer();
  const localMask = Buffer.from(
    `<svg width="${photoW}" height="${photoH}">
      <defs><filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="3"/></filter></defs>
      <path d="M ${photoW},0 L ${localJagged.join(" L ")} L ${photoW},${photoH} Z"
        fill="#fff" filter="url(#rough)"/>
      <path d="M ${localJagged.join(" L ")}" stroke="#f6efe0" stroke-width="3" fill="none" filter="url(#rough)"/>
    </svg>`,
  );
  const masked = await sharp(maskedPhoto)
    .composite([{ input: await sharp(localMask).png().toBuffer(), blend: "dest-in" }])
    .png()
    .toBuffer();

  // 纸面：底色 + 纤维斑点 + 边缘微暗
  const title = (opts.title ?? "MOMENT").slice(0, 24);
  const paperSvg = Buffer.from(
    `<svg width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#efe7d6"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#e2d8c2" stroke-width="2"/>
      ${grainSvg(W, H, 900, rand, false)}
      ${grainSvg(W, H, 700, rand, true)}
      <!-- 标题：打字机体，左下角 -->
      <text x="70" y="${H - 88}" font-family="Consolas, 'Courier New', monospace" font-size="30"
        letter-spacing="10" fill="#4a443c">${escapeXml(title)}</text>
      <text x="70" y="${H - 52}" font-family="Consolas, 'Courier New', monospace" font-size="14"
        letter-spacing="6" fill="#8a8272">A MOMENT, TORN FROM TIME</text>
    </svg>`,
  );
  // 红色饰带：最顶层横穿撕边（样例同款：纸面与照片上各露一段）
  const ribbonSvg = Buffer.from(
    `<svg width="${W}" height="${H}">
      <g transform="rotate(-7 ${W / 2} ${H * 0.42})">
        <rect x="${photoX - 150}" y="${H * 0.415}" width="470" height="10" rx="3" fill="#c9402e" opacity="0.92"/>
      </g>
    </svg>`,
  );

  return sharp(paperSvg)
    .composite([
      { input: masked, left: photoX, top: photoY },
      { input: ribbonSvg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

// ──────────────────────────── 风格二：拍立得 ────────────────────────────

async function applyPolaroid(
  photo: SharpInstance,
  meta: { width: number; height: number },
  opts: { title?: string; seed?: string },
): Promise<Buffer> {
  const sharp = await loadSharp();
  const rand = mulberry32(seedFrom(opts.seed));
  void rand;
  const frameW = 720;
  const inset = 34;
  const bottom = 118;
  const photoW = frameW - inset * 2;
  const photoH = Math.min(760, Math.round((photoW * 4) / 3));

  const graded = await photo
    .clone()
    .resize(photoW, photoH, { fit: "cover" })
    .modulate({ saturation: 0.82, brightness: 1.05 })
    .linear(1.04, -4)
    .png()
    .toBuffer();

  const H = photoH + bottom + inset;
  const caption = (opts.title ?? "").slice(0, 20);
  const frameSvg = Buffer.from(
    `<svg width="${frameW}" height="${H}">
      <rect width="${frameW}" height="${H}" rx="4" fill="#f7f4ec"/>
      <rect width="${frameW}" height="${H}" rx="4" fill="none" stroke="#ddd6c6" stroke-width="1.5"/>
      ${grainSvg(frameW, H, 500, mulberry32(seedFrom(opts.seed)), true)}
      <text x="${frameW / 2}" y="${H - 40}" text-anchor="middle" font-family="'Segoe Script','Segoe UI',cursive"
        font-size="30" fill="#40403c">${escapeXml(caption)}</text>
    </svg>`,
  );

  return sharp(frameSvg)
    .composite([{ input: graded, left: inset, top: inset }])
    .png()
    .toBuffer();
}

// ──────────────────────────── 风格三：黑白胶片 ────────────────────────────

async function applyNoir(
  photo: SharpInstance,
  meta: { width: number; height: number },
  opts: { title?: string; seed?: string },
): Promise<Buffer> {
  const sharp = await loadSharp();
  const W = meta.width;
  const H = meta.height;
  const rand = mulberry32(seedFrom(opts.seed));
  const border = Math.max(14, Math.round(Math.min(W, H) * 0.028));

  const graded = await photo
    .clone()
    .resize(W, H, { fit: "cover" })
    .grayscale()
    .linear(1.18, -22)
    .png()
    .toBuffer();

  // 暗角：径向渐变叠加（multiply）
  const vignette = Buffer.from(
    `<svg width="${W}" height="${H}">
      <defs><radialGradient id="v" cx="50%" cy="46%" r="72%">
        <stop offset="55%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#5a5a5a"/>
      </radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#v)"/>
    </svg>`,
  );
  const grain = Buffer.from(
    `<svg width="${W}" height="${H}">${grainSvg(W, H, Math.round((W * H) / 900), rand, true)}</svg>`,
  );
  const frameSvg = Buffer.from(
    `<svg width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#0c0c0c"/>
      <text x="${border + 12}" y="${H - border / 2.4}" font-family="Consolas, monospace"
        font-size="${Math.max(12, Math.round(border * 0.9))}" letter-spacing="4" fill="#6f6f6f">35MM FILM</text>
    </svg>`,
  );

  return sharp(frameSvg)
    .composite([
      { input: graded, left: border, top: border },
      { input: vignette, left: border, top: border, blend: "multiply" },
      { input: grain, left: border, top: border },
    ])
    .png()
    .toBuffer();
}

// ──────────────────────────── 风格四：双色版画 ────────────────────────────

async function applyPrintDuotone(
  photo: SharpInstance,
  meta: { width: number; height: number },
  opts: { title?: string; seed?: string },
): Promise<Buffer> {
  const sharp = await loadSharp();
  const W = meta.width;
  const H = meta.height;
  const rand = mulberry32(seedFrom(opts.seed));
  const border = Math.max(18, Math.round(Math.min(W, H) * 0.04));

  // 强对比灰度 → 纸面 multiply 出双色版画感
  const ink = await photo
    .clone()
    .resize(W, H, { fit: "cover" })
    .grayscale()
    .normalise()
    .linear(1.7, -95)
    .png()
    .toBuffer();

  const paper = Buffer.from(
    `<svg width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#ece4d2"/>
      ${grainSvg(W, H, 1200, rand, true)}
      <rect x="${border / 2}" y="${border / 2}" width="${W - border}" height="${H - border}"
        fill="none" stroke="#3a342a" stroke-width="3"/>
      ${(opts.title ?? "").trim()
        ? `<text x="${W / 2}" y="${H - border / 2 + 2}" text-anchor="middle" font-family="Consolas, monospace"
            font-size="${Math.max(14, Math.round(border))}" letter-spacing="12" fill="#3a342a">${escapeXml((opts.title ?? "").toUpperCase().slice(0, 18))}</text>`
        : ""}
    </svg>`,
  );

  return sharp(paper)
    .composite([{ input: ink, left: 0, top: 0, blend: "multiply" }])
    .png()
    .toBuffer();
}

// ──────────────────────────── 入口 ────────────────────────────

/**
 * 对照片应用风格化。输入任意常见格式，输出 PNG（确定性：同输入同输出）。
 */
export async function applyPhotoStyle(
  input: Buffer,
  style: PhotoStyleId,
  opts: { title?: string; seed?: string } = {},
): Promise<PhotoStyleResult> {
  const sharp = await loadSharp();
  const spec = PHOTO_STYLES.find((s) => s.id === style);
  if (!spec) {
    throw new Error(`未知风格: ${style}（可选：${PHOTO_STYLES.map((s) => s.id).join(", ")}）`);
  }
  const base = sharp(input, { animated: false }).rotate(); // EXIF 方向归正
  const meta = await base.metadata();
  const width = meta.width ?? 800;
  const height = meta.height ?? 600;

  let buffer: Buffer;
  switch (style) {
    case "poster_torn":
      buffer = await applyPosterTorn(base, { width, height }, opts);
      break;
    case "polaroid":
      buffer = await applyPolaroid(base, { width, height }, opts);
      break;
    case "noir":
      buffer = await applyNoir(base, { width, height }, opts);
      break;
    case "print_duotone":
      buffer = await applyPrintDuotone(base, { width, height }, opts);
      break;
  }
  return { buffer, style, label: spec.label, width, height };
}
