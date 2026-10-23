import { randomUUID } from "node:crypto";

export type OpenClawGatewayConfig = {
  wsUrl: string;
  token?: string;
  password?: string;
  connectTimeoutMs?: number;
};

export type OpenClawWebLoginResult = {
  message?: string;
  /** 原始扫码链接（客户端可本地生成二维码，避免传输巨型 base64） */
  qrLink?: string;
  qrDataUrl?: string;
  connected?: boolean;
  /** OpenClaw 微信插件登录会话（wait 时必须带回） */
  sessionKey?: string;
};

export type OpenClawChannelsStatusSnapshot = Record<string, unknown>;

type GatewayFrame =
  | { type: "event"; event: string; payload?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown };

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isGatewayAuthNone(env: NodeJS.ProcessEnv): boolean {
  const auth = (env.OPENCLAW_GATEWAY_AUTH ?? "").trim().toLowerCase();
  return auth === "none" || parseBooleanEnv(env.OPENCLAW_GATEWAY_AUTH_NONE);
}

export function isWechatClawFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (parseBooleanEnv(env.WECHAT_CLAW_ENABLED)) return true;
  const ws = env.OPENCLAW_GATEWAY_WS_URL?.trim() ?? "";
  const token = env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? "";
  const password = env.OPENCLAW_GATEWAY_PASSWORD?.trim() ?? "";
  if (ws.length > 0 && isGatewayAuthNone(env)) return true;
  return ws.length > 0 && (token.length > 0 || password.length > 0);
}

export function readOpenClawGatewayConfig(env: NodeJS.ProcessEnv = process.env): OpenClawGatewayConfig {
  const wsUrl = (env.OPENCLAW_GATEWAY_WS_URL?.trim() || "ws://127.0.0.1:18789").replace(/\/+$/, "");
  const token = env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const password = env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  return {
    wsUrl,
    token,
    password,
    connectTimeoutMs: 15_000,
  };
}

export function readOpenClawWeixinChannelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_WEIXIN_CHANNEL?.trim() || "openclaw-weixin";
}

function requestWebLoginStart(
  session: GatewaySession,
  params: {
    force?: boolean;
    timeoutMs?: number;
    accountId?: string;
  },
): Promise<OpenClawWebLoginResult> {
  return session.request<OpenClawWebLoginResult>("web.login.start", {
    force: Boolean(params.force),
    timeoutMs: params.timeoutMs ?? 30_000,
    accountId: params.accountId,
  });
}

function requestWebLoginWait(
  session: GatewaySession,
  params: {
    timeoutMs?: number;
    currentQrDataUrl?: string;
    accountId?: string;
  },
): Promise<OpenClawWebLoginResult> {
  const waitMs = params.timeoutMs ?? 32_000;
  return session.request<OpenClawWebLoginResult>(
    "web.login.wait",
    {
      timeoutMs: waitMs,
      currentQrDataUrl: params.currentQrDataUrl,
      accountId: params.accountId,
    },
    waitMs + 20_000,
  );
}

/**
 * 轻量 OpenClaw Gateway WebSocket RPC 客户端（connect → req/res → close）。
 */
export class OpenClawGatewayClient {
  constructor(private readonly config: OpenClawGatewayConfig) {}

  async ping(): Promise<boolean> {
    try {
      await this.withSession(async (session) => {
        await session.request("channels.status", { probe: false, timeoutMs: 5000 });
      });
      return true;
    } catch {
      return false;
    }
  }

  async channelsStatus(probe = true): Promise<OpenClawChannelsStatusSnapshot> {
    return this.withSession(async (session) => {
      return session.request<OpenClawChannelsStatusSnapshot>("channels.status", {
        probe,
        timeoutMs: 8000,
      });
    });
  }

  async webLoginStart(params: {
    force?: boolean;
    timeoutMs?: number;
    accountId?: string;
  }): Promise<OpenClawWebLoginResult> {
    return this.withSession(async (session) => requestWebLoginStart(session, params));
  }

  async webLoginWait(params: {
    timeoutMs?: number;
    currentQrDataUrl?: string;
    /** 须与 login.start 时一致（Gateway schema 仅接受 accountId，会映射为微信插件 sessionKey） */
    accountId?: string;
  }): Promise<OpenClawWebLoginResult> {
    return this.withSession(async (session) => requestWebLoginWait(session, params));
  }

  /** 创建并保持 WebSocket，供 web.login.start → web.login.wait 在同一连接上完成。 */
  async openWebLoginSession(): Promise<OpenClawWebLoginSession> {
    return OpenClawWebLoginSession.connect(this.config);
  }

  private async withSession<T>(fn: (session: GatewaySession) => Promise<T>): Promise<T> {
    const session = await GatewaySession.connect(this.config);
    try {
      return await fn(session);
    } finally {
      session.close();
    }
  }

  async channelsLogout(channel: string, accountId?: string): Promise<void> {
    await this.withSession(async (session) => {
      await session.request("channels.logout", { channel, accountId });
    });
  }

  /** 配置变更后通知 Gateway 重新加载 openclaw.json */
  async configReload(force = false): Promise<void> {
    await this.withSession(async (session) => {
      await session.request("config.reload", { force });
    });
  }
}

/** 扫码登录专用长连接：start 后必须复用同一 WebSocket 调用 wait，否则微信侧易报网络错误。 */
export class OpenClawWebLoginSession {
  private constructor(private session: GatewaySession) {}

  static async connect(config: OpenClawGatewayConfig): Promise<OpenClawWebLoginSession> {
    const session = await GatewaySession.connect(config);
    return new OpenClawWebLoginSession(session);
  }

  async start(params: {
    force?: boolean;
    timeoutMs?: number;
    accountId?: string;
  }): Promise<OpenClawWebLoginResult> {
    return requestWebLoginStart(this.session, params);
  }

  async wait(params: {
    timeoutMs?: number;
    currentQrDataUrl?: string;
    accountId?: string;
  }): Promise<OpenClawWebLoginResult> {
    return requestWebLoginWait(this.session, params);
  }

  close(): void {
    this.session.close();
  }
}

class GatewaySession {
  private readonly ws: WebSocket;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private connected = false;
  private challengeSeen = false;
  private challengeWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data ?? "")));
    ws.addEventListener("close", () => this.rejectAll(new Error("OpenClaw Gateway 连接已关闭")));
  }

  static async connect(config: OpenClawGatewayConfig): Promise<GatewaySession> {
    const WebSocketCtor = globalThis.WebSocket as typeof WebSocket | undefined;
    if (!WebSocketCtor) {
      throw new Error("当前 Node 运行时缺少 WebSocket，请使用 Node 20+");
    }

    const ws = new WebSocketCtor(config.wsUrl);
    const session = new GatewaySession(ws);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 OpenClaw Gateway 超时")), config.connectTimeoutMs ?? 15_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("无法连接 OpenClaw Gateway"));
        },
        { once: true },
      );
    });

    await session.handshake(config);
    return session;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
    requestTimeoutMs?: number,
  ): Promise<T> {
    if (!this.connected) {
      throw new Error("OpenClaw Gateway 未完成握手");
    }

    const id = randomUUID();
    const paramWait =
      typeof params?.timeoutMs === "number" ? params.timeoutMs : 25_000;
    const timeoutMs =
      requestTimeoutMs ??
      (method === "web.login.wait" ? paramWait + 20_000 : paramWait + 5_000);
    const payload = JSON.stringify({ type: "req", id, method, params: params ?? {} });

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw Gateway 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });

    return result as T;
  }

  private async handshake(config: OpenClawGatewayConfig): Promise<void> {
    await this.waitForEvent("connect.challenge", config.connectTimeoutMs ?? 15_000);

    const auth: Record<string, string> = {};
    if (config.token) auth.token = config.token;
    if (config.password) auth.password = config.password;

    const res = await this.sendConnectRequest({
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "nextbot/0.1",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      commands: [],
      permissions: {},
      auth,
      locale: "zh-CN",
      userAgent: "nextbot-server/0.1",
    });

    if ((res as { type?: string } | null)?.type !== "hello-ok") {
      throw new Error("OpenClaw Gateway 握手失败");
    }
    this.connected = true;
  }

  private async sendConnectRequest(params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    const payload = JSON.stringify({ type: "req", id, method: "connect", params });
    const timeoutMs = 15_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("OpenClaw connect 握手超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  private waitForEvent(eventName: string, timeoutMs: number): Promise<void> {
    if (eventName === "connect.challenge" && this.challengeSeen) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.challengeWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.challengeWaiters.splice(idx, 1);
        reject(new Error(`等待 OpenClaw ${eventName} 超时`));
      }, timeoutMs);
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      if (eventName === "connect.challenge") {
        this.challengeWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
        return;
      }
      reject(new Error(`不支持等待事件 ${eventName}`));
    });
  }

  private onMessage(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (frame.type === "event" && frame.event === "connect.challenge") {
      this.challengeSeen = true;
      const waiters = this.challengeWaiters.splice(0);
      for (const w of waiters) w.resolve();
      return;
    }

    if (frame.type !== "res") return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(frame.id);
    if (frame.ok) {
      entry.resolve(frame.payload);
      return;
    }
    const errObj = frame.error as { message?: string } | undefined;
    const msg = errObj?.message ?? JSON.stringify(frame.error ?? "unknown error");
    entry.reject(new Error(msg));
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    const waiters = this.challengeWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }
}
