import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import QRCode from "qrcode";

import {
  OpenClawGatewayClient,
  OpenClawWebLoginSession,
  isWechatClawFeatureEnabled,
  readOpenClawGatewayConfig,
  readOpenClawWeixinChannelId,
  type OpenClawWebLoginResult,
} from "./openclaw-gateway-client.js";
import { syncOpenClawAgentModel } from "./openclaw-config-sync.js";

export type WechatClawBindingRecord = {
  actorId: string;
  channel: string;
  accountId?: string;
  boundAt: string;
  lastQrMessage?: string;
};

export type WechatClawStatus = {
  enabled: boolean;
  gatewayReachable: boolean;
  bound: boolean;
  channelConnected: boolean;
  boundAt: string | null;
  channel: string;
  actorId: string;
  message: string | null;
  weixinAccountId: string | null;
};

type Persisted = {
  bindings: Record<string, WechatClawBindingRecord>;
};

/** 缓存的二维码，避免每次调用都重新 spawn CLI */
type QrCache = {
  qrDataUrl: string;
  rawLink: string;
  sessionKey: string;
  createdAt: number;
  cliProcess: import("node:child_process").ChildProcess | null;
  loginVia: "gateway" | "cli";
  gatewaySession: OpenClawWebLoginSession | null;
};

/** 从 openclaw channels login 输出中提取 liteapp 链接 */
function extractQrLink(output: string): string | null {
  const match = output.match(/https:\/\/liteapp\.weixin\.qq\.com\/q\/[^"&\s]+/);
  return match?.[0] ? normalizeLiteappQrUrl(match[0]) : null;
}

/** 二维码有效期（毫秒）——微信二维码约 2 分钟有效，这里设 100s 让前端有足够时间刷新 */
const QR_CACHE_TTL_MS = 100_000;

const DEFAULT_ILINK_BOT_TYPE = "3";

/** liteapp 链接必须带 bot_type，否则微信扫码常报「网络错误」。 */
function normalizeLiteappQrUrl(url: string, botType = DEFAULT_ILINK_BOT_TYPE): string {
  const trimmed = url.trim();
  if (!trimmed || !/liteapp\.weixin\.qq\.com/i.test(trimmed)) return trimmed;
  if (/[?&]bot_type=/i.test(trimmed)) return trimmed;
  return `${trimmed}${trimmed.includes("?") ? "&" : "?"}bot_type=${encodeURIComponent(botType)}`;
}

function pickQrLink(result: OpenClawWebLoginResult): string {
  const direct = result.qrLink?.trim();
  if (direct) return normalizeLiteappQrUrl(direct);
  const url = result.qrDataUrl?.trim() ?? "";
  if (/^https?:\/\//i.test(url) && !url.startsWith("data:")) return normalizeLiteappQrUrl(url);
  const fromMsg = extractQrLink(result.message ?? "");
  return fromMsg ? normalizeLiteappQrUrl(fromMsg) : "";
}

function pickSessionKey(
  result: OpenClawWebLoginResult,
  fallbackAccountId: string,
): string {
  const key = result.sessionKey?.trim();
  if (key) return key;
  return fallbackAccountId;
}

function hasValidQrCache(cache: QrCache | null): cache is QrCache {
  if (!cache) return false;
  return Boolean(cache.rawLink.trim() || cache.qrDataUrl.trim());
}

/** 缓存二维码仍有关联的登录会话（CLI 进程或 Gateway WS）。 */
function hasLiveQrSession(cache: QrCache | null): cache is QrCache {
  if (!hasValidQrCache(cache)) return false;
  if (Date.now() - cache.createdAt >= QR_CACHE_TTL_MS) return false;
  if (cache.loginVia === "cli") {
    const proc = cache.cliProcess;
    return proc != null && proc.exitCode === null;
  }
  return cache.loginVia === "gateway" && cache.gatewaySession != null;
}

function loginPayload(
  cache: QrCache | null,
  extra: { connected?: boolean; message?: string },
): OpenClawWebLoginResult & { ok: true } {
  const link = cache?.rawLink ?? "";
  const dataUrl = cache?.qrDataUrl ?? "";
  return {
    ok: true,
    connected: extra.connected ?? false,
    message: extra.message,
    qrLink: link || undefined,
    qrDataUrl: link ? undefined : dataUrl || undefined,
  };
}

export class WechatClawBindingService {
  private readonly gateway: OpenClawGatewayClient;
  private readonly channelId: string;
  private readonly pendingByActor = new Map<string, { startedAt: number }>();

  /** 全局二维码缓存（所有 actor 共享一个活跃的扫码会话） */
  private qrCache: QrCache | null = null;

  /** Gateway 后台 wait 任务（start 后立即启动，保持 liteapp 会话有效） */
  private gatewayWaitTask: Promise<void> | null = null;

  /** 后台 wait 检测到扫码成功时写入，供 HTTP wait 快速返回 */
  private recentConnect: { actorId: string; message: string } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    gateway?: OpenClawGatewayClient,
  ) {
    this.gateway = gateway ?? new OpenClawGatewayClient(readOpenClawGatewayConfig(env));
    this.channelId = readOpenClawWeixinChannelId(env);
  }

  isEnabled(): boolean {
    return isWechatClawFeatureEnabled(this.env);
  }

  private get persistPath(): string {
    return this.env.WECHAT_CLAW_BINDING_FILE ?? join(getDataDir(), "wechat-claw-bindings.json");
  }

  async load(): Promise<void> {
    /* 按需读写；启动无需预加载 */
  }

  // ─── 持久化 ──────────────────────────────────────────────

  private async readPersisted(): Promise<Persisted> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as Persisted;
      return { bindings: data.bindings ?? {} };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { bindings: {} };
      throw e;
    }
  }

  private async writePersisted(data: Persisted): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(data, null, 2), "utf8");
  }

  // ─── 工具方法 ────────────────────────────────────────────

  private accountIdFor(actorId: string): string | undefined {
    const raw = this.env.WECHAT_CLAW_ACCOUNT_ID?.trim();
    if (raw) return raw;
    const perActor = this.env.WECHAT_CLAW_ACCOUNT_ID_PREFIX?.trim();
    if (perActor) return `${perActor}${actorId}`;
    return undefined;
  }

  private closeGatewayLoginSession(): void {
    try {
      this.qrCache?.gatewaySession?.close();
    } catch {
      /* ignore */
    }
    if (this.qrCache) {
      this.qrCache.gatewaySession = null;
    }
  }

  private clearQrCache(): void {
    if (this.qrCache?.cliProcess) {
      try {
        this.qrCache.cliProcess.kill();
      } catch {
        /* ignore */
      }
    }
    this.closeGatewayLoginSession();
    this.qrCache = null;
  }

  private ensureGatewayWaitLoop(actorId: string): void {
    if (this.gatewayWaitTask) return;
    if (!this.qrCache?.gatewaySession) return;
    if (!this.pendingByActor.has(actorId)) return;
    this.gatewayWaitTask = this.runGatewayWaitLoop(actorId).finally(() => {
      this.gatewayWaitTask = null;
    });
  }

  /** 在 start 同一 WebSocket 上持续 wait，避免微信 liteapp 扫码报「网络错误」。 */
  private async runGatewayWaitLoop(actorId: string): Promise<void> {
    const bindAccountId = this.accountIdFor(actorId) ?? actorId;

    while (this.qrCache?.gatewaySession && this.pendingByActor.has(actorId)) {
      const session = this.qrCache.gatewaySession;
      const sessionKey = this.qrCache.sessionKey;
      const qrForGateway = this.qrCache.qrDataUrl.startsWith("data:")
        ? this.qrCache.qrDataUrl
        : undefined;

      try {
        const gw = await session.wait({
          timeoutMs: 480_000,
          currentQrDataUrl: qrForGateway,
          accountId: sessionKey,
        });

        if (gw.connected) {
          const message = gw.message ?? "微信扫码绑定成功";
          await this.markBound(actorId, bindAccountId, message);
          this.recentConnect = { actorId, message };
          this.pendingByActor.delete(actorId);
          this.clearQrCache();
          return;
        }

        if (!this.qrCache) return;

        const link = pickQrLink(gw);
        if (link && link !== this.qrCache.rawLink) {
          this.qrCache.rawLink = link;
          this.qrCache.createdAt = Date.now();
        }
        const dataUrl = gw.qrDataUrl?.trim();
        if (dataUrl?.startsWith("data:")) {
          this.qrCache.qrDataUrl = dataUrl;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  private parseChannelConnected(snapshot: Record<string, unknown>): boolean {
    const accounts = snapshot.channelAccounts as Record<string, unknown> | undefined;
    const list = accounts?.[this.channelId];
    if (Array.isArray(list)) {
      for (const item of list) {
        const acc = item as Record<string, unknown>;
        if (acc.running === true || acc.connected === true) return true;
      }
    }

    const channels = snapshot.channels as Record<string, unknown> | undefined;
    const summary = channels?.[this.channelId] as Record<string, unknown> | undefined;
    if (!summary) return false;
    if (summary.connected === true || summary.running === true) return true;
    const linked = summary.linked ?? summary.loggedIn ?? summary.ok;
    return linked === true;
  }

  private parseWeixinAccount(snapshot: Record<string, unknown>): string | null {
    const defaults = snapshot.channelDefaultAccountId as Record<string, string> | undefined;
    const defaultId = defaults?.[this.channelId]?.trim();
    if (defaultId) return defaultId;

    const accounts = snapshot.channelAccounts as Record<string, unknown> | undefined;
    const list = accounts?.[this.channelId];
    if (Array.isArray(list)) {
      for (const item of list) {
        const acc = item as Record<string, unknown>;
        const id = acc.accountId;
        if (typeof id === "string" && id.trim()) return id.trim();
      }
    }

    const channelAccounts = accounts?.[this.channelId] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (channelAccounts && !Array.isArray(channelAccounts)) {
      const ids = Object.keys(channelAccounts);
      return ids[0] ?? null;
    }
    return null;
  }

  // ─── 状态查询 ────────────────────────────────────────────

  async getStatus(actorId: string): Promise<WechatClawStatus> {
    const enabled = this.isEnabled();
    const persisted = await this.readPersisted();
    const local = persisted.bindings[actorId] ?? null;

    if (!enabled) {
      return {
        enabled: false,
        gatewayReachable: false,
        bound: Boolean(local),
        channelConnected: false,
        boundAt: local?.boundAt ?? null,
        channel: this.channelId,
        actorId,
        message: "未配置 OpenClaw Gateway（设置 OPENCLAW_GATEWAY_WS_URL 与 OPENCLAW_GATEWAY_TOKEN）",
        weixinAccountId: local?.accountId ?? null,
      };
    }

    let gatewayReachable = false;
    let channelConnected = false;
    let weixinAccountId: string | null = local?.accountId ?? null;
    let message: string | null = null;

    try {
      const snapshot = await this.gateway.channelsStatus(Boolean(local));
      gatewayReachable = true;
      channelConnected = this.parseChannelConnected(snapshot);
      weixinAccountId = this.parseWeixinAccount(snapshot) ?? weixinAccountId;
      if (channelConnected && !local) {
        message = "Gateway 显示微信渠道已连接，但本服务尚未记录绑定";
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    const bound = Boolean(local) || channelConnected;

    return {
      enabled: true,
      gatewayReachable,
      bound,
      channelConnected,
      boundAt: local?.boundAt ?? null,
      channel: this.channelId,
      actorId,
      message,
      weixinAccountId,
    };
  }

  // ─── 启动登录（获取二维码） ─────────────────────────────

  /**
   * 获取微信扫码二维码。
   * 使用缓存机制：如果缓存有效则立即返回，否则后台启动 CLI 并生成新二维码。
   */
  async startLogin(actorId: string, force = false): Promise<OpenClawWebLoginResult & { ok: true }> {
    if (!this.isEnabled()) {
      throw new Error("微信 Claw 未启用（请设置 WECHAT_CLAW_ENABLED=1 并启动 OpenClaw Gateway）");
    }

    if (
      !force &&
      hasLiveQrSession(this.qrCache)
    ) {
      this.pendingByActor.set(actorId, { startedAt: Date.now() });
      this.ensureGatewayWaitLoop(actorId);
      return loginPayload(this.qrCache, { message: "请用微信扫描二维码" });
    }

    this.recentConnect = null;
    this.gatewayWaitTask = null;

    if (this.qrCache?.cliProcess) {
      try {
        this.qrCache.cliProcess.kill();
      } catch {
        /* ignore */
      }
    }
    this.closeGatewayLoginSession();

    const accountId = this.accountIdFor(actorId) ?? actorId;

    // 优先 CLI：与 `openclaw channels login` 一致，start+wait 不断链，二维码 URL 含 bot_type。
    try {
      const cliResult = await this.refreshQrCache(accountId);
      if (cliResult.rawLink.trim()) {
        this.pendingByActor.set(actorId, { startedAt: Date.now() });
        this.qrCache = {
          qrDataUrl: cliResult.qrDataUrl,
          rawLink: cliResult.rawLink,
          sessionKey: accountId,
          createdAt: Date.now(),
          cliProcess: cliResult.cliProcess,
          loginVia: "cli",
          gatewaySession: null,
        };
        return loginPayload(this.qrCache, { message: "请用微信扫描二维码" });
      }
    } catch {
      /* CLI 不可用时回退 Gateway API */
    }

    try {
      const loginSession = await this.gateway.openWebLoginSession();
      const gw = await loginSession.start({
        force,
        accountId,
        timeoutMs: 8_000,
      });

      if (gw.connected) {
        loginSession.close();
        await this.markBound(actorId, accountId, gw.message ?? "Gateway 已连接");
        this.pendingByActor.delete(actorId);
        this.qrCache = null;
        return { ok: true, connected: true, message: gw.message ?? "微信扫码绑定成功" };
      }

      const link = pickQrLink(gw);
      const dataUrl =
        gw.qrDataUrl?.trim().startsWith("data:") === true ? gw.qrDataUrl!.trim() : "";
      if (link || dataUrl) {
        this.qrCache = {
          qrDataUrl: dataUrl,
          rawLink: link,
          sessionKey: pickSessionKey(gw, accountId),
          createdAt: Date.now(),
          cliProcess: null,
          loginVia: "gateway",
          gatewaySession: loginSession,
        };
        this.pendingByActor.set(actorId, { startedAt: Date.now() });
        this.ensureGatewayWaitLoop(actorId);
        return loginPayload(this.qrCache, { message: gw.message ?? "请用微信扫描二维码" });
      }
      loginSession.close();
    } catch {
      /* Gateway 不可用时已在上方尝试 CLI */
    }

    throw new Error("无法获取微信二维码，请确认 Gateway 在运行且已执行 npm run setup:openclaw");
  }

  private async fillQrDataUrlInBackground(link: string): Promise<void> {
    try {
      const qrDataUrl = await QRCode.toDataURL(link, {
        width: 240,
        margin: 1,
        errorCorrectionLevel: "L",
      });
      if (this.qrCache?.rawLink === link) {
        this.qrCache.qrDataUrl = qrDataUrl;
      }
    } catch {
      /* ignore */
    }
  }

  private resolveOpenClawCommand(): string {
    if (process.platform === "win32") {
      const npmOpenclaw = this.env.APPDATA
        ? join(this.env.APPDATA, "npm", "openclaw.cmd")
        : "";
      if (npmOpenclaw) return npmOpenclaw;
      return "openclaw.cmd";
    }
    return "openclaw";
  }

  /**
   * 刷新二维码缓存：spawn CLI → 提取链接 → 保持进程等待扫码
   */
  private refreshQrCache(accountId: string): Promise<{
    qrDataUrl: string;
    rawLink: string;
    cliProcess: import("node:child_process").ChildProcess | null;
  }> {
    return new Promise((resolve, reject) => {
      const npmPrefix = this.env.APPDATA ? `${this.env.APPDATA}\\npm` : "";
      const cmd = this.resolveOpenClawCommand();
      const env = { ...this.env };

      const extraPaths: string[] = [];
      if (npmPrefix) extraPaths.push(npmPrefix);
      if (process.execPath) {
        const nodeDir = process.execPath.replace(/[/\\]node\.exe$/i, "");
        if (nodeDir !== process.execPath) extraPaths.unshift(nodeDir);
      }
      if (extraPaths.length > 0) {
        env.PATH = `${extraPaths.join(";")};${env.PATH}`;
      }

      const child = spawnProcess(
        cmd,
        ["channels", "login", "--channel", this.channelId, "--account", accountId],
        {
          env,
          shell: process.platform === "win32",
          windowsHide: true,
        },
      );

      let output = "";
      let resolved = false;

      const onOutput = (data: Buffer) => {
        output += data.toString("utf8");
        const link = extractQrLink(output);
        if (link && !resolved) {
          resolved = true;
          resolve({ qrDataUrl: "", rawLink: link, cliProcess: child });
          void QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: "L" }).catch(() => "");
        }
      };

      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);

      child.on("error", (err) => {
        if (!resolved) reject(err);
      });

      child.on("exit", async (code) => {
        if (!resolved) {
          const link = extractQrLink(output);
          if (link) {
            resolve({ qrDataUrl: "", rawLink: link, cliProcess: null });
          } else {
            reject(
              new Error(
                `未找到 openclaw CLI（请在项目根执行 npm run setup:openclaw），或先启动 Gateway。退出 code=${code}`,
              ),
            );
          }
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const link = extractQrLink(output) ?? "";
          resolve({ qrDataUrl: "", rawLink: link, cliProcess: child });
        }
      }, 12_000);
    });
  }

  // ─── 等待扫码结果 ────────────────────────────────────────

  /**
   * 轮询扫码状态。永远不会抛异常。
   *
   * 检测优先级：
   * 1. CLI 进程以 code=0 退出 → 扫码成功
   * 2. Gateway channelsStatus 显示渠道已连接 → 成功
   * 3. 以上均不满足 → 返回 connected:false 继续轮询
   */
  async waitLogin(
    actorId: string,
    opts: {
      currentQrDataUrl?: string;
      qrKnown?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<OpenClawWebLoginResult & { ok: true }> {
    if (!this.isEnabled()) {
      throw new Error("微信 Claw 未启用");
    }

    const pending = this.pendingByActor.get(actorId);
    const bindAccountId = this.accountIdFor(actorId) ?? actorId;
    const budgetMs = Math.min(Math.max(opts.timeoutMs ?? 55_000, 10_000), 90_000);
    const deadline = Date.now() + budgetMs;

    if (this.recentConnect?.actorId === actorId) {
      const message = this.recentConnect.message;
      this.recentConnect = null;
      return { ok: true as const, connected: true, message };
    }

    if (this.qrCache?.loginVia === "gateway") {
      this.ensureGatewayWaitLoop(actorId);
    }

    const tryMarkConnected = async (message: string) => {
      await this.markBound(actorId, bindAccountId, message);
      this.pendingByActor.delete(actorId);
      this.clearQrCache();
      return { ok: true as const, connected: true, message };
    };

    let lastQrLink = this.qrCache?.rawLink ?? "";
    let lastChannelProbeAt = 0;

    while (Date.now() < deadline) {
      if (this.recentConnect?.actorId === actorId) {
        const message = this.recentConnect.message;
        this.recentConnect = null;
        return { ok: true as const, connected: true, message };
      }

      const remaining = deadline - Date.now();
      if (remaining < 1000) break;

      if (this.qrCache?.cliProcess) {
        const proc = this.qrCache.cliProcess;
        if (proc.exitCode !== null && proc.exitCode === 0) {
          return tryMarkConnected("CLI 登录流程已完成");
        }
        if (proc.exitCode !== null && proc.exitCode !== 0) {
          this.qrCache.cliProcess = null;
        }
      }

      if (this.qrCache?.loginVia === "gateway") {
        const link = this.qrCache.rawLink;
        if (link && link !== lastQrLink) {
          lastQrLink = link;
          return loginPayload(this.qrCache, { message: "二维码已刷新，请重新扫码" });
        }
      }

      if (Date.now() - lastChannelProbeAt >= 5000) {
        lastChannelProbeAt = Date.now();
        try {
          const snapshot = await this.gateway.channelsStatus(true);
          if (this.parseChannelConnected(snapshot)) {
            return tryMarkConnected("渠道已连接");
          }
        } catch {
          /* ignore */
        }
      }

      if (!pending || !this.qrCache) break;

      await new Promise((r) => setTimeout(r, 1000));
    }

    return loginPayload(this.qrCache, {
      message: pending ? "等待微信扫码..." : "正在准备二维码...",
    });
  }

  // ─── 解绑 ────────────────────────────────────────────────

  async unbind(actorId: string): Promise<void> {
    const accountId = this.accountIdFor(actorId);
    if (this.isEnabled()) {
      try {
        await this.gateway.channelsLogout(this.channelId, accountId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/not support|unknown channel/i.test(msg)) {
          throw e;
        }
      }
    }

    // 杀掉当前 CLI 进程 / Gateway 登录会话
    this.clearQrCache();

    const persisted = await this.readPersisted();
    delete persisted.bindings[actorId];
    await this.writePersisted(persisted);
    this.pendingByActor.delete(actorId);
  }

  // ─── 内部 ────────────────────────────────────────────────

  private async markBound(actorId: string, accountId: string | undefined, message?: string): Promise<void> {
    let resolvedAccountId = accountId;
    try {
      const snapshot = await this.gateway.channelsStatus(true);
      resolvedAccountId = this.parseWeixinAccount(snapshot) ?? accountId;
    } catch {
      /* ignore */
    }

    const modelSync = await syncOpenClawAgentModel(this.env, { forceReload: true });
    if (!modelSync.ok) {
      console.warn(`[wechat-claw] ${modelSync.message}`);
    }

    const persisted = await this.readPersisted();
    persisted.bindings[actorId] = {
      actorId,
      channel: this.channelId,
      accountId: resolvedAccountId,
      boundAt: new Date().toISOString(),
      lastQrMessage: message,
    };
    await this.writePersisted(persisted);
  }
}
