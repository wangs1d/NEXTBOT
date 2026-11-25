import assert from "node:assert/strict";
import test from "node:test";

import {
  extractReminderSubject,
} from "../src/services/schedule-intent-service.js";
import { isEchoLikeReminderCopy } from "../src/services/reminder-copy.js";

/** 用户对助手的称呼（小弟/老哥等）不是提醒事项：不得混入 shortTitle 与到点文案。 */
test("extractReminderSubject strips trailing vocative appended after the subject", () => {
  assert.equal(extractReminderSubject("五分钟后提醒我睡觉 小弟"), "睡觉");
  assert.equal(extractReminderSubject("五分钟后提醒我睡觉 老铁呀"), "睡觉");
  assert.equal(extractReminderSubject("10分钟后提醒我喝水 老板"), "喝水");
});

test("extractReminderSubject strips leading vocative before the time expression", () => {
  assert.equal(extractReminderSubject("小弟，五分钟后提醒我睡觉"), "睡觉");
  // 「帮我」剥掉后紧跟的时间段一并剥离（9 点是日程锚点不是事项）：事项只留「开会」
  assert.equal(extractReminderSubject("老哥 帮我明天9点提醒我开会"), "开会");
});

/** 2026-10-21 回归：「4分钟后（17:40）提醒我去游泳」的括号时间把正则链挡死，
 * 回声原句「（17:40）提醒我去游泳」原样落库上了岛。括号包裹的时间段须逐段剥净。 */
test("extractReminderSubject strips parenthesized time prefixes", () => {
  assert.equal(extractReminderSubject("4分钟后（17:40）提醒我去游泳"), "去游泳");
  assert.equal(extractReminderSubject("（17:40）提醒我去游泳"), "去游泳");
  assert.equal(extractReminderSubject("提醒我（17:40）去游泳"), "去游泳");
  assert.equal(extractReminderSubject("提醒我17:40去游泳"), "去游泳");
});

test("extractReminderSubject keeps vocative that is a sentence object (no separator)", () => {
  assert.equal(extractReminderSubject("明天9点提醒我打电话给大哥"), "打电话给大哥");
  assert.equal(extractReminderSubject("下午3点提醒我问老板要签字"), "问老板要签字");
});

test("reminder copy for vocative-suffixed request stays clean", () => {
  // 2026-11-25 定调：文案只由模型写，规则路径只出中性事项词（不再套「该X啦」模板）
  const subject = extractReminderSubject("五分钟后提醒我睡觉 小弟");
  assert.equal(subject, "睡觉");
});

test("extractReminderSubject still handles plain reminders without vocatives", () => {
  assert.equal(extractReminderSubject("半小时后提醒我睡觉"), "睡觉");
  assert.equal(extractReminderSubject("2分钟后提醒吃药"), "吃药");
  assert.equal(extractReminderSubject("一分钟后提醒上厕所"), "上厕所");
});

/** 2026-10-21 回归：相对+绝对时间连用须逐段剥净（旧版只剥第一段，留下
 * 「的11点03分提醒我吃饭」进了 shortTitle/reminderMessage）。 */
test("extractReminderSubject strips chained relative and absolute time prefixes", () => {
  assert.equal(extractReminderSubject("一分钟后的11点03分提醒我吃饭"), "吃饭");
  assert.equal(extractReminderSubject("今晚8点提醒我收衣服"), "收衣服");
});

/** 指令词后残留标点：「今晚8点提醒我，闹钟」→「闹钟」而非「，闹钟」。 */
test("extractReminderSubject cleans punctuation after instruction words", () => {
  assert.equal(extractReminderSubject("今晚8点提醒我，闹钟"), "闹钟");
});

test("isEchoLikeReminderCopy catches wake-up instruction variants", () => {
  // 2026-11-25 回归：「定个闹钟喊醒我」的回声「闹钟喊醒我」曾漏判、到点被模板
  // 包成「该闹钟喊醒我啦」。叫醒类指令词一并判回声。
  assert.equal(isEchoLikeReminderCopy("闹钟喊醒我"), true);
  assert.equal(isEchoLikeReminderCopy("闹钟叫醒我"), true);
});

/** 回声判定：模型把原句/半截原句塞进展示文案字段时必须能识别。 */
test("isEchoLikeReminderCopy detects echoed raw sentences", () => {
  assert.equal(isEchoLikeReminderCopy("的11点03分提醒我吃饭"), true);
  assert.equal(isEchoLikeReminderCopy("今晚8点提醒我收衣服"), true);
  assert.equal(isEchoLikeReminderCopy("11点03分提醒我吃饭"), true);
  // 兜底标记及其包装都是垃圾文案（存量脏数据实证：「该到点提醒啦」）
  assert.equal(isEchoLikeReminderCopy("该到点提醒啦"), true);
  assert.equal(isEchoLikeReminderCopy("到点提醒"), true);
  assert.equal(isEchoLikeReminderCopy("该吃饭啦"), false);
  assert.equal(isEchoLikeReminderCopy("该吃药啦！记得按时服药"), false);
  assert.equal(isEchoLikeReminderCopy("给妈妈打电话"), false);
});
