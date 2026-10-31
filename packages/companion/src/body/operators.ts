import {
  SHAPES,
  clampEnvelope,
  merge,
  type Action,
  type Envelope,
  type EnvelopeChannel,
  type RecipeFragment,
  type Shape,
} from "./clamp.ts";

function env(
  channel: EnvelopeChannel,
  amp: number,
  atMs: number,
  durMs: number,
  shape: Shape,
  mode: "add" | "set",
): RecipeFragment {
  return { envelopes: [clampEnvelope({ channel, amp, startMs: atMs, durMs, shape, mode })], actions: [] };
}

/** 一次性速度冲击。之后运动由力学规律解算，不由这里规定。 */
export function impulse(x: number, y: number, z: number, atMs = 0): RecipeFragment {
  return { envelopes: [], actions: [{ atMs, kind: "impulse", vec: [x, y, z] } as Action] };
}

/** 腾空：关掉锚点弹簧，只剩重力与阻尼。跳跃的必备段。 */
export function airborne(atMs = 0): RecipeFragment {
  return { envelopes: [], actions: [{ atMs, kind: "airborne" } as Action] };
}

export function hold(ch: EnvelopeChannel, v: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, v, atMs, durMs, SHAPES.const, "add");
}

export function set(ch: EnvelopeChannel, v: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, v, atMs, durMs, SHAPES.const, "set");
}

export function pulse(ch: EnvelopeChannel, amp: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, amp, atMs, durMs, SHAPES.dampedSine, "add");
}

export function swell(ch: EnvelopeChannel, amp: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, amp, atMs, durMs, SHAPES.halfSine, "add");
}

export function fade(ch: EnvelopeChannel, amp: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, amp, atMs, durMs, SHAPES.decay, "add");
}

/** 确定性伪噪声：三个不可通约频率叠加，不用 Math.random，轨迹可重放 */
const tremorShape: Shape = (u) => {
  const n =
    Math.sin(u * Math.PI * 2 * 3.1) +
    0.6 * Math.sin(u * Math.PI * 2 * 7.7 + 1.1) +
    0.35 * Math.sin(u * Math.PI * 2 * 13.3 + 2.4);
  return (n / 1.95) * Math.exp(-1.2 * u);
};

export function tremor(amp: number, durMs: number, atMs = 0): RecipeFragment {
  return merge(
    env("deform", amp * 0.35, atMs, durMs, tremorShape, "add"),
    env("yawBias", amp, atMs, durMs, tremorShape, "add"),
    env("rollBias", amp * 0.5, atMs, durMs, tremorShape, "add"),
  );
}

/** 追随：从当前值爬到目标，gain 越小越拖沓。视线与凑近用它。 */
export function track(ch: EnvelopeChannel, v: number, durMs: number, atMs = 0): RecipeFragment {
  return env(ch, v, atMs, durMs, SHAPES.easeOut, "set");
}

/** 第 9 个算子：落地挤压不是时间的函数，是事件的函数 */
export function onContact(fragment: RecipeFragment, once = true): RecipeFragment {
  return { envelopes: [], actions: [{ atMs: 0, kind: "contactHook", hook: fragment, once } as Action] };
}

export type { Envelope, RecipeFragment };
