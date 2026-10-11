import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { shouldRecallLongTerm } from "../src/agent/recall-gate.js";
import { parseUnderstanding } from "../src/agent/route-llm-call.js";
import type { TurnUnderstanding } from "../src/agent/task-router.js";
import { DailyJournalService } from "../src/services/daily-journal-service.js";
import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import { isNoiseLogLine } from "../src/services/nightly-memory-task-service.js";

// ===== recall-gate：触发条件由 L1 路由 understanding 驱动（词表判定退役）=====

/** 构造合法 TurnUnderstanding（缺省全 false = 无特殊处理） */
function u(partial: Partial<TurnUnderstanding> = {}): TurnUnderstanding {
  return {
    isFollowUp: false,
    reference: "none",
    recallIntent: false,
    memoryInstruction: false,
    personalFact: false,
    scheduleQuery: false,
    travelQuery: false,
    ...partial,
  };
}

test("understanding 缺省（路由失败/降级）→ 一律不触发（最小注入）", () => {
  // 词表判定退役：用户原文不再被正则扫描（旧版这里 "还记得/我叫/上次" 会命中
  // 各张词表）。文本是猜不准的——「你叫我什么？」因标点分支缺 ^ 锚被判成追问轮
  // 的教训；语义判定归模型，缺省方向 = 不触发（误注入=串台 > 漏注入=少点上下文）。
  assert.equal(shouldRecallLongTerm({ text: "还记得我上次说的那个项目吗" }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "我叫李雷，在杭州工作" }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "你叫我什么？" }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "在吗", threadMessageCount: 0 }).trigger, false);
});

test("memory_instruction / recall_intent / earlier_session 锚定 → memory_cue", () => {
  const memoryCue = shouldRecallLongTerm({
    text: "记住我不吃香菜",
    understanding: u({ memoryInstruction: true }),
  });
  assert.equal(memoryCue.trigger, true);
  assert.equal(memoryCue.reason, "memory_cue");

  const recallIntent = shouldRecallLongTerm({
    text: "上次聊天我们聊到哪了",
    threadMessageCount: 2,
    understanding: u({ recallIntent: true }),
  });
  assert.equal(recallIntent.trigger, true);
  assert.equal(recallIntent.reason, "memory_cue");

  const earlierSession = shouldRecallLongTerm({
    text: "我们之前聊过的那家餐厅",
    threadMessageCount: 2,
    understanding: u({ reference: "earlier_session" }),
  });
  assert.equal(earlierSession.trigger, true);
  assert.equal(earlierSession.reason, "memory_cue");
});

test("personal_fact → personal_fact", () => {
  const gate = shouldRecallLongTerm({
    text: "我叫李雷，在杭州工作",
    understanding: u({ personalFact: true }),
  });
  assert.equal(gate.trigger, true);
  assert.equal(gate.reason, "personal_fact");
});

test("anaphora escalation: 追问轮仅在长会话（超出注入窗口）时升级", () => {
  // 短会话：LLM 从最近轮次即可消解指代，不需要长期检索
  assert.equal(
    shouldRecallLongTerm({
      text: "那个方案后来怎么样了",
      threadMessageCount: 8,
      understanding: u({ isFollowUp: true }),
    }).trigger,
    false,
  );
  // 长会话（早期轮次已截出窗口）：指代可能指向窗口外，升级检索
  const escalated = shouldRecallLongTerm({
    text: "那个方案后来怎么样了",
    threadMessageCount: 30,
    understanding: u({ isFollowUp: true }),
  });
  assert.equal(escalated.trigger, true);
  assert.equal(escalated.reason, "anaphora_escalation");
  // 非追问轮次即使会话再长也不触发
  assert.equal(
    shouldRecallLongTerm({
      text: "今天天气怎么样",
      threadMessageCount: 30,
      understanding: u({ isFollowUp: false }),
    }).trigger,
    false,
  );
});

test("empty text never triggers", () => {
  assert.equal(shouldRecallLongTerm({ text: "   ", understanding: u({ personalFact: true }) }).trigger, false);
});

// ===== parseUnderstanding 契约（L1 路由 LLM 产出 → 消费链入口）=====

test("parseUnderstanding: 「你叫我什么？」期望产出（全 false）→ undefined（零注入）", () => {
  // 回归锚：这句话曾被词表误判成追问轮 → 追问锚点注入带偏模型 → 手写行程
  // 检测误触发强制规划。新契约下 L1 路由判 chat 且全标记 false → 解析层省略
  // understanding → recall-gate off / 追问锚点无 / scheduleSnapshot 无 / travelState 无。
  const raw = JSON.stringify({
    intent: "chat",
    confidence: 0.95,
    understanding: {
      is_follow_up: false,
      reference: "none",
      recall_intent: false,
      memory_instruction: false,
      personal_fact: false,
      schedule_query: false,
      travel_query: false,
    },
  });
  assert.equal(parseUnderstanding(raw), undefined);
});

test("parseUnderstanding: snake_case 信号解析 + reference 封闭集校验", () => {
  const parsed = parseUnderstanding(
    JSON.stringify({
      intent: "task",
      understanding: {
        is_follow_up: true,
        reference: "earlier_session",
        recall_intent: "true",
        memory_instruction: false,
        personal_fact: true,
        schedule_query: false,
        travel_query: false,
      },
    }),
  );
  assert.notEqual(parsed, undefined);
  assert.equal(parsed!.isFollowUp, true);
  assert.equal(parsed!.reference, "earlier_session");
  assert.equal(parsed!.recallIntent, true);
  assert.equal(parsed!.memoryInstruction, false);
  assert.equal(parsed!.personalFact, true);
  assert.equal(parsed!.scheduleQuery, false);
  assert.equal(parsed!.travelQuery, false);
});

test("parseUnderstanding: 非法 reference 回落 none；坏 JSON/缺字段容错", () => {
  // reference 非法值 → "none"，其余有效信号保留
  const badRef = parseUnderstanding(
    JSON.stringify({ understanding: { reference: "last_week", recall_intent: true } }),
  );
  assert.equal(badRef!.reference, "none");
  assert.equal(badRef!.recallIntent, true);

  // 坏 JSON / 空 / 无大括号 → undefined
  assert.equal(parseUnderstanding("not json at all"), undefined);
  assert.equal(parseUnderstanding(""), undefined);
  assert.equal(parseUnderstanding(undefined), undefined);
  assert.equal(parseUnderstanding('{"understanding": broken'), undefined);

  // 未产出 understanding 字段（旧模型/降级响应）→ undefined
  assert.equal(parseUnderstanding(JSON.stringify({ intent: "chat", confidence: 0.9 })), undefined);
});

// ===== 固化噪音过滤：闲聊语气行不进入长期记忆 =====

test("noise consolidation filter keeps substance, drops chit-chat", () => {
  // 高信号行恒保留
  assert.equal(isNoiseLogLine("fact", "我在做智能家居项目"), false);
  assert.equal(isNoiseLogLine("prefer", "我喜欢喝冰美式"), false);
  assert.equal(isNoiseLogLine("commit", "我明天帮你查一下"), false);
  // 闲聊/语气填充行过滤
  assert.equal(isNoiseLogLine("U", "哈哈哈哈"), true);
  assert.equal(isNoiseLogLine("A", "好的。"), true);
  assert.equal(isNoiseLogLine("U", "嗯嗯"), true);
  assert.equal(isNoiseLogLine("U", "晚安"), true);
  assert.equal(isNoiseLogLine("U", "谢谢你"), true);
  // 实义陈述保留
  assert.equal(isNoiseLogLine("U", "帮我看看这段代码的报错"), false);
  assert.equal(isNoiseLogLine("A", "我已帮你查了小米SU7的交付数据"), false);
});

// ===== daily-journal：当日写入 + 词法检索 + 固化标记 =====

function createJournal(): DailyJournalService {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  return new DailyJournalService(dir);
}

test("appendTurn writes simplified lines and searchToday finds them", async () => {
  const journal = createJournal();
  const actorId = "user-a";
  journal.appendTurn(actorId, "session1234567890", "我们聊聊小米SU7的销量数据吧", "好的，我帮你查了小米SU7上月交付数据。");
  await new Promise((r) => setTimeout(r, 50)); // 等写入链 flush

  const hits = await journal.searchToday(actorId, "小米SU7 交付");
  assert.ok(hits.length > 0, "应能命中今天写入的对话行");
  assert.ok(hits.some((h) => h.text.includes("小米")), "命中行应含检索词");
});

test("searchToday returns empty when no journal exists", async () => {
  const journal = createJournal();
  const hits = await journal.searchToday("nobody", "随便查点什么");
  assert.deepEqual(hits, []);
});

test("preference/fact extraction lines are journaled", async () => {
  const journal = createJournal();
  const actorId = "user-b";
  journal.appendTurn(actorId, "sess-1", "我喜欢喝冰美式。我在做智能家居项目。", "知道了。");
  await new Promise((r) => setTimeout(r, 50));

  const preferHits = await journal.searchToday(actorId, "喜欢 冰美式");
  assert.ok(preferHits.length > 0, "偏好句应被提取为 prefer 行");
  const factHits = await journal.searchToday(actorId, "智能家居 项目");
  assert.ok(factHits.length > 0, "事实句应被提取为 fact 行");
});

test("consolidation flow: getUnconsolidated → markConsolidated → empty", async () => {
  const journal = createJournal();
  const actorId = "user-c";
  journal.appendTurn(actorId, "sess-1", "今天聊了记忆架构重构", "已记录。");
  await new Promise((r) => setTimeout(r, 50));

  const before = await journal.getUnconsolidatedLines(actorId);
  assert.equal(before.length, 1, "应有 1 个未固化日期");
  assert.ok(before[0]!.lines.length > 0, "日志行应非空");

  await journal.markConsolidated(actorId, [before[0]!.dateKey]);
  const after = await journal.getUnconsolidatedLines(actorId);
  assert.equal(after.length, 0, "固化后不应再有未处理日志");
});

test("appendTurn dedups identical turn within window (防多路径双写)", async () => {
  const journal = createJournal();
  const actorId = "user-idem";
  // 同一轮（同 session + 同首句）连续两次落盘：标准主答 / complex 后台 / parallel 续接可能多路径调同一次，
  // 幂等防抖窗口内应只写一次，避免当日检索/固化被重复行污染
  journal.appendTurn(actorId, "sess-idem-1", "今天聊了记忆架构", "已记录。");
  journal.appendTurn(actorId, "sess-idem-1", "今天聊了记忆架构", "已记录。");
  await new Promise((r) => setTimeout(r, 80));

  const hits = await journal.searchToday(actorId, "记忆架构");
  assert.equal(hits.length, 1, "同一轮重复写应只落一行");
});

test("searchRange covers recent days window (跨天检索)", async () => {
  const journal = createJournal();
  const actorId = "user-range";
  journal.appendTurn(actorId, "sess-range-1", "记得把项目部署到服务器", "好的，已记下。");
  await new Promise((r) => setTimeout(r, 80));

  const hits = await journal.searchRange(actorId, "部署 服务器", 3);
  assert.ok(hits.length > 0, "近 3 天窗口应能命中今天写入的行");
});

test("markConsolidated is idempotent", async () => {
  const journal = createJournal();
  const actorId = "user-d";
  journal.appendTurn(actorId, "sess-1", "写一行", "回一行");
  await new Promise((r) => setTimeout(r, 50));

  const before = await journal.getUnconsolidatedLines(actorId);
  const dateKey = before[0]!.dateKey;
  await journal.markConsolidated(actorId, [dateKey]);
  await journal.markConsolidated(actorId, [dateKey]);
  const after = await journal.getUnconsolidatedLines(actorId);
  assert.equal(after.length, 0);
});

// ===== STM gateway：buildRecallQuery 已删除的回归保护 =====

test("ShortTermMemoryGatewayService no longer exposes buildRecallQuery", () => {
  const dir = mkdtempSync(join(tmpdir(), "stm-gate-"));
  const service = new ShortTermMemoryGatewayService(join(dir, "stack.json"));
  assert.equal(
    typeof (service as unknown as Record<string, unknown>).buildRecallQuery,
    "undefined",
    "buildRecallQuery 拼接链应已彻底移除",
  );
});
