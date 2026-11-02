/**
 * 通用浏览器层：所有浏览器能力（购物 / 通用网页操作 / 预订报价）共用的
 * 页面运行时 + human-required 判定 + 人工交接。
 */
export * from "./browser-runtime.js";
export * from "./human-gate.js";
export * from "./browser-human-handoff.js";
