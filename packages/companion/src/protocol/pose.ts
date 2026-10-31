import { z } from "zod";

const n = z.number().finite();

export const Vec3Schema = z.object({ x: n, y: n, z: n });
export type Vec3 = z.infer<typeof Vec3Schema>;

/**
 * 解算层每帧的唯一输出。壳只读这个结构，不参与决定它。
 * deform > 0 压扁、< 0 拉长；scale 由体积守恒推出。
 */
export const PoseSchema = z.object({
  tMs: z.number().nonnegative(),
  pos: Vec3Schema,
  vel: Vec3Schema,
  rot: Vec3Schema,
  deform: z.number().min(-0.75).max(0.75),
  scale: Vec3Schema,
  glow: z.number().min(0).max(1),
  gaze: z.object({ yaw: n, pitch: n }),
  airborne: z.boolean(),
  /** 本帧由哪个 intent 主导，供 inspector 回溯判据① */
  driver: z.string().max(96),
});
export type Pose = z.infer<typeof PoseSchema>;

const EPS = 1e-9;

/** sy = 1-d 且 sxz = 1/sqrt(sy) 时体积恒为 1，无需事后修正 */
export function volumePreservingScale(deform: number): Vec3 {
  const sy = Math.max(0.1, 1 - deform);
  const sxz = 1 / Math.sqrt(sy);
  return { x: sxz, y: sy, z: sxz };
}

export function volumeOf(s: Vec3): number {
  return s.x * s.y * s.z;
}

export const VOLUME_EPS = EPS;
