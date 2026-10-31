import { z } from "zod";

export const INTENT_KINDS = [
  "jump",
  "retreat",
  "lean_in",
  "cower",
  "bounce_gait",
  "sink",
  "peek",
  "tremor",
  "nudge",
  "doze",
  "perk",
  "sulk",
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/**
 * 情绪直接改写的是身体常数，不是行为选择。
 * 这是判据⑤的落点：被凶过之后同一个 intent 出来是另一种力学。
 */
export const PhysicsTuningSchema = z.object({
  springK: z.number().min(0.2).max(24),
  damping: z.number().min(0.02).max(6),
  restitution: z.number().min(0).max(0.94),
  maxSpeed: z.number().min(0.05).max(16),
  intensityCap: z.number().min(0).max(1),
  noiseAmp: z.number().min(0).max(0.4),
});
export type PhysicsTuning = z.infer<typeof PhysicsTuningSchema>;

export const BASE_TUNING: PhysicsTuning = {
  springK: 5.2,
  damping: 0.26,
  restitution: 0.6,
  maxSpeed: 3.2,
  intensityCap: 1,
  noiseAmp: 0.03,
};

export const CauseSchema = z.object({
  kind: z.enum(["event", "drive", "deliberation", "user"]),
  id: z.string().min(1).max(96),
  driveKey: z.enum(["curiosity", "caution", "sociability", "energy", "arousal", "none"]),
  driveLevel: z.number().min(0).max(1),
});
export type Cause = z.infer<typeof CauseSchema>;

export const DirectiveSchema = z.object({
  version: z.literal(1),
  intent: z.enum(INTENT_KINDS),
  intensity: z.number().min(0).max(1),
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  /** 语义锚点，不是坐标 */
  attend: z.string().min(1).max(64),
  holdMs: z.number().int().min(0).max(60_000),
  cause: CauseSchema,
  tuning: PhysicsTuningSchema,
  issuedAtMs: z.number().nonnegative(),
});
export type Directive = z.infer<typeof DirectiveSchema>;

export function makeDirective(input: Directive): Directive {
  return DirectiveSchema.parse(input);
}
