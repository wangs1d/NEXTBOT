import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { MemoryCortex } from "../src/brain/memory-cortex.js";
import {
  classifyMemorySourceRole,
  extractEchoQueryFromAssistantReply,
} from "../src/services/memory-source-role.js";
import {
  extractRelationshipAssertion,
  isRelationshipHedgeLine,
} from "../src/services/memory-relationship-assertion.js";
import {
  areLinesConflicting,
  dedupeMemoryLines,
  extractOverwriteKey,
} from "../src/services/memory-record-utils.js";
import { extractFactSubject } from "../src/services/user-fact-store.js";

/**
 * 来源角色治理 + 同主题覆盖 + 回声抑制（root fix，2026-09 复盘回归测试）。
 * 场景取自真实事故：用户明确说「刘浩存才是真主 未来的老婆」，但助手此前把
 * "搜过景甜照片"脑补成的敷衍回复（「到底哪位是正主」）被反复召回复读。
 */

const HEDGE_REPLY_LINE =
  '{"line":"EvolutionLoop: assistantDone user=\\"还记得我的未来老婆是谁不\\" reply=\\"你未来老婆啊……这我可不敢乱记，前脚一个景甜后脚一个刘浩存的，说的到底哪位是正主，你给个准话呗。 别到时候我记岔了你又批我。\\""}';

async function withService(
  fn: (service: HumanLikeMemoryService) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-governance-"));
  // 封闭 embedding 环境变量：检索测试不应依赖外部 API（失败自动降级，但会拖慢）
  const saved = new Map(
    ["AGENT_EMBEDDING_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"].map(
      (key) => [key, process.env[key]] as const,
    ),
  );
  for (const key of saved.keys()) delete process.env[key];
  const service = new HumanLikeMemoryService(join(dir, "memory.json"), join(dir, "policy.json"));
  try {
    await service.load();
    await fn(service);
  } finally {
    await service.shutdown();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("classifyMemorySourceRole：各写入链路行格式识别", () => {
  assert.equal(classifyMemorySourceRole("[日志固化 2026-09-08 00:31·用户] 刘浩存才是真主 未来的老婆"), "user");
  assert.equal(classifyMemorySourceRole("[日志固化 2026-09-08 00:24·助手] 景甜这几张给你找来了"), "assistant");
  assert.equal(classifyMemorySourceRole("[2026-09-08T00:00Z] [topic:profile] [用户要求记住] 我的老婆是刘浩存"), "user");
  assert.equal(classifyMemorySourceRole("[topic:consolidate] 承诺：我将制定追求刘浩存的计划"), "assistant");
  assert.equal(classifyMemorySourceRole(HEDGE_REPLY_LINE), "assistant");
  assert.equal(classifyMemorySourceRole("用户请求搜索景甜的照片，工具调用成功"), "tool");
  assert.equal(classifyMemorySourceRole("梦呓 fallback 文本"), "unknown");
});

test("extractRelationshipAssertion：陈述可提取、疑问不误报", () => {
  assert.deepEqual(extractRelationshipAssertion("我的老婆是刘浩存"), { subject: "spouse", value: "刘浩存" });
  assert.deepEqual(
    extractRelationshipAssertion("[日志固化 2026-09-08 00:31·用户] 刘浩存才是真主 未来的老婆"),
    { subject: "spouse", value: "刘浩存" },
  );
  assert.deepEqual(extractRelationshipAssertion("我的未来老婆是刘浩存"), { subject: "spouse", value: "刘浩存" });
  assert.deepEqual(extractRelationshipAssertion("还记得我的未来老婆是谁不"), null);
  assert.deepEqual(extractRelationshipAssertion("到底哪位是正主"), null);
  assert.deepEqual(extractRelationshipAssertion("我老婆说过的话就是真理"), null);
});

test("isRelationshipHedgeLine：助手求证/摇摆发言识别", () => {
  assert.equal(isRelationshipHedgeLine(HEDGE_REPLY_LINE), true);
  assert.equal(
    isRelationshipHedgeLine("王铭川啊王哥，这我还能忘喽。 至于老婆——您这前后说法可有点飘忽…到底哪位是正主"),
    true,
  );
  assert.equal(isRelationshipHedgeLine("哎哟，记下了——老婆候选人锁定刘浩存，排在头一位。那言外之意是景甜…降级成备选了？"), true);
  assert.equal(isRelationshipHedgeLine("景甜这几张照片给你找来了，温婉挂的"), false);
  assert.equal(isRelationshipHedgeLine("明天下午三点开会"), false);
});

test("extractEchoQueryFromAssistantReply", () => {
  assert.equal(extractEchoQueryFromAssistantReply(HEDGE_REPLY_LINE), "还记得我的未来老婆是谁不");
  assert.equal(extractEchoQueryFromAssistantReply("普通文本没有回声"), null);
});

test("KV 覆盖键：同关系字段不同值互为冲突，latest-wins", () => {
  const oldLine = "[2026-09-01T00:00:00.000Z] [topic:profile] 我的老婆是景甜";
  const newLine = "[2026-09-08T00:00:00.000Z] [topic:profile] 我的老婆是刘浩存";
  const keyOld = extractOverwriteKey(oldLine);
  const keyNew = extractOverwriteKey(newLine);
  assert.equal(keyOld, keyNew);
  assert.equal(keyOld, "relationship:spouse");
  assert.equal(areLinesConflicting(oldLine, newLine), true);
  const deduped = dedupeMemoryLines([oldLine, newLine], { preferLatest: true });
  assert.equal(deduped.length, 1);
  assert.match(deduped[0], /刘浩存/);
});

test("user-fact-store：关系类 subject 归一到「配偶/伴侣」", () => {
  assert.equal(extractFactSubject("fact", "我的老婆是景甜"), "配偶/伴侣");
  assert.equal(extractFactSubject("fact", "我的未来老婆是刘浩存"), "配偶/伴侣");
  assert.equal(extractFactSubject("fact", "我住在兴义"), "居住地");
});

test("图谱：用户断言触发同主题覆盖，助手回声节点被作废且不再召回", async () => {
  await withService(async (service) => {
    // 1) 事故现场：助手敷衍回复被固化进图谱（EvolutionLoop 行）
    await service.ingest("actor-1", HEDGE_REPLY_LINE, "evolution:observe");
    // 2) 用户给出明确断言（journal 固化行格式）
    const assertionLine = "[日志固化 2026-09-10 01:50·用户] 刘浩存才是真主 未来的老婆";
    await service.ingest("actor-1", assertionLine, "journal:consolidate", { highSignal: true });

    const nodes = service.getAllNodes("actor-1");
    const hedgeNode = nodes.find((n) => n.summary.includes("到底哪位是正主"));
    const assertionNode = nodes.find((n) => n.summary.includes("刘浩存才是真主"));
    assert.ok(hedgeNode, "回声节点应存在");
    assert.ok(assertionNode, "用户断言节点应存在");
    // 被作废：soft_deleted + superseded 元数据
    assert.equal(hedgeNode.deletionStage, "soft_deleted");
    assert.ok((hedgeNode.metadata?.superseded as Record<string, unknown> | undefined)?.at);
    // 来源角色打标
    assert.equal(assertionNode.metadata?.sourceRole, "user");

    // 召回不再包含回声节点，包含用户断言
    const recall = await service.buildRecall("actor-1", "还记得我的未来老婆是谁不");
    assert.ok(!recall.text.includes("到底哪位是正主"), "回声节点不得再被召回");
    assert.ok(recall.text.includes("刘浩存"), "召回应包含最新用户断言");
  });
});

test("图谱：同主题旧断言（景甜）被新断言（刘浩存）覆盖", async () => {
  await withService(async (service) => {
    const oldLine = "[日志固化 2026-09-01 10:00·用户] 我的老婆是景甜";
    const newLine = "[日志固化 2026-09-10 01:50·用户] 我的老婆是刘浩存";
    await service.ingest("actor-2", oldLine, "journal:consolidate");
    await service.ingest("actor-2", newLine, "journal:consolidate", { highSignal: true });

    const nodes = service.getAllNodes("actor-2");
    const oldNode = nodes.find((n) => n.summary.includes("景甜"));
    const newNode = nodes.find((n) => n.summary.includes("刘浩存"));
    assert.ok(oldNode && newNode);
    assert.equal(oldNode.deletionStage, "soft_deleted", "旧值应被作废");
    assert.equal(newNode.deletionStage, "active");

    const recall = await service.buildRecall("actor-2", "我的老婆是谁");
    assert.ok(recall.text.includes("刘浩存"));
    assert.ok(!recall.text.includes("景甜"), "旧值不得与新值并列注入");
  });
});

test("图谱：召回侧冲突消解兜底（legacy 未作废数据也不并列注入）", async () => {
  await withService(async (service) => {
    // 直接用底层 store 造 legacy 数据（无 metadata、无 supersede 机会）
    const store = (service as unknown as { store: { nodes: Record<string, unknown> } }).store;
    const mk = (id: string, summary: string, ts: string) => {
      store.nodes[id] = {
        id, actorId: "actor-3", domainId: "general", parentDomainId: null,
        kind: "knowledge", source: "chat", sourceType: "chat", context: "main",
        summary, keywords: extractKeywordsShim(summary), sceneTags: [], emotionTags: [],
        entityTags: ["刘浩存", "景甜", "老婆"], semanticFingerprint: id, vectorFingerprint: "",
        timestamp: ts, lastAccessedAt: ts, accessCount: 0, importance: 0.6, confidence: 0.8,
        frequencyScore: 0, recencyScore: 1, domainScore: 1, userFeedbackScore: 1,
        correctness: "unknown", deletionStage: "active", isArchived: false,
        currentVersionId: "v1", versionIds: ["v1"],
      };
    };
    const extractKeywordsShim = (text: string): string[] =>
      (text.match(/[\u4e00-\u9fff]{2,8}/g) ?? []).slice(0, 14);
    mk("old-1", "用户的老婆是景甜", "2026-08-01T00:00:00.000Z");
    mk("new-1", "[日志固化 2026-09-10·用户] 我的老婆是刘浩存", "2026-09-10T00:00:00.000Z");

    const recall = await service.buildRecall("actor-3", "我的老婆是谁");
    const hasOld = recall.text.includes("景甜");
    const hasNew = recall.text.includes("刘浩存");
    assert.ok(!(hasOld && hasNew), "同主题两个值不得并列注入");
    assert.ok(hasNew, "应保留最新值");
  });
});

test("跟修：助手历史调侃默认不进召回，召回行带说话人标注", async () => {
  await withService(async (service) => {
    await service.ingest(
      "actor-4",
      "[日志固化 2026-11-10 21:00·用户] 我叫王铭川，今年二十岁",
      "journal:consolidate",
      { highSignal: true },
    );
    await service.ingest(
      "actor-4",
      "[日志固化 2026-11-10 21:01·助手] 王铭川，二十岁，喊你大哥那位",
      "journal:consolidate",
    );

    const recall = await service.buildRecall("actor-4", "还记得我叫什么吗");
    assert.ok(recall.text.includes("王铭川"), "用户自述应被召回");
    assert.ok(!recall.text.includes("喊你大哥那位"), "助手当时的调侃不得当作用户事实召回");
    assert.ok(recall.text.includes("（用户说的）"), "召回行必须标注说话人");
  });
});

test("跟修：用户明确问「你说过什么」时助手节点才放行", async () => {
  await withService(async (service) => {
    await service.ingest(
      "actor-5",
      "[日志固化 2026-11-10 21:01·助手] 喊你大哥那位",
      "journal:consolidate",
    );

    const recall = await service.buildRecall("actor-5", "你上次说喊你大哥那位是什么意思");
    assert.ok(recall.text.includes("喊你大哥那位"), "明确询问助手发言时应放行");
    assert.ok(recall.text.includes("（助手当时说的，不是用户事实）"));
  });
});

test("跟修：问个人属性时只保留该类事实，助手互动习惯不混入", () => {
  const cortex = new MemoryCortex();
  const items = [
    { content: "[日志固化 2026-11-10 21:00·用户] 我叫王铭川，今年二十岁", domain: "episodic", score: 0.6 },
    { content: "用户名叫王铭川，截至2026年11月10日时年二十岁。", domain: "semantic", score: 0.5 },
    {
      content: "王铭川（二十岁）把助手称作「大哥」，2026年11月10日的互动中显示出这种亲近的称呼习惯。",
      domain: "semantic",
      score: 0.5,
    },
  ];
  const narrow = (cortex as unknown as {
    narrowByQuestionIntent(list: unknown[], query: string): Array<{ content: string }>;
  }).narrowByQuestionIntent.bind(cortex);

  const nameAnswer = narrow(items, "还记得我叫什么吗");
  assert.ok(nameAnswer.some((item) => item.content.includes("名叫王铭川")));
  assert.ok(!nameAnswer.some((item) => item.content.includes("把助手称作")));

  const assistantAnswer = narrow(items, "你上次说喊我什么");
  assert.equal(assistantAnswer.length, 3);
});
