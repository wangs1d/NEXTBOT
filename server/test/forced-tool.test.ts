/**
 * 词面工具存留测试（2026-11-09 更新）。
 *
 * 出口对账闸已于 2026-11-08 整体删除（「你知道我在哪吗」第三泡复述事故），
 * 它曾消费的怀疑信号与显式动作识别（turnSuggestsToolNeed /
 * resolveExplicitActionTool）随闸退役，不再有测试对象。
 * 本文件现只测仍存留的三个词面工具：
 *   - needsToolChoiceRequired：agent-core 显式规划升级（useExplicitPlanner）
 *     的「这轮像不像要办事」确定性信号（只作提示，不作强制）；
 *   - isInjectionAnsweredQuery：时间/日期/身份类注入直答判定；
 *   - claimsActionCompleted：完成态宣告词面（供调用方合取条件使用）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { needsToolChoiceRequired } from "../src/gateway/forced-tool.js";
import { claimsActionCompleted, isInjectionAnsweredQuery } from "../src/agent/task-intent.js";

/* ---------------- 办事信号（显式规划升级的确定性输入） ---------------- */

test("needsToolChoiceRequired：提醒/闹钟句式命中（信号）", () => {
  for (const text of [
    "明天早上9点提醒我开会",
    "记得提醒我买菜",
    "每天叫我起床",
    "今晚设个闹钟",
  ]) {
    assert.equal(needsToolChoiceRequired(text), true, `${text} 应命中提醒信号`);
  }
});

test("needsToolChoiceRequired：确认式反问（你会提醒我吗）不命中", () => {
  assert.equal(needsToolChoiceRequired("你会提醒我吗"), false);
});

test("needsToolChoiceRequired：祈使动作请求命中（信号）", () => {
  for (const text of [
    "帮我查查最新的新闻",
    "帮我搜索成龙最近的照片",
    "帮我订明天中午的餐厅",
    "把客厅的灯打开",
  ]) {
    assert.equal(needsToolChoiceRequired(text), true, `${text} 应命中祈使动作信号`);
  }
});

test("needsToolChoiceRequired：闲聊/纯提问/知识问答/既往陈述不命中", () => {
  for (const text of [
    "你还记得 不错不错",
    "电话是什么时候发明的",
    "为什么天空是蓝色的",
    "哈哈笑死我了",
    // 2026-10-21 事故回归：「独立开发」含动作动词词根「开发」，曾被已删除的
    // 「动词+长度」规则判成任务并强制 tool_choice=required，模型被迫搜明星近况。
    "哎呀 这不是在做独立开发吗 我要追我老婆呀",
    "今天分析了一下这个bug，有点意思",
    // 2026-10-22 把字句负例：既往陈述（把前带主语）不是祈使
    "我把门关了",
    "他已经把灯关了就走了",
    // 2026-11-08 事故回归：确认式反问「你知道我在哪吗」曾被位置正则判成
    // 显式动作并触发出口闸打回，产生第二稿复述泡。闸已删，这里回归确认式
    // 反问一律不命中。
    "你知道我在哪吗",
  ]) {
    assert.equal(needsToolChoiceRequired(text), false, `${text} 不该命中办事信号`);
  }
});

/* ---------------- 注入直答判定 ---------------- */

test("isInjectionAnsweredQuery：时间/日期/身份类（天气不在内）", () => {
  assert.equal(isInjectionAnsweredQuery("现在几点了"), true);
  assert.equal(isInjectionAnsweredQuery("今天几号，星期几"), true);
  assert.equal(isInjectionAnsweredQuery("你叫什么"), true);
  // 天气必须真调工具，不能算「注入可答」
  assert.equal(isInjectionAnsweredQuery("明天天气怎么样"), false);
  assert.equal(isInjectionAnsweredQuery("帮我订明天中午的餐厅"), false);
});

/* ---------------- 完成态宣告词面 ---------------- */

test("claimsActionCompleted：外部动作完成宣告命中", () => {
  for (const text of [
    "已经帮你设好提醒了",
    "消息已经发给妈妈了",
    "好的，已经下单了",
    "闹钟已经定了",
    "已经给你转到账了",
    "嗯，已经安排好了",
  ]) {
    assert.equal(claimsActionCompleted(text), true, `${text} 应识别为完成态宣告`);
  }
});

test("claimsActionCompleted：纯口头回应/第三方陈述的词面行为", () => {
  // 注意：词面只负责识别「宣告」本身。「价格已经定了」这类第三方陈述也会
  // 命中词面——它由调用方的合取条件兜底（办事怀疑信号 + 服务端零成功工具），
  // 单独看词面是设计内的宽松。
  for (const text of [
    "我知道了",
    "我记住了",
    "我想好了",
    "已经想好了",
    "今天天气已经发布了预警",
    "哈哈笑死我了",
    "",
  ]) {
    assert.equal(claimsActionCompleted(text), false, `${text} 不该识别为完成态宣告`);
  }
  assert.equal(claimsActionCompleted("价格已经定了，三百块"), true, "词面宽松是设计内的");
});
