/**
 * 桌宠脸部「电子屏」状态机。
 *
 * 面部不是一张静态贴图，而是一块可以连续变化的屏：所有表情都由一组连续参数
 * （睁眼度、眯眼、瞳孔位置、瞳孔缩放、眼睑倾斜、屏幕辉光）描述，
 * 目标值之间用临界阻尼弹簧插值，所以任意时刻切换表情都是丝滑过渡，不会跳帧。
 *
 * 参考图（DG2 正脸）：灰壳 → 黑色面罩 → 眼白 + 黑豆瞳孔，眼心略高于球心、瞳孔向内偏。
 */

export type FaceExpression =
  | "focused"
  | "idle"
  | "listening"
  | "thinking"
  | "happy"
  | "alert"
  | "sleepy";

export interface FacePose {
  /** 睁眼度 0..1 */
  openL: number;
  openR: number;
  /** 下眼睑上抬（眯眼）0..1 */
  squintL: number;
  squintR: number;
  /** 视线偏移 -1..1（屏幕坐标，右/上为正） */
  gazeX: number;
  gazeY: number;
  /** 瞳孔缩放 0.5..1.5 */
  pupilScale: number;
  /** 眼球旋转（弧度，正值为内眼角下沉） */
  tiltL: number;
  tiltR: number;
  /** 屏幕辉光 0..1（面罩亮度） */
  glow: number;
}

const BASE: FacePose = {
  openL: 1,
  openR: 1,
  squintL: 0,
  squintR: 0,
  gazeX: 0,
  gazeY: 0,
  pupilScale: 1,
  tiltL: 0.27,
  tiltR: 0.27,
  glow: 0.35,
};

/** 表情预设 —— focused 就是参考图那一张 */
export const FACE_EXPRESSIONS: Record<FaceExpression, Partial<FacePose>> = {
  focused: {},
  idle: { openL: 0.99, openR: 0.99, squintL: 0.06, squintR: 0.06, gazeX: 0, gazeY: 0, tiltL: 0.27, tiltR: 0.27 },
  listening: { openL: 1.04, openR: 1.04, squintL: 0, squintR: 0, gazeX: 0, gazeY: -0.05, pupilScale: 1.04, tiltL: 0.2, tiltR: 0.2 },
  thinking: { openL: 0.9, openR: 0.86, squintL: 0.32, squintR: 0.26, gazeX: 0.12, gazeY: 0.6, tiltL: 0.22, tiltR: 0.16 },
  happy: { openL: 0.74, openR: 0.74, squintL: 0.44, squintR: 0.44, gazeX: 0, gazeY: 0.04, pupilScale: 1.05, tiltL: 0.24, tiltR: 0.24 },
  alert: { openL: 1.12, openR: 1.12, squintL: 0, squintR: 0, gazeX: 0, gazeY: 0.05, pupilScale: 0.78, tiltL: 0.18, tiltR: 0.18, glow: 0.6 },
  sleepy: { openL: 0.4, openR: 0.4, squintL: 0.3, squintR: 0.3, gazeX: 0, gazeY: -0.3, pupilScale: 1.1, tiltL: 0.05, tiltR: 0.05, glow: 0.2 },
};

export function poseFor(expression: FaceExpression): FacePose {
  return { ...BASE, ...FACE_EXPRESSIONS[expression] };
}

/** 临界阻尼弹簧：值、速度、目标 */
class Spring {
  value: number;
  target: number;
  private vel = 0;

  constructor(value: number) {
    this.value = value;
    this.target = value;
  }

  step(dt: number, k: number, damping: number) {
    const accel = (this.target - this.value) * k - this.vel * damping;
    this.vel += accel * dt;
    this.value += this.vel * dt;
  }
}

const SPRING_KEYS = [
  "openL",
  "openR",
  "squintL",
  "squintR",
  "gazeX",
  "gazeY",
  "pupilScale",
  "tiltL",
  "tiltR",
  "glow",
] as const;

export interface FaceFrame extends FacePose {
  /** 眨眼倍数（1 = 正常，0 = 闭眼），由眨眼调度器叠加 */
  blink: number;
  /** 是否需要重绘 */
  dirty: boolean;
}

/**
 * 面部驱动器：持有弹簧参数、眨眼与微动调度，每帧产出一份可直接绘制的姿态。
 */
export class FaceRig {
  private springs = new Map<keyof FacePose, Spring>();
  private expression: FaceExpression = "focused";

  private autoBlink = true;
  private blinkPhase = -1;
  private nextBlinkAt = 2.4;
  private time = 0;
  private stillFor = 0;
  private last: (FacePose & { blink: number }) | null = null;

  /** 外部视线覆盖（如 attentionTarget），有值时优先于表情自带的视线 */
  private lookOverride: { x: number; y: number; until: number } | null = null;

  constructor() {
    const base = poseFor("focused");
    for (const key of SPRING_KEYS) this.springs.set(key, new Spring(base[key]));
  }

  setExpression(next: FaceExpression) {
    if (next === this.expression) return;
    this.expression = next;
    this.stillFor = 0;
    const target = poseFor(next);
    for (const key of SPRING_KEYS) {
      const spring = this.springs.get(key);
      if (spring) spring.target = target[key];
    }
  }

  getExpression() {
    return this.expression;
  }

  /** 临时把视线拉向某个方向（屏幕归一化坐标，-1..1），holdMs 后自动回落到表情基线 */
  look(x: number, y: number, holdMs = 1800) {
    this.lookOverride = {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
      until: this.time + holdMs / 1000,
    };
  }

  blink() {
    if (this.blinkPhase < 0) this.blinkPhase = 0;
  }

  /** 调试/截图用：关掉自动眨眼，保证抓到的静帧是完整睁眼 */
  setAutoBlink(on: boolean) {
    this.autoBlink = on;
    if (!on) this.blinkPhase = -1;
  }

  update(dt: number): FaceFrame {
    const step = Math.min(dt, 1 / 20);
    this.time += step;

    // 眨眼调度：随机 2.6~6.5s 一次，偶尔连眨两下
    if (this.autoBlink && this.blinkPhase < 0 && this.time > this.nextBlinkAt) {
      this.blinkPhase = 0;
    }
    if (this.time > this.nextBlinkAt) {
      this.nextBlinkAt = this.time + 2.6 + Math.random() * 3.9;
    }

    let blink = 1;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += step / 0.24; // 整次眨眼 240ms
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
      } else {
        blink = 1 - Math.sin(Math.PI * this.blinkPhase) ** 0.7;
      }
    }

    // 微动：没在动的时候瞳孔极缓慢漂移，屏才有「活着」的感觉
    this.stillFor += step;
    const drift = Math.min(this.stillFor / 6, 1);
    const microX = Math.sin(this.time * 0.53) * 0.06 * drift;
    const microY = Math.cos(this.time * 0.37) * 0.05 * drift;

    for (const key of SPRING_KEYS) {
      this.springs.get(key)?.step(step, 130, 20);
    }

    const g = (key: keyof FacePose) => this.springs.get(key)?.value ?? 0;
    const pose: FacePose = {
      openL: g("openL"),
      openR: g("openR"),
      squintL: g("squintL"),
      squintR: g("squintR"),
      gazeX: g("gazeX"),
      gazeY: g("gazeY"),
      pupilScale: g("pupilScale"),
      tiltL: g("tiltL"),
      tiltR: g("tiltR"),
      glow: g("glow"),
    };

    if (this.lookOverride && this.time < this.lookOverride.until) {
      pose.gazeX = this.lookOverride.x;
      pose.gazeY = this.lookOverride.y;
    }

    const rendered: FacePose = {
      ...pose,
      gazeX: pose.gazeX + microX,
      gazeY: pose.gazeY + microY,
    };

    const dirty =
      !this.last ||
      SPRING_KEYS.some((k) => Math.abs(this.last![k] - rendered[k]) > 0.0015) ||
      this.last.blink !== blink;
    this.last = { ...rendered, blink };

    return { ...rendered, blink, dirty };
  }
}
