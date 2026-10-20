/**
 * 目标拆解（goal / plan）真实链路 live E2E。
 *
 * 问题：用户说「我要去旅游」，agent 到底会不会把它拆成「先订票、后订酒店」这类
 * 有序步骤？拆出来的东西是不是真落在台账里（而不是只在正文里说说）？
 *
 * 真实组件：createAppServices 完整生产装配（沙箱 data，仓库 data/ 不受影响）+
 * 真实 LLM（server/.env.local）+ WS 客户端扮演手机端 + 真实 tool-loop。
 *
 * 证据线（不用「看起来像」下结论，只看落盘/落帧）：
 *   ① tool.call 帧：本轮真实调了哪些工具（goal.plan.create / plan.write / travel.*）
 *   ② plan_step 帧：前端真收到的步骤事件
 *   ③ data/goals.json：GoalRecord 里的 steps / status / successCriteria / verdict
 *   ④ data/session-plans/*.json：TaskPlan 的 steps
 *   ⑤ GET /api/proactivity/goals/view|cost：统一视图 + 成本面
 *
 * 跑法：npx tsx scripts/e2e-goal-decompose-live.ts
 *      PA_E2E_ATTACH=1 PA_E2E_PORT=3000 PA_E2E_ACTOR=xxx → attach 已在跑的生产 server
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

await import("../src/config/load-server-env.js");

// GoalRunner 自驱循环默认 tick=30min，脚本窗口内永远看不到自动推进 →
// 显式降到最小允许值 30s，才能观测「目标是否真被后台推起来」
process.env.GOAL_RUNNER_TICK_MS ??= "30000";

const PORT = Number(process.env.PA_E2E_PORT ?? 3105);
const ACTOR = process.env.PA_E2E_ACTOR ?? "e2e_goal_user";
const ATTACH = process.env.PA_E2E_ATTACH === "1";
// 仓库根（chdir 前取；chdir 后 cwd 变成沙箱）
const repoRoot = process.cwd();
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-goal-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
const log = (line: string): void => console.log(`[e2e-goal] ${line}`);

// chdir 必须在 import 之前——不少模块在模块加载时就把 dataPath 定死
// （否则沙箱隔离失效，写入会落到仓库 data/）
if (!ATTACH) {
  process.chdir(sandbox);
  log(`沙箱数据目录: ${sandbox}`);
  // 生产等价数据：不拷的话旅行路径会被「宁缺毋滥」拒绝（无 POI 库 + 无知识库），
  // 第 1 轮 itinerary 直接 ok:false，看不到拆解后的真实执行
  const repoData = join(repoRoot, "data");
  for (const f of ["travel-poi.db", "mcp-servers.json"]) {
    const src = join(repoData, f);
    if (existsSync(src)) copyFileSync(src, join(sandbox, "data", f));
  }
  const knSrc = join(repoData, "travel-knowledge");
  if (existsSync(knSrc)) cpSync(knSrc, join(sandbox, "data", "travel-knowledge"), { recursive: true });
  log("已拷入生产等价旅行数据（travel-poi.db / travel-knowledge）");
}
const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
let services: Awaited<ReturnType<typeof createAppServices>> | null = null;
if (ATTACH) {
  log(`attach 模式：连接 ws://127.0.0.1:${PORT}/ws（actor=${ACTOR}，不内嵌服务端）`);
} else {
  services = await createAppServices();
  await services.app.listen({ port: PORT, host: "127.0.0.1" });
  log(`服务端已监听 http://127.0.0.1:${PORT}`);
}

// ── WS 客户端 = 模拟手机端 ──────────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

const seenTools: Array<{ name: string; args: string }> = [];
const toolResults: Array<Record<string, unknown>> = [];
const planSteps: Array<Record<string, unknown>> = [];
const otherFrames = new Map<string, number>();
const turnTexts: string[] = [];
let doneResolver: ((p: Record<string, unknown>) => void) | null = null;

ws.on("message", (raw) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(msg.type ?? "");
  const payload = (msg.payload ?? {}) as Record<string, unknown>;

  if (type === "tool.call") {
    // 真实帧字段是 payload.input（chat-tool-wire / chat-user-message 都是这个名字）
    const name = String(payload.toolName ?? payload.name ?? "");
    const args = JSON.stringify(payload.input ?? payload.toolInput ?? {});
    seenTools.push({ name, args });
    log(`[tool.call] ${name} ${args.slice(0, 400)}`);
    return;
  }
  if (type === "tool.result") {
    toolResults.push(msg);
    log(`[tool.result] ${String(payload.toolName ?? payload.name ?? "")} ${JSON.stringify(payload.result ?? payload).slice(0, 400)}`);
    return;
  }
  if (type === "agent.location_request") {
    // 模拟手机端：纯坐标秒回（不做客户端逆地理），免得按需定位 12s 干等
    log(`[agent.location_request] jobId=${payload.jobId}`);
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          type: "client.location_report",
          payload: {
            jobId: payload.jobId,
            latitude: 18.2528,
            longitude: 109.5119,
            timezone: "Asia/Shanghai",
            label: "海南省三亚市",
          },
        }),
      );
    }, 200);
    return;
  }
  if (JSON.stringify(msg).includes("plan_step")) {
    planSteps.push(msg);
    log(`[plan_step] ${JSON.stringify(payload).slice(0, 240)}`);
    return;
  }
  if (type === "chat.assistant_done") {
    const p = payload as Record<string, unknown>;
    turnTexts.push(String(p.finalText ?? ""));
    doneResolver?.(p);
    doneResolver = null;
    log(`[assistant_done] finalText ${String(p.finalText ?? "").length} 字`);
    return;
  }
  if (type === "chat.assistant_chunk") return;
  otherFrames.set(type, (otherFrames.get(type) ?? 0) + 1);
  if (type.startsWith("agent.")) log(`[帧] ${type} ${JSON.stringify(payload).slice(0, 200)}`);
});

ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR, platform: "mobile" } }));
await new Promise((r) => setTimeout(r, 1_500));
log(`WS 已连接（actor=${ACTOR}）`);

function send(text: string): void {
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: ACTOR, messageId: `e2e-goal-${Date.now()}`, timestamp: new Date().toISOString(), text },
    }),
  );
}
async function waitDone(timeoutMs: number): Promise<Record<string, unknown> | null> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      doneResolver = null;
      resolve(null);
    }, timeoutMs);
    doneResolver = (p) => {
      clearTimeout(timer);
      resolve(p);
    };
  });
}

// ── 多轮对话：一个真实的「去旅游」意图 ──────────────────────────────────
const DIALOGUE: string[] = [
  "我下个月想去三亚玩五天，两个人，预算八千左右，帮我把行程、机票和酒店都安排一下",
  "好，就按你的思路来，先做能定的，需要我拍板的再问我",
  "这个安排你帮我盯着点，一步一步推进，别半途忘了",
  "继续推进下一步",
  // 第 5 轮：直接点名「立成目标 + 先订票再订酒店」——测 goal.plan.create 到底能不能被召回
  "把这个三亚行立成一个目标，帮我盯着一步步办完，顺序上是先订机票再订酒店，最后排行程",
];

const turnResults: Array<{ user: string; finalText: string; tools: string[] }> = [];
for (const text of DIALOGUE) {
  const before = seenTools.length;
  log(`──── 用户: ${text}`);
  send(text);
  const done = await waitDone(180_000);
  const toolsThisTurn = seenTools.slice(before).map((t) => t.name);
  log(`本轮工具: ${toolsThisTurn.join(", ") || "（无）"}`);
  turnResults.push({ user: text, finalText: String(done?.finalText ?? turnTexts[turnTexts.length - 1] ?? ""), tools: toolsThisTurn });
  await new Promise((r) => setTimeout(r, 1_200));
}

// ── 落盘证据 ────────────────────────────────────────────────────────────
function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
type GoalItem = Record<string, unknown>;
const dataDir = ATTACH ? join(process.cwd(), "data") : join(sandbox, "data");
/** 目标台账真实落点：GoalBoard dataPath = data/proactivity（**不是** data/goals.json） */
const goalsPath = join(dataDir, "proactivity", "goals.json");

function readGoalsNow(): GoalItem[] {
  const raw = readJsonSafe(goalsPath) ?? readJsonSafe(join(dataDir, "goals.json"));
  if (Array.isArray(raw)) return raw as GoalItem[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return (Array.isArray(o.goals) ? o.goals : Object.values(o)).filter((g) => g && typeof g === "object") as GoalItem[];
  }
  return [];
}
const stepsSig = (list: GoalItem[]): string =>
  list
    .map((g) => {
      const steps = ((g.payload as Record<string, unknown>)?.steps ?? []) as Array<Record<string, unknown>>;
      return `  [${String(g.status)}] ${String(g.title)} → 步骤状态 [${steps.map((s) => String(s.status)).join("/")}]`;
    })
    .join("\n");

const goalsBefore = readGoalsNow();

// ── Goal 自驱观察窗：等一个 GoalRunner tick（30s），看后台有没有把目标推起来 ──
log("Goal 自驱观察窗：等待 GoalRunner tick（30s）…");
await new Promise((r) => setTimeout(r, 45_000));
const goalsAfter = readGoalsNow();
const runnerStatus = (
  services as unknown as { proactivityFabric?: { goalRunnerStatus: () => unknown } } | null
)?.proactivityFabric?.goalRunnerStatus();

// 给后台一点时间落盘
await new Promise((r) => setTimeout(r, 1_500));

const goals = goalsAfter;
const myGoals = goals.filter(
  (g) => String((g as Record<string, unknown>).actorId ?? "") === ACTOR || !(g as Record<string, unknown>).actorId,
);

const sessionPlans: Array<{ file: string; json: unknown }> = [];
try {
  const dir = join(dataDir, "session-plans");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) sessionPlans.push({ file: f, json: readJsonSafe(join(dir, f)) });
    }
  }
} catch {
  /* ignore */
}

async function getJson(path: string): Promise<unknown> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
    return await r.json();
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}
const view = await getJson(`/api/proactivity/goals/view?actorId=${encodeURIComponent(ACTOR)}`);
const cost = await getJson(`/api/proactivity/goals/cost?actorId=${encodeURIComponent(ACTOR)}`);

ws.close();

// ── 报告 ────────────────────────────────────────────────────────────────
const sep = "═".repeat(60);
console.log(`\n${sep}\n目标拆解 live E2E 结果（actor=${ACTOR}）\n${sep}`);

console.log("\n──── 每轮对话 ────");
turnResults.forEach((t, i) => {
  console.log(`\n【第 ${i + 1} 轮】用户: ${t.user}`);
  console.log(`工具: ${t.tools.join(", ") || "（无）"}`);
  console.log(`正文(${t.finalText.length}字):\n${t.finalText.slice(0, 1200) || "(空)"}`);
});

console.log("\n──── 全轮工具调用（去重）────");
const uniqTools = [...new Set(seenTools.map((t) => t.name))];
console.log(uniqTools.join(", ") || "（无）");
console.log("\n──── 拆解/推进类工具是否被真实调用 ────");
for (const key of ["goal.plan.create", "goal.plan.list", "goal.plan.advance", "goal.plan.replan", "plan.write", "plan.read", "travel.plan-itinerary", "travel.search-poi"]) {
  console.log(`  ${seenTools.some((t) => t.name === key) ? "✔" : "✘"} ${key}`);
}

console.log("\n──── 拆解类工具的真实入参（LLM 到底写了什么步骤）────");
const decomposeCalls = seenTools.filter((t) => /^(goal\.plan\.|plan\.|travel_booking\.)/.test(t.name));
if (decomposeCalls.length === 0) console.log("（无）");
for (const c of decomposeCalls) console.log(`  ${c.name} ${c.args.slice(0, 800)}`);

console.log("\n──── tool.result 帧（工具真实回执）────");
if (toolResults.length === 0) console.log("（无）");
for (const r of toolResults) {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  console.log(`  ${String(p.toolName ?? "")}: ${JSON.stringify(p.result ?? p).slice(0, 600)}`);
}

console.log("\n──── plan_step 帧 ────");
if (planSteps.length === 0) console.log("（无）— 前端步骤条没有收到任何步骤");
else for (const s of planSteps) console.log(JSON.stringify(s).slice(0, 400));

console.log("\n──── Goal 自驱推进观察（GoalRunner tick=30s，等 45s 后再读台账）────");
console.log(`runner.status(): ${JSON.stringify(runnerStatus)}`);
console.log(`推进前:\n${stepsSig(goalsBefore) || "（无）"}`);
console.log(`推进后:\n${stepsSig(goalsAfter) || "（无）"}`);

console.log(`\n──── goals.json（真实路径 ${goalsPath}，kind=plan 的目标）────`);
const planGoals = myGoals.filter((g) => String(g.kind ?? g.type ?? "") === "plan");
if (planGoals.length === 0) console.log(`（无）—— goals.json 共 ${goals.length} 条，未落任何 plan 目标`);
for (const g of planGoals) {
  const payload = (g.payload ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(payload.steps) ? (payload.steps as Array<Record<string, unknown>>) : [];
  console.log(`\n目标: ${g.title}  [status=${g.status}${g.verdict ? ` verdict=${g.verdict}` : ""}]`);
  console.log(`  达成判据: ${g.successCriteria ?? "（无）"}`);
  console.log(`  步骤模板: ${payload.templateId ?? "（模型自己拆）"}  偏好: ${payload.preferences ?? "（无）"}`);
  steps.forEach((s, i) => console.log(`   ${i + 1}. [${s.status}] ${s.title}${s.note ? ` — ${s.note}` : ""}${s.sensitivity ? ` <${s.sensitivity}>` : ""}`));
}

console.log("\n──── session-plans（TaskPlan）────");
if (sessionPlans.length === 0) console.log("（无）");
for (const sp of sessionPlans) {
  const p = sp.json as { goal?: string; steps?: Array<Record<string, unknown>>; sessionId?: string } | null;
  console.log(`\n文件: ${sp.file}（sessionId=${p?.sessionId ?? "?"}）`);
  console.log(`  计划: ${p?.goal ?? "（无）"}`);
  (p?.steps ?? []).forEach((s, i) => console.log(`   ${i + 1}. [${s.status}] ${s.title}`));
}

console.log("\n──── GET /api/proactivity/goals/view ────");
console.log(JSON.stringify(view).slice(0, 1500));
console.log("\n──── GET /api/proactivity/goals/cost ────");
console.log(JSON.stringify(cost).slice(0, 1200));

console.log("\n──── 其他收到的帧 ────");
console.log([...otherFrames.entries()].map(([k, v]) => `${k}×${v}`).join(", ") || "（无）");

// ── 判定 ────────────────────────────────────────────────────────────────
const decomposed =
  planGoals.length > 0 ||
  sessionPlans.length > 0 ||
  seenTools.some((t) => ["goal.plan.create", "plan.write", "goal.plan.replan"].includes(t.name));
const travelToolUsed = seenTools.some((t) => t.name.startsWith("travel"));
const stepsText = JSON.stringify(planGoals.map((g) => (g.payload as Record<string, unknown>)?.steps ?? [])) + JSON.stringify(sessionPlans);
const mentionsBooking = /机票|订票|航班|交通|酒店|住宿/.test(stepsText);

console.log(`\n${sep}\n结论\n${sep}`);
console.log(`① 发生拆解（有 goal/plan 台账或对应工具调用）: ${decomposed ? "是" : "否"}`);
console.log(`② 拆解产物含「订票/酒店」类步骤: ${mentionsBooking ? "是" : "否（或拆解未落到台账）"}`);
console.log(`③ 本轮用到 travel 域工具: ${travelToolUsed ? "是" : "否"}`);
const autoAdvanced = stepsSig(goalsBefore) !== stepsSig(goalsAfter);
console.log(`④ Goal 后台自驱推进（tick=30s 窗口内步骤状态发生变化）: ${autoAdvanced ? "是" : "否"}`);

const failures = ["①", "②", "③"].filter((k, i) => [decomposed, mentionsBooking, travelToolUsed][i] === false);
if (failures.length === 0) console.log("✔ 三项证据齐备");
else console.log(`✘ 缺项: ${failures.join(" / ")}`);

if (services) {
  try {
    await services.app.close();
  } catch {
    /* ignore */
  }
}
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  log(`沙箱保留（清理被占用）: ${sandbox}`);
}
process.exit(failures.length === 0 ? 0 : 1);
