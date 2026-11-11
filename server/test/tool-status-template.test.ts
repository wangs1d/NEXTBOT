import test from "node:test";
import assert from "node:assert/strict";

import { renderToolStatusLine } from "../src/ws/tool-status-template.js";

test("参数化模板：检索类把 query 带进文案", () => {
  assert.equal(
    renderToolStatusLine("search_web", { query: "明天天气" }),
    "我在查「明天天气」",
  );
  assert.equal(renderToolStatusLine("search_web", {}), null);
});

test("参数化模板：天气/购物/日程各取各的字段", () => {
  assert.equal(
    renderToolStatusLine("weather_query", { city: "北京" }),
    "我看下北京的天气",
  );
  assert.equal(
    renderToolStatusLine("shopping.compare.prices", { productName: "耳机" }),
    "我在比「耳机」的价",
  );
  assert.equal(
    renderToolStatusLine("calendar", { action: "create", title: "周会" }),
    "我在排「周会」",
  );
  assert.equal(
    renderToolStatusLine("email.send", { contactName: "老妈" }),
    "我在给老妈写邮件",
  );
});

test("参数化模板：出行带起终点", () => {
  assert.equal(
    renderToolStatusLine("travel_booking.search", { from: "上海", to: "成都" }),
    "我在看上海到成都的票",
  );
  assert.equal(
    renderToolStatusLine("ride_hailing.book", { to: "公司" }),
    "我叫车去公司",
  );
});

test("参数化模板：网页抓取族不亮域名，交给客户端兜底", () => {
  // 「我在读example.com」这种域名直出生硬且无信息量 → 返回 null，
  // 客户端用工具族文案（「我上网读读这篇」）。
  assert.equal(
    renderToolStatusLine("fetch_web", { url: "https://www.example.com/a/b?c=1" }),
    null,
  );
});

test("参数化模板：内部标识与超长参数不复述", () => {
  // snake_case / dotted 参数不是人话，整条丢弃 → 交给客户端工具族映射表
  assert.equal(renderToolStatusLine("search_web", { query: "get_user_profile" }), null);
  // 超长截断，不把整段正文搬进状态位
  assert.equal(
    renderToolStatusLine("search_web", { query: "一二三四五六七八九十一二三四五六七八" }),
    "我在查「一二三四五六七八九十一二三四…」",
  );
});

test("参数化模板：没命中规则或无参数时返回 null（客户端兜底）", () => {
  assert.equal(renderToolStatusLine("unknown.tool", { query: "x1" }), null);
  assert.equal(renderToolStatusLine("weather_query", {}), null);
  assert.equal(renderToolStatusLine("", { query: "x1" }), null);
});
