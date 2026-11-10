/**
 * 双端渲染契约验收（P4，2026-11-07）。
 *
 * 一张声明驱动全部登记点：场景的 produces → render-contract.json →
 * 客户端 case / 服务端 RENDER_AS 字面量 / 信封块类型交叉校验。
 * 任何一侧漂移（新增形态没接客户端、改了声明忘导出契约）都在这里变红。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRenderContract,
  assertRenderContract,
  RENDER_AS_FORMS,
  ENVELOPE_BLOCK_TYPES,
  KNOWN_CLIENT_EXEMPT_CARD_TYPES,
  sceneRegistry,
  SceneRegistry,
} from "../src/render/index.js";
import type { RenderScene } from "../src/render/scenes/types.js";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");
const dartCases = (src: string): string[] =>
  [...src.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]);

const contractJson = JSON.parse(
  read("packages/agent-protocol/render-contract.json"),
) as ReturnType<typeof buildRenderContract>;

test("构建期契约：JSON 与当前场景声明完全一致（改声明必须重跑导出）", () => {
  const live = buildRenderContract(sceneRegistry);
  assert.deepEqual(contractJson, live, "契约 JSON 过期，请运行 npm run render:contract");
  assert.equal(contractJson.version, 2);
  assert.ok(contractJson.scenes.length >= 7);
  assert.deepEqual(assertRenderContract(sceneRegistry), []);
});

test("形态门：服务端 [RENDER_AS:*] 字面量 ⊆ 契约白名单 ⊆ 客户端 case", () => {
  const clientSrc = read("client/flutter_app/lib/features/chat/message_body_renderer.dart");
  const clientForms = new Set(dartCases(clientSrc));
  const bodySrc = read("server/src/render/body.ts");
  const serverForms = [...bodySrc.matchAll(/\[RENDER_AS:([A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);
  const protocolForms = new Set<string>(RENDER_AS_FORMS);

  for (const form of serverForms) {
    assert.ok(protocolForms.has(form), `服务端注入了未登记的形态: ${form}`);
    assert.ok(clientForms.has(form), `客户端没有 ${form} 的 case`);
  }
  for (const form of contractJson.forms) {
    assert.ok(protocolForms.has(form), `场景声明了非法形态: ${form}`);
    assert.ok(clientForms.has(form), `场景声明的形态客户端没接: ${form}`);
  }
  for (const form of contractJson.renderAsForms) {
    assert.ok(clientForms.has(form), `契约白名单里的 ${form} 客户端没有 case`);
  }
});

test("卡型门：场景声明的 cardType 都在共享枚举内，历史债务只在豁免清单里", () => {
  const protocol = read("packages/agent-protocol/src/display-effects.ts");
  const listBlock = /export const DISPLAY_EFFECT_TYPES = \[([\s\S]*?)\] as const/.exec(protocol)?.[1] ?? "";
  const allowed = new Set(
    [...listBlock.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter(Boolean),
  );
  allowed.add("permission_request");
  for (const cardType of contractJson.cardTypes) {
    assert.ok(allowed.has(cardType), `未登记的 cardType: ${cardType}`);
  }

  // 全量枚举的双端漂移门（与 render-scenes.test.ts 同一份豁免清单）
  const clientTypes = new Set([
    ...dartCases(read("client/flutter_app/lib/features/chat/display_effects/display_effects.dart")),
    ...dartCases(read("client/flutter_app/lib/features/chat/agent_result_card.dart")),
  ]);
  const drift = contractJson.cardTypes.filter(
    (t) => !clientTypes.has(t) && !KNOWN_CLIENT_EXEMPT_CARD_TYPES.includes(t as never),
  );
  assert.deepEqual(drift, [], "新增 cardType 未接入客户端渲染分支");
});

test("块类型门：客户端 dispatcher 支持契约里的全部 EnvelopeBlock 类型", () => {
  const dispatcher = read("client/flutter_app/lib/features/chat/render_envelope_dispatcher.dart");
  const blockList = /const List<String> kEnvelopeBlockTypes = <String>\[([\s\S]*?)\];/.exec(dispatcher)?.[1] ?? "";
  const clientBlocks = new Set([...blockList.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.ok(clientBlocks.size >= 6, "dispatcher 块类型清单解析失败");
  for (const type of ENVELOPE_BLOCK_TYPES) {
    assert.ok(clientBlocks.has(type), `客户端 dispatcher 不支持块类型: ${type}`);
  }
  assert.match(dispatcher, /dispatchDonePayload\(/);
  assert.match(dispatcher, /hasV2RenderEnvelope\(/);
  assert.match(dispatcher, /projectEnvelopeToSpeech\(/);
});

test("自检门：非法 produces 声明在启动期就被 fail-fast 拦下", () => {
  const registry = new SceneRegistry();
  const bad: RenderScene = {
    id: "bad_scene",
    label: "非法场景",
    priority: 10,
    phase: "post",
    produces: {
      cardTypes: ["not_registered"],
      forms: ["not_a_client_case"],
    },
    detect: () => ({ reason: "x" }),
    plan: () => ({ sceneId: "bad_scene", label: "非法场景", cards: [], reason: "x" }),
  };
  registry.register(bad);
  const problems = assertRenderContract(registry);
  assert.ok(problems.some((p) => p.includes("not_registered")));
  assert.ok(problems.some((p) => p.includes("not_a_client_case")));
  assert.ok(problems.some((p) => p.includes("markdown")), "缺兜底场景必须报错");
});

test("全场景声明门：每个场景都有 produces，pre/post 分工明确", () => {
  const post = contractJson.scenes.filter((s) => s.phase === "post").map((s) => s.id);
  assert.deepEqual(post, ["result_card"], "只有依赖模型正文的结构卡留在 post");
  for (const scene of contractJson.scenes) {
    assert.ok(scene.priority >= 0);
    assert.ok(scene.label);
  }
  // 2026-11-09 用户指令：取消「场景接管正文」，所有场景都不许重写模型正文
  const takeover = contractJson.scenes.filter((s) => "rewritesText" in s);
  assert.equal(takeover.length, 0, "契约里不得再有 rewritesText");
});
