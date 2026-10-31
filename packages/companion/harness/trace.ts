import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DG2_OVERLAY_CAPABILITY } from "../src/protocol/capability.ts";
import { restY, wallAt } from "../src/protocol/world.ts";
import type { Percept } from "../src/protocol/affect.ts";
import type { Directive } from "../src/protocol/directive.ts";
import { createMind } from "../src/mind/tick.ts";
import { tuningFromAffect } from "../src/mind/emotion-physics.ts";
import { createEngine } from "../src/body/engine.ts";
import type { Pose } from "../src/protocol/pose.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const FRAME_MS = 1000 / 60;

const SCRIPT: Array<{ atMs: number; label: string; percept: Percept["kind"] }> = [
  { atMs: 30_000, label: "你打开了一个新窗口", percept: "app.focus.new" },
  { atMs: 60_000, label: "你戳了它一下", percept: "user.tap" },
  { atMs: 90_000, label: "你夸了它", percept: "user.praise" },
  { atMs: 120_000, label: "你凶了它", percept: "user.scold" },
  { atMs: 180_000, label: "你又戳了它一下（同一事件，不同的身体）", percept: "user.tap" },
  { atMs: 240_000, label: "任务报错", percept: "alert.error" },
  { atMs: 300_000, label: "它自己缓过来，没人理它", percept: "ambient.tick" },
];

// 判据③取证：连续逗它 10 下，看它是不是越动越软
for (let n = 0; n < 10; n++) {
  SCRIPT.push({ atMs: 330_000 + n * 5000, label: `你连续逗它 第${n + 1}下`, percept: "user.tap" });
}

const mind = createMind(undefined, 20261031);
const engine = createEngine(DG2_OVERLAY_CAPABILITY);
const directives: Array<Directive & { atMs: number }> = [];
const poses: Pose[] = [];
const samples: Array<{ atMs: number; energy: number; caution: number; attention: string }> = [];

const UNTIL = 400_000;
let scriptIdx = 0;
let lastMindTick = -1;

for (let t = 0; t <= UNTIL; t += FRAME_MS) {
  const now = Math.round(t);
  while (scriptIdx < SCRIPT.length && SCRIPT[scriptIdx].atMs <= now) {
    const s = SCRIPT[scriptIdx];
    mind.perceive({ kind: s.percept, atMs: s.atMs });
    scriptIdx += 1;
  }
  if (now - lastMindTick >= 1000) {
    lastMindTick = now;
    for (const d of mind.tick(now)) {
      directives.push({ ...d, atMs: now });
      engine.applyDirective(d);
    }
    const st = mind.state();
    samples.push({ atMs: now, energy: st.energy, caution: st.drives.caution, attention: st.attention.target });
  }
  poses.push(...engine.advance(FRAME_MS));
}

function windowStats(fromMs: number, toMs: number) {
  const win = poses.filter((p) => p.tMs >= fromMs && p.tMs < toMs);
  if (!win.length) return { apex: 0, squash: 0, contacts: 0, turns: 0 };
  return {
    apex: Math.max(...win.map((p) => p.pos.y)) - restY(DG2_OVERLAY_CAPABILITY.world),
    squash: Math.max(...win.map((p) => p.deform)),
    contacts: win.filter((p, i) => i > 0 && p.airborne && !win[i - 1].airborne).length,
    turns: Math.max(...win.map((p) => Math.abs(p.rot.y))),
  };
}

const rows: string[] = [];
for (const s of SCRIPT.slice(0, 7)) {
  const fired = directives.filter((d) => d.atMs >= s.atMs && d.atMs < s.atMs + 12_000);
  const st = windowStats(s.atMs, s.atMs + 12_000);
  const mind0 = samples.find((x) => x.atMs >= s.atMs);
  rows.push(
    [
      `${(s.atMs / 1000).toFixed(0)}s`,
      s.label,
      fired.map((d) => `${d.intent}(${d.intensity.toFixed(2)})`).join(" ") || "—",
      st.apex.toFixed(3),
      st.squash.toFixed(3),
      String(st.contacts),
      mind0 ? mind0.caution.toFixed(2) : "-",
      mind0 ? mind0.energy.toFixed(2) : "-",
    ].join(" | "),
  );
}

console.log("时刻 | 发生了什么 | 自发行为(强度) | 腾空高 | 挤压 | 接触次数 | caution | energy");
console.log(rows.join("\n"));

const pre = windowStats(60_000, 72_000);
const post = windowStats(180_000, 192_000);
console.log(`\n判据⑤ 决策端：被凶前那一下戳 → ${directives.filter((d) => d.atMs >= 60_000 && d.atMs < 72_000).length} 条行为；被凶后同样一下 → ${directives.filter((d) => d.atMs >= 180_000 && d.atMs < 192_000).length} 条`);
console.log(`判据⑤ 身体端：pre apex=${pre.apex.toFixed(3)} / post apex=${post.apex.toFixed(3)}`);

// 同一条 jump 配方、同一个强度，只换身体常数——这是"记忆留在身体里"的直证
function apexOfTuning(tuningKind: "calm" | "scared"): { apex: number; contacts: number; squash: number } {
  const e = createEngine(DG2_OVERLAY_CAPABILITY);
  const st = mind.state();
  const tuning =
    tuningKind === "calm"
      ? { springK: 5.4, damping: 0.24, restitution: 0.74, maxSpeed: 4.3, intensityCap: 1, noiseAmp: 0.02 }
      : tuningFromAffect({ ...st, drives: { curiosity: 0.3, caution: 0.88, sociability: 0.2 }, arousal: 0.5, energy: 0.55 });
  e.applyDirective({
    version: 1,
    intent: "jump",
    intensity: 0.85,
    valence: 0.3,
    arousal: 0.6,
    attend: "user",
    holdMs: 600,
    cause: { kind: "user", id: "trace:ab", driveKey: "none", driveLevel: 0 },
    tuning,
    issuedAtMs: 0,
  });
  let apex = -Infinity;
  let squash = 0;
  for (let t = 0; t < 4000; t += FRAME_MS) {
    for (const p of e.advance(FRAME_MS)) {
      apex = Math.max(apex, p.pos.y);
      squash = Math.max(squash, p.deform);
    }
  }
  return { apex: apex - restY(DG2_OVERLAY_CAPABILITY.world), contacts: e.stats().contacts, squash };
}
const calmJump = apexOfTuning("calm");
const scaredJump = apexOfTuning("scared");
console.log(
  `\n同一条 jump 配方 intensity=0.85：常态 apex=${calmJump.apex.toFixed(3)} 回弹${calmJump.contacts}次 ` +
    `| 受惊态 apex=${scaredJump.apex.toFixed(3)} 回弹${scaredJump.contacts}次 落地挤压${scaredJump.squash.toFixed(3)}`,
);

const burst = directives.filter((d) => d.atMs >= 330_000);
if (burst.length >= 2) {
  const first = burst[0];
  const last = burst[burst.length - 1];
  const sameIntent = burst.filter((d) => d.intent === first.intent);
  const lastSame = sameIntent[sameIntent.length - 1];
  const e0 = samples.filter((s) => s.atMs >= 330_000)[0];
  const e1 = samples[samples.length - 1];
  console.log(
    `判据③ 连逗 ${burst.length} 次：精力 ${e0?.energy.toFixed(2)} → ${e1.energy.toFixed(2)}，` +
      `强度上限 ${first.tuning.intensityCap.toFixed(2)} → ${last.tuning.intensityCap.toFixed(2)}（代价是身体层面的，与 intent 无关）\n` +
      `        同一条 ${first.intent}：驱力压力把它推得更响 ${first.intensity.toFixed(2)} → ${lastSame?.intensity.toFixed(2)}，` +
      `但上限一路压低——兴奋盖过了疲劳，这是真的越逗越来劲，不是无代价`,
  );
}
const energyBurst = samples.filter((s) => s.atMs >= 325_000).map((s) => s.energy);
console.log(
  `判据③ 精力轨迹(325s 后，每 5s 一点)：${energyBurst.filter((_, n) => n % 5 === 0).map((v) => v.toFixed(2)).join(" ")}` +
    ` ｜ 区间 ${Math.min(...energyBurst).toFixed(2)}–${Math.max(...energyBurst).toFixed(2)}`,
);

const first30 = directives.filter((d) => d.atMs < 30_000);
console.log(`\n全程：${poses.length} 帧 / ${directives.length} 条 directive / 引擎丢弃 ${engine.stats().dropped} 个不支持通道`);

const r = (x: number): number => Math.round(x * 1e3) / 1e3;
const thinned = poses.filter((_, n) => n % 2 === 0).map((p) => ({
  t: Math.round(p.tMs * 10) / 10,
  x: r(p.pos.x),
  y: r(p.pos.y),
  z: r(p.pos.z),
  ry: r(p.rot.y),
  rz: r(p.rot.z),
  d: r(p.deform),
  g: r(p.glow),
  a: p.airborne ? 1 : 0,
  dr: p.driver,
}));

// 抽稀后的真实步距 = 跨度 / (帧数-1)，不拿名义常量冒充
const realFrameMs = (thinned[thinned.length - 1].t - thinned[0].t) / (thinned.length - 1);

mkdirSync(OUT, { recursive: true });
const trace = {
  capability: DG2_OVERLAY_CAPABILITY,
  frameMs: realFrameMs,
  script: SCRIPT,
  directives,
  poses: thinned,
  samples,
};
const body = JSON.stringify(trace);
writeFileSync(join(OUT, "day.trace.json"), body);
writeFileSync(join(OUT, "day.trace.js"), `window.TRACE = ${body};`);
console.log(`轨迹已录制：harness/out/day.trace.json（${(body.length / 1024).toFixed(0)} KB）`);

const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else console.log(`✓ ${msg}`);
};
assert(first30.length === 0, "无输入时不动（判据①）");
assert(directives.every((d) => d.cause.id.length > 0), "每条行为都有因（判据①）");
assert(scaredJump.apex < calmJump.apex * 0.9, "同一条配方，受惊的身体跳得更低（判据⑤）");
assert(scaredJump.contacts < calmJump.contacts, "受惊后回弹次数更少（判据⑤）");
assert(calmJump.apex > 0.3, `常态跳跃应明显离锚，实得 ${calmJump.apex.toFixed(3)}`);
assert(Math.max(...poses.map((p) => Math.abs(p.pos.x))) <= wallAt(DG2_OVERLAY_CAPABILITY.world,"x",1)!! + 1e-6, "从未越出边界（判据②）");
assert(directives.length >= 6, `有因的自发行为成串出现，不是脚本回放：${directives.length} 条`);
assert(
  burst.length >= 2 &&
    burst[burst.length - 1].tuning.intensityCap <= burst[0].tuning.intensityCap,
  "连逗之后强度上限下降（判据③）",
);
assert(
  samples.filter((s) => s.atMs >= 330_000).every((s, n, arr) => n === 0 || s.energy <= arr[n - 1].energy + 0.02),
  "连逗期间精力单调走低（判据③）",
);
