import {
  INITIAL_AFFECT,
  type AffectState,
  type DriveKey,
  type Percept,
} from "../protocol/affect.ts";
import {
  makeDirective,
  type Directive,
  type IntentKind,
} from "../protocol/directive.ts";
import {
  DRIVE_BASELINE,
  DRIVE_DECAY,
  ENERGY,
  EVENT_TABLE,
  INTENT_COOLDOWN_MS,
  INTENT_COST,
  REFRACTORY_MS,
  THRESHOLD,
} from "./drives.ts";
import { allocateAttention, decayAttention } from "./attention.ts";
import { tuningFromAffect } from "./emotion-physics.ts";

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : lo;

/** 确定性 PRNG：只用来决定"要不要做"，不用来决定"做成什么样" */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AVERSIVE_RESIDUE = { amount: 0.24, tauMs: 78_000 };
const PLEASANT_RESIDUE = { amount: 0.12, tauMs: 52_000 };

interface Candidate {
  intent: IntentKind;
  pressure: number;
  driveKey: DriveKey | "energy" | "arousal" | "none";
  level: number;
}

export interface Mind {
  perceive(p: Percept): void;
  tick(nowMs: number): Directive[];
  state(): AffectState;
  lastDirective(): Directive | null;
}

export function createMind(initial?: Partial<AffectState>, seed = 20261031): Mind {
  let s: AffectState = structuredClone({ ...INITIAL_AFFECT, ...initial });
  const rng = mulberry32(seed);
  let lastEmitAt = -Infinity;
  let last: Directive | null = null;
  const lastIntentAt = new Map<string, number>();

  function perceive(p: Percept): void {
    const spec = EVENT_TABLE[p.kind];
    if (!spec) return;
    const anchor = p.anchor ?? spec.anchor;
    const salience = clamp(p.salience ?? spec.salience, 0, 1);

    s.drives.curiosity = clamp(s.drives.curiosity + (spec.curiosity ?? 0), 0, 1);
    s.drives.caution = clamp(s.drives.caution + (spec.caution ?? 0), 0, 1);
    s.drives.sociability = clamp(s.drives.sociability + (spec.sociability ?? 0), 0, 1);
    s.energy = clamp(s.energy + (spec.energy ?? 0), 0, 1);
    s.valence = clamp(s.valence + (spec.valence ?? 0), -1, 1);
    s.arousal = clamp(s.arousal + (spec.arousal ?? 0), 0, 1);

    if (spec.aversive) s.lastAversiveAtMs = Math.max(s.lastAversiveAtMs, p.atMs);
    if (spec.pleasant) s.lastPleasantAtMs = Math.max(s.lastPleasantAtMs, p.atMs);

    const alloc = allocateAttention(s.attention, { anchor, salience }, s.drives.curiosity);
    s.attention = alloc.attention;
  }

  function candidates(): Candidate[] {
    const out: Candidate[] = [];
    const { curiosity, caution, sociability } = s.drives;
    const { energy, arousal, valence, attention } = s;

    if (arousal > 0.6 && valence > 0.1 && energy > 0.45) {
      out.push({ intent: "jump", pressure: arousal * (0.5 + energy), driveKey: "arousal", level: arousal });
    }
    if (caution > THRESHOLD.caution) {
      const intent: IntentKind = valence < -0.35 && arousal < 0.45 ? "sulk" : arousal > 0.6 ? "cower" : "retreat";
      out.push({ intent, pressure: caution, driveKey: "caution", level: caution });
    }
    if (curiosity > THRESHOLD.curiosity && attention.target !== "ambient") {
      const intent: IntentKind =
        attention.strength > 0.62 ? "lean_in" : attention.strength > 0.42 ? "peek" : "nudge";
      out.push({ intent, pressure: curiosity * (0.45 + attention.strength), driveKey: "curiosity", level: curiosity });
    }
    if (sociability > THRESHOLD.sociability) {
      out.push({
        intent: energy > 0.55 ? "bounce_gait" : "perk",
        pressure: sociability * (0.4 + energy),
        driveKey: "sociability",
        level: sociability,
      });
    }
    if (energy < ENERGY.exhaustion) {
      out.push({ intent: "doze", pressure: 0.55 + (ENERGY.exhaustion - energy) * 2, driveKey: "energy", level: 1 - energy });
    }
    if (arousal * caution > 0.3) {
      out.push({ intent: "tremor", pressure: arousal * caution * 1.3, driveKey: "arousal", level: arousal * caution });
    }
    return out;
  }

  function tick(nowMs: number): Directive[] {
    const dt = clamp((nowMs - s.clockMs) / 1000, 0, 5);
    s.clockMs = Math.max(s.clockMs, nowMs);

    const aversive = AVERSIVE_RESIDUE.amount * Math.exp(-(nowMs - s.lastAversiveAtMs) / AVERSIVE_RESIDUE.tauMs);
    const pleasant = PLEASANT_RESIDUE.amount * Math.exp(-(nowMs - s.lastPleasantAtMs) / PLEASANT_RESIDUE.tauMs);
    const baselines: Record<DriveKey, number> = {
      curiosity: DRIVE_BASELINE.curiosity,
      caution: DRIVE_BASELINE.caution + aversive,
      sociability: DRIVE_BASELINE.sociability + pleasant,
    };

    for (const k of Object.keys(s.drives) as DriveKey[]) {
      const target = baselines[k];
      const rate = DRIVE_DECAY[k];
      s.drives[k] = clamp(target + (s.drives[k] - target) * Math.exp(-rate * dt), 0, 1);
    }

    const dozing = last?.intent === "doze" && nowMs - last.issuedAtMs < 20_000;
    s.energy = clamp(s.energy + (dozing ? ENERGY.dozeRestorePerSec : ENERGY.restorePerSec) * dt, ENERGY.floor, 1);
    s.arousal = clamp(s.arousal + (0.22 - s.arousal) * (1 - Math.exp(-0.05 * dt)), 0, 1);
    s.valence = clamp(s.valence + (0.12 - s.valence) * (1 - Math.exp(-0.03 * dt)), -1, 1);
    s.attention = decayAttention(s.attention, dt);

    const won = candidates().sort((a, b) => b.pressure - a.pressure)[0];
    if (!won) return [];
    if (won.pressure < 0.45) return [];
    if (nowMs - lastEmitAt < REFRACTORY_MS) return [];
    if (nowMs - (lastIntentAt.get(won.intent) ?? -Infinity) < (INTENT_COOLDOWN_MS[won.intent] ?? 4000)) return [];

    const tuning = tuningFromAffect(s);
    // 随机只决定"要不要理这件事"：怂、累的时候更容易作罢
    const willingness = 0.35 + s.dominance * 0.4 + s.energy * 0.3;
    if (rng() > clamp(willingness, 0.05, 0.98)) return [];

    const intensity = clamp(won.pressure * tuning.intensityCap, 0, 1);
    if (intensity <= 0.02) return [];

    const directive = makeDirective({
      version: 1,
      intent: won.intent,
      intensity,
      valence: s.valence,
      arousal: s.arousal,
      attend: s.attention.target,
      holdMs: Math.round(clamp(intensity * 2600, 120, 9000)),
      cause: { kind: "drive", id: `${won.driveKey}>threshold`, driveKey: won.driveKey, driveLevel: won.level },
      tuning,
      issuedAtMs: nowMs,
    });

    s.energy = clamp(s.energy - INTENT_COST[won.intent] * intensity, ENERGY.floor, 1);
    lastEmitAt = nowMs;
    lastIntentAt.set(won.intent, nowMs);
    last = directive;
    return [directive];
  }

  return {
    perceive,
    tick,
    state: () => structuredClone(s),
    lastDirective: () => last,
  };
}
