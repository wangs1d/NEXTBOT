import test from "node:test";
import assert from "node:assert/strict";

import { resolveForcedToolChoice } from "../src/gateway/forced-tool.js";

function fnTool(name: string) {
  return { type: "function" as const, function: { name } };
}

test("显式电话请求强制 phone.call_user（工具名以注册名为准）", () => {
  const choice = resolveForcedToolChoice(
    "帮我打个电话提醒我三点开会",
    [fnTool("phone.call_user"), fnTool("search_web")],
  );
  assert.deepEqual(choice, { type: "function", function: { name: "phone.call_user" } });
});

test("电话未在工具列表时电话分支不强制", () => {
  const choice = resolveForcedToolChoice("帮我打个电话", [fnTool("search_web")]);
  assert.equal(choice, "auto");
});

test("解释性提问不触发电话强制路由", () => {
  const choice = resolveForcedToolChoice(
    "电话是什么时候发明的",
    [fnTool("phone.call_user")],
  );
  assert.equal(choice, "auto");
});

test("问时间不再强制 clock.get_current_time（2026-10-11 口径：以【当前时间】块为准）", () => {
  const choice = resolveForcedToolChoice(
    "现在几点了",
    [fnTool("clock.get_current_time"), fnTool("clock.get_user_location")],
  );
  assert.equal(choice, "auto");
});

test("问时间不再强制（含日期/星期式提问）", () => {
  const choice = resolveForcedToolChoice(
    "今天几号，星期几",
    [fnTool("clock.get_current_time")],
  );
  assert.equal(choice, "auto");
});

test("问当前位置强制 clock.get_user_location（注册名带点号）", () => {
  const choice = resolveForcedToolChoice(
    "我现在在哪",
    [fnTool("clock.get_current_time"), fnTool("clock.get_user_location")],
  );
  assert.deepEqual(choice, { type: "function", function: { name: "clock.get_user_location" } });
});

test("Fast 模式跳过位置强制（system prompt 已注入定位上下文）", () => {
  const choice = resolveForcedToolChoice(
    "我现在在哪",
    [fnTool("clock.get_user_location")],
    true,
  );
  assert.equal(choice, "auto");
});

test("明确动作/取料请求 → tool_choice=required（2026-10-21 请求层强制，替代后置闸）", () => {
  for (const text of [
    "帮我查查最新的新闻",
    "帮我搜索成龙最近的照片",
    "明天早上9点提醒我开会",
    "帮我订明天中午的餐厅",
  ]) {
    const choice = resolveForcedToolChoice(text, [fnTool("search_web"), fnTool("reminder.plan")]);
    assert.equal(choice, "required", `${text} 应强制本轮至少调一个工具`);
  }
});

test("闲聊/纯提问/知识问答 → auto（不强制工具）", () => {
  for (const text of [
    "你还记得 不错不错",
    "电话是什么时候发明的",
    "为什么天空是蓝色的",
    "哈哈笑死我了",
  ]) {
    const choice = resolveForcedToolChoice(text, [fnTool("search_web")]);
    assert.equal(choice, "auto", `${text} 不该被强制调用工具`);
  }
});

test("Fast 模式跳过 required 强制（system 已注入上下文，避免多一次 round trip）", () => {
  const choice = resolveForcedToolChoice(
    "帮我查查最新的新闻",
    [fnTool("search_web")],
    true,
  );
  assert.equal(choice, "auto");
});
