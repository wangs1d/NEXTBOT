import type { PhysicsTuning } from "../protocol/directive.ts";
import type { Vec3 } from "../protocol/pose.ts";
import type { Floor, Wall, WorldDescriptor } from "../protocol/world.ts";
import { clampNumber } from "./clamp.ts";

export const FIXED_DT = 1 / 120;

const DEFORM_K = 42;
const DEFORM_DAMP = 6;
const ROT_K = 9;
const ROT_DAMP = 3.4;
const GLOW_RATE = 7;
const ROLL_FROM_ACCEL = 0.045;
const MIN_BOUNCE_SPEED = 0.18;

/** 全部由世界推导而来，这里不留任何自造常数。 */
export interface Forces {
  gravity: Vec3;
  anchor: Vec3 | null;
  anchorSpringK: number;
  floor: Floor | null;
  walls: Wall[];
  bodyRadius: number;
}

export function forcesFromWorld(w: WorldDescriptor): Forces {
  return {
    gravity: { ...w.gravity },
    anchor: w.anchor ? { ...w.anchor.pos } : null,
    anchorSpringK: w.anchor?.springK ?? 0,
    floor: w.floor,
    walls: w.walls,
    bodyRadius: w.bodyRadius,
  };
}

export interface ChannelSum {
  deform: number;
  glow: number;
  yawBias: number;
  pitchBias: number;
  rollBias: number;
  tuning: Partial<PhysicsTuning>;
}

export interface BodyState {
  pos: Vec3;
  vel: Vec3;
  rot: Vec3;
  rotVel: Vec3;
  deform: number;
  deformVel: number;
  glow: number;
  airborne: boolean;
  tMs: number;
  contacts: number;
  lastContactSpeed: number;
}

export function createBody(f: Forces): BodyState {
  const rest = f.anchor ?? { x: 0, y: f.floor ? f.floor.planeY + f.bodyRadius : 0, z: 0 };
  return {
    pos: { ...rest },
    vel: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0 },
    rotVel: { x: 0, y: 0, z: 0 },
    deform: 0,
    deformVel: 0,
    glow: 0.35,
    airborne: false,
    tMs: 0,
    contacts: 0,
    lastContactSpeed: 0,
  };
}

export function emptyChannels(): ChannelSum {
  return { deform: 0, glow: 0, yawBias: 0, pitchBias: 0, rollBias: 0, tuning: {} };
}

export interface StepEvents {
  contact: boolean;
}

/**
 * 半隐式欧拉。相位规则：
 *   有锚点 → 未腾空时三轴都归弹簧管；腾空时垂直只归重力管（否则弹簧把跳跃当场拽回去）。
 *   无锚点 → 垂直恒受重力，靠地面接触停下。
 * 接触只由**地面平面**判定，球底触线才算落地；锚点平面不是地面。
 */
export function step(
  b: BodyState,
  tuningRaw: PhysicsTuning,
  ch: ChannelSum,
  gaze: { yaw: number; pitch: number },
  f: Forces,
  dt: number = FIXED_DT,
): StepEvents {
  const t: PhysicsTuning = { ...tuningRaw, ...ch.tuning };
  const out: StepEvents = { contact: false };
  const anchor = f.anchor;

  if (anchor) {
    b.vel.x += (anchor.x - b.pos.x) * f.anchorSpringK * dt;
    b.vel.z += (anchor.z - b.pos.z) * f.anchorSpringK * dt;
  }

  const verticalByGravity = !anchor || b.airborne;
  if (verticalByGravity) {
    b.vel.y += f.gravity.y * dt;
  } else {
    b.vel.y += (anchor.y - b.pos.y) * f.anchorSpringK * dt;
  }

  const drag = Math.exp(-t.damping * dt);
  b.vel.x *= drag;
  b.vel.z *= drag;
  b.vel.y *= drag;

  const hs = Math.hypot(b.vel.x, b.vel.z);
  if (hs > t.maxSpeed) {
    const k = t.maxSpeed / hs;
    b.vel.x *= k;
    b.vel.z *= k;
  }

  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.pos.z += b.vel.z * dt;

  if (anchor && !b.airborne && b.vel.y > MIN_BOUNCE_SPEED && b.pos.y > anchor.y + 0.02) b.airborne = true;

  if (f.floor && b.pos.y - f.bodyRadius <= f.floor.planeY && b.vel.y < 0) {
    b.pos.y = f.floor.planeY + f.bodyRadius;
    out.contact = true;
    b.contacts += 1;
    b.lastContactSpeed = Math.abs(b.vel.y);
    if (Math.abs(b.vel.y) > MIN_BOUNCE_SPEED) {
      b.vel.y = -b.vel.y * f.floor.restitution;
    } else {
      b.vel.y = 0;
      b.airborne = false;
    }
    const grip = Math.exp(-f.floor.friction * dt);
    b.vel.x *= grip;
    b.vel.z *= grip;
  }

  for (const wall of f.walls) {
    const limit = wall.at - f.bodyRadius;
    const signed = wall.sign * b.pos[wall.axis];
    if (signed > limit) {
      b.pos[wall.axis] = wall.sign * limit;
      if (wall.sign * b.vel[wall.axis] > 0) {
        b.vel[wall.axis] = -b.vel[wall.axis] * wall.restitution;
        out.contact = true;
      }
    }
  }

  const deformTarget = clampNumber(ch.deform, -0.7, 0.7);
  b.deformVel += (deformTarget - b.deform) * DEFORM_K * dt;
  b.deformVel *= Math.exp(-DEFORM_DAMP * dt);
  b.deform = clampNumber(b.deform + b.deformVel * dt, -0.75, 0.75);

  const lateralAccel = anchor ? (anchor.x - b.pos.x) * f.anchorSpringK : 0;
  const rollTarget = clampNumber(ch.rollBias - lateralAccel * ROLL_FROM_ACCEL, -0.6, 0.6);
  const rotTargets = { x: ch.pitchBias + gaze.pitch, y: ch.yawBias + gaze.yaw, z: rollTarget };
  (["x", "y", "z"] as const).forEach((axis) => {
    b.rotVel[axis] += (rotTargets[axis] - b.rot[axis]) * ROT_K * dt;
    b.rotVel[axis] *= Math.exp(-ROT_DAMP * dt);
    b.rot[axis] += b.rotVel[axis] * dt;
  });

  b.glow = clampNumber(b.glow + (ch.glow + 0.35 - b.glow) * (1 - Math.exp(-GLOW_RATE * dt)), 0, 1);
  b.tMs += dt * 1000;
  return out;
}

export function applyImpulse(b: BodyState, vec: [number, number, number], cap: PhysicsTuning): void {
  b.vel.x = clampNumber(b.vel.x + vec[0], -cap.maxSpeed * 2, cap.maxSpeed * 2);
  b.vel.y = clampNumber(b.vel.y + vec[1], -cap.maxSpeed * 4, cap.maxSpeed * 4);
  b.vel.z = clampNumber(b.vel.z + vec[2], -cap.maxSpeed * 2, cap.maxSpeed * 2);
}
