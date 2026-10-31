import {
  BASE_TUNING,
  type Directive,
  type PhysicsTuning,
} from "../protocol/directive.ts";
import {
  canResolve,
  supports,
  type CapabilityDescriptor,
  type Channel,
} from "../protocol/capability.ts";
import { volumePreservingScale, type Pose } from "../protocol/pose.ts";
import { clampNumber, type Envelope, type RecipeFragment } from "./clamp.ts";
import { RECIPES } from "./recipes.ts";
import {
  FIXED_DT,
  applyImpulse,
  createBody,
  emptyChannels,
  forcesFromWorld,
  step,
  type BodyState,
  type ChannelSum,
} from "./physics.ts";

const CHANNEL_REQUIREMENT: Record<Envelope["channel"], Channel> = {
  deform: "deform",
  glow: "glow",
  yawBias: "rotate",
  pitchBias: "rotate",
  rollBias: "rotate",
  springK: "translate",
  damping: "translate",
  restitution: "translate",
  maxSpeed: "translate",
  noiseAmp: "translate",
};

interface Scheduled {
  env: Envelope;
  startMs: number;
}
interface ScheduledAction {
  atMs: number;
  kind: "impulse" | "airborne";
  vec?: [number, number, number];
}
interface Hook {
  frag: RecipeFragment;
  once: boolean;
  fired: boolean;
}

export interface Engine {
  applyDirective(d: Directive): void;
  setAttentionPoint(yawRad: number, pitchRad: number): void;
  advance(dtMs: number): Pose[];
  pose(): Pose;
  body(): BodyState;
  stats(): { dropped: number; envelopes: number; contacts: number };
}

export function sanitizeTuning(t: PhysicsTuning): PhysicsTuning {
  return {
    springK: clampNumber(t.springK, 0.2, 24),
    damping: clampNumber(t.damping, 0.02, 6),
    restitution: clampNumber(t.restitution, 0, 0.94),
    maxSpeed: clampNumber(t.maxSpeed, 0.05, 16),
    intensityCap: clampNumber(t.intensityCap, 0, 1),
    noiseAmp: clampNumber(t.noiseAmp, 0, 0.4),
  };
}

export function createEngine(cap: CapabilityDescriptor): Engine {
  const forces = forcesFromWorld(cap.world);
  let body: BodyState = createBody(forces);
  let tuning: PhysicsTuning = { ...BASE_TUNING };
  let envelopes: Scheduled[] = [];
  let actions: ScheduledAction[] = [];
  let hooks: Hook[] = [];
  let gaze = { yaw: 0, pitch: 0 };
  let gazeTarget = { yaw: 0, pitch: 0 };
  let driver = "reflex";
  let arousal = 0.25;
  let acc = 0;
  let dropped = 0;

  function schedule(frag: RecipeFragment, atMs: number): void {
    for (const e of frag.envelopes) {
      if (!supports(cap, CHANNEL_REQUIREMENT[e.channel])) {
        dropped += 1;
        continue;
      }
      envelopes.push({ env: e, startMs: atMs + e.startMs });
    }
    for (const a of frag.actions) {
      if (a.kind === "impulse" || a.kind === "airborne") {
        if (!supports(cap, "translate")) {
          dropped += 1;
          continue;
        }
        if (a.kind === "impulse") actions.push({ atMs: atMs + a.atMs, kind: "impulse", vec: a.vec });
        else actions.push({ atMs: atMs + a.atMs, kind: "airborne" });
      } else if (a.kind === "contactHook") {
        hooks.push({ frag: a.hook, once: a.once, fired: false });
      }
    }
  }

  function applyDirective(d: Directive): void {
    const recipe = RECIPES[d.intent];
    if (!recipe) {
      dropped += 1;
      return;
    }
    if (!canResolve(cap, d.attend)) {
      // 壳解算不了的锚点不改变朝向，但动作本身照做
      gazeTarget = { yaw: gazeTarget.yaw * 0.5, pitch: gazeTarget.pitch * 0.5 };
    }
    tuning = sanitizeTuning(d.tuning);
    arousal = clampNumber(d.arousal, 0, 1);
    driver = `${d.intent}:${d.cause.id}`;
    schedule(
      recipe({
        intensity: clampNumber(d.intensity, 0, 1),
        valence: clampNumber(d.valence, -1, 1),
        arousal,
        holdMs: clampNumber(d.holdMs, 120, 60_000),
        tuning,
      }),
      body.tMs,
    );
  }

  function accumulate(nowMs: number): ChannelSum {
    const ch = emptyChannels();
    const keep: Scheduled[] = [];
    for (const s of envelopes) {
      const e = s.env;
      const t = nowMs - s.startMs;
      if (t < 0) {
        keep.push(s);
        continue;
      }
      const u = clampNumber(t / e.durMs, 0, 1);
      const value = e.amp * e.shape(u);
      if (u >= 1) continue;
      keep.push(s);
      if (e.channel in ch) {
        if (e.mode === "add") (ch as unknown as Record<string, number>)[e.channel] += value;
        else (ch as unknown as Record<string, number>)[e.channel] = value;
      } else {
        ch.tuning[e.channel as keyof PhysicsTuning] = value as number;
      }
    }
    envelopes = keep;

    const breath = 0.01 * (1.2 - arousal) * Math.sin((nowMs / 1000) * Math.PI * 2 * 0.22);
    const micro =
      Math.sin((nowMs / 1000) * Math.PI * 2 * 2.7) + 0.5 * Math.sin((nowMs / 1000) * Math.PI * 2 * 6.1 + 1.3);
    ch.deform += breath + micro * tuning.noiseAmp * 0.12;
    ch.yawBias += micro * tuning.noiseAmp * 0.5;
    return ch;
  }

  function fireDueActions(nowMs: number): void {
    const keep: ScheduledAction[] = [];
    for (const a of actions) {
      if (a.atMs > nowMs) {
        keep.push(a);
        continue;
      }
      if (a.kind === "impulse" && a.vec) applyImpulse(body, a.vec, tuning);
      else if (a.kind === "airborne") body.airborne = true;
    }
    actions = keep;
  }

  function onContact(): void {
    const keep: Hook[] = [];
    for (const h of hooks) {
      if (h.once && h.fired) {
        keep.push(h);
        continue;
      }
      schedule(h.frag, body.tMs);
      h.fired = true;
      if (!h.once) keep.push(h);
    }
    hooks = keep;
  }

  function substep(ch: ChannelSum): void {
    gazeTargetLerp();
    const ev = step(body, tuning, ch, gaze, forces, FIXED_DT);
    if (ev.contact) onContact();
  }

  function gazeTargetLerp(): void {
    const k = 1 - Math.exp(-3.2 * FIXED_DT);
    gaze.yaw += (gazeTarget.yaw - gaze.yaw) * k;
    gaze.pitch += (gazeTarget.pitch - gaze.pitch) * k;
  }

  function currentPose(): Pose {
    return {
      tMs: Math.round(body.tMs * 1000) / 1000,
      pos: { ...body.pos },
      vel: { ...body.vel },
      rot: { ...body.rot },
      deform: body.deform,
      scale: volumePreservingScale(body.deform),
      glow: body.glow,
      gaze: { yaw: gaze.yaw, pitch: gaze.pitch },
      airborne: body.airborne,
      driver,
    };
  }

  return {
    applyDirective,
    setAttentionPoint(yawRad, pitchRad) {
      gazeTarget = { yaw: clampNumber(yawRad, -1.2, 1.2), pitch: clampNumber(pitchRad, -0.7, 0.7) };
    },
    advance(dtMs) {
      const out: Pose[] = [];
      if (!Number.isFinite(dtMs) || dtMs < 0) return out;
      acc += dtMs / 1000;
      let guard = 0;
      while (acc >= FIXED_DT && guard < 600) {
        const ch = accumulate(body.tMs);
        fireDueActions(body.tMs);
        substep(ch);
        acc -= FIXED_DT;
        guard += 1;
        out.push(currentPose());
      }
      if (guard >= 600) acc = 0;
      return out;
    },
    pose: currentPose,
    body: () => body,
    stats: () => ({ dropped, envelopes: envelopes.length, contacts: body.contacts }),
  };
}
