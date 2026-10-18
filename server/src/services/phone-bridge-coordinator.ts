import { randomUUID, timingSafeEqual } from "node:crypto";

import { ServerEventType } from "../protocol.js";

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

type PendingJob = {
  resolve: (r: PhoneBridgeResult) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
  jobId: string;
};

export type PhoneBridgeResult = {
  ok: boolean;
  [key: string]: unknown;
};

export type PhoneDeviceInfo = {
  model?: string;
  manufacturer?: string;
  brand?: string;
  androidVersion?: string;
  sdkInt?: number;
  isHuawei?: boolean;
  isHarmonyOS?: boolean;
  systemVersion?: string;
  batteryLevel?: number;
  /** 系统通知使用权是否已授予（客户端注册时上报；undefined=旧客户端未上报） */
  notificationListenerEnabled?: boolean;
  [key: string]: unknown;
};

export type PhoneBridgeSyncPayload = {
  phoneBridgeOnline: boolean;
  updatedAt: string;
  deviceInfo?: PhoneDeviceInfo;
};

export type PhoneBridgeCoordinatorOptions = {
  onSync?: (actorId: string, payload: PhoneBridgeSyncPayload) => void;
};

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function safeSend(socket: WsSendLike, payload: object) {
  try {
    if (socket.readyState !== undefined && socket.readyState > 1) return;
    socket.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export class PhoneBridgeCoordinator {
  private readonly executors = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly deviceInfoByActor = new Map<string, PhoneDeviceInfo>();
  private readonly lastSyncAt = new Map<string, string>();

  constructor(private readonly opts?: PhoneBridgeCoordinatorOptions) {}

  isBridgeFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (parseBooleanEnv(env.PHONE_BRIDGE_ENABLED)) return true;
    const t = env.PHONE_BRIDGE_TOKEN?.trim() ?? "";
    return t.length >= 8;
  }

  requiresRegisterToken(env: NodeJS.ProcessEnv = process.env): boolean {
    const t = env.PHONE_BRIDGE_TOKEN?.trim() ?? "";
    return t.length >= 8;
  }

  verifyRegisterToken(token: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const expected = env.PHONE_BRIDGE_TOKEN?.trim() ?? "";
    if (expected.length < 8) return true;
    if (!token || token.length < 8) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  bindExecutor(actorId: string, socket: WsSendLike, deviceInfo?: PhoneDeviceInfo) {
    const had = this.executors.has(actorId);
    this.executors.set(actorId, socket);
    if (deviceInfo) {
      this.deviceInfoByActor.set(actorId, deviceInfo);
    }
    this.lastSyncAt.set(actorId, new Date().toISOString());
    if (!had) {
      this._emitSync(actorId, true);
    }
  }

  unbindIfSocket(actorId: string, socket: WsSendLike): boolean {
    const current = this.executors.get(actorId);
    if (current === socket) {
      this.executors.delete(actorId);
      this.cancelPendingForSocket(socket);
      this._emitSync(actorId, false);
      return true;
    }
    return false;
  }

  updateDeviceInfo(actorId: string, deviceInfo: PhoneDeviceInfo) {
    this.deviceInfoByActor.set(actorId, deviceInfo);
    this.lastSyncAt.set(actorId, new Date().toISOString());
    this._emitSync(actorId, true);
  }

  hasExecutor(actorId: string): boolean {
    return this.executors.has(actorId);
  }

  getDeviceInfo(actorId: string): PhoneDeviceInfo | undefined {
    return this.deviceInfoByActor.get(actorId);
  }

  getSyncPayload(actorId: string): PhoneBridgeSyncPayload {
    return {
      phoneBridgeOnline: this.executors.has(actorId),
      updatedAt: this.lastSyncAt.get(actorId) ?? new Date().toISOString(),
      deviceInfo: this.deviceInfoByActor.get(actorId),
    };
  }

  invoke(actorId: string, action: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<PhoneBridgeResult> {
    const socket = this.executors.get(actorId);
    if (!socket) {
      return Promise.resolve({ ok: false, error: "phone bridge offline" });
    }

    const jobId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        resolve({ ok: false, error: "phone bridge invoke timeout" });
      }, timeoutMs);

      this.pending.set(jobId, { resolve, timer, socket, jobId });

      safeSend(socket, {
        type: ServerEventType.PhoneBridgeInvoke,
        payload: { jobId, action, params },
      });
    });
  }

  completeFromSocket(actorId: string, socket: WsSendLike, jobId: string, result: PhoneBridgeResult) {
    const current = this.executors.get(actorId);
    if (current !== socket) return;

    const job = this.pending.get(jobId);
    if (!job) return;

    clearTimeout(job.timer);
    this.pending.delete(jobId);
    job.resolve(result);
  }

  cancelPendingForSocket(socket: WsSendLike) {
    for (const [id, job] of this.pending.entries()) {
      if (job.socket === socket) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: "socket disconnected" });
        this.pending.delete(id);
      }
    }
  }

  private _emitSync(actorId: string, online: boolean) {
    const payload: PhoneBridgeSyncPayload = {
      phoneBridgeOnline: online,
      updatedAt: new Date().toISOString(),
      deviceInfo: this.deviceInfoByActor.get(actorId),
    };
    this.opts?.onSync?.(actorId, payload);
  }
}
