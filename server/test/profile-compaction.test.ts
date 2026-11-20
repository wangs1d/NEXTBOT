import assert from "node:assert/strict";
import test from "node:test";

import { compactProfileMarkdown } from "../src/services/user-personalization/user-profile-store.js";

test("同一句重复 71 次 → 只留最新一条", () => {
  const repeated = Array.from({ length: 71 }, () => "- 用户喜欢猫").join("\n");
  const md = `# 用户画像\n\n## 兴趣与习惯\n\n${repeated}\n`;
  const out = compactProfileMarkdown(md);
  assert.equal(out.match(/- 用户喜欢猫/g)?.length, 1);
});

test("基本信息同字段 latest-wins（新值替换旧值）", () => {
  const md = `# 用户画像\n\n## 基本信息\n\n- 所在城市：杭州\n- 职业：设计师\n- 所在城市：上海\n`;
  const out = compactProfileMarkdown(md);
  assert.doesNotMatch(out, /杭州/);
  assert.match(out, /所在城市：上海/);
  assert.match(out, /职业：设计师/);
});

test("超过分段上限时丢最旧的行，标题/样板/占位行保留", () => {
  const items = Array.from({ length: 14 }, (_, i) => `- 兴趣${i}`).join("\n");
  const md = `# 用户画像\n\n## 兴趣与习惯\n\n${items}\n\n## 沟通偏好\n\n- 语气风格：自然均衡（系统根据对话自动调整）\n`;
  const out = compactProfileMarkdown(md);
  assert.doesNotMatch(out, /兴趣0\b/);
  assert.doesNotMatch(out, /兴趣3\b/);
  assert.match(out, /兴趣4\b/);
  assert.match(out, /兴趣13\b/);
  assert.match(out, /## 沟通偏好/);
  assert.match(out, /语气风格：自然均衡（系统根据对话自动调整）/);
});

test("幂等：压缩两次结果一致", () => {
  const md = `# 用户画像\n\n## 兴趣与习惯\n\n- 喜欢猫\n- 喜欢猫\n`;
  const once = compactProfileMarkdown(md);
  assert.equal(compactProfileMarkdown(once), once);
});