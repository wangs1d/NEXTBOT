import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_TUNING, INTENT_KINDS, type IntentKind } from "../protocol/directive.ts";
import { DG2_STANDING_CAPABILITY } from "../protocol/capability.ts";
import { restY } from "../protocol/world.ts";
import { createEngine } from "../body/engine.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "__golden__");
const GOLDEN = join(GOLDEN_DIR, "trajectories.json");
const UPDATE = process.env.COMPANION_GOLDEN === "update";

/**
 * 零预制动画之后没有 clip 文件可比对，轨迹快照就是新的资产。
 * 改任何一个物理常数，这里会指名道姓地说哪几条 intent 变了。
 */
function trajectory(intent: IntentKind, intensity: number): number[][] {
  const engine = createEngine(DG2_STANDING_CAPABILITY);
  engine.applyDirective({
    version: 1,
    intent,
    intensity,
    valence: 0.2,
    arousal: 0.4,
    attend: "user",
    holdMs: 900,
    cause: { kind: "drive", id: "golden", driveKey: "none", driveLevel: 0.5 },
    tuning: { ...BASE_TUNING },
    issuedAtMs: 0,
  });
  const r = (x: number): number => Math.round(x * 1e4) / 1e4;
  const out: number[][] = [];
  for (let t = 0; t < 4000; t += 1000 / 60) {
    for (const p of engine.advance(1000 / 60)) {
      out.push([r(p.pos.x), r(p.pos.y), r(p.pos.z), r(p.rot.y), r(p.rot.z), r(p.deform), r(p.glow)]);
    }
  }
  return out;
}

const digest = (frames: number[][]): string => {
  let h = 2166136261;
  const s = JSON.stringify(frames);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

function build(): Record<string, { hash: string; frames: number; peakApex: number; peakSquash: number }> {
  const out: Record<string, { hash: string; frames: number; peakApex: number; peakSquash: number }> = {};
  for (const intent of INTENT_KINDS) {
    const tr = trajectory(intent, 0.7);
    out[intent] = {
      hash: digest(tr),
      frames: tr.length,
      peakApex: Math.round((Math.max(...tr.map((f) => f[1])) - restY(DG2_STANDING_CAPABILITY.world)) * 1e4) / 1e4,
      peakSquash: Math.round(Math.max(...tr.map((f) => f[5])) * 1e4) / 1e4,
    };
  }
  return out;
}

const current = build();

if (UPDATE) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`golden 已更新：${GOLDEN}`);
}

test("12 条 intent 的轨迹与 golden 快照一致（改常数必须显式认账）", async (t) => {
  if (!existsSync(GOLDEN)) {
    await t.skip("尚无 golden 快照，先跑 COMPANION_GOLDEN=update");
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof current;
  const drifted: string[] = [];
  for (const intent of INTENT_KINDS) {
    const g = golden[intent];
    const c = current[intent];
    assert.ok(g, `golden 里缺 ${intent}，请更新快照`);
    if (g.hash !== c.hash) drifted.push(`${intent} ${g.hash}→${c.hash}（apex ${g.peakApex}→${c.peakApex}）`);
  }
  assert.deepEqual(drifted, [], drifted.join("；"));
});

test("每条 intent 都真的产生了位移或形变，不是空转", async (t) => {
  for (const intent of INTENT_KINDS) {
    const c = current[intent];
    const moved = Math.abs(c.peakApex) > 1e-4 || Math.abs(c.peakSquash) > 1e-4;
    if (!moved) await t.skip(`${intent} 峰值位移与形变均为零`);
    assert.ok(c.frames > 200, `${intent} 帧数异常`);
  }
});

test("强度单调：同一条 jump，intensity 越大跳得越高", () => {
  const apex = (v: number): number => Math.max(...trajectory("jump", v).map((f) => f[1]));
  const low = apex(0.25);
  const mid = apex(0.55);
  const high = apex(0.95);
  assert.ok(mid > low, `${mid} 应高于 ${low}`);
  assert.ok(high > mid, `${high} 应高于 ${mid}`);
});
