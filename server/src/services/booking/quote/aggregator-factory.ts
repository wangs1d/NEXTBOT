/**
 * 报价聚合器工厂：组装默认源集（local 保底 + 飞猪 FlyAI 实时源 + 可选浏览器代查源）。
 *
 * bootstrap 调用一次，注入 TravelTicketProvider。源可用性由各自 fetch 内部判定
 * （flyai CLI 未装 / Playwright 未装都如实返回错误，聚合器如实汇总），故这里无条件挂载。
 */

import type { BrowserRunner } from "./browser-quote-source.js";
import type { QuoteSource, QuoteAggregatorOptions } from "./quote-source.js";
import { QuoteAggregator } from "./quote-aggregator.js";
import { LocalQuoteSource } from "./local-quote-source.js";
import {
  createFlyAiHotelSource,
  createFlyAiFlightSource,
  createDefaultFlyAiRunner,
  type FlyAiRunner,
} from "./flyai-quote-source.js";
import { createCtripFlightSource } from "./site-adapters.js";
import { createFliggyHotelWebSource } from "./hotel-web-price-source.js";

export interface BuildQuoteAggregatorDeps {
  /** 飞猪 flyai CLI 执行器（测试注入桩）；缺省 = 调 PATH 里的真实 flyai */
  flyAiRunner?: FlyAiRunner | null;
  browserRunner?: BrowserRunner | null;
  /**
   * 用户可见内置浏览器执行器（API 给不出实价时的代查通道，如飞猪体验模式脱敏价）。
   * 缺省 = 不挂载浏览器补价源。
   */
  sharedBrowserRunner?: BrowserRunner | null;
  /** 显式覆盖源集（测试用）；缺省 = local + 飞猪 FlyAI + 已配置的浏览器代查源 */
  sources?: QuoteSource[];
  options?: QuoteAggregatorOptions;
}

export function buildDefaultQuoteSources(deps: BuildQuoteAggregatorDeps): QuoteSource[] {
  if (deps.sources) return deps.sources;
  const flyai = deps.flyAiRunner ?? createDefaultFlyAiRunner();
  const sources: QuoteSource[] = [
    new LocalQuoteSource(),
    createFlyAiHotelSource(flyai),
    createFlyAiFlightSource(flyai),
  ];
  if (deps.browserRunner) sources.push(createCtripFlightSource(deps.browserRunner));
  if (deps.sharedBrowserRunner) {
    sources.push(createFliggyHotelWebSource({ flyai, browser: deps.sharedBrowserRunner }));
  }
  return sources;
}

export function buildQuoteAggregator(deps: BuildQuoteAggregatorDeps): QuoteAggregator {
  return new QuoteAggregator(buildDefaultQuoteSources(deps), deps.options);
}
