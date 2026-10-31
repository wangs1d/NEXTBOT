import type { AffectState } from "../protocol/affect.ts";
import type { PhysicsTuning } from "../protocol/directive.ts";

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/**
 * 情绪改写的是身体常数本身，不是行为选择。
 * 于是"被凶过"不需要一条 sulk 动画，它体现为之后所有动作都更软、更黏、弹不起来。
 */
export function tuningFromAffect(s: AffectState): PhysicsTuning {
  const { energy, arousal } = s;
  const { caution, curiosity, sociability } = s.drives;

  const dread = clamp(caution - 0.18, 0, 1) / 0.82;
  const bright = clamp(sociability + curiosity * 0.5, 0, 1.4) / 1.4;
  const vigor = clamp(energy - 0.05, 0, 1) / 0.95;

  return {
    springK: clamp(lerp(5.4, 2.1, dread) * lerp(0.92, 1.3, bright * arousal), 0.2, 24),
    damping: clamp(lerp(0.24, 1.05, dread) + (1 - vigor) * 0.34, 0.02, 6),
    restitution: clamp(lerp(0.74, 0.16, dread) * lerp(0.55, 1, vigor), 0, 0.94),
    maxSpeed: clamp(lerp(1.05, 4.3, vigor) * lerp(1, 0.5, dread), 0.05, 16),
    intensityCap: clamp(lerp(0.22, 1, vigor) * lerp(1, 0.42, dread), 0, 1),
    noiseAmp: clamp(arousal * caution * 0.34 + (1 - vigor) * 0.02, 0, 0.4),
  };
}
