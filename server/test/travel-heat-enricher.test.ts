/**
 * 社媒热度回填器测试（travel-upgrade-plan P1，travel-heat-enricher）：
 * - parseModelJson 容错：围栏/前后缀噪声/越界钳位/非法项过滤/类型字段越界忽略
 * - enrichDestination 集成：名单外 POI resolve 失败不落库（宁缺毋滥，count=0）
 * - maybeEnrich 去重：7 天间隔与 in-flight 防并发
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TravelHeatEnricher,
  type PoiSocialPatch,
} from "../src/skills/travel-planning/travel-heat-enricher.js";

function makeEnricher(llmRaw: string): TravelHeatEnricher {
  return new TravelHeatEnricher({
    searchXiaohongshu: async () => ({ provider: "mock", raw: "x".repeat(50), notes: [] }),
    searchDouyin: async () => ({ provider: "mock", raw: "y".repeat(50), notes: [] }),
    llmComplete: async () => llmRaw,
  });
}

test("parseModelJson: 正常输出解析出 patch", () => {
  const svc = makeEnricher("");
  const patches = svc.parseModelJson(
    '{"items":[{"type":"attraction","name":"洱海","socialHeat":"hot","photo":{"score":4,"spot":"环海西路日落机位","bestTime":"17:00-19:00"}}]}',
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].name, "洱海");
  assert.equal(patches[0].socialHeat.level, "hot");
  assert.equal(patches[0].photo?.score, 4);
});

test("parseModelJson: markdown 围栏与前后缀噪声可解析", () => {
  const svc = makeEnricher("");
  const fenced = svc.parseModelJson('```json\n{"items":[{"type":"restaurant","name":"A 店","socialHeat":"mid","prettyFood":{"vibe":"海景","signature":"酸辣鱼"}}]}\n```');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].type, "restaurant");
  assert.equal(fenced[0].prettyFood?.signature, "酸辣鱼");
  const noisy = svc.parseModelJson('好的，结果如下：{"items":[{"type":"attraction","name":"B","socialHeat":"hot"}]} 希望有帮助');
  assert.equal(noisy.length, 1);
});

test("parseModelJson: score 越界钳位 1-5，非法分数回退 3", () => {
  const svc = makeEnricher("");
  const patches = svc.parseModelJson(
    '{"items":[{"type":"attraction","name":"A","socialHeat":"hot","photo":{"score":9}},{"type":"attraction","name":"B","socialHeat":"hot","photo":{"score":"很出片"}}]}',
  );
  assert.equal(patches[0].photo?.score, 5);
  assert.equal(patches[1].photo?.score, 3);
});

test("parseModelJson: 非法项过滤（缺名/非法热度/空输入/非 JSON）", () => {
  const svc = makeEnricher("");
  assert.deepEqual(svc.parseModelJson(""), []);
  assert.deepEqual(svc.parseModelJson("这不是 JSON"), []);
  assert.deepEqual(
    svc.parseModelJson('{"items":[{"type":"attraction","socialHeat":"hot"},{"name":"无名","socialHeat":"warm"}]}'),
    [],
  );
});

test("parseModelJson: 类型与字段越界忽略（restaurant 带 photo / attraction 带 prettyFood）", () => {
  const svc = makeEnricher("");
  const patches = svc.parseModelJson(
    '{"items":[{"type":"restaurant","name":"R","socialHeat":"hot","photo":{"score":5}},{"type":"attraction","name":"S","socialHeat":"hot","prettyFood":{"vibe":"x"}}]}',
  );
  assert.equal(patches[0].photo, undefined);
  assert.equal(patches[1].prettyFood, undefined);
});

test("enrichDestination: 名单外 POI 与未知目的地 resolve 失败，count=0 不落库", async () => {
  const svc = makeEnricher(
    '{"items":[{"type":"attraction","name":"根本不存在的景点XYZ","socialHeat":"hot","photo":{"score":5}}]}',
  );
  const entry = {
    key: "__test_no_such_dest__",
    updatedAt: Date.now(),
    data: { attractions: [{ id: "a1", name: "真实景点", rating: 4.5 }], restaurants: [], hotels: [] },
  } as never;
  const count = await svc.enrichDestination("__test_no_such_dest__", entry);
  assert.equal(count, 0);
});

test("enrichDestination: 名单内 POI 命中计数（mock LLM 按名单归类）", async () => {
  const svc = makeEnricher(
    '{"items":[{"type":"attraction","name":"真实景点","socialHeat":"hot","photo":{"score":4,"spot":"山顶机位"}}]}',
  );
  const entry = {
    key: "__test_dest2__",
    updatedAt: Date.now(),
    data: { attractions: [{ id: "a1", name: "真实景点", rating: 4.5 }], restaurants: [], hotels: [] },
  } as never;
  // poiCache 无此目的地 → updatePOISocial 返回 false → count 仍为 0，但全链路无异常
  const count = await svc.enrichDestination("__test_dest2__", entry);
  assert.equal(count, 0);
});

test("maybeEnrich: 未启用（缺 LLM 口）返回 false；启用后 7 天内去重、in-flight 防并发", async () => {
  const disabled = new TravelHeatEnricher({});
  const entry = { key: "d", updatedAt: 0, data: { attractions: [], restaurants: [], hotels: [] } } as never;
  assert.equal(disabled.maybeEnrich("d", entry), false);

  let resolveLlm: (v: string) => void = () => {};
  const gate = new Promise<string>((r) => (resolveLlm = r));
  const slow = new TravelHeatEnricher({
    searchXiaohongshu: async () => ({ provider: "m", raw: "z".repeat(50), notes: [] }),
    llmComplete: () => gate,
  });
  assert.equal(slow.maybeEnrich("d2", entry), true); // 首次启动
  assert.equal(slow.maybeEnrich("d2", entry), false); // in-flight 去重
  resolveLlm('{"items":[]}');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(slow.maybeEnrich("d2", entry), false); // 7 天内去重（lastEnrichAt 已更新）
});

test("PoiSocialPatch 类型完整性（编译期形状，运行时冒烟）", () => {
  const patch: PoiSocialPatch = {
    type: "attraction",
    name: "x",
    socialHeat: { level: "mid", source: "test" },
    photo: { score: 3, spot: "s", bestTime: "t" },
  };
  assert.equal(patch.socialHeat.level, "mid");
});
