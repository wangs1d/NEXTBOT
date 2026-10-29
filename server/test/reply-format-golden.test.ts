/**
 * 回复格式黄金快照回归测试。
 *
 * 语料：test/fixtures/reply-format-corpus.ts（来源与维护说明见该文件头）。
 * 快照：test/fixtures/golden/reply-format.snapshots.json，由
 *       `npm run eval:reply-format -- --update` 生成（更新后须逐条人工审核）。
 *
 * 与 display-routing-corpus.test.ts 的边界：那边锁两个路由器的孤立打分，
 * 这里锁完整管线（文本切片 → 级联优先级 → 标记注入）的最终产物——
 * 任何切片/级联/阈值改动导致的产物漂移都会在这里炸出来。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getToolResultProcessor } from "../src/services/tool-result-processor.js";
import { classifyRenderHint } from "../src/services/render-hint-service.js";
import {
  REPLY_FORMAT_CORPUS,
  type ReplyFormatCase,
} from "./fixtures/reply-format-corpus.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_PATH = path.join(ROOT, "test/fixtures/golden/reply-format.snapshots.json");

interface Snapshot {
  hint: string;
  output: string;
}

interface Golden {
  description: string;
  snapshots: Record<string, Snapshot>;
}

function normalize(output: string): string {
  return output
    .replace(/card_\d+_[a-z0-9]+/g, "card_<id>")
    .replace(/"ts":\d+/g, '"ts":<ts>')
    .replace(/sum-[a-z0-9]+-[a-z0-9]+/g, "sum_<id>")
    .replace(/"createdAt":"[^"]*"/g, '"createdAt":"<ts>"');
}

function runCase(c: ReplyFormatCase): Snapshot {
  const output = getToolResultProcessor().processAssistantText(c.text, {
    plainTextMode: c.plainTextMode,
    userText: c.userText,
    toolName: c.toolName,
    toolResult: c.toolResult,
  });
  const hint = classifyRenderHint(c.text, { toolName: c.toolName, userText: c.userText });
  return { hint: hint.type, output: normalize(output) };
}

const golden: Golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

for (const c of REPLY_FORMAT_CORPUS) {
  test(`reply format golden: ${c.name}`, () => {
    const snap = golden.snapshots[c.name];
    assert.ok(snap, `语料「${c.name}」缺少快照，运行 npm run eval:reply-format -- --update 生成并人工审核`);
    const now = runCase(c);
    assert.equal(
      now.hint,
      snap.hint,
      `「${c.name}」消息级路由漂移（${snap.hint || "(plain)"} → ${now.hint || "(plain)"}）。` +
        `若为预期改动：npm run eval:reply-format -- --update 后逐条人工审核`,
    );
    assert.equal(
      now.output,
      snap.output,
      `「${c.name}」产物漂移（${c.note}）。` +
        `若为预期改动：npm run eval:reply-format -- --update 后逐条人工审核`,
    );
  });
}

test("contract drift: golden covers exactly the corpus", () => {
  const corpusNames = new Set(REPLY_FORMAT_CORPUS.map((c) => c.name));
  const goldenNames = new Set(Object.keys(golden.snapshots));
  for (const name of corpusNames) {
    assert.ok(goldenNames.has(name), `快照缺语料样本「${name}」`);
  }
  for (const name of goldenNames) {
    assert.ok(corpusNames.has(name), `快照残留已删除语料「${name}」`);
  }
});
