import type { FacePose } from "./face-rig";

/**
 * 脸部屏的绘制层 —— 按实拍参考图逐像素还原的 1:1 版本。
 *
 * 设计坐标 1024²（纹理 512²，SCALE = 0.5），球冠开窗 R = 512：
 *   眼心 ±230 / Y 465、眼白 245×195（内倾由 pose.tilt 控制，基线 0.27rad）、
 *   眼窝玻璃边 11、竖瞳 78×135（内偏 54、上端顶到眼白上缘）、
 *   面罩带 904×378（超级椭圆 n=4.4，中心 Y 489）、屏幕底色 #15181F→#101218。
 *
 * 分层（自外向内）：灰壳 → 黑面罩 → 护目镜式面罩带 → 眼窝光晕/阴影 → 玻璃圈 →
 * 眼白（含眼睑阴影、外暗内亮）→ 竖瞳 → 内缘亮边。
 */

/** 设计坐标系（度量都按 1024 写），实际纹理等比缩放 */
const DESIGN = 1024;
export const FACE_TEX_SIZE = 512;
const SCALE = FACE_TEX_SIZE / DESIGN;

const C = DESIGN / 2;
const R = DESIGN / 2;

export const EYE_DX = 230;
export const EYE_CY = 465;
/** 眼白半宽 / 半高 */
export const EYE_A = 124;
export const EYE_B = 96;
/** 眼窝（玻璃圈）边宽 */
const BEVEL = 11;

const PUPIL_HW = 39;
const PUPIL_DX = 54;
const PUPIL_DY = 2;
const PUPIL_TOP = -72;
const PUPIL_BOT = 63;

const BAND = { cx: C, cy: 489, rx: 452, ry: 189, n: 4.4 };

/** 上下半径不同的椭圆并按 rot 旋转（rot 为正 = 内眼角下沉） */
function eyeOutline(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ryTop: number,
  ryBot: number,
  rot: number,
  N = 160,
) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  ctx.beginPath();
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * Math.PI * 2;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const lx = cs * rx;
    const ly = sn * (sn >= 0 ? ryBot : ryTop);
    const x = cx + lx * cos - ly * sin;
    const y = cy + lx * sin + ly * cos;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** 竖瞳：上端宽圆、下端收尖（贝塞尔），按 rot 旋转 */
function pupilPath(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  hw: number,
  top: number,
  bot: number,
  rot: number,
) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const T = (x: number, y: number): [number, number] => [
    px + x * cos - y * sin,
    py + x * sin + y * cos,
  ];
  const h = bot - top;
  const p: Array<[number, number]> = [
    [0, top],
    [hw * 0.64, top + h * 0.004],
    [hw, top + h * 0.2],
    [hw, top + h * 0.46],
    [hw, top + h * 0.68],
    [hw * 0.68, top + h * 0.87],
    [0, bot],
    [-hw * 0.68, top + h * 0.87],
    [-hw, top + h * 0.68],
    [-hw, top + h * 0.46],
    [-hw, top + h * 0.2],
    [-hw * 0.64, top + h * 0.004],
    [0, top],
  ];
  ctx.beginPath();
  ctx.moveTo(...T(p[0][0], p[0][1]));
  for (let s = 0; s < 4; s += 1) {
    const i = 1 + s * 3;
    const c1 = T(p[i][0], p[i][1]);
    const c2 = T(p[i + 1][0], p[i + 1][1]);
    const e = T(p[i + 2][0], p[i + 2][1]);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
  }
  ctx.closePath();
}

/** 面罩带：圆角收敛的超级椭圆 */
function bandPath(ctx: CanvasRenderingContext2D) {
  const N = 180;
  ctx.beginPath();
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * Math.PI * 2;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const x = BAND.cx + Math.sign(cs) * Math.pow(Math.abs(cs), 2 / BAND.n) * BAND.rx;
    const y = BAND.cy + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / BAND.n) * BAND.ry;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawMouth(ctx: CanvasRenderingContext2D) {
  const cx = 530;
  const cy = 952;
  const rx = 205;
  const ry = 30;
  ctx.save();
  ctx.filter = `blur(${2.4 * SCALE}px)`;
  ctx.beginPath();
  ctx.moveTo(cx - rx, cy + 8);
  ctx.quadraticCurveTo(cx - rx * 0.45, cy - ry, cx, cy - ry * 0.55);
  ctx.quadraticCurveTo(cx + rx * 0.45, cy - ry, cx + rx, cy + 8);
  ctx.quadraticCurveTo(cx, cy + ry * 0.9, cx - rx, cy + 8);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.10)";
  ctx.fill();
  ctx.strokeStyle = "rgba(120,140,172,0.022)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
}

function drawEye(ctx: CanvasRenderingContext2D, dir: number, pose: FacePose, blink: number) {
  const cx = C + dir * EYE_DX;
  const cy = EYE_CY;
  const open = Math.max(0.03, (dir > 0 ? pose.openR : pose.openL) * blink);
  const squint = dir > 0 ? pose.squintR : pose.squintL;
  const rot = -dir * (dir > 0 ? pose.tiltR : pose.tiltL);

  const rx = EYE_A;
  const ryTop = EYE_B * open;
  const ryBot = EYE_B * open * (1 - squint * 0.8);
  const rxB = rx + BEVEL;
  const ryTopB = (EYE_B + BEVEL) * open;
  const ryBotB = (EYE_B + BEVEL) * open * (1 - squint * 0.78);

  // ── 眼白外溢光晕（屏光反射到眼窝）
  ctx.save();
  ctx.filter = `blur(${14 * SCALE}px)`;
  eyeOutline(ctx, cx, cy, rxB + 8, ryTopB + 8, ryBotB + 8, rot);
  ctx.fillStyle = "rgba(190,200,220,0.07)";
  ctx.fill();
  ctx.restore();

  // ── 眼窝凹陷
  ctx.save();
  ctx.filter = `blur(${10 * SCALE}px)`;
  eyeOutline(ctx, cx, cy, rxB + 3, ryTopB + 3, ryBotB + 3, rot);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fill();
  ctx.restore();

  // ── 玻璃圈（上暗下亮的金属边）
  eyeOutline(ctx, cx, cy, rxB, ryTopB, ryBotB, rot);
  const bezel = ctx.createLinearGradient(0, cy - EYE_B, 0, cy + EYE_B);
  bezel.addColorStop(0.0, "#1a1c21");
  bezel.addColorStop(0.3, "#2c2f35");
  bezel.addColorStop(0.62, "#3d4047");
  bezel.addColorStop(0.86, "#4a4e56");
  bezel.addColorStop(1.0, "#545861");
  ctx.fillStyle = bezel;
  ctx.fill();
  ctx.strokeStyle = "rgba(3,4,7,0.5)";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // ── 圈口反光：外上方最亮，向下收
  eyeOutline(ctx, cx, cy, rxB, ryTopB, ryBotB, rot);
  const rim = ctx.createLinearGradient(cx + dir * rxB, cy - ryTopB, cx - dir * rxB, cy + ryBotB);
  rim.addColorStop(0.0, "rgba(255,255,255,0.30)");
  rim.addColorStop(0.4, "rgba(255,255,255,0.07)");
  rim.addColorStop(0.7, "rgba(255,255,255,0.015)");
  rim.addColorStop(1.0, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = rim;
  ctx.lineWidth = 3.4;
  ctx.stroke();

  // ── 眼白
  eyeOutline(ctx, cx, cy, rx, ryTop, ryBot, rot);
  const sclera = ctx.createLinearGradient(0, cy - EYE_B, 0, cy + EYE_B);
  sclera.addColorStop(0.0, "#c9cbd1");
  sclera.addColorStop(0.1, "#dfe0e4");
  sclera.addColorStop(0.34, "#ededef");
  sclera.addColorStop(0.62, "#f1f1f3");
  sclera.addColorStop(0.86, "#e5e6e9");
  sclera.addColorStop(1.0, "#ced0d4");
  ctx.fillStyle = sclera;
  ctx.fill();

  ctx.save();
  eyeOutline(ctx, cx, cy, rx, ryTop, ryBot, rot);
  ctx.clip();

  // 外暗内亮的横向层次
  const side = ctx.createLinearGradient(cx + dir * rx, cy, cx - dir * rx, cy);
  side.addColorStop(0.0, "rgba(0,0,0,0.07)");
  side.addColorStop(0.55, "rgba(0,0,0,0)");
  side.addColorStop(1.0, "rgba(0,0,0,0.02)");
  ctx.fillStyle = side;
  ctx.fillRect(cx - rx, cy - EYE_B, rx * 2, EYE_B * 2);

  // 外上方压暗（眼窝深处的遮挡）
  const shade = ctx.createRadialGradient(
    cx + dir * rx * 0.85,
    cy - ryTop,
    0,
    cx + dir * rx * 0.85,
    cy - ryTop,
    170,
  );
  shade.addColorStop(0.0, "rgba(70,76,90,0.20)");
  shade.addColorStop(0.45, "rgba(70,76,90,0.05)");
  shade.addColorStop(1.0, "rgba(70,76,90,0)");
  ctx.fillStyle = shade;
  ctx.fillRect(cx - rx, cy - EYE_B, rx * 2, EYE_B * 2);

  // 上眼睑投影（越靠上越暗，让竖瞳上端与上缘融为一体）
  const lid = ctx.createLinearGradient(0, cy - EYE_B * open, 0, cy - EYE_B * open * 0.5);
  lid.addColorStop(0, "rgba(78,84,98,0.42)");
  lid.addColorStop(1, "rgba(78,84,98,0)");
  ctx.fillStyle = lid;
  ctx.fillRect(cx - rx, cy - EYE_B, rx * 2, EYE_B * 1.5);

  // 眼白中心的高光核
  const core = ctx.createRadialGradient(cx - dir * 22, cy - 10, 8, cx - dir * 22, cy - 10, 165);
  core.addColorStop(0, "rgba(255,255,255,0.16)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(cx - rx, cy - EYE_B, rx * 2, EYE_B * 2);

  // ── 竖瞳
  const gx = pose.gazeX * 34;
  const gy = pose.gazeY * 26;
  const px = cx - dir * PUPIL_DX + gx;
  const py = cy + PUPIL_DY + gy;
  const sc = Math.max(0.4, pose.pupilScale * (0.82 + 0.18 * open));
  const vf = 0.48 + 0.52 * open;
  pupilPath(ctx, px, py, PUPIL_HW * sc, PUPIL_TOP * sc * vf, PUPIL_BOT * sc * vf, 0);
  const drop = ctx.createLinearGradient(px - 40, py - 80, px + 30, py + 80);
  drop.addColorStop(0, "#191d27");
  drop.addColorStop(0.42, "#121620");
  drop.addColorStop(1, "#0c1017");
  ctx.fillStyle = drop;
  ctx.fill();
  ctx.strokeStyle = "rgba(150,168,196,0.07)";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.restore();

  // ── 内缘亮边（下缘最亮）
  eyeOutline(ctx, cx, cy, rx, ryTop, ryBot, rot);
  const innerLine = ctx.createLinearGradient(0, cy - EYE_B * open, 0, cy + EYE_B * open);
  innerLine.addColorStop(0, "rgba(255,255,255,0.02)");
  innerLine.addColorStop(0.6, "rgba(255,255,255,0.16)");
  innerLine.addColorStop(1, "rgba(255,255,255,0.55)");
  ctx.strokeStyle = innerLine;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * 背景层（黑面罩 + 面罩带 + 嘴线 + 暗角）：只在辉光变化时重画，
 * 每帧只重画眼睛，桌宠常驻 30fps 也不吃 CPU。
 */
export function drawFaceBackground(ctx: CanvasRenderingContext2D, glow: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, FACE_TEX_SIZE, FACE_TEX_SIZE);
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  const size = DESIGN;
  const g = Math.max(0, Math.min(1, glow));

  ctx.save();
  ctx.beginPath();
  ctx.arc(C, C, R, 0, Math.PI * 2);
  ctx.clip();

  // 屏幕底色：中心略亮、边缘压暗（glow 只做极小幅提亮）
  const r0 = Math.round(18 + 8 * g);
  const g0 = Math.round(21 + 8 * g);
  const b0 = Math.round(29 + 9 * g);
  const base = ctx.createRadialGradient(512, 500, 240, 512, 500, 660);
  base.addColorStop(0.0, `rgb(${r0},${g0},${b0})`);
  base.addColorStop(0.55, `rgb(${r0},${g0},${b0 - 1})`);
  base.addColorStop(0.8, `rgb(${r0 - 1},${g0 - 2},${b0 - 4})`);
  base.addColorStop(1.0, `rgb(${r0 - 5},${g0 - 6},${b0 - 8})`);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // 上缘冷光
  const glowTop = ctx.createRadialGradient(430, 210, 20, 430, 210, 560);
  glowTop.addColorStop(0, "rgba(126,151,190,0.02)");
  glowTop.addColorStop(0.5, "rgba(112,136,175,0.008)");
  glowTop.addColorStop(1, "rgba(112,136,175,0)");
  ctx.fillStyle = glowTop;
  ctx.fillRect(0, 0, size, size);

  // 右侧薄反光
  const rightStreak = ctx.createLinearGradient(824, 0, 962, 0);
  rightStreak.addColorStop(0, "rgba(120,145,185,0)");
  rightStreak.addColorStop(0.72, "rgba(120,145,185,0.03)");
  rightStreak.addColorStop(1, "rgba(120,145,185,0)");
  ctx.fillStyle = rightStreak;
  ctx.fillRect(760, 120, 264, 840);

  // 面罩带：比面罩更深的哑光黑，带一点冷蓝，边缘锐利
  ctx.save();
  ctx.filter = `blur(${2.5 * SCALE}px)`;
  bandPath(ctx);
  const bandGrad = ctx.createLinearGradient(0, BAND.cy - BAND.ry, 0, BAND.cy + BAND.ry);
  bandGrad.addColorStop(0, "rgba(3,7,20,0.56)");
  bandGrad.addColorStop(0.25, "rgba(3,8,21,0.50)");
  bandGrad.addColorStop(0.62, "rgba(3,8,21,0.50)");
  bandGrad.addColorStop(1, "rgba(3,7,20,0.56)");
  ctx.fillStyle = bandGrad;
  ctx.fill();
  ctx.restore();

  // 面罩带上沿的分模线
  ctx.save();
  ctx.filter = `blur(${3 * SCALE}px)`;
  const inner = { cx: BAND.cx, cy: BAND.cy - 14, rx: BAND.rx - 26, ry: BAND.ry - 6, n: BAND.n };
  const N = 180;
  ctx.beginPath();
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * Math.PI * 2;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const x = inner.cx + Math.sign(cs) * Math.pow(Math.abs(cs), 2 / inner.n) * inner.rx;
    const y = inner.cy + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / inner.n) * inner.ry;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(132,152,182,0.055)";
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();

  drawMouth(ctx);

  // 暗角
  const vig = ctx.createRadialGradient(C, C, 340, C, C, 512);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(0.62, "rgba(0,0,0,0.06)");
  vig.addColorStop(0.9, "rgba(0,0,0,0.14)");
  vig.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, size, size);

  // 左上壳沿的一道冷光
  ctx.strokeStyle = "rgba(146,166,198,0.10)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(C, C, 508, Math.PI * 1.03, Math.PI * 1.62);
  ctx.stroke();

  ctx.restore();
}

/** 每帧只画眼睛（背景用缓存层） */
export function drawFaceEyes(ctx: CanvasRenderingContext2D, pose: FacePose, blink: number) {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  drawEye(ctx, -1, pose, blink);
  drawEye(ctx, 1, pose, blink);
}
