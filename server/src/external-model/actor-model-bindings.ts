/**
 * 按 actor 的用户自有模型绑定仓（云端连接版 BYOK，2026-10-20）。
 *
 * 背景：云端连接版（无本地 runtime，exe 直连云端 wss）里 AgentCore 的
 * `externalChat` 解析自运营方环境变量——用户对话烧的是平台 key。本仓让
 * 客户端在 session.init 携带 `modelProvider: {baseUrl, apiKey, model}`
 * 三元组，服务端按 actorId 绑定一份用户自有 provider；agent-core 的
 * 用户轮调用点经 `chatProviderFor(actorId)` 优先取 BYOK，无绑定回落
 * 运营方 provider（旁路 LLM 一律不受影响）。
 *
 * 安全设计：
 * - key 纯内存驻留（Map），不落盘、不进日志；TTL 24h 由惰性 + 定时双路清理，
 *   客户端每次连接 session.init 重传自愈。
 * - baseUrl 仅接受 https 公网地址（SSRF 门：拒明文协议、localhost/私网段/
 *   metadata 网段/IPv6 字面量）；上送通道本身要求 wss（connection.ts 校验
 *   x-forwarded-proto / socket.encrypted）。
 * - provider 实例按 actor 缓存、按绑定内容判等复用（thread 历史挂 provider
 *   语义，配置未变不重建）；配置变更才换新实例。
 */

import { UserByokProvider } from "./providers/user-byok-provider.js";
import type { ExternalChatProvider } from "./types.js";

/** session.init 上送的用户自有模型三元组 */
export type ActorModelBinding = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

type BindingEntry = {
  binding: ActorModelBinding;
  provider: UserByokProvider;
  expiresAt: number;
};

const BINDING_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * SSRF 门：校验并规范化 baseUrl，非法返回 null。
 * 仅接受 https 公网地址——拒明文协议、localhost/.local/.internal 主机名、
 * 全部 IPv6 字面量（用户端点几乎不用，逐一判 global unicast 得不偿失）、
 * IPv4 私网/保留/metadata 网段。
 */
export function validateByokBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null;
  }
  if (host.includes(":")) return null; // IPv6 字面量（URL.hostname 已去方括号）
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]];
    const o = parts.map(Number);
    if (o.some((n) => n > 255)) return null;
    // 前导零拒绝：防「010 解析为八进制 8（私有段）」的解析器分歧型 SSRF
    if (parts.some((s) => s.length > 1 && s.startsWith("0"))) return null;
    const [a, b] = o;
    const privateOrReserved =
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 169 && b === 254) || // link-local / 云 metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 198 && (b === 18 || b === 19)) || // benchmark 198.18/15
      a >= 224; // multicast + reserved
    if (privateOrReserved) return null;
  }
  return url.toString();
}

function bindingKey(b: ActorModelBinding): string {
  return `${b.baseUrl}|${b.model}|${b.apiKey}`;
}

export class ActorModelBindingStore {
  private readonly entries = new Map<string, BindingEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 设置/更新 actor 的绑定。baseUrl 非法（SSRF 门拒绝）返回 false 且不改动
   * 现有绑定；合法时写入/续期，绑定内容未变仅续期（provider 实例不动）。
   */
  set(actorId: string, binding: ActorModelBinding): boolean {
    const baseUrl = validateByokBaseUrl(binding.baseUrl);
    if (!baseUrl) return false;
    const normalized: ActorModelBinding = { baseUrl, apiKey: binding.apiKey, model: binding.model };
    const existing = this.entries.get(actorId);
    if (existing && bindingKey(existing.binding) === bindingKey(normalized)) {
      existing.expiresAt = Date.now() + BINDING_TTL_MS;
      return true;
    }
    this.entries.set(actorId, {
      binding: normalized,
      provider: new UserByokProvider(normalized),
      expiresAt: Date.now() + BINDING_TTL_MS,
    });
    this.ensureCleanupTimer();
    return true;
  }

  /** 撤销绑定（客户端上送空 modelProvider = 用户在 UI 清空了配置）。 */
  clear(actorId: string): void {
    this.entries.delete(actorId);
  }

  /** 取该 actor 的 BYOK provider；无绑定/已过期返回 null（调用方回落运营方 provider）。 */
  get(actorId: string): ExternalChatProvider | null {
    const entry = this.entries.get(actorId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(actorId);
      return null;
    }
    return entry.provider;
  }

  /** 当前有效绑定数（观测/日志用）。 */
  get size(): number {
    return this.entries.size;
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [actorId, entry] of this.entries) {
        if (now >= entry.expiresAt) this.entries.delete(actorId);
      }
      if (this.entries.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }
}
