/**
 * @nextbot/agent-protocol
 *
 * Agent 系统的正式线缆契约（wire contract）：外壳（shell）、gateway、runtime
 * 三方共用的事件信封、载荷类型、chat turn 入参 schema 与统一错误码。
 * 换外壳 / 换 runtime 实现时，以本包为唯一兼容性承诺面。
 */
export * from "./events.js";
export * from "./unified-errors.js";
export * from "./client-location.js";
export * from "./schemas.js";
export * from "./display-effects.js";
