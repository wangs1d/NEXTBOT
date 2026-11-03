/**
 * 实时报价比价抽象层公共出口。
 */

export type {
  QuoteType,
  QuotePriceSource,
  QuoteRequest,
  HotelSearchFilters,
  TravelQuote,
  QuoteSourceResult,
  QuoteSource,
  QuoteSourceOutcome,
  QuoteAggregate,
  QuoteAggregatorOptions,
} from "./quote-source.js";
export { compareQuotes } from "./quote-source.js";
export { QuoteAggregator } from "./quote-aggregator.js";
export { LocalQuoteSource } from "./local-quote-source.js";
export {
  BrowserQuoteSource,
  type BrowserRunner,
  type BrowserQuoteSourceConfig,
} from "./browser-quote-source.js";
export {
  createFlyAiHotelSource,
  createFlyAiFlightSource,
  createDefaultFlyAiRunner,
  flyAiHotelSearchArgs,
  type FlyAiRunner,
  type FlyAiRunResult,
} from "./flyai-quote-source.js";
export {
  createCtripFlightSource,
  parseCtripFlightText,
} from "./site-adapters.js";
export {
  createFliggyHotelWebSource,
  fliggyHotelDetailUrl,
  parseFliggyHotelDetailPrice,
  type FliggyHotelWebSourceDeps,
} from "./hotel-web-price-source.js";
export {
  createSharedBrowserRunner,
  type SharedPageOpener,
} from "./shared-browser-runner.js";
export {
  buildDefaultQuoteSources,
  buildQuoteAggregator,
  type BuildQuoteAggregatorDeps,
} from "./aggregator-factory.js";
