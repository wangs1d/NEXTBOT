import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { decryptJson, encryptJson } from "./browser-session-crypto.js";
import {
  BROWSER_SESSION_SITES,
  hostMatchesSite,
  isBrowserSessionSiteId,
  resolveSiteIdFromUrl,
  type BrowserSessionSiteId,
} from "./browser-session-sites.js";
import type {
  ActorBrowserSessionsFile,
  ImportedBrowserCookie,
  PersistedBrowserSiteSession,
} from "./browser-session-types.js";

export type BrowserSiteStatus = {
  siteId: BrowserSessionSiteId;
  label: string;
  homeUrl: string;
  hasCookies: boolean;
  agentAllowed: boolean;
  cookieCount: number;
  importedAt?: string;
  updatedAt?: string;
};

export class BrowserSessionService {
  private readonly cache = new Map<string, ActorBrowserSessionsFile>();

  private get dataDir(): string {
    return process.env.BROWSER_SESSION_DATA_DIR ?? join(getDataDir(), "browser-sessions");
  }

  private filePath(actorId: string): string {
    const safe = actorId.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return join(this.dataDir, `${safe}.json`);
  }

  async listSiteCatalog(): Promise<
    Array<{ siteId: BrowserSessionSiteId; label: string; homeUrl: string }>
  > {
    return (Object.keys(BROWSER_SESSION_SITES) as BrowserSessionSiteId[]).map((siteId) => ({
      siteId,
      label: BROWSER_SESSION_SITES[siteId].label,
      homeUrl: BROWSER_SESSION_SITES[siteId].homeUrl,
    }));
  }

  async listStatuses(actorId: string): Promise<BrowserSiteStatus[]> {
    const file = await this.loadActor(actorId);
    return (Object.keys(BROWSER_SESSION_SITES) as BrowserSessionSiteId[]).map((siteId) => {
      const row = file.sites[siteId];
      const meta = BROWSER_SESSION_SITES[siteId];
      return {
        siteId,
        label: meta.label,
        homeUrl: meta.homeUrl,
        hasCookies: Boolean(row?.cookiesEnc),
        agentAllowed: row?.agentAllowed === true,
        cookieCount: row?.cookieCount ?? 0,
        importedAt: row?.importedAt,
        updatedAt: row?.updatedAt,
      };
    });
  }

  async importCookies(
    actorId: string,
    siteId: string,
    cookies: ImportedBrowserCookie[],
    opts?: { agentAllowed?: boolean },
  ): Promise<BrowserSiteStatus> {
    if (!isBrowserSessionSiteId(siteId)) {
      throw new Error(`不支持的站点 siteId: ${siteId}`);
    }
    const normalized = normalizeCookies(cookies, siteId);
    if (normalized.length === 0) {
      throw new Error("cookies 为空或域名与站点不匹配");
    }

    const now = new Date().toISOString();
    const file = await this.loadActor(actorId);
    const row: PersistedBrowserSiteSession = {
      siteId,
      label: BROWSER_SESSION_SITES[siteId].label,
      cookiesEnc: encryptJson(normalized),
      importedAt: file.sites[siteId]?.importedAt ?? now,
      updatedAt: now,
      agentAllowed: opts?.agentAllowed === true,
      cookieCount: normalized.length,
    };
    file.sites[siteId] = row;
    await this.saveActor(file);
    const statuses = await this.listStatuses(actorId);
    return statuses.find((s) => s.siteId === siteId)!;
  }

  async setAgentAllowed(
    actorId: string,
    siteId: string,
    agentAllowed: boolean,
  ): Promise<BrowserSiteStatus> {
    if (!isBrowserSessionSiteId(siteId)) {
      throw new Error(`不支持的站点 siteId: ${siteId}`);
    }
    const file = await this.loadActor(actorId);
    const row = file.sites[siteId];
    if (!row?.cookiesEnc) {
      throw new Error(`尚未导入 ${BROWSER_SESSION_SITES[siteId].label} 的 Cookie，请先导入`);
    }
    row.agentAllowed = agentAllowed;
    row.updatedAt = new Date().toISOString();
    await this.saveActor(file);
    const statuses = await this.listStatuses(actorId);
    return statuses.find((s) => s.siteId === siteId)!;
  }

  /**
   * 登录态捕获写入（「一次登录一直使用」）。
   *
   * 与手动 importCookies 的区别：
   *   - 扫码登录成功 / 用户本人在内置浏览器登录后，由服务端自动捕获调用——
   *     用户本人的登录动作即授权，新行可直接置 agentAllowed=true；
   *   - 已有行只刷新 Cookie，授权**只升不降**（绝不静默重置/清除）：
   *     手动导入后未授权（agentAllowed=false）的行不会被本次捕获悄悄升权，
   *     除非显式传 opts.agentAllowed=true；
   *   - 无删除语义：不清理旧行、不过滤过期 cookie（由使用方检测登录失效）。
   */
  async updateCookiesFromLogin(
    actorId: string,
    siteId: string,
    cookies: ImportedBrowserCookie[],
    opts?: { agentAllowed?: boolean },
  ): Promise<BrowserSiteStatus> {
    if (!isBrowserSessionSiteId(siteId)) {
      throw new Error(`不支持的站点 siteId: ${siteId}`);
    }
    const normalized = normalizeCookies(cookies, siteId);
    if (normalized.length === 0) {
      throw new Error("捕获的 cookies 为空或域名与站点不匹配");
    }

    const now = new Date().toISOString();
    const file = await this.loadActor(actorId);
    const previous = file.sites[siteId];
    const row: PersistedBrowserSiteSession = {
      siteId,
      label: BROWSER_SESSION_SITES[siteId].label,
      cookiesEnc: encryptJson(normalized),
      importedAt: previous?.importedAt ?? now,
      updatedAt: now,
      agentAllowed: previous?.agentAllowed === true || opts?.agentAllowed === true,
      cookieCount: normalized.length,
    };
    file.sites[siteId] = row;
    await this.saveActor(file);
    const statuses = await this.listStatuses(actorId);
    return statuses.find((s) => s.siteId === siteId)!;
  }

  async revoke(actorId: string, siteId: string): Promise<void> {
    if (!isBrowserSessionSiteId(siteId)) {
      throw new Error(`不支持的站点 siteId: ${siteId}`);
    }
    const file = await this.loadActor(actorId);
    delete file.sites[siteId];
    await this.saveActor(file);
  }

  async getCookiesForAgent(
    actorId: string,
    siteId: BrowserSessionSiteId,
  ): Promise<ImportedBrowserCookie[]> {
    const file = await this.loadActor(actorId);
    const row = file.sites[siteId];
    if (!row?.cookiesEnc) {
      throw new Error(`未导入 ${BROWSER_SESSION_SITES[siteId].label} Cookie`);
    }
    if (!row.agentAllowed) {
      throw new Error(
        `用户未授权 Agent 操作 ${BROWSER_SESSION_SITES[siteId].label}。请在客户端将 agentAllowed 设为 true（POST /integrations/browser-sessions/consent）。`,
      );
    }
    return decryptJson<ImportedBrowserCookie[]>(row.cookiesEnc);
  }

  assertUrlAllowedForSite(url: string, siteId: BrowserSessionSiteId): void {
    const resolved = resolveSiteIdFromUrl(url);
    if (resolved !== siteId) {
      throw new Error(`URL 主机与站点 ${siteId} 不匹配`);
    }
  }

  resolveSiteForUrl(url: string): BrowserSessionSiteId | null {
    return resolveSiteIdFromUrl(url);
  }

  private async loadActor(actorId: string): Promise<ActorBrowserSessionsFile> {
    const cached = this.cache.get(actorId);
    if (cached) return cached;

    const path = this.filePath(actorId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as ActorBrowserSessionsFile;
      const file: ActorBrowserSessionsFile = {
        actorId,
        sites: parsed.sites ?? {},
      };
      this.cache.set(actorId, file);
      return file;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        const empty: ActorBrowserSessionsFile = { actorId, sites: {} };
        this.cache.set(actorId, empty);
        return empty;
      }
      throw e;
    }
  }

  private async saveActor(file: ActorBrowserSessionsFile): Promise<void> {
    const path = this.filePath(file.actorId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2), "utf8");
    this.cache.set(file.actorId, file);
  }
}

function normalizeCookies(
  cookies: ImportedBrowserCookie[],
  siteId: BrowserSessionSiteId,
): ImportedBrowserCookie[] {
  const out: ImportedBrowserCookie[] = [];
  for (const raw of cookies) {
    const name = String(raw.name ?? "").trim();
    const value = String(raw.value ?? "");
    if (!name) continue;
    // RFC 6265：cookie value 不得包含分号/逗号/空白/引号/反斜杠等——
    // 带 ';' 的值会在 Playwright addCookies 处变成晦涩的 "Invalid cookie fields"，
    // 常见原因是导出格式不对（整段 "k=v; k2=v2" 粘进了 value）。这里提前给出可读报错。
    if (/[;,\s"\\]/.test(value)) {
      throw new Error(
        `Cookie「${name}」的 value 含非法字符（; , 空白 引号等）。` +
          `请检查导出格式：应导出 JSON 数组（[{ name, value, domain, ... }]），不要把整段 "k=v; k2=v2" 文本粘进单个 value`,
      );
    }
    const domain = String(raw.domain ?? "").trim().replace(/^\./, "");
    if (domain) {
      const host = domain.toLowerCase();
      if (!hostMatchesSite(host, siteId) && !BROWSER_SESSION_SITES[siteId].hosts.some((h) => host.endsWith(h))) {
        continue;
      }
    }
    out.push({
      name,
      value,
      domain: raw.domain,
      path: raw.path ?? "/",
      expires: typeof raw.expires === "number" ? raw.expires : undefined,
      httpOnly: raw.httpOnly,
      secure: raw.secure,
      sameSite: raw.sameSite,
    });
  }
  return out;
}
