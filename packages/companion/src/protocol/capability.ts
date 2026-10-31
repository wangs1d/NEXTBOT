import { z } from "zod";
import {
  DESKTOP_HOVER_WORLD,
  DESKTOP_STANDING_WORLD,
  TEST_ROOM_WORLD,
  WorldDescriptorSchema,
} from "./world.ts";

export const CHANNELS = [
  "translate",
  "rotate",
  "deform",
  "glow",
  "gaze",
  "lid",
  "mouth",
] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * 本体感觉说明书：壳声明自己的身体能表达什么、活在什么物理世界里。
 * 世界（重力/地面/墙/标尺）是这里唯一的事实来源——解算层不许再自己发明常数。
 */
export const CapabilityDescriptorSchema = z.object({
  version: z.literal(1),
  shell: z.string().min(1).max(64),
  channels: z.array(z.enum(CHANNELS)).min(1),
  anchors: z.array(z.string().min(1).max(64)).min(1),
  hasAnchor: z.boolean(),
  maxHz: z.number().int().min(24).max(360),
  world: WorldDescriptorSchema,
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const DG2_OVERLAY_CAPABILITY: CapabilityDescriptor = CapabilityDescriptorSchema.parse({
  version: 1,
  shell: "dg2-overlay",
  channels: ["translate", "rotate", "deform", "glow", "gaze"],
  anchors: ["ambient", "user", "self", "focus", "schedule", "source", "clock"],
  hasAnchor: true,
  maxHz: 120,
  world: DESKTOP_HOVER_WORLD,
});

/** 同一个 248×309 窗口，落地站着的那个版本——力学取证跑在这里。 */
export const DG2_STANDING_CAPABILITY: CapabilityDescriptor = CapabilityDescriptorSchema.parse({
  version: 1,
  shell: "dg2-overlay-standing",
  channels: ["translate", "rotate", "deform", "glow", "gaze"],
  anchors: ["ambient", "user", "self", "focus", "schedule", "source", "clock"],
  hasAnchor: true,
  maxHz: 120,
  world: DESKTOP_STANDING_WORLD,
});

export const TEST_ROOM_CAPABILITY: CapabilityDescriptor = CapabilityDescriptorSchema.parse({
  version: 1,
  shell: "test-room",
  channels: ["translate", "rotate", "deform", "glow"],
  anchors: ["ambient", "user", "self", "focus"],
  hasAnchor: true,
  maxHz: 120,
  world: TEST_ROOM_WORLD,
});

/** 聊天页内嵌的壳：有位移无视线。 */
export const DOM_EMBED_CAPABILITY: CapabilityDescriptor = CapabilityDescriptorSchema.parse({
  version: 1,
  shell: "dom-embed",
  channels: ["translate", "rotate", "deform", "glow"],
  anchors: ["ambient", "user", "self", "focus"],
  hasAnchor: false,
  maxHz: 60,
  world: { ...TEST_ROOM_WORLD, name: "dom-embed-room" },
});

/** 只有脸没有身的壳：证明契约对"表达带宽极窄"的壳也成立 */
export const LED_BAR_CAPABILITY: CapabilityDescriptor = CapabilityDescriptorSchema.parse({
  version: 1,
  shell: "led-bar",
  channels: ["glow"],
  anchors: ["ambient", "user"],
  hasAnchor: false,
  maxHz: 30,
  world: { ...TEST_ROOM_WORLD, name: "led-bar-strip", gravity: { x: 0, y: 0, z: 0 }, floor: null, anchor: null },
});

export function supports(cap: CapabilityDescriptor, ch: Channel): boolean {
  return cap.channels.includes(ch);
}

export function canResolve(cap: CapabilityDescriptor, anchor: string): boolean {
  return cap.anchors.includes(anchor);
}
