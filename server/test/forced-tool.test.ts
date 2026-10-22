/**
 * 办事信号供给测试（2026-10-22 架构定稿：不预测，只验证）。
 *
 * 请求层已不做任何 tool_choice 预判——原 resolveForcedToolChoice（电话/位置
 * 指定门 + 祈使扳机）整体退役。本文件测的两类东西都只作**出口对账闸的授权**：
 *   - needsToolChoiceRequired / turnSuggestsToolNeed：允许出口闸在「零成功
 *     工具 + 宣称办过」时打回一次 required 续波；
 *   - resolveExplicitActionTool：允许出口闸在「显式动作整轮未执行」时打回
 *     一次 required 续波并指名工具（事前指定门的替代，只看执行记录）。
 * 以及词面工具：claimsActionCompleted / isInjectionAnsweredQuery。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  needsToolChoiceRequired,
  resolveExplicitActionTool,
  turnSuggestsToolNeed,
} from "../src/gateway/forced-tool.js";
import { claimsActionCompleted, isInjectionAnsweredQuery } from "../src/agent/task-intent.js";

/* ---------------- 显式外部动作识别（出口闸指名工具用） ---------------- */

test("resolveExplicitActionTool：显式电话请求 → phone.call_user", () => {
  for (const text of [
    "帮我打个电话给老婆",
    "给妈妈打电话说我晚点回去",
    "帮我打个电话提醒我三点开会",
  ]) {
    assert.equal(resolveExplicitActionTool(text), "phone.call_user", `${text} 应识别为电话动作`);
  }
});

test("resolveExplicitActionTool：明确位置问题 → clock.get_user_location", () => {
  for (const text of ["我现在在哪", "当前位置是哪里", "我所在城市是哪个"]) {
    assert.equal(
      resolveExplicitActionTool(text),
      "clock.get_user_location",
      `${text} 应识别为位置动作`,
    );
  }
});

test("resolveExplicitActionTool：解释性提问/闲聊/实时单一查询不命中", () => {
  for (const text of [
    "电话是什么时候发明的",
    "哈哈笑死我了",
    "现在几点了",
    "明天天气怎么样",
    "帮我查查最新的新闻",
    "把客厅的灯打开",
  ]) {
    assert.equal(resolveExplicitActionTool(text), null, `${text} 不该识别为显式动作`);
  }
});

test("resolveExplicitActionTool：否定句不命中（「别给我打电话」不是请求）", () => {
  for (const text of [
    "别给我打电话",
    "不用打电话了，我马上就到",
    "甭打那个电话",
  ]) {
    assert.equal(resolveExplicitActionTool(text), null, `${text} 是拒绝外呼，不是请求`);
  }
});

/* ---------------- 办事信号（只授权出口闸，不再驱动 tool_choice） ---------------- */

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
  ]) {
    assert.equal(needsToolChoiceRequired(text), false, `${text} 不该命中办事信号`);
  }
});

/* ---------------- 出口对账闸的怀疑信号 ---------------- */

test("turnSuggestsToolNeed：办事类消息命中", () => {
  for (const text of [
    "明天天气怎么样",
    "我钱包余额还有多少",
    "给妈妈发消息说我到家了",
    "明天早上9点提醒我开会",
    "帮我看看最近的日程",
    "查一下我的快递",
  ]) {
    assert.equal(turnSuggestsToolNeed(text), true, `${text} 应命中办事怀疑信号`);
  }
});

test("turnSuggestsToolNeed：闲聊/实时单一查询/知识问答不命中", () => {
  for (const text of [
    "哈哈笑死我了",
    "现在几点了",
    "今天几号",
    "你叫什么名字",
    "为什么天空是蓝色的",
    "什么是量子纠缠",
    "哎呀 这不是在做独立开发吗 我要追我老婆呀",
  ]) {
    assert.equal(turnSuggestsToolNeed(text), false, `${text} 不该命中办事怀疑信号`);
  }
});

test("isInjectionAnsweredQuery：时间/日期/身份类（天气不在内）", () => {
  assert.equal(isInjectionAnsweredQuery("现在几点了"), true);
  assert.equal(isInjectionAnsweredQuery("今天几号，星期几"), true);
  assert.equal(isInjectionAnsweredQuery("你叫什么"), true);
  // 天气必须真调工具，不能算「注入可答」
  assert.equal(isInjectionAnsweredQuery("明天天气怎么样"), false);
  assert.equal(isInjectionAnsweredQuery("帮我订明天中午的餐厅"), false);
});

/* ---------------- 完成态宣告词面（出口对账闸的另一半） ---------------- */

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
