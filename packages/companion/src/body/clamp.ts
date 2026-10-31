import type { PhysicsTuning } from "../protocol/directive.ts";

export const TUNING_KEYS = [
  "springK",
  "damping",
  "restitution",
  "maxSpeed",
  "noiseAmp",
] as const satisfies readonly (keyof PhysicsTuning)[];

export type TuningKey = (typeof TUNING_KEYS)[number];

export const ENVELOPE_CHANNELS = [
  "deform",
  "glow",
  "yawBias",
  "pitchBias",
  "rollBias",
  ...TUNING_KEYS,
] as const;
export type EnvelopeChannel = (typeof ENVELOPE_CHANNELS)[number];

export type Shape = (u: number) => number;

export const SHAPES = {
  const: (): number => 1,
  ramp: (u: number): number => u,
  decay: (u: number): number => Math.exp(-3 * u),
  halfSine: (u: number): number => Math.sin(u * Math.PI),
  dampedSine: (u: number): number => Math.sin(u * Math.PI * 2) * Math.exp(-2.4 * u),
  easeOut: (u: number): number => 1 - (1 - u) * (1 - u),
} satisfies Record<string, Shape>;

export interface Envelope {
  channel: EnvelopeChannel;
  startMs: number;
  durMs: number;
  amp: number;
  shape: Shape;
  mode: "add" | "set";
}

export type Action =
  | { atMs: number; kind: "impulse"; vec: [number, number, number] }
  | { atMs: number; kind: "airborne" }
  | { atMs: number; kind: "contactHook"; hook: RecipeFragment; once: boolean };

export interface RecipeFragment {
  envelopes: Envelope[];
  actions: Action[];
}

export const empty = (): RecipeFragment => ({ envelopes: [], actions: [] });

export function merge(...frags: RecipeFragment[]): RecipeFragment {
  const out = empty();
  for (const f of frags) {
    out.envelopes.push(...f.envelopes);
    out.actions.push(...f.actions);
  }
  return out;
}

export function shift(f: RecipeFragment, byMs: number): RecipeFragment {
  return {
    envelopes: f.envelopes.map((e) => ({ ...e, startMs: e.startMs + byMs })),
    actions: f.actions.map((a) => ({ ...a, atMs: a.atMs + byMs })),
  };
}

/** NaN 一律折到 lo：脏输入宁可不动，也不能把 NaN 带进积分器 */
export function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 越界钳制，不报错：心智给的数永远可能是脏的，身体不许抽搐 */
export function clampEnvelope(e: Envelope): Envelope {
  return {
    ...e,
    amp: clampNumber(e.amp, -1.5, 1.5),
    startMs: Math.max(0, e.startMs),
    durMs: clampNumber(e.durMs, 1, 30_000),
  };
}
