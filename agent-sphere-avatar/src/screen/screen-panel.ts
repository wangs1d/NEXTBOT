/**
 * 曲屏面板质感 — 只画「屏幕本身」，不画任何脸。
 *
 * 内容：深色背板、中心背光、极淡扫描线、缓慢下移的刷新亮带、边缘暗角。
 * 这里**不画任何五官** —— 表情系统已按用户要求整体删除（SVG 表情方案不满意），
 * 但「把 DG2 黑色曲面玻璃当真实屏幕」的质感层保留。
 *
 * 分层的理由：除中心背光外全部离屏预渲染，每帧只有几次 drawImage。
 */

const TAU = Math.PI * 2;

export interface ScreenFrame {
  /** 整体亮度 0–1 */
  lit: number;
  /** 秒 */
  time: number;
  /** 刷新亮带的速度倍率 — 让屏幕在情绪变化时有可感知的呼吸 */
  bandSpeed: number;
  /** 中心背光强度 0–1 */
  glow: number;
}

export interface ScreenPanelOptions {
  /** 是否绘制扫描线 / 刷新带，默认 true */
  screenFx?: boolean;
}

function createLayer(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function layerCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

export class ScreenPanel {
  readonly size: number;
  private readonly screenFx: boolean;

  private readonly backplate: HTMLCanvasElement;
  private readonly centerGlow: HTMLCanvasElement;
  private readonly scanlines: HTMLCanvasElement;
  private readonly bezel: HTMLCanvasElement;
  private readonly refreshBar: HTMLCanvasElement;
  private readonly refreshHeight: number;

  constructor(size = 512, options: ScreenPanelOptions = {}) {
    this.size = size;
    this.screenFx = options.screenFx ?? true;
    this.backplate = createLayer(size, size);
    this.centerGlow = createLayer(size, size);
    this.scanlines = createLayer(size, size);
    this.bezel = createLayer(size, size);
    this.refreshHeight = Math.round(size * 0.2);
    this.refreshBar = createLayer(size, this.refreshHeight);
    this.buildBackplate();
    this.buildCenterGlow();
    this.buildScanlines();
    this.buildBezel();
    this.buildRefreshBar();
  }

  /** 背板：OLED 底色 */
  private buildBackplate(): void {
    const s = this.size;
    const ctx = layerCtx(this.backplate);
    ctx.fillStyle = "#03060a";
    ctx.fillRect(0, 0, s, s);
  }

  /** 中心背光：单独一层，强度可随能量调节 */
  private buildCenterGlow(): void {
    const s = this.size;
    const ctx = layerCtx(this.centerGlow);
    const g = ctx.createRadialGradient(s * 0.5, s * 0.46, s * 0.02, s * 0.5, s * 0.46, s * 0.62);
    g.addColorStop(0, "rgba(22,42,68,0.55)");
    g.addColorStop(0.5, "rgba(12,24,40,0.36)");
    g.addColorStop(1, "rgba(3,6,10,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }

  /**
   * 扫描线。刻意做得极淡：它只该是一层可感知的通电质感，
   * 一旦能「看出条纹」就说明过头了。
   */
  private buildScanlines(): void {
    const s = this.size;
    const ctx = layerCtx(this.scanlines);
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    for (let y = 0; y < s; y += 4) {
      ctx.fillRect(0, y, s, 1);
    }
  }

  /** 屏幕内圈暗角 — 曲面屏边缘的自然衰减 */
  private buildBezel(): void {
    const s = this.size;
    const ctx = layerCtx(this.bezel);
    ctx.clearRect(0, 0, s, s);
    const r = s * 0.5;
    const g = ctx.createRadialGradient(s * 0.5, s * 0.5, r * 0.78, s * 0.5, s * 0.5, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.72, "rgba(0,0,0,0.16)");
    g.addColorStop(0.95, "rgba(0,0,0,0.58)");
    g.addColorStop(1, "rgba(0,0,0,0.9)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, r, 0, TAU);
    ctx.fill();
  }

  /** 缓慢下移的刷新亮带（极淡） */
  private buildRefreshBar(): void {
    const { width, height } = this.refreshBar;
    const ctx = layerCtx(this.refreshBar);
    ctx.clearRect(0, 0, width, height);
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, "rgba(150,200,255,0)");
    g.addColorStop(0.5, "rgba(160,205,255,0.03)");
    g.addColorStop(1, "rgba(150,200,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  draw(ctx: CanvasRenderingContext2D, frame: ScreenFrame): void {
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.backplate, 0, 0);

    if (frame.lit > 0.02) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, frame.glow * frame.lit);
      ctx.drawImage(this.centerGlow, 0, 0);
      ctx.restore();

      if (this.screenFx) {
        ctx.drawImage(this.scanlines, 0, 0);
        const speed = Math.max(0.2, frame.bandSpeed);
        const period = 9 / speed;
        const phase = (frame.time % period) / period;
        const bandY = -this.refreshHeight + phase * (s + this.refreshHeight * 2);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.4 * frame.lit;
        ctx.drawImage(this.refreshBar, 0, bandY);
        ctx.restore();
      }
    }

    ctx.drawImage(this.bezel, 0, 0);
  }

  dispose(): void {
    for (const layer of [this.backplate, this.centerGlow, this.scanlines, this.bezel, this.refreshBar]) {
      layer.width = 0;
      layer.height = 0;
    }
  }
}
