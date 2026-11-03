import type { FacePose } from "./face-rig";

/**
 * 脸部屏的绘制层。
 *
 * 版面按参考图（1920² 实拍，球半径 748px）换算到设计坐标：
 *   球半径 = 640px（5 模型单位），画布 1024 覆盖 8 单位
 *   眼心 ±222、眼心高 484、眼半宽 127、眼半高 96、眼窝边框 13、瞳孔半宽 42 / 高 78、向内偏 50
 *
 * 分层（自外向内）：灰壳（模型本体）→ 黑面罩（玻璃）→ 护目镜式眼罩带 → 眼白 + 黑豆瞳孔。
 */

/** 设计坐标系（度量都按 1024 写），实际纹理等比缩放 */
const DESIGN = 1024;
export const FACE_TEX_SIZE = 512;
const SCALE = FACE_TEX_SIZE / DESIGN;

const C = DESIGN / 2;
const R = DESIGN / 2;

export const EYE_DX = 222;
export const EYE_CY = 458;
export const EYE_HW = 132;
export const EYE_HH = 130;
/** 眼窝（玻璃管）边宽 */
const BEVEL = 14;
const PUPIL_HW = 40;
const PUPIL_HH = 68;
const PUPIL_DX = 52;

/**
 * 眼型：上眼睑略平、下眼睑圆、两端收圆角。
 * 睁眼度 / 眯眼 / 倾斜都是连续参数，眨眼与表情过渡靠它们插值。
 */
function eyePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  open: number,
  squint: number,
  tilt: number,
) {
  ctx.beginPath();
  const N = 128;
  const up = hh * open;
  const down = hh * open * (1 - squint * 0.86);
  const pUp = 0.66;
  const pDown = 1.0;
  const pX = 0.92;
  for (let i = 0; i <= N; i += 1) {
    const a = (i / N) * Math.PI * 2;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const p = sn >= 0 ? pUp : pDown;
    const x = Math.sign(cs) * Math.pow(Math.abs(cs), pX) * hw;
    const y = Math.sign(sn) * Math.pow(Math.abs(sn), p) * (sn >= 0 ? up : down);
    const rx = x * Math.cos(tilt) - y * Math.sin(tilt);
    const ry = x * Math.sin(tilt) + y * Math.cos(tilt);
    if (i === 0) ctx.moveTo(cx + rx, cy + ry);
    else ctx.lineTo(cx + rx, cy + ry);
  }
  ctx.closePath();
}

/** 黑豆瞳孔：上端探出眼白上缘、下端收成圆头，整体往内偏 */
function pupilPath(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number) {
  // 饱满的黑豆：上端略收、下端圆，整体靠内
  ctx.beginPath();
  ctx.ellipse(px, py, pw, ph, 0, 0, Math.PI * 2);
  ctx.closePath();
}

function drawEye(ctx: CanvasRenderingContext2D, dir: number, pose: FacePose, blink: number) {
  const cx = C + dir * EYE_DX;
  const cy = EYE_CY;
  const open = Math.max(0.02, pose[dir > 0 ? "openR" : "openL"] * blink);
  const squint = pose[dir > 0 ? "squintR" : "squintL"];
  const tilt = -dir * pose[dir > 0 ? "tiltR" : "tiltL"];

  // ── 眼窝：一圈「玻璃管」边框（上暗下亮）
  eyePath(ctx, cx, cy, EYE_HW, EYE_HH, open, squint, tilt);
  const bezel = ctx.createLinearGradient(0, cy - EYE_HH, 0, cy + EYE_HH);
  bezel.addColorStop(0, "#4e545e");
  bezel.addColorStop(0.3, "#7a818c");
  bezel.addColorStop(0.68, "#a9afb8");
  bezel.addColorStop(1, "#c2c7cf");
  ctx.fillStyle = bezel;
  ctx.fill();

  // 圈外缘压一道很细的暗线，把圈从黑屏里「切」出来
  ctx.save();
  ctx.strokeStyle = "rgba(6,7,10,0.8)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // ── 眼白
  const iw = EYE_HW - BEVEL;
  const ih = EYE_HH - BEVEL * 0.82;
  const icy = cy - BEVEL * 0.35;
  eyePath(ctx, cx, icy, iw, ih, open, squint, tilt);
  ctx.save();
  ctx.strokeStyle = "rgba(10,12,16,0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
  const sclera = ctx.createLinearGradient(0, icy - ih, 0, icy + ih);
  sclera.addColorStop(0, "#ffffff");
  sclera.addColorStop(0.45, "#f2f4f7");
  sclera.addColorStop(1, "#cfd3da");
  ctx.fillStyle = sclera;
  ctx.fill();

  ctx.save();
  eyePath(ctx, cx, icy, iw, ih, open, squint, tilt);
  ctx.clip();

  // 上眼睑投影
  const lid = ctx.createLinearGradient(0, icy - ih * open, 0, icy - ih * open * 0.1);
  lid.addColorStop(0, "rgba(92,98,112,0.38)");
  lid.addColorStop(1, "rgba(92,98,112,0)");
  ctx.fillStyle = lid;
  ctx.fillRect(cx - iw * 1.2, icy - ih * 1.2, iw * 2.4, ih * 1.4);

  // 玻璃高光（左上）
  const spec = ctx.createRadialGradient(cx - iw * 0.38, icy - ih * 0.42, 4, cx - iw * 0.3, icy - ih * 0.35, iw * 1.05);
  spec.addColorStop(0, "rgba(255,255,255,0.65)");
  spec.addColorStop(0.5, "rgba(255,255,255,0.1)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spec;
  ctx.fillRect(cx - iw, icy - ih, iw * 2, ih * 2);

  // 下缘反光
  const bounce = ctx.createLinearGradient(0, icy + ih * 0.35, 0, icy + ih);
  bounce.addColorStop(0, "rgba(255,255,255,0)");
  bounce.addColorStop(1, "rgba(255,255,255,0.42)");
  ctx.fillStyle = bounce;
  ctx.fillRect(cx - iw, icy, iw * 2, ih);

  // ── 瞳孔
  const range = iw - PUPIL_HW - 4;
  const px = cx + dir * PUPIL_DX + pose.gazeX * range * 0.6;
  // 瞳孔上端顶到眼白上缘、与黑罩连成一体；gazeY 在此基础上小幅偏移
  const py = icy - ih * open + PUPIL_HH * pose.pupilScale * 0.92 - pose.gazeY * (ih - PUPIL_HH) * 0.5;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(tilt);
  const pw = PUPIL_HW * pose.pupilScale;
  const ph = PUPIL_HH * pose.pupilScale;
  pupilPath(ctx, 0, 0, pw, ph);
  const pupilGrad = ctx.createLinearGradient(-pw, -ph, pw * 0.6, ph);
  pupilGrad.addColorStop(0, "#0e1116");
  pupilGrad.addColorStop(0.5, "#050609");
  pupilGrad.addColorStop(1, "#000000");
  ctx.fillStyle = pupilGrad;
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // 内缘高光：玻璃管内壁的一道细亮边（下缘最亮）
  ctx.save();
  eyePath(ctx, cx, cy, iw, ih, open, squint, tilt);
  const innerLine = ctx.createLinearGradient(0, icy - ih, 0, icy + ih);
  innerLine.addColorStop(0, "rgba(255,255,255,0.06)");
  innerLine.addColorStop(0.6, "rgba(255,255,255,0.3)");
  innerLine.addColorStop(1, "rgba(255,255,255,0.62)");
  ctx.strokeStyle = innerLine;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();
}

/** 护目镜式眼罩：上沿是一条略下凹的浅弧，下沿是宽弧，四角大圆角 */
function maskPath(ctx: CanvasRenderingContext2D) {
  const y = EYE_CY;
  const w = 478;
  const left = C - w;
  const right = C + w;
  const topY = y - 186;
  const botY = y + 182;
  ctx.beginPath();
  // 上沿：中间比两端低一点点（鼻梁位置的下凹）
  ctx.moveTo(left, topY + 46);
  ctx.quadraticCurveTo(C, topY + 68, right, topY + 46);
  // 右侧大圆角
  ctx.quadraticCurveTo(right + 16, y + 16, right - 44, botY - 10);
  // 下沿：中间比两端低（往下鼓的宽弧）
  ctx.quadraticCurveTo(C, botY + 20, left + 44, botY - 10);
  ctx.quadraticCurveTo(left - 16, y + 16, left, topY + 46);
  ctx.closePath();
}

/**
 * 背景层（黑面罩 + 玻璃反光 + 眼罩带）：只在辉光变化时重画，
 * 每帧只重画眼睛，桌宠常驻 30fps 也不吃 CPU。
 */
export function drawFaceBackground(ctx: CanvasRenderingContext2D, glow: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, FACE_TEX_SIZE, FACE_TEX_SIZE);
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  const size = DESIGN;

  ctx.save();
  ctx.beginPath();
  ctx.arc(C, C, R, 0, Math.PI * 2);
  ctx.clip();

  // 黑面罩底色：中心略亮、边缘压暗
  const base = ctx.createRadialGradient(C, C - 30, 40, C, C, R);
  base.addColorStop(0, `rgb(${Math.round(16 + 12 * glow)},${Math.round(20 + 13 * glow)},${Math.round(28 + 16 * glow)})`);
  base.addColorStop(0.55, "#080b12");
  base.addColorStop(1, "#030508");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // 上缘玻璃反光
  const gloss = ctx.createRadialGradient(C - 40, C - R * 0.82, 20, C, C - R * 0.7, R * 1.05);
  gloss.addColorStop(0, "rgba(168,192,230,0.22)");
  gloss.addColorStop(0.45, "rgba(130,155,195,0.06)");
  gloss.addColorStop(1, "rgba(130,155,195,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, size, size);

  // 眼罩带：比面罩更深的一块哑光黑，边缘虚化
  ctx.save();
  ctx.filter = `blur(${12 * SCALE}px)`;
  maskPath(ctx);
  ctx.fillStyle = "rgba(0,0,0,0.9)";
  ctx.fill();
  ctx.restore();

  // 眼罩上沿的极细亮边（塑料分模线）
  ctx.save();
  ctx.filter = `blur(${2.5 * SCALE}px)`;
  ctx.strokeStyle = "rgba(140,158,186,0.14)";
  ctx.lineWidth = 3;
  maskPath(ctx);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

/** 每帧只画眼睛（背景用缓存层） */
export function drawFaceEyes(ctx: CanvasRenderingContext2D, pose: FacePose, blink: number) {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  drawEye(ctx, -1, pose, blink);
  drawEye(ctx, 1, pose, blink);
}
