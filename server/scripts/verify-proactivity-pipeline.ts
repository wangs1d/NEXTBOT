// 统一主动性管道端到端验证（自包含模拟，不依赖 LLM / 外部服务）。
// 运行：npx tsx scripts/verify-proactivity-pipeline.ts
// 投递模型：全部在线设备 fan-out 直推（电脑端+手机端），不落离线信箱——
// 两端离线提案挂起，任一设备重连立即直推；高重要度带 display=popup（客户端保证弹窗展示）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { UpcomingScheduleWatcher } from "../src/proactivity/upcoming-schedule-watcher.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import type { ScheduleTaskRecord } from "../src/services/schedule-task-service.js";

const NOON = new Date(2026, 7, 30, 12, 0, 0).getTime();
let clock = NOON;
const results: Array<{ scenario: string; verdict: string; chain: string; ok: boolean }> = [];

const dir = mkdtempSync(join(tmpdir(), "verify-proactive-"));
const presence = new PresenceService();
const governor = new FrequencyGovernor({ ignoreEnv: true, });
const delivered: string[] = [];
const spoken: string[] = [];
const pushes: Array<{ actorId: string; title: string; body: string }> = [];
const pushFlags = { enabled: false };
// 模拟设备连接状态：电脑端/手机端在线集合（断开 = 从集合移除）
const onlineDevices = new Set<string>(["desktop"]);
const pipeline = new ProactivePipeline({
  dataPath: dir,
  governor,
  suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
  presence,
  delivery: new ProactiveDeliveryService({
    trySend: (actorId, json) => {
      if (!onlineDevices.has("desktop") && !onlineDevices.has("mobile")) return false;
      delivered.push(`${onlineDevices.has("desktop") ? "desktop+" : ""}${onlineDevices.has("mobile") ? "mobile+" : ""}${json}`);
      return true;
    },
  }),
  outcomes: new OutcomeStore(join(dir, "outcomes.json")),
  speak: (p) => spoken.push(p.title),
  nowFn: () => clock,
  // 移动端推送通道（离线必达升级）：token 已注册时，两端离线的必达提醒走系统推送
  mobilePush: {
    hasChannel: () => pushFlags.enabled,
    push: async (input) => {
      pushes.push({ actorId: input.actorId, title: input.title, body: input.body });
      return { ok: true, provider: "stub" };
    },
  },
});
pipeline.start();

function expect(scenario: string, verdict: string, chain: string, ok: boolean): void {
  results.push({ scenario, verdict, chain, ok });
}

// 场景 1：临近日程感知 → 在线直投（零 LLM，弹窗保证）
const watcher = new UpcomingScheduleWatcher({
  listTasks: () => [
    {
      taskId: "t-meeting",
      sessionId: "user-a",
      title: "产品评审会",
      description: "季度路线图评审",
      kind: "reminder",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      runAt: new Date(NOON + 14 * 60_000).toISOString(),
      nextRunAt: new Date(NOON + 14 * 60_000).toISOString(),
      status: "active",
      createdAt: new Date(NOON).toISOString(),
      updatedAt: new Date(NOON).toISOString(),
    } as ScheduleTaskRecord,
  ],
  submit: (p: ProactiveProposal) => {
    pipeline.submitProposal(p);
  },
  leadMs: 15 * 60_000,
});
presence.markConnected("user-a", NOON - 5 * 60_000);
watcher.scan(NOON);
const firstPayload = JSON.parse(delivered[0]!.split("+").slice(-1)[0]!);
expect(
  "临近日程(在线) 提前14min 提案",
  "delivered",
  "tier=must→deliver_now（WS 直投零 LLM，display=popup）",
  delivered.length === 1 && firstPayload.payload.display === "popup",
);

// 场景 2：同一会议重复扫描（模拟 watcher 重启重扫）→ 合并
watcher.scan(NOON);
expect("同会议重复扫描", "merged", "dedup:schedule_upcoming:t-meeting:*（已投递指纹 24h 防重）", delivered.length === 1);

// 场景 3：两端都掉线 → 到点提醒挂起（不落离线信箱）
onlineDevices.clear();
presence.markDisconnected("user-a");
clock = NOON + 20 * 60_000;
pipeline.submitProposal({
  proposalId: "p-off", actorId: "user-a", kind: "schedule_reminder", tier: "must", importance: "high",
  dedupKey: "schedule_reminder:t-standup", title: "每日站会", summary: "10 分钟后每日站会",
  evidence: ["ws_push_failed"], directText: "该开每日站会了", createdAt: clock, source: "schedule",
});
expect(
  "到点提醒(两端离线) 挂起",
  "deferred",
  "offline_wait_reconnect（信箱已移除，提案保留待发区）",
  pipeline.diagnostics().pending.length === 1 && delivered.length === 1,
);

// 场景 3b：手机端 token 已注册 → 必达提醒自动升级系统推送（App 被杀也能收到）
pushFlags.enabled = true;
pipeline.submitProposal({
  proposalId: "p-off2", actorId: "user-a", kind: "schedule_reminder", tier: "must", importance: "high",
  dedupKey: "schedule_reminder:t-review", title: "产品评审", summary: "15 分钟后产品评审",
  evidence: ["ws_push_failed"], directText: "该去产品评审了", createdAt: clock, source: "schedule",
});
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
expect(
  "两端离线+推送已注册 → 升级系统推送",
  "pushed",
  "must 层离线自动升级 mobile_push（出队防重，重连后不重复投递）",
  pushes.length === 1 && pushes[0]!.title === "产品评审" && pipeline.diagnostics().pending.length === 1,
);

// 场景 4：手机端重连 → 挂起的那条立即直推（must 层对话中也不延迟）
onlineDevices.add("mobile");
presence.markConnected("user-a", clock - 30_000);
pipeline.flushDue(clock);
const replayPayload = delivered.length > 1 ? JSON.parse(delivered[1]!.split("+").slice(-1)[0]!) : null;
expect(
  "手机端重连→直推弹窗",
  "delivered",
  "重连 flush 立即直推（display=popup，弹窗保证）",
  delivered.length === 2 && replayPayload?.payload?.display === "popup",
);

// 场景 5：对话中不打断 → 90s 后自动投递
pipeline.submitProposal({
  proposalId: "p-conv", actorId: "user-a", kind: "interest_alert", tier: "social", importance: "medium",
  dedupKey: "interest:刘浩存", title: "兴趣动态", summary: "你关注的刘浩存上了热搜",
  evidence: ["hot_search"], directText: "你关注的刘浩存上热搜了", createdAt: clock, interruptible: false, source: "interest_watch",
});
expect("对话中不打断", "deferred", "in_conversation_defer_90s（等本轮对话结束）", pipeline.diagnostics().pending.length === 1);
clock = NOON + 20 * 60_000 + 91_000;
pipeline.flushDue(clock);
expect("对话结束后补投", "delivered", "flush 重仲裁→deliver_now", delivered.length === 3);

// 场景 6：outcome 反馈 → 自适应冷却（连续忽略 → interest_alert 冷却上升）
const before = governor.snapshot().cooldowns.interest_alert ?? 0;
const ids = pipeline.diagnostics().recentOutcomes.map((o) => o.deliveryId);
for (let i = 0; i < 5; i++) {
  pipeline.recordOutcome(ids[ids.length - 1]!, i === 4 ? "accepted" : "ignored");
}
const after = governor.snapshot().cooldowns.interest_alert ?? 0;
expect("连续忽略→冷却上升", `4h→${Math.round(after / 60000)}m`, "outcome 回灌 noteOutcome", after > before);

pipeline.stop();
rmSync(dir, { recursive: true, force: true });

console.log("\n═══ 统一主动性管道 端到端验证 ═══\n");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✔" : "✖"} ${r.scenario}`);
  console.log(`   verdict=${r.verdict}  ${r.chain}`);
}
console.log(`\n${results.length - failed}/${results.length} 场景通过`);
if (failed > 0) process.exit(1);
