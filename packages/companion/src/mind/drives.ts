import type { DriveKey, EventKindT } from "../protocol/affect.ts";

export const DRIVE_BASELINE: Record<DriveKey, number> = {
  curiosity: 0.3,
  caution: 0.18,
  sociability: 0.38,
};

/** 每秒向基线靠拢的比例，决定"缓多久" */
export const DRIVE_DECAY: Record<DriveKey, number> = {
  curiosity: 0.075,
  caution: 0.032,
  sociability: 0.055,
};

export const THRESHOLD: Record<DriveKey, number> = {
  curiosity: 0.62,
  caution: 0.68,
  sociability: 0.66,
};

export const ENERGY = {
  restorePerSec: 0.0035,
  dozeRestorePerSec: 0.03,
  floor: 0.05,
  exhaustion: 0.28,
};

export interface DriveImpulse {
  curiosity?: number;
  caution?: number;
  sociability?: number;
  energy?: number;
  valence?: number;
  arousal?: number;
  anchor: string;
  salience: number;
  /** 事件是否算 aversive，会抬高 caution 的基线残留 */
  aversive?: boolean;
  pleasant?: boolean;
}

export const EVENT_TABLE: Record<EventKindT, DriveImpulse> = {
  "user.message": { sociability: 0.26, curiosity: 0.08, anchor: "user", salience: 0.72, pleasant: true },
  "user.tap": { curiosity: 0.34, sociability: 0.14, arousal: 0.14, anchor: "self", salience: 0.62, pleasant: true },
  "user.scold": { caution: 0.55, sociability: -0.2, energy: -0.12, valence: -0.6, arousal: 0.34, anchor: "user", salience: 0.94, aversive: true },
  "user.praise": { sociability: 0.36, caution: -0.24, valence: 0.6, arousal: 0.38, anchor: "user", salience: 0.7, pleasant: true },
  "app.focus.new": { curiosity: 0.44, anchor: "focus", salience: 0.56 },
  "alert.error": { caution: 0.46, curiosity: -0.1, valence: -0.4, arousal: 0.44, anchor: "source", salience: 0.9, aversive: true },
  "schedule.due": { sociability: 0.18, arousal: 0.26, energy: -0.05, anchor: "schedule", salience: 0.82 },
  "task.done": { sociability: 0.2, curiosity: 0.1, valence: 0.3, energy: -0.08, anchor: "source", salience: 0.5, pleasant: true },
  "peer.arrive": { sociability: 0.3, curiosity: 0.22, anchor: "user", salience: 0.6 },
  "ambient.tick": { curiosity: 0.06, anchor: "ambient", salience: 0.16 },
};

export const REFRACTORY_MS = 2400;

export const INTENT_COOLDOWN_MS: Record<string, number> = {
  jump: 11_000,
  bounce_gait: 8_000,
  retreat: 6_000,
  cower: 7_000,
  lean_in: 5_000,
  peek: 4_000,
  nudge: 5_000,
  sink: 6_000,
  tremor: 3_500,
  doze: 45_000,
  perk: 5_500,
  sulk: 14_000,
};

/** 每个 intent 的基础精力消耗，乘上强度 */
export const INTENT_COST: Record<string, number> = {
  jump: 0.09,
  bounce_gait: 0.07,
  retreat: 0.04,
  cower: 0.05,
  lean_in: 0.03,
  peek: 0.025,
  nudge: 0.03,
  sink: 0.02,
  tremor: 0.045,
  doze: -0.06,
  perk: 0.02,
  sulk: 0.015,
};
