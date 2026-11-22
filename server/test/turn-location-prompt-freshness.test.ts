/**
 * 「用户位置每轮都是新的，且注入在 prompt 动态层」契约测试（2026-11-22）。
 *
 * 验证三件事（对应线上诉求）：
 *   1. 每轮都会按龄期刷新：上一轮的位置不会原样留到下一轮；
 *   2. Agent 在 prompt 里看到的确实是**新地址**（不是旧快照）；
 *   3. 位置块落在动态层（assembleLayeredSections.dynamicContext /
 *      prefix-cache.tailDynamicContext），**不在**稳定层——所以会话级
 *      stable 冻结不会把它冻住，每轮都能换值。
 *
 * 链路取真实边界：TurnLocationHook → ActorContextService 快照 →
 * resolveUserLocationPrompt（与 agent-core 同一函数）→ assembleSystemPrompt
 * → preparePromptCachePlan（同一 sessionId，走 stable 冻结）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientLocationWire } from "@nextbot/agent-protocol";

import {
  assembleLayeredSections,
  assembleSystemPrompt,
} from "../src/agent/prompt-assembler.js";
import {
  preparePromptCachePlan,
  resetStablePromptSnapshotForTest,
} from "../src/external-model/prefix-cache.js";
import { ActorContextService } from "../src/services/actor-context-service.js";
import type { LocationCoordinator } from "../src/services/location-coordinator.js";
import {
  TurnLocationHook,
  isLocationAgeAcceptable,
  selectPromptLocation,
} from "../src/services/turn-location-hook.js";
import { resolveUserLocationPrompt } from "../src/services/user-location-service.js";

const T0 = Date.UTC(2026, 10, 21, 17, 30, 0);
const ACTOR = "actor-loc-freshness";

const CHONGQING: ClientLocationWire = {
  latitude: 29.5628,
  longitude: 106.5501,
  city: "重庆市",
  district: "渝中区",
  address: "重庆市渝中区民族路 1 号",
  poi: "解放碑",
  poiDistanceMeters: 130,
  capturedAt: new Date(T0).toISOString(),
};

const BEIJING: ClientLocationWire = {
  latitude: 39.9087,
  longitude: 116.3975,
  city: "北京市",
  district: "东城区",
  address: "北京市东城区东长安街 1 号",
  poi: "天安门广场",
  poiDistanceMeters: 210,
  capturedAt: new Date(T0 + 30 * 60_000).toISOString(),
};

test("每轮位置都是新的，且落在 prompt 动态层（会话冻结不冻住它）", async () => {
  resetStablePromptSnapshotForTest();
  const dir = await mkdtemp(join(tmpdir(), "loc-freshness-"));
  let nowMs = T0;
  const ctx = new ActorContextService({
    persistPath: join(dir, "actor-context.json"),
    now: () => nowMs,
    persistThrottleMs: 0,
  });

  // 设备侧按顺序回包：第一轮重庆，第二轮北京（模拟用户真的移动了）。
  const queue: ClientLocationWire[] = [{ ...CHONGQING }, { ...BEIJING }];
  const calls: string[] = [];
  const coordinator = {
    hasSocket: () => true,
    requestLocation: async (_actorId: string, reason?: string) => {
      calls.push(reason ?? "-");
      const next = queue.shift();
      if (!next) return null;
      nowMs = Date.parse(next.capturedAt ?? new Date(nowMs).toISOString());
      return next;
    },
  } as unknown as LocationCoordinator;

  const hook = new TurnLocationHook({
    context: ctx,
    coordinator,
    now: () => nowMs,
    enabled: true,
    freshMs: 60_000,
    budgetMs: 2_000,
  });

  const runTurn = async (label: string) => {
    const state = await hook.run(ACTOR, { reason: "chat" });
    // 走与 agent-core 完全相同的选择/龄期口，再走同一格式化函数。
    const selected = selectPromptLocation({
      snapshot: ctx.get(ACTOR)?.location ?? null,
      nowMs,
    });
    const block = selected
      ? await resolveUserLocationPrompt({ clientLocation: selected.location })
      : undefined;
    const memory = {
      userLocation: block,
      currentTime: `${label} 01:30 周日`,
    };
    const plan = preparePromptCachePlan({
      providerId: "deepseek",
      model: "deepseek-chat",
      baseSystemPrompt: "你是用户的私人管家。",
      memory,
      sessionId: ACTOR,
    });
    return { state, selected, block, memory, plan };
  };

  try {
    // ── 第 1 轮：重庆 ──
    const turn1 = await runTurn("2026-11-22T01:30+08:00");
    assert.equal(turn1.state.refreshed, true);
    assert.match(turn1.block ?? "", /重庆市渝中区民族路 1 号/);
    // 坐标不进 prompt（2026-11-22）：不再出现「GPS 29.56..., 106.55...」这类数字，
    // 也不出现裸经纬度对；地名/门牌/地标照常给。
    assert.doesNotMatch(
      turn1.block ?? "",
      /GPS\s*[-+]?\d/,
      "位置块不得再附带 GPS 经纬度",
    );
    assert.doesNotMatch(
      turn1.block ?? "",
      /\d{1,3}\.\d{5,}\s*,\s*[-+]?\d{1,3}\.\d{5,}/,
      "位置块不得出现经纬度数字",
    );
    assert.match(turn1.plan.tailDynamicContext ?? "", /重庆市渝中区民族路 1 号/);
    assert.match(String(turn1.plan.fullSystemPrompt), /重庆市渝中区民族路 1 号/);
    // 位置块不进请求头 system（稳定层/冻结层）
    assert.doesNotMatch(
      JSON.stringify(turn1.plan.requestSystemMessages),
      /重庆市渝中区民族路 1 号/,
      "位置块不得进 stable system（否则会话内被冻结）",
    );

    // 层次断言：userLocation 在 dynamicContext，不在 stablePrefix
    const layering = assembleLayeredSections(turn1.memory);
    assert.ok(
      layering.dynamicContext.some((b) => b.includes("【用户位置】")),
      "用户位置必须在动态层",
    );
    assert.ok(
      !layering.stablePrefix.some((b) => b.includes("【用户位置】")),
      "用户位置不得出现在稳定层",
    );
    const assembled = assembleSystemPrompt("你是用户的私人管家。", turn1.memory);
    assert.match(assembled.dynamicSystemPrompt ?? "", /【用户位置】/);
    assert.doesNotMatch(assembled.stableSystemPrompt, /【用户位置】/);

    // ── 第 2 轮（30 分钟后，同一会话）：北京 ──
    nowMs += 30 * 60_000;
    const turn2 = await runTurn("2026-11-22T02:00+08:00");

    assert.equal(calls.length, 2, "每轮过期都应向设备刷新一次");
    assert.equal(turn2.state.refreshed, true);
    assert.match(turn2.block ?? "", /北京市东城区东长安街 1 号/);
    assert.match(turn2.plan.tailDynamicContext ?? "", /北京市东城区东长安街 1 号/);
    assert.doesNotMatch(
      turn2.plan.tailDynamicContext ?? "",
      /重庆市渝中区民族路 1 号/,
      "上一轮旧位置不得留在本轮动态层",
    );
    assert.match(String(turn2.plan.fullSystemPrompt), /北京市东城区东长安街 1 号/);
    assert.doesNotMatch(String(turn2.plan.fullSystemPrompt), /重庆市渝中区民族路 1 号/);

    // 稳定层逐字节不变（会话冻结 + 动态层换值，两者同时成立）
    assert.equal(
      JSON.stringify(turn2.plan.requestSystemMessages),
      JSON.stringify(turn1.plan.requestSystemMessages),
      "稳定层必须逐字节稳定，位置变化只发生在动态尾块",
    );
    assert.notEqual(turn1.plan.tailDynamicContext, turn2.plan.tailDynamicContext);

    // ── 第 3 轮：设备离线 + 快照超龄 → 位置块整体缺席（不携带旧数据） ──
    queue.length = 0;
    nowMs += 5 * 60 * 60_000;
    const turn3 = await runTurn("2026-11-22T07:00+08:00");
    assert.equal(turn3.state.available, false);
    assert.equal(turn3.block, undefined, "超龄快照不得再渲染成用户位置块");
    assert.doesNotMatch(String(turn3.plan.fullSystemPrompt), /【用户位置】/);
    assert.doesNotMatch(String(turn3.plan.fullSystemPrompt), /北京市东城区/);
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
    resetStablePromptSnapshotForTest();
  }
});

test("龄期门：2h 内可用，超过即不可用（prompt 注入唯一裁决）", () => {
  assert.equal(isLocationAgeAcceptable(0), true);
  assert.equal(isLocationAgeAcceptable(59 * 60_000), true);
  assert.equal(isLocationAgeAcceptable(120 * 60_000), true);
  assert.equal(isLocationAgeAcceptable(121 * 60_000), false);
  assert.equal(isLocationAgeAcceptable(undefined), false);
  assert.equal(isLocationAgeAcceptable(Number.NaN), false);
  assert.equal(isLocationAgeAcceptable(5 * 60_000, 60_000), false, "自定义上限生效");
});

test("接线闸：bootstrap 装配钩子、AgentCore 每轮调用、SpeechHub 自动注入位置", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
  const app = read("../src/bootstrap/create-app-services.ts");
  assert.match(app, /new TurnLocationHook\(/, "bootstrap 必须构造位置钩子");
  assert.match(app, /agentCore\.setTurnLocationHook\(turnLocationHook\)/, "钩子必须接到 AgentCore");
  assert.match(app, /turnLocationBriefRef\.current = async/, "主动消息必须接 locationBrief");

  const core = read("../src/services/agent-core.ts");
  assert.match(core, /this\.turnLocationHook\.run\(/, "每轮必须跑位置钩子");
  assert.match(core, /selectPromptLocation\(\{/, "位置选择必须走唯一裁决口");

  const speech = read("../src/proactivity/speech-express.ts");
  assert.match(speech, /locationBrief\?\.\(opts\.sessionId\)/, "SpeechHub 必须注入位置块");
});
