/**
 * 兼容导出：通用人工交接已迁到 `services/browser-runtime/browser-human-handoff.ts`。
 *
 * 购物比价/搜索沿用 platformLabels 入参，内部统一映射到通用交接（continueStep
 * 固定为「继续抓取报价」）；新代码请直接使用 requestBrowserHumanHandoff。
 */
import { requestBrowserHumanHandoff } from "../services/browser-runtime/browser-human-handoff.js";

export interface PlatformLoginHandoffInput {
  actorId: string;
  sessionId: string;
  /** 平台显示名（京东 / 拼多多）；单平台时用 */
  platformLabel?: string;
  /** 多平台统一交接时用（与 platformLabel 合并去重） */
  platformLabels?: string[];
  /** 任务一句话（写进计划 goal，续跑时给模型上下文） */
  goal?: string;
  /** login=登录墙；captcha=安全验证（滑块/验证码） */
  reason?: "login" | "captcha";
}

export type PlatformLoginHandoffResult =
  | { ok: true; stepId: string }
  | { ok: false; error: string };

export function requestPlatformLoginHandoff(
  input: PlatformLoginHandoffInput,
): PlatformLoginHandoffResult {
  return requestBrowserHumanHandoff({
    actorId: input.actorId,
    sessionId: input.sessionId,
    siteLabels: [...(input.platformLabels ?? []), input.platformLabel ?? ""].filter(Boolean),
    reason: input.reason === "captcha" ? "captcha" : "login",
    ...(input.goal ? { goal: input.goal } : {}),
    continueStep: "继续抓取报价",
  });
}
