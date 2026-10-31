import { z } from "zod";

export const DRIVE_KEYS = ["curiosity", "caution", "sociability"] as const;
export type DriveKey = (typeof DRIVE_KEYS)[number];

const unit = z.number().min(0).max(1);
const bipolar = z.number().min(-1).max(1);

export const DrivesSchema = z.object({
  curiosity: unit,
  caution: unit,
  sociability: unit,
});
export type Drives = z.infer<typeof DrivesSchema>;

export const AttentionSchema = z.object({
  // 语义锚点 id，由壳在 CapabilityDescriptor.anchors 里声明并自行解算位置。
  target: z.string().min(1).max(64),
  strength: unit,
});
export type Attention = z.infer<typeof AttentionSchema>;

export const AffectStateSchema = z.object({
  version: z.literal(1),
  drives: DrivesSchema,
  energy: unit,
  valence: bipolar,
  arousal: unit,
  dominance: unit,
  attention: AttentionSchema,
  /** 上一次被斥责/出错的时间戳，判据⑤靠它把记忆留在身体里 */
  lastAversiveAtMs: z.number().nonnegative(),
  lastPleasantAtMs: z.number().nonnegative(),
  clockMs: z.number().nonnegative(),
});
export type AffectState = z.infer<typeof AffectStateSchema>;

export const EventKind = [
  "user.message",
  "user.tap",
  "user.scold",
  "user.praise",
  "app.focus.new",
  "alert.error",
  "schedule.due",
  "task.done",
  "peer.arrive",
  "ambient.tick",
] as const;
export type EventKindT = (typeof EventKind)[number];

export const PerceptSchema = z.object({
  kind: z.enum(EventKind),
  /** 事件自带的语义锚点；缺省时由事件表补 */
  anchor: z.string().max(64).optional(),
  salience: unit.optional(),
  atMs: z.number().nonnegative(),
});
export type Percept = z.infer<typeof PerceptSchema>;

export const INITIAL_AFFECT: AffectState = AffectStateSchema.parse({
  version: 1,
  drives: { curiosity: 0.3, caution: 0.18, sociability: 0.38 },
  energy: 0.85,
  valence: 0.2,
  arousal: 0.25,
  dominance: 0.5,
  attention: { target: "ambient", strength: 0.2 },
  lastAversiveAtMs: 0,
  lastPleasantAtMs: 0,
  clockMs: 0,
});
