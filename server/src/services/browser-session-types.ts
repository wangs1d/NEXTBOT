import type { BrowserSessionSiteId } from "./browser-session-sites.js";

/** 与 Chrome 扩展 / EditThisCookie 等导出的 JSON 数组兼容。 */
export type ImportedBrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
};

export type PersistedBrowserSiteSession = {
  siteId: BrowserSessionSiteId;
  label: string;
  cookiesEnc: string;
  importedAt: string;
  updatedAt: string;
  /** 用户是否允许 Agent 使用此站登录态读价（默认 false） */
  agentAllowed: boolean;
  cookieCount: number;
};

export type ActorBrowserSessionsFile = {
  actorId: string;
  sites: Record<string, PersistedBrowserSiteSession>;
  /**
   * 登录态保存授权（2026-10-25 用户拍板：保存 Cookie 须用户同意，与主流做法
   * 一致）。siteId → { allowed, at }；缺省 = 未表态（先征询再保存）。
   */
  captureConsents?: Record<string, { allowed: boolean; at: string }>;
};
