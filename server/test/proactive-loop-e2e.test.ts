// 端到端（接缝 1→2→3）：外部信源 → 统一库合并 → 共享上下文 → pulse 开口 → 提案分档。
// 只用真实适配器与真实服务，只有 LLM 与投递出口是桩。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentPulseService } from "../src/proactivity/agent-pulse.js";
import { buildSharedContext, presenceText } from "../src/proactivity/context-snapshot.js";
import { intelTierFor } from "../src/proactivity/intel/intel-tier.js";
import { IcsSensor } from "../src/proactivity/sensors/ics-sensor.js";
import { MailSensor } from "../src/proactivity/sensors/mail-sensor.js";
import { SourceStore } from "../src/proactivity/source-store.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const T0 = Date.UTC(2026, 10, 25, 2, 0, 0);
const FLIGHT_AT = Date.UTC(2026, 11, 30, 1, 0, 0);

test("e2e：机票邮件 + 日历行程 → 一条事件；pulse 带着同一份上下文开口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-loop-e2e-"));
  try {
    const store = new SourceStore({ dataPath: dir, nowFn: () => T0, disablePersist: true, env: {} });

    // ① 真实适配器产出信号（只有 IMAP/ICS 读口是桩）
    const mail = new MailSensor({
      fetchNewSince: () => [
        {
          uid: 9001,
          importance: "high",
          mail: {
            actorId: "u1",
            from: "携程 <trip@ctrip.com>",
            subject: "机票行程确认 CA1234 12月30日 北京-三亚",
            date: new Date(T0).toISOString(),
            textSnippet: "12月30日 CA1234 北京-三亚，值机请提前 2 小时",
          },
        },
      ],
    });
    const ics = new IcsSensor({
      fetchEventsSince: () => [
        {
          actorId: "u1",
          feed: "work-cal",
          key: "evt-42",
          summary: "CA1234 北京-三亚",
          location: "首都机场 T3",
          startMs: FLIGHT_AT,
          allDay: false,
        },
      ],
    });
    store.feedAll(mail.collect(0));
    store.feedAll(ics.collect(0));

    // ② 跨源汇聚：一件事只存一条，来源都在 refs 里
    const stats = store.stats();
    assert.equal(stats.windowSize, 1, "邮件与日历是同一件事，不能各存一条");
    assert.equal(stats.eventMerge.merged, 1);
    const [event] = store.findByEventKey("flight:CA1234:2026-12-30");
    assert.ok(event, "航班事件键应能命中主事件");
    assert.deepEqual(event.payload?.sources, ["mail", "schedule"]);
    assert.equal(store.findByEntity("三亚").length >= 1, true, "跨源实体检索仍命中同一事件");

    // ③ 共享上下文：pulse 与情报判断读同一份（接话锚点真的存在）
    const ctx = buildSharedContext({
      actorId: "u1",
      at: T0,
      presence: { state: "active", since: T0 - 5 * 60_000 },
      place: { kind: "work", label: "公司", updatedMinutesAgo: 4 },
      idleMinutes: 400,
      openLoops: ["还没聊到：下午面试"],
      interests: ["网球"],
      findings: ["mail：机票行程确认 CA1234"],
      recentTurns: ["我明天有个面试"],
    });
    assert.equal(presenceText(ctx), "active（已持续 5 分钟）");
    assert.equal(ctx.version.length > 0, true);

    // ④ pulse：真实评审链路（LLM/投递为桩），提案必须带上下文版号且走 social
    let submitted: ProactiveProposal | null = null;
    let seenPrompt = "";
    const pulse = new AgentPulseService({
      actors: () => ["u1"],
      aggregate: () => ({
        tasks: [],
        unread: [],
        goals: [],
        interests: ctx.interests,
        findings: ctx.findings,
        openLoops: ctx.openLoops,
        presence: presenceText(ctx),
        recentTurns: ctx.recentTurns,
        idleMinutes: ctx.idleMinutes,
        activity: ctx.activity,
        mood: ctx.mood,
        contextVersion: ctx.version,
      }),
      llmComplete: async (prompt) => {
        seenPrompt = prompt;
        return '{"speak":true,"text":"下午面试加油，结果出来想聊随时说。","options":[]}';
      },
      submitProposal: (p) => {
        submitted = p as unknown as ProactiveProposal;
        return { verdict: "delivered" };
      },
      nowFn: () => T0,
    });
    const result = await pulse.check({ actorId: "u1", force: true });
    assert.equal(result.reason, "sent");
    assert.ok(seenPrompt.includes("还没聊到：下午面试"), "接话素材必须真的进 prompt");
    assert.ok(seenPrompt.includes("【用户关注的话题】网球"));
    assert.ok(submitted, "应当产生一条提案");
    const proposal = submitted as unknown as {
      tier: string;
      evidence: string[];
      directText: string;
    };
    assert.equal(proposal.tier, "social", "普通社交开口不抢 must 通道");
    assert.ok(proposal.evidence.includes(`ctx=${ctx.version}`), "提案要能归因到上下文版本");
    assert.ok(proposal.directText.includes("面试"));

    // ⑤ 情报投递分档：同一件事如果来自情报链，也不该无条件 must
    assert.equal(intelTierFor({ judgment: { verdict: "now", reason: "" } }, T0, {}).tier, "social");
    assert.equal(
      intelTierFor({ judgment: { verdict: "now", reason: "", needsConfirm: true } }, T0, {}).tier,
      "must",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
