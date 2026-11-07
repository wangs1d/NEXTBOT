import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAndSelectStrategy,
  isWeatherCardRound,
  WEATHER_CARD_INSTRUCTION,
} from "../src/agent/synthesis-strategy.js";

/**
 * 回归背景（2026-10-08「天气卡下方复读数据表格」修复）：
 * 天气轮此前走常规数据质量分档，天气回执被评成 medium 档 →
 * layered_progressive 的「先给出已确认的事实（有数据支撑的部分）」
 * 把模型教成「## 标题 + > 引用 + |项目|数值| 表格」（复述数据当事实层）
 * + 穿搭建议（推断层）。天气数值已由 tool-card-registry 从工具回执
 * 确定性构建成结构化天气卡，正文再复述就是同屏双份。
 */

test("天气卡轮命中 weather_card 策略，注入卡片专用指令", () => {
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "weather.get_local",
        ok: true,
        result: {
          ok: true,
          weatherText: "小雨",
          todayRangeC: "18–24℃",
          humidityPct: 87,
          windKph: 4.2,
          precipitationProbabilityPct: 8,
          clothingAdvice: "长袖+薄外套，出门带伞",
          summary: "成都 · 明天天气",
        },
      },
    ],
    "明天穿什么合适",
  );
  assert.equal(directive.strategy, "weather_card");
  assert.equal(directive.instruction, WEATHER_CARD_INSTRUCTION);
  // 2026-11-05 用户拍板：天气轮的回复引导保留——三条硬边界（数值上卡不重复、
  // 坐标不给用户、口语建议收束）都是有用的结构化引导。
  assert.match(directive.instruction, /正文里不要再出现/);
  assert.match(directive.instruction, /经纬度坐标/);
  assert.match(directive.instruction, /口语给结论和建议/);
});

test("天气+搜索混合轮不走 weather_card，仍按常规分档", () => {
  const directive = evaluateAndSelectStrategy(
    [
      {
        toolName: "weather.get_local",
        ok: true,
        result: { weatherText: "晴", todayRangeC: "20–28℃", summary: "北京" },
      },
      {
        toolName: "search_web",
        ok: true,
        result: { items: [{ title: "香山红叶攻略", snippet: "正文" }] },
      },
    ],
    "北京天气怎么样，适合去香山看红叶吗",
  );
  assert.notEqual(directive.strategy, "weather_card");
});

test("weather 工具失败的轮次不是天气卡轮", () => {
  assert.equal(isWeatherCardRound([{ toolName: "weather.get_local", ok: false }]), false);
});

test("没有 weather 工具的轮次不是天气卡轮", () => {
  assert.equal(isWeatherCardRound([{ toolName: "clock.get_current_time", ok: true }]), false);
});
