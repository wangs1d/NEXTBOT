/**
 * 前后对比实验（2026-10-19）：同一场景，旧路径 vs 共享发现层。
 *
 * 目的：让「共享发现层」的收益**可复现**，而不是一句"架构更好了"。
 * 两个场景，同一份输入，两种实现：
 *
 *  场景 A「三源撞车」：邮件 / GoalRunner / 夜间内省 三层就用户同一件在办的事
 *    各产出了一条发现（各层都还没开口）。
 *    旧路径：三条链各说各的 → 用户收到 3 条消息，其中 2 条在说同一件事。
 *    新路径：第一条开口读合成 → 1 条消息说完三层信息（同一发现不会被第二层重复说）。
 *
 *  场景 B「抑制后的信息不蒸发」：邮件与目标层先开口，但被主动管道频控挡下
 *    （verdict=suppressed，等于没说），夜间内省随后开口。
 *    旧路径：被挡下的那两条信息**无人转述**，用户永远不知道"卡在哪一步 / 房东说了什么"。
 *    新路径：发现落在总线上（被抑制的开口不消费发现）→ 内省开口时顺带说出，
 *      用户一次听到完整图景。
 *
 * 旧路径是**忠实复刻**（用的是本次改造仍在导出的旧函数）：relatedGoalFor 定档 +
 * appendGoalHint 补目标口径 + isCrossSourceRepeat/downgradeImportanceForRepeat 重复降档；
 * 差别只在于"各层不共享发现源"这件事本身。
 *
 * 运行：cd server && npx tsx scripts/compare-shared-discovery.ts
 * 输出：控制台对比表 + e:\ws-project\NextBot\shared-discovery-before-after.html
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GoalBoard } from "../src/proactivity/goal-board.js";
import { GoalPlanner } from "../src/proactivity/goal-planner.js";
import {
  GoalSignalBridge,
  adjustImportanceByGoalRelation,
  appendGoalHint,
  downgradeImportanceForRepeat,
  isCrossSourceRepeat,
} from "../src/proactivity/goal-signal-bridge.js";
import { SourceStore } from "../src/proactivity/source-store.js";
import { DiscoveryLayer } from "../src/proactivity/discovery-layer.js";

const ACTOR = "u1";
const MIN = 60_000;
const T0 = new Date(2026, 9, 19, 9, 0, 0).getTime();

/** 一条"层产出"，同一份输入喂给旧/新两种实现 */
type LayerEvent = {
  at: number;
  /** 产出者标识（旧路径不用，新路径用于 finding.source） */
  source: string;
  title: string;
  body: string;
  importance: "low" | "medium" | "high";
  /** 是否在请用户拍板（外部步骤等确认） */
  needsUser: boolean;
  /** 这一层开口最终被管道的裁决（suppressed = 被频控/静默挡下，等于没说） */
  verdict: "delivered" | "suppressed";
};

/** 三层就"搬家"这件事各自产出的发现（各层都还没开口） */
const EVENTS: LayerEvent[] = [
  {
    at: T0,
    source: "email",
    title: "收到来自 房东 的重要邮件",
    body: "房东邮件：搬家要提前一周预约电梯，物业周末不上班。",
    importance: "medium",
    needsUser: false,
    verdict: "suppressed",
  },
  {
    at: T0 + 3 * MIN,
    source: "goal",
    title: "计划「搬家」卡住等确认",
    body: "计划「搬家」卡在第 1 步「预约搬家公司」，等你点确认。",
    importance: "medium",
    needsUser: true,
    verdict: "suppressed",
  },
  {
    at: T0 + 6 * MIN,
    source: "goal_introspect",
    title: "在办目标还作数吗",
    body: "「搬家」三天没动静，这个目标还作数吗？",
    importance: "medium",
    needsUser: true,
    verdict: "delivered",
  },
];

type Opening = {
  at: number;
  source: string;
  importance: string;
  repeat: boolean;
  text: string;
  merged: string[];
  verdict: string;
};

/** 场景 A 的"撞车"版本：三层在开口前就把发现登记好（模拟扫描/后台已产出） */
function scenarioA(now0: number) {
  const dir = mkdtempSync(join(tmpdir(), "pa-cmp-"));
  const nowFn = () => now0 + 6 * MIN;
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn });
  const planner = new GoalPlanner({ goalBoard: board, launchTask: () => "task" });
  const plan = planner.createPlan({ actorId: ACTOR, title: "搬家", steps: ["预约搬家公司", "打包行李"] });
  const goalId = plan.ok ? plan.goal.goalId : "";
  if (plan.ok) {
    const steps = planner.stepsOf(plan.goal);
    if (steps[0]) steps[0].status = "awaiting_confirm";
  }
  const bridge = new GoalSignalBridge({ goalPlanner: planner });
  const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn, env: {} });
  const discovery = new DiscoveryLayer({
    store,
    goalOpens: {
      lastOpenedAt: (s) => board.get(s)?.lastOpenedAt,
      markOpened: (s, at) => board.noteOpened(s, at),
    },
    nowFn,
  });

  // 场景 A 里三条都送达（不掺抑制因素，单独看"撞车"这一件事）
  const delivered: LayerEvent[] = EVENTS.map((e) => ({ ...e, verdict: "delivered" }));

  // ── 旧路径：三条链各说各的（每条链自己开口，互不读取对方的发现）──
  const old: Opening[] = delivered.map((e) => {
    const relation = e.source === "email" ? null : bridge.relatedGoalFor(ACTOR, `${e.title} ${e.body}`);
    const graded = adjustImportanceByGoalRelation(e.importance, relation);
    const repeat = relation ? isCrossSourceRepeat(board.get(relation.goalId)?.lastOpenedAt, e.at) : false;
    if (relation) board.noteOpened(relation.goalId, e.at);
    const importance = repeat ? downgradeImportanceForRepeat(graded, relation) : graded;
    return {
      at: e.at,
      source: e.source,
      importance,
      repeat,
      text: appendGoalHint(e.body, relation),
      merged: [],
      verdict: e.verdict,
    };
  });

  // ── 新路径：三层先写发现（未开口），再由"第一个开口"一次读合成 ──
  for (const e of delivered) {
    discovery.write({ subject: e.source === "email" ? undefined : goalId, actorId: ACTOR, source: e.source, content: e.body });
  }
  const opener = delivered[delivered.length - 1];
  const composed = discovery.composeBeforeOpen({
    subject: goalId,
    ownSource: opener.source,
    actorId: ACTOR,
    body: opener.body,
    importance: opener.importance,
    needsUser: opener.needsUser,
  });
  discovery.noteSpoken(composed.pendingFingerprints, opener.verdict);
  const neu: Opening[] = [
    {
      at: opener.at,
      source: opener.source,
      importance: composed.importance,
      repeat: composed.repeat,
      text: composed.body,
      merged: composed.merged.map((m) => `${m.source}：${m.content}`),
      verdict: opener.verdict,
    },
  ];
  rmSync(dir, { recursive: true, force: true });
  return { old, neu, goalId };
}

/** 场景 B 的"抑制"版本：按时间顺序逐条开口，被抑制的开口不消费发现 */
function scenarioB(now0: number) {
  const dir = mkdtempSync(join(tmpdir(), "pa-cmp-"));
  let clock = now0;
  const nowFn = () => clock;
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn });
  const planner = new GoalPlanner({ goalBoard: board, launchTask: () => "task" });
  const plan = planner.createPlan({ actorId: ACTOR, title: "搬家", steps: ["预约搬家公司", "打包行李"] });
  const goalId = plan.ok ? plan.goal.goalId : "";
  if (plan.ok) {
    const steps = planner.stepsOf(plan.goal);
    if (steps[0]) steps[0].status = "awaiting_confirm";
  }
  const bridge = new GoalSignalBridge({ goalPlanner: planner });
  const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn, env: {} });
  const discovery = new DiscoveryLayer({
    store,
    goalOpens: {
      lastOpenedAt: (s) => board.get(s)?.lastOpenedAt,
      markOpened: (s, at) => board.noteOpened(s, at),
    },
    nowFn,
  });

  const old: Opening[] = [];
  const neu: Opening[] = [];
  for (const e of EVENTS) {
    clock = e.at;
    // ── 旧路径 ──
    const relation = e.source === "email" ? null : bridge.relatedGoalFor(ACTOR, `${e.title} ${e.body}`);
    const graded = adjustImportanceByGoalRelation(e.importance, relation);
    const repeatOld = relation ? isCrossSourceRepeat(board.get(relation.goalId)?.lastOpenedAt, e.at) : false;
    if (relation) board.noteOpened(relation.goalId, e.at);
    old.push({
      at: e.at,
      source: e.source,
      importance: repeatOld ? downgradeImportanceForRepeat(graded, relation) : graded,
      repeat: repeatOld,
      text: appendGoalHint(e.body, relation),
      merged: [],
      verdict: e.verdict,
    });

    // ── 新路径：先登记发现，再合成开口；只有真的说出口才消费 ──
    discovery.write({ subject: e.source === "email" ? undefined : goalId, actorId: ACTOR, source: e.source, content: e.body });
    const composed = discovery.composeBeforeOpen({
      subject: e.source === "email" ? undefined : goalId,
      ownSource: e.source,
      actorId: ACTOR,
      body: e.body,
      importance: e.importance,
      needsUser: e.needsUser,
    });
    discovery.noteSpoken(composed.pendingFingerprints, e.verdict);
    neu.push({
      at: e.at,
      source: e.source,
      importance: composed.importance,
      repeat: composed.repeat,
      text: composed.body,
      merged: composed.merged.map((m) => `${m.source}：${m.content}`),
      verdict: e.verdict,
    });
  }
  rmSync(dir, { recursive: true, force: true });
  return { old, neu, goalId };
}

/** 用户实际收到的消息（被抑制的开口不产生消息） */
function heard(openings: Opening[]): Opening[] {
  return openings.filter((o) => o.verdict !== "suppressed");
}

/** 三层信息实际到达用户的条数（在已送达消息里出现的层内容计数） */
function coverage(openings: Opening[]): number {
  const text = heard(openings).map((o) => o.text).join("\n");
  return EVENTS.filter((e) => text.includes(e.body)).length;
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

function table(rows: Opening[][], titles: string[]): string {
  const body = rows
    .map((list, i) => {
      const items = list.length
        ? list
            .map(
              (o) =>
                `<li><b>${esc(o.source)}</b> <span class="badge ${o.verdict}">${o.verdict === "suppressed" ? "被挡下（等于没说）" : o.importance}</span>` +
                `<div class="msg">${esc(o.text).replace(/\n/g, "<br>")}</div>` +
                (o.merged.length ? `<div class="merged">合并了 ${o.merged.length} 条他人发现</div>` : "") +
                `</li>`,
            )
            .join("")
        : "<li class='empty'>（无开口）</li>";
      return `<div class="col"><h3>${esc(titles[i])}</h3><ul>${items}</ul></div>`;
    })
    .join("");
  return `<div class="grid">${body}</div>`;
}

function main(): void {
  const a = scenarioA(T0);
  const b = scenarioB(T0);

  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  say("═══ 场景 A：三源撞车（同一件事被三层同时发现）═══");
  say(`旧路径：用户收到 ${heard(a.old).length} 条消息（三层各说各的），信息覆盖 ${coverage(a.old)}/3`);
  for (const o of a.old) say(`  · [${o.source}] ${o.verdict} ${o.text}`);
  say(`新路径：用户收到 ${heard(a.neu).length} 条消息（一条说完全部），信息覆盖 ${coverage(a.neu)}/3`);
  for (const o of a.neu) say(`  · [${o.source}] ${o.verdict} ${o.text}`);

  say("");
  say("═══ 场景 B：抑制之后（被频控挡下的那两条信息去哪了）═══");
  say(`旧路径：用户收到 ${heard(b.old).length} 条消息，信息覆盖 ${coverage(b.old)}/3（被挡下的两条无人转述）`);
  for (const o of b.old) say(`  · [${o.source}] ${o.verdict} ${o.text}`);
  say(`新路径：用户收到 ${heard(b.neu).length} 条消息，信息覆盖 ${coverage(b.neu)}/3（被挡下的两条被下一个出口说出）`);
  for (const o of b.neu) say(`  · [${o.source}] ${o.verdict} ${o.text}`);

  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>共享发现层 · 前后对比</title>
<style>
 body{font:14px/1.7 -apple-system,"Segoe UI","PingFang SC",sans-serif;background:#0f1115;color:#e6e8ee;margin:0;padding:32px}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#8b93a7;margin-bottom:24px}
 h2{font-size:17px;margin:32px 0 12px;border-left:3px solid #4f8cff;padding-left:10px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .col{background:#161a22;border:1px solid #232936;border-radius:10px;padding:14px}
 .col h3{margin:0 0 10px;font-size:14px;color:#9fb0d0}
 ul{list-style:none;padding:0;margin:0} li{padding:10px 0;border-top:1px dashed #232936}
 li:first-child{border-top:0}
 .msg{white-space:normal;color:#cdd4e3;margin-top:6px;background:#10141b;border-radius:6px;padding:8px 10px}
 .badge{font-size:11px;padding:2px 7px;border-radius:99px;background:#26304a;color:#a9c0ff}
 .badge.suppressed{background:#4a2530;color:#ff9aa8}
 .badge.delivered{background:#1e3a2b;color:#7ee0a8}
 .merged{font-size:12px;color:#7ee0a8;margin-top:6px}
 .empty{color:#5a6373}
 .stats{background:#161a22;border:1px solid #232936;border-radius:10px;padding:14px;margin-top:16px}
 table{border-collapse:collapse;width:100%} td,th{padding:8px 10px;border-bottom:1px solid #232936;text-align:left;font-size:13px}
 th{color:#8b93a7;font-weight:500}
</style>
<h1>共享发现层 · 前后优化对比</h1>
<div class="sub">同一场景、同一份输入；旧路径 = 三条链各说各的（发现源不共享），新路径 = 一条总线（SourceStore.finding）+ 一个共同键（subject）+ 一个单开口闸（composeBeforeOpen）。</div>

<h2>场景 A：三源撞车（邮件 / GoalRunner / 夜间内省 同时发现了同一件在办的事）</h2>
${table([a.old, a.neu], ["旧路径：三层各说各的", "新路径：一条说完全部"])}

<h2>场景 B：抑制之后（前两条被主动管道频控挡下，等于没说）</h2>
${table([b.old, b.neu], ["旧路径：被挡下的信息无人转述", "新路径：发现留在总线上，被下一个出口说出"])}

<div class="stats">
<table>
<tr><th>指标</th><th>旧路径</th><th>新路径</th></tr>
<tr><td>场景 A：用户收到消息数</td><td>${heard(a.old).length} 条</td><td>${heard(a.neu).length} 条</td></tr>
<tr><td>场景 A：三层信息覆盖</td><td>${coverage(a.old)} / 3</td><td>${coverage(a.neu)} / 3</td></tr>
<tr><td>场景 B：三层信息覆盖（两条被频控挡下）</td><td>${coverage(b.old)} / 3</td><td>${coverage(b.neu)} / 3</td></tr>
<tr><td>跨层读取（A 层能否读到 B 层的发现）</td><td>不能（无共同键）</td><td>能（subject + 实体倒排）</td></tr>
<tr><td>重复说同一件事</td><td>同目标被两层各说一遍</td><td>未消费发现被合并/读走后不再重复</td></tr>
</table>
</div>
</html>`;

  const out = join(process.cwd(), "..", "shared-discovery-before-after.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  console.log(`\n报告已写入：${out}`);
}

main();
