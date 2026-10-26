/**
 * 主动性优化七件套真链探针（2026-10-01）。
 *
 * 腿1 兴趣语义匹配：真实本地 ONNX bge-small-zh 引擎 + InterestWatcher 兜底路径
 *      （「苹果手机」×「iPhone 17 发布」应高相似命中；无关标题应低于阈值不推）。
 * 腿2 顺嘴 medium 过期升级：真实 TurnAsideQueue + 升级回调重投断言。
 * 腿3 按时段接受率 × 话题 dismiss：真实 OutcomeStore + TopicDismissTracker +
 *      真实 ProactivePipeline（临时目录）端到端——3 次同话题 dismiss 后
 *      mute_suggest 提案应真实投递。
 * 腿4 goal 轻步骤判定 + goal 车道预算装配断言（bootstrap 源码级检查）。
 * 腿5 润色重要性闸：真实 SpeechHub 装配（无 provider）下 low 直落模板。
 *
 * 用法：cd server && npx tsx scripts/probe-proactivity-optimizations.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { initLocalEmbeddingEngine } from "../src/agentic-memory/local-embedding/local-embedding-engine.js";
import { InterestWatcher, type InterestHit } from "../src/proactivity/interest-watcher.js";
import { TurnAsideQueue } from "../src/proactivity/turn-aside-queue.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { TopicDismissTracker } from "../src/proactivity/topic-dismiss-tracker.js";
import { SpeechHub } from "../src/proactivity/speech-express.js";
import { isLightStep } from "../src/proactivity/goal-planner.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { PresenceService } from "../src/proactivity/presence-service.js";

const results: Array<{ leg: string; pass: boolean; detail: string }> = [];
function report(leg: string, pass: boolean, detail: string): void {
  results.push({ leg, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${leg}] ${detail}`);
}

async function leg1SemanticInterest(): Promise<void> {
  const engine = await initLocalEmbeddingEngine();
  if (!engine) {
    report("腿1 语义兴趣", false, "本地 ONNX 引擎不可用（models/bge-small-zh-v1.5 缺失？）");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "probe-interest-"));
  try {
    const hits: InterestHit[] = [
      { title: "iPhone 17 全系发布：灵动岛交互升级", platform: "微博", hot: "爆" },
      { title: "某地迎来大范围降雨降温", platform: "百度" },
    ];
    let pushed = "";
    const watcher = new InterestWatcher({
      fetchHot: async () => hits,
      embed: async (texts) => engine.embed(texts),
      persistPath: join(dir, "interest.json"),
      onHit: (_actor, interest, hit) => {
        pushed = `${interest.name}→${hit.title}`;
      },
    });
    await watcher.addInterest("probe_user", "苹果手机", "brand");
    const n = await watcher.checkAll();
    report(
      "腿1 语义兴趣",
      n === 1 && pushed.includes("iPhone 17"),
      n === 1 ? `真实 bge 向量命中换说法热点：${pushed}` : `未命中（n=${n}）`,
    );
    // 反例：无关兴趣不应命中（阈值闸）
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    report("腿1 语义兴趣", false, `异常：${err}`);
  }
}

function leg2TurnAsideExpiry(): void {
  let now = Date.now();
  const escalated: string[] = [];
  const q = new TurnAsideQueue({ nowFn: () => now });
  q.setOnExpire((item) => escalated.push(`${item.importance}:${item.kind}`));
  const okMed = q.tryEnqueue({ actorId: "u1", kind: "interest_alert", title: "中优挂起", importance: "medium" });
  const okLow = q.tryEnqueue({ actorId: "u1", kind: "care", title: "低优挂起", importance: "low" });
  now += 6 * 60 * 60_000 + 60_000; // 越过 6h TTL
  q.prune();
  report(
    "腿2 搭车过期升级",
    okMed && okLow && escalated.length === 1 && escalated[0] === "medium:interest_alert",
    `medium 过期升级回调触发、low 静默作废（escalated=${JSON.stringify(escalated)}）`,
  );
}

async function leg3HourlyAndTopicDismiss(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "probe-pipeline-"));
  try {
    const outcomes = new OutcomeStore(join(dir, "outcomes.json"));
    const presence = new PresenceService();
    // 5 分钟前连接：active 但不在 90s 对话窗内（60s 会被判「对话中」→ social 提案 defer 90s）
    presence.markConnected("probe_user", Date.now() - 5 * 60_000);
    const governor = new FrequencyGovernor();
    const delivered: string[] = [];
    const topicDismiss = new TopicDismissTracker({ dataPath: dir });
    const pipeline = new ProactivePipeline({
      dataPath: dir,
      governor,
      suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
      presence,
      delivery: new ProactiveDeliveryService({
        trySend: (_actorId, json) => {
          delivered.push(json);
          return true;
        },
      }),
      outcomes,
      topicDismiss,
    });

    // 投递 3 条同话题提案并全部 dismissed
    for (let i = 0; i < 3; i++) {
      const d = pipeline.submitProposal({
        proposalId: `p${i}`,
        actorId: "probe_user",
        kind: "action.schedule_change",
        tier: "must",
        importance: "high",
        dedupKey: `probe:${i}`,
        title: "发现日程变动",
        summary: "项目经理：评审会议改期",
        evidence: [],
        directText: `第${i + 1}条：评审会议改期`,
        createdAt: Date.now(),
        source: "message_watch",
        detail: { 发件人: "项目经理", 原文: "评审会议改到周四" },
      });
      if (d.verdict !== "delivered") throw new Error(`提案${i}未投递: ${d.verdict}`);
      const row = outcomes.recent(1)[0]!;
      pipeline.recordOutcome(row.deliveryId, "dismissed");
    }
    await new Promise((r) => setImmediate(r));
    const muteSent = delivered.some((j) => j.includes("mute_suggest"));
    const topicRecorded = outcomes.recent(5).some((r) => r.topic === "发件人:项目经理");
    report(
      "腿3 话题dismiss→静音建议",
      muteSent && topicRecorded,
      `话题键随投递落库 + 连续3次dismiss后 mute_suggest 真实投递（delivered=${delivered.length}）`,
    );

    // 按小时画像
    const byHour = outcomes.hourlyReceptivity("probe_user");
    const hour = new Date().getHours();
    const stat = byHour.get(hour);
    report(
      "腿3 按时段接受率",
      stat !== undefined && stat.samples === 3 && stat.rate < 0.5,
      `当前时段 3 条全 dismiss → rate=${stat?.rate.toFixed(2)}（Laplace 平滑后应显著低于 0.5）`,
    );
    pipeline.persist();
  } catch (err) {
    report("腿3 话题dismiss→静音建议", false, `异常：${err}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function leg4GoalLane(): void {
  const light = isLightStep("总结一下目前的进展") && !isLightStep("查一下机票价格");
  const src = readFileSync(join(process.cwd(), "src", "bootstrap", "create-app-services.ts"), "utf8");
  const hasBudget = src.includes("PROACTIVITY_GOAL_DAILY_BUDGET");
  const hasAudit = src.includes('auditStage: "goal_plan_stage"');
  report(
    "腿4 goal车道治理",
    light && hasBudget && hasAudit,
    `轻步骤判定=${light}；日预算闸=${hasBudget}；token归因单列=${hasAudit}`,
  );
}

async function leg5PhraseGate(): Promise<void> {
  let providerCalls = 0;
  const chat = {
    isEnabled: () => true,
    streamCompletion: async () => {
      providerCalls += 1;
      throw new Error("low 档不应到达 provider");
    },
  };
  const hub = new SpeechHub({ chat: () => chat as never, dataPath: tmpdir() });
  const out = await hub.speak({
    kind: "unread_burst",
    sessionId: "probe",
    facts: {},
    fallback: "模板话术",
    tier: "light",
    importance: "low",
  });
  report(
    "腿5 润色重要性闸",
    out === "模板话术" && providerCalls === 0 && hub.stats().lastFallback === "low_importance(low)",
    `low 档直接模板零调用（providerCalls=${providerCalls}，lastFallback=${hub.stats().lastFallback}）`,
  );
}

async function main(): Promise<void> {
  console.log("=== 主动性优化七件套真链探针 ===");
  await leg1SemanticInterest();
  leg2TurnAsideExpiry();
  await leg3HourlyAndTopicDismiss();
  leg4GoalLane();
  await leg5PhraseGate();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 探针结果：${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length > 0) process.exit(1);
}

void main();
