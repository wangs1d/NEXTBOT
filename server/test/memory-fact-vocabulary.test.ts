/**
 * 事实词表统一（memory/fact-vocabulary）回归测试（2026-11-13）
 *
 * 锁定一件事：**标准档案字段只有一份词表**。
 *   - 认得出 → 落权威库（structured_facts），不再往长尾事实库存第二份；
 *   - 认不准 → 返回 null，宁可留在长尾库，也不要把猜错的值写进权威库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectProfileFieldFromText,
  isUsableProfileValue,
  normalizeDetectedProfileFact,
} from "../src/memory/fact-vocabulary.js";
import { UserFactStore } from "../src/services/user-fact-store.js";

test("V1 字段：值 形态直接归一（提示词里的规范写法）", () => {
  assert.deepEqual(detectProfileFieldFromText("职业：后端开发"), {
    field: "职业",
    value: "后端开发",
  });
  assert.deepEqual(detectProfileFieldFromText("居住地：兴义"), {
    field: "居住地",
    value: "兴义",
  });
  assert.deepEqual(detectProfileFieldFromText("用户称呼：王哥"), {
    field: "称呼",
    value: "王哥",
  });
  // 别名也要归一（姓名/名字/昵称 → 称呼）
  assert.deepEqual(detectProfileFieldFromText("姓名：王铭川"), {
    field: "称呼",
    value: "王铭川",
  });
});

test("V2 自然句形态识别档案字段", () => {
  assert.deepEqual(detectProfileFieldFromText("用户住在兴义"), {
    field: "居住地",
    value: "兴义",
  });
  assert.deepEqual(detectProfileFieldFromText("用户的职业是后端开发"), {
    field: "职业",
    value: "后端开发",
  });
  assert.deepEqual(detectProfileFieldFromText("用户希望被称作「王哥」"), {
    field: "称呼",
    value: "王哥",
  });
  assert.deepEqual(detectProfileFieldFromText("用户的生日是3月5日"), {
    field: "生日",
    value: "3月5日",
  });
  assert.deepEqual(detectProfileFieldFromText("用户的学历是本科"), {
    field: "学历",
    value: "本科",
  });
});

test("V3 长尾事实一律不认（宁可留长尾库，也不猜错写进权威库）", () => {
  for (const text of [
    "用户喜欢简洁的回答",
    "用户在为小米 18 Pro 比价",
    "用户在写一个项目",
    "用户会在周五交付报告",
    "用户讨厌香菜",
  ]) {
    assert.equal(detectProfileFieldFromText(text), null, `不该认成档案字段：${text}`);
  }
});

test("V4 值必须像短值（带主语/带助词/太长一律拒绝）", () => {
  assert.equal(isUsableProfileValue("兴义"), true);
  assert.equal(isUsableProfileValue("我在兴义"), false, "带主语不是短值");
  assert.equal(isUsableProfileValue("是我的"), false);
  assert.equal(isUsableProfileValue("很长的一个值很长的一个值很长的一个值很长的一个值"), false);
  assert.equal(isUsableProfileValue(""), false);
});

test("V5 模型给的 field/value 也要过归一与校验", () => {
  assert.deepEqual(normalizeDetectedProfileFact("名字", "王哥"), {
    field: "称呼",
    value: "王哥",
  });
  assert.deepEqual(normalizeDetectedProfileFact("职业", "后端开发"), {
    field: "职业",
    value: "后端开发",
  });
  assert.equal(normalizeDetectedProfileFact("喜好", "简洁"), null, "不是标准档案字段");
  assert.equal(normalizeDetectedProfileFact("职业", "我是一名后端"), null, "值不像短值");
  assert.equal(normalizeDetectedProfileFact(undefined, "王哥"), null);
  assert.equal(normalizeDetectedProfileFact("称呼", 42), null);
});

test("V6 行式事实库拒收档案字段类事实（词表统一在存储层落地）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-facts-"));
  const store = new UserFactStore(dir);

  // 档案字段 → 拒收（权威归 structured_facts）
  const rejected = await store.upsertFact("u1", {
    kind: "fact",
    value: "职业：后端开发",
    source: "nightly-extract",
  });
  assert.equal(rejected, null, "档案字段不应进长尾事实库");

  // 长尾事实 → 照常写
  const kept = await store.upsertFact("u1", {
    kind: "preference",
    value: "用户喜欢简洁的回答",
    source: "nightly-extract",
  });
  assert.ok(kept, "长尾事实应正常落库");
  const facts = await store.getFacts("u1");
  assert.equal(facts.length, 1);
  assert.match(facts[0]!.value, /简洁的回答/);
});
