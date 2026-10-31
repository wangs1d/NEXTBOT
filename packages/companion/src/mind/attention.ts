import type { Attention } from "../protocol/affect.ts";

const HOLD = 0.86;
const DECAY_PER_SEC = 0.16;
const FLOOR_STRENGTH = 0.16;

export function decayAttention(a: Attention, dtSec: number): Attention {
  const strength = a.strength * Math.exp(-DECAY_PER_SEC * dtSec);
  if (strength < FLOOR_STRENGTH && a.target !== "ambient") {
    return { target: "ambient", strength: FLOOR_STRENGTH * 0.6 };
  }
  return { ...a, strength: Math.max(0.05, strength) };
}

/**
 * 注意力是互斥资源：一次只有一个靶。
 * 换靶要求新事件的显著性压过当前持有的注意力，否则它只是"听见了"但没转头。
 */
export function allocateAttention(
  cur: Attention,
  next: { anchor: string; salience: number },
  curiosity: number,
): { attention: Attention; taken: boolean } {
  const pressure = next.salience * (1 + curiosity * 0.6);
  const held = cur.strength * HOLD;
  if (cur.target === next.anchor) {
    return { attention: { ...cur, strength: Math.max(cur.strength, next.salience) }, taken: true };
  }
  if (pressure > held) {
    return { attention: { target: next.anchor, strength: Math.min(1, next.salience) }, taken: true };
  }
  return { attention: cur, taken: false };
}
