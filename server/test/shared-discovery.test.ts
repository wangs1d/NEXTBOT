/**
 * 共享发现层（DiscoveryLayer + SourceStore.finding，2026-10-19）契约测试。
 *
 * 锁住的是架构级行为，而不是某条规则的数值：
 *   - 一条总线：finding 落进 SourceStore（不新建存储），幂等、保期、可跨源检索
 *   - 一个共同键：subject 让三源（GoalRunner / 夜间内省 / 感知规则桥）互相读到
 *   - 一个单开口闸：composeBeforeOpen 合并他人未消费发现 + 实体联系，并在读走即消费
 *   - 重复不再各说一遍：窗口内二次开口降一档（needsUser 不降）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SourceStore } = await import("../src/proactivity/source-store.js");
const { DiscoveryLayer, primarySubjectOf } = await import("../src/proactivity/discovery-layer.js");
const { ProactivePipeline } = await import("../src/proactivity/proactive-pipeline.js");
const { FrequencyGovernor } = await import("../src/proactivity/frequency-governor.js");
const { ProactiveDeliveryService } = await import("../src/proactivity/delivery-service.js");
const { OutcomeStore } = await import("../src/proactivity/outcome-store.js");
const { PresenceService } = await import("../src/proactivity/presence-service.js");

/** 造一个不落盘的共享总线（disablePersist）+ 发现层；时钟可控 */
function makeLayer(nowFn: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "pa-discovery-"));
  const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn, env: {} });
  const discovery = new DiscoveryLayer({ store, nowFn });
  return { store, discovery };
}

test("finding 落进同一条总线：幂等、未消费可读、读走即消费", () => {
  const now = () => 1_700_000_000_000;
  const { store, discovery } = makeLayer(now);
  const subject = "g_搬家";

  assert.equal(discovery.write({ subject, source: "goal_runner", content: "计划「搬家」卡在第 3 步等确认" }), true);
  assert.equal(discovery.write({ subject, source: "goal_runner", content: "计划「搬家」卡在第 3 步等确认" }), false, "同内容重复登记被幂等吞掉");

  const pending = discovery.findingsFor(subject);
  assert.equal(pending.length, 1, "未消费的发现可读");
  assert.equal(store.stats().findings.pending, 1, "诊断台账同步反映待开口条数");

  store.consumeFindings(pending.map((f) => f.fingerprint), now());
  assert.equal(discovery.findingsFor(subject).length, 0, "读走后不再返回（同一发现不会被两个出口各说一遍）");
});

test("一个共同键：GoalRunner 的发现会被夜间内省的开口合并带走（不是各说一遍）", () => {
  const now = () => 1_700_000_000_000;
  const { store, discovery } = makeLayer(now);
  const subject = "g_搬家";

  // 源 1：GoalRunner 先登记发现（尚未开口）
  discovery.write({ subject, source: "hub:goal", content: "计划「搬家」卡在第 3 步「预约搬家公司」，等你点确认" });

  // 源 2：夜间内省开口——合成时把源 1 的发现一并带走
  const composed = discovery.composeBeforeOpen({
    subject,
    ownSource: "hub:goal_introspect",
    body: "在办目标「搬家」还作数吗？",
    importance: "medium",
    needsUser: true,
  });
  assert.equal(composed.merged.length, 1);
  assert.match(composed.body, /计划「搬家」卡在第 3 步/);
  assert.equal(composed.pendingFingerprints.length, 1, "读到 1 条他人发现");

  // 没说出口（被频控/静默挡下）→ 发现不消费：留给下一个出口，信息不蒸发
  discovery.noteSpoken(composed.pendingFingerprints, "suppressed");
  assert.equal(discovery.findingsFor(subject).length, 1, "被抑制的开口不吞掉发现");
  // 说出口了 → 消费
  discovery.noteSpoken(composed.pendingFingerprints, "delivered");

  // 源 3：再来一个源开口——已无未消费发现，只剩重复降档
  const third = discovery.composeBeforeOpen({
    subject,
    ownSource: "sensor_bridge",
    body: "看见你连续工作 3 小时（顺便：你还在推进「搬家」）",
    importance: "medium",
  });
  assert.equal(third.merged.length, 0, "同一条发现不会第三次出现");
  assert.equal(third.repeat, true, "窗口内二次开口判为重复");
  assert.equal(third.importance, "low", "重复 + 非 needsUser → 降一档");
  assert.equal(store.stats().findings.pending, 0, "原有发现已被消费（未新增他人发现）");
});

test("重复降档：needsUser 的开口不降（用户是阻塞点，价值不由刚不刚说过决定）", () => {
  const now = () => 1_700_000_000_000;
  const { discovery } = makeLayer(now);
  const subject = "g_搬家";
  discovery.composeBeforeOpen({ subject, body: "第一次提醒", importance: "high" });
  const second = discovery.composeBeforeOpen({ subject, body: "请用户拍板", importance: "high", needsUser: true });
  assert.equal(second.repeat, true);
  assert.equal(second.importance, "high", "needsUser 不参与降档");
});

test("实体联系由倒排自然产生：别的来源提到同一实体时被带进正文", () => {
  const now = () => 1_700_000_000_000;
  const { store, discovery } = makeLayer(now);
  // 邮件源的原始信号（不是 finding）：真实跨源资料
  store.feed({
    stream: "mail",
    actorId: "u1",
    at: now(),
    fingerprint: "mail:1",
    salience: "medium",
    delta: "房东邮件提到搬家要提前一周预约电梯",
  });
  const composed = discovery.composeBeforeOpen({
    subject: "g_搬家",
    body: "计划「搬家」下一步是预约搬家公司",
    importance: "medium",
  });
  assert.equal(composed.linked.length >= 1, true, "命中「搬家」的邮件被联系上");
  assert.match(composed.body, /邮件提到/);
});

test("时效：过期发现不再被读走（发现是「当下值得一提」，不是账本）", () => {
  let t = 1_700_000_000_000;
  const { discovery } = makeLayer(() => t);
  discovery.write({ subject: "s", source: "x", content: "旧发现", ttlMs: 1000 });
  assert.equal(discovery.findingsFor("s").length, 1);
  t += 2000;
  assert.equal(discovery.findingsFor("s").length, 0, "过 TTL 的发现不再参与合并开口");
});

test("主体词推断（零 LLM）：给不出共同键时不硬绑", () => {
  assert.equal(primarySubjectOf("邮件提到三亚合同 review"), "三亚", "剥前缀噪声 + 优先双字实体");
  assert.equal(primarySubjectOf("要不要"), null, "全是停用词 → 无共同键（宁缺勿滥）");
  assert.equal(primarySubjectOf("房东邮件提到搬家要提前一周预约电梯"), null, "剥不干净的长句式碎片 → 弃用，退回实体联系");
});

// ─── 旁路生产者走共享层（2026-10-19 通用化回归）───
// 以前 messageWatch / commitmentTrigger / 到点提醒 / 早报 等直接调 submitProposal，
// 绕过共享层；现在"发现登记 + 开口前读合成 + 按 verdict 消费"下沉到管道这一个入口
// （所有触发源的共同底）。这条用例锁住：旁路提案的发现被登记，且能与其他源的发现
// 交叉合并成同一条开口——不再需要给每个生产者各自打补丁。

test("旁路生产者（直接 submitProposal）也走共享层：跨源发现被合并进同一条开口", () => {
  const now = () => 1_700_000_100_000;
  const dir = mkdtempSync(join(tmpdir(), "pa-discovery-pipe-"));
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn: now, env: {} });
    const discovery = new DiscoveryLayer({ store, nowFn: now });
    const presence = new PresenceService();
    presence.markConnected("u1", now() - 5 * 60_000); // 在线（active 但非对话中 → social 提案可直投）
    const delivered: Array<{ actorId: string; json: string }> = [];
    const pipeline = new ProactivePipeline({
      dataPath: dir,
      governor: new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true }),
      suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
      presence,
      delivery: new ProactiveDeliveryService({
        trySend: (actorId, json) => {
          delivered.push({ actorId, json });
          return true;
        },
      }),
      outcomes: new OutcomeStore(join(dir, "outcomes.json")),
      nowFn: now,
      discovery,
    });

    // 源 1（对应 GoalRunner，经 hub → 直达车道）先登记一条未消费发现，尚未开口
    discovery.write({
      subject: "g_搬家",
      actorId: "u1",
      source: "hub:goal",
      content: "计划「搬家」卡在第 3 步「预约搬家公司」，等你点确认",
    });

    // 源 2（旁路：直接 submitProposal，如承诺板/消息监控）就同一目标开口
    const decision = pipeline.submitProposal({
      proposalId: "p_bypass",
      actorId: "u1",
      kind: "life_reminder",
      tier: "social",
      importance: "medium",
      dedupKey: "bypass:commitment:1",
      title: "搬家进度",
      summary: "搬家这事有新动静",
      directText: "搬家这事有新动静",
      evidence: ["commitment-board"],
      createdAt: now(),
      source: "commitment-board",
      subject: "g_搬家",
    });

    assert.equal(decision.verdict, "delivered");
    const payload = JSON.parse(delivered[0].json);
    assert.match(
      payload.payload.text,
      /计划「搬家」卡在第 3 步/,
      "旁路提案把源 1 的发现合并进了同一条开口（共享层收口生效）",
    );
    assert.equal(store.stats().findings.pending, 0, "说出口后未消费发现被消费");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 消费解耦：预留 ≠ 消费（2026-10-19 二期）───
// 旧版把 "deferred" 也算消费，于是挂起的提案若后续被静默清理/僵尸丢弃，
// 它读走的他人发现已被吞掉 = 信息蒸发（正是修 merged 想堵的洞，在 deferred 上又裂一道）。
// 现在开口瞬间只**预留**（第二个出口读不到，杜绝各说一遍），结算拆三态：
// delivered=消费 / deferred=维持预留 / 丢弃=释放回总线。

test("消费解耦：开口即预留；deferred 不消费；丢弃释放、投递才消费", () => {
  const now = () => 1_700_000_200_000;
  const { store, discovery } = makeLayer(now);
  const subject = "g_搬家";
  discovery.write({ subject, source: "goal_runner", content: "计划「搬家」卡在第 3 步" });

  const composed = discovery.composeBeforeOpen({ subject, ownSource: "hub:goal", body: "搬家提醒", importance: "medium" });
  assert.equal(composed.pendingFingerprints.length, 1);
  assert.equal(discovery.findingsFor(subject).length, 0, "开口瞬间即预留：第二个出口读不到（杜绝各说一遍）");

  // deferred：入队等时刻——既不消费也不释放（预留维持，等那次真的投出去）
  discovery.noteSpoken(composed.pendingFingerprints, "deferred");
  assert.equal(store.findingStats().consumed, 0, "deferred 不算说出，不消费");
  assert.equal(discovery.findingsFor(subject).length, 0, "deferred 期间仍预留（第二个出口仍读不到）");

  // 队列丢弃 → 释放回总线（旧版会在此吞掉发现=蒸发）
  discovery.settle(composed.pendingFingerprints, "dropped");
  assert.equal(discovery.findingsFor(subject).length, 1, "被丢弃的开口把发现释放回总线，信息不蒸发");

  // 真投递 → 消费
  assert.equal(discovery.settle(composed.pendingFingerprints, "delivered"), 1, "投递结算成消费");
  assert.equal(discovery.findingsFor(subject).length, 0);
});

test("管道结算：deferred 提案维持预留（不消费发现），等真投递才消费", () => {
  const now = () => 1_700_000_300_000;
  const dir = mkdtempSync(join(tmpdir(), "pa-discovery-defer-"));
  try {
    const store = new SourceStore({ dataPath: dir, disablePersist: true, nowFn: now, env: {} });
    const discovery = new DiscoveryLayer({ store, nowFn: now });
    const presence = new PresenceService(); // 未 markConnected → offline → 仲裁挂起
    const pipeline = new ProactivePipeline({
      dataPath: dir,
      governor: new FrequencyGovernor({ ignoreEnv: true, disableQuietHours: true }),
      suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
      presence,
      delivery: new ProactiveDeliveryService({ trySend: () => true }),
      outcomes: new OutcomeStore(join(dir, "outcomes.json")),
      nowFn: now,
      discovery,
    });

    discovery.write({ subject: "g_x", actorId: "u1", source: "goal_runner", content: "别处也提到 X" });
    const decision = pipeline.submitProposal({
      proposalId: "p_defer",
      actorId: "u1",
      kind: "life_reminder",
      tier: "social",
      importance: "medium",
      dedupKey: "defer:1",
      title: "X 进度",
      summary: "X 有动静",
      directText: "X 有动静",
      evidence: ["e"],
      createdAt: now(),
      source: "commitment-board",
      subject: "g_x",
    });

    assert.equal(decision.verdict, "deferred", "离线 → 挂起待重连");
    assert.equal(store.findingStats().consumed, 0, "deferred 不消费发现");
    assert.equal(store.findingStats().pending, 0, "被这次开口预留中（对别的出口不可见）");
    assert.ok(pipeline.diagnostics().pending.length >= 1, "提案仍在待发区（fingerprints 已随提案留存，等真投递结算）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
