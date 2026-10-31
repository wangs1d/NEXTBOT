import type { PhysicsTuning } from "../protocol/directive.ts";
import type { RecipeFragment } from "./clamp.ts";
import { merge, shift } from "./clamp.ts";
import {
  airborne,
  fade,
  hold,
  impulse,
  onContact,
  pulse,
  set,
  swell,
  track,
  tremor as tremorOp,
} from "./operators.ts";

export interface RecipeParams {
  intensity: number;
  valence: number;
  arousal: number;
  holdMs: number;
  tuning: PhysicsTuning;
}

export type Recipe = (p: RecipeParams) => RecipeFragment;

const i = (p: RecipeParams): number => p.intensity;

/** 蓄力压扁 → 冲量 → 交给重力 → 接触帧触发挤压与回弹 → 收势 */
const jump: Recipe = (p) =>
  merge(
    hold("deform", 0.16 + 0.14 * i(p), 130),
    set("springK", p.tuning.springK * 1.6, 130),
    impulse(0, 3.2 + 1.4 * i(p), 0, 130),
    airborne(130),
    onContact(
      merge(
        pulse("deform", 0.2 + 0.12 * i(p), 260),
        set("restitution", Math.min(0.94, p.tuning.restitution), 420),
      ),
    ),
    swell("glow", 0.35 * i(p), 500, 130),
    fade("rollBias", 0.05 * i(p), 400, 130),
  );

const retreat: Recipe = (p) =>
  merge(
    pulse("deform", 0.1 + 0.1 * i(p), 220),
    impulse(-1.6 - 1.9 * i(p), 0.5 + 0.5 * i(p), 0, 40),
    airborne(40),
    onContact(pulse("deform", 0.12 * i(p), 200)),
    track("yawBias", -0.18 * i(p), 420),
    fade("glow", -0.18 * i(p), 700),
  );

const lean_in: Recipe = (p) =>
  merge(
    hold("deform", -(0.06 + 0.07 * i(p)), 340),
    impulse(1.0 + 1.2 * i(p), 0.15, 0, 340),
    airborne(340),
    track("pitchBias", 0.1 * i(p), 500),
    swell("glow", 0.16 * i(p), 900),
  );

const cower: Recipe = (p) =>
  merge(
    hold("deform", 0.28 + 0.22 * i(p), 260),
    impulse(0, -0.9 * i(p), 0, 260),
    set("restitution", 0.05, 600),
    fade("glow", -0.4 * i(p), 1200),
    track("pitchBias", 0.22 * i(p), 400),
  );

const bounce_gait: Recipe = (p) => {
  const hop = (n: number, at: number, scale: number): RecipeFragment => {
    const amp = (0.55 + 0.45 * i(p)) * scale;
    return merge(
      hold("deform", 0.1 * amp, 90, at),
      impulse(0, 2.7 * amp, 0, at + 90),
      airborne(at + 90),
      fade("rollBias", (n % 2 ? 1 : -1) * 0.06 * amp, 320, at + 90),
      swell("glow", 0.12 * amp, 360, at + 90),
    );
  };
  return merge(hop(0, 0, 1), hop(1, 420, 0.72), hop(2, 800, 0.5), onContact(pulse("deform", 0.14 * i(p), 220)));
};

const sink: Recipe = (p) =>
  merge(
    hold("deform", 0.18 + 0.12 * i(p), p.holdMs),
    impulse(0, -0.5 * i(p), 0, 60),
    fade("glow", -0.25 * i(p), 1400),
    set("damping", p.tuning.damping * 1.5, p.holdMs),
  );

const peek: Recipe = (p) =>
  merge(
    hold("deform", -(0.04 + 0.04 * i(p)), 200),
    track("yawBias", 0.2 * i(p), 320),
    track("rollBias", -0.09 * i(p), 320),
    impulse(0.6 * i(p), 2.1 * i(p), 0, 200),
    airborne(200),
    swell("glow", 0.14 * i(p), 600),
  );

const nudge: Recipe = (p) =>
  merge(impulse(0.7 * i(p), 0.22 * i(p), 0.2 * i(p), 0), airborne(0), pulse("deform", 0.07 * i(p), 240));

const doze: Recipe = (p) =>
  merge(
    hold("deform", 0.1 + 0.08 * i(p), p.holdMs),
    set("springK", p.tuning.springK * 0.45, p.holdMs),
    set("noiseAmp", 0.012, p.holdMs),
    fade("glow", -0.45 * i(p), p.holdMs),
    track("pitchBias", 0.26 * i(p), 1200),
  );

const perk: Recipe = (p) =>
  merge(
    hold("deform", -(0.1 + 0.12 * i(p)), 180),
    impulse(0, 1.9 + 1.6 * i(p), 0, 180),
    airborne(180),
    onContact(pulse("deform", 0.1 * i(p), 200)),
    swell("glow", 0.4 * i(p), 700),
    track("pitchBias", -0.16 * i(p), 260),
  );

const sulk: Recipe = (p) =>
  merge(
    hold("deform", 0.14 + 0.1 * i(p), p.holdMs),
    track("rollBias", 0.13 * i(p), 1400),
    track("pitchBias", 0.2 * i(p), 1400),
    fade("glow", -0.35 * i(p), p.holdMs),
    set("restitution", 0.08, p.holdMs),
    shift(tremorOp(0.02 * i(p), 900, 1800), 0),
  );

export const RECIPES = {
  jump,
  retreat,
  lean_in,
  cower,
  bounce_gait,
  sink,
  peek,
  nudge,
  doze,
  perk,
  sulk,
  tremor: (p: RecipeParams) => tremorOp(0.06 + 0.12 * i(p), Math.max(600, p.holdMs)),
} satisfies Record<string, Recipe>;
