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
 * - key 经 AES-256-GCM 加密落盘（model-key-vault），内存驻留一份 provider；
 *   主密钥缺失时不写盘，退回"每次连接重传"。不进日志、不经任何接口回显。
 * - 绑定不过期：客户端离线期间的主动轮次（提醒/后台整理）要用**用户自己的** key，
 *   用不了就跳过并记因，不静默回落运营方 provider。
 * - baseUrl 仅接受 https 公网地址（SSRF 门：拒明文协议、localhost/私网段/
 *   metadata 网段/IPv6 字面量）；上送通道本身要求 wss（connection.ts 校验
 *   x-forwarded-proto / socket.encrypted）。
 * - provider 实例按 actor 缓存、按绑定内容判等复用（thread 历史挂 provider
 *   语义，配置未变不重建）；配置变更才换新实例。
 */

import { UserByokProvider } from "./providers/user-byok-provider.js";
import type { ExternalChatProvider } from "./types.js";
import {
  deleteModelKey,
  hasModelKey,
  loadModelKeys,
  modelKeyCount,
  modelKeyVaultEnabled,
  saveModelKey,
} from "../services/model-key-vault.js";

/** session.init 上送的用户自有模型三元组 */
export type ActorModelBinding = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

type BindingEntry = {
  binding: ActorModelBinding;
  provider: UserByokProvider;
};

export class ActorModelBindingStore {
  private readonly entries = new Map<string, BindingEntry>();
  private vaultLoaded = false;
  /** 主密钥轮换后解不开的份数：状态口报数，不外传内容 */
  private vaultUndecryptable = 0;

  /**
   * 设置/更新 actor 的绑定。baseUrl 非法（SSRF 门拒绝）返回 false 且不改动
   * 现有绑定；合法时写入并落盘（客户端离线期间的主动轮次要用它）。
   * 绑定内容未变则不重建 provider（thread 历史挂在 provider 实例上）。
   */
  set(actorId: string, binding: ActorModelBinding): boolean {
    const baseUrl = validateByokBaseUrl(binding.baseUrl);
    if (!baseUrl) return false;
    const normalized: ActorModelBinding = { baseUrl, apiKey: binding.apiKey, model: binding.model };
    const existing = this.entries.get(actorId);
    if (existing && bindingKey(existing.binding) === bindingKey(normalized)) {
      return true;
    }
    this.entries.set(actorId, {
      binding: normalized,
      provider: new UserByokProvider(normalized),
    });
    saveModelKey(actorId, normalized);
    return true;
  }

  /** 撤销绑定（客户端上送空 modelProvider = 用户在 UI 清空了配置）：内存与落盘一起清。 */
  clear(actorId: string): void {
    this.entries.delete(actorId);
    deleteModelKey(actorId);
  }

  /** 取该 actor 的 BYOK provider；未配置过返回 null（调用方回落运营方 provider）。 */
  get(actorId: string): ExternalChatProvider | null {
    this.ensureVaultLoaded();
    return this.entries.get(actorId)?.provider ?? null;
  }

  /** 绑定状态（客户端状态角标用）：只回网关与模型，密钥永不外出。 */
  status(actorId: string): { configured: boolean; model: string; baseUrl: string } | null {
    this.ensureVaultLoaded();
    const entry = this.entries.get(actorId);
    if (!entry) return null;
    return { configured: true, model: entry.binding.model, baseUrl: entry.binding.baseUrl };
  }

  /** 当前有效绑定数（观测/日志用）。 */
  get size(): number {
    this.ensureVaultLoaded();
    return this.entries.size;
  }

  /** 落盘绑定数 + 主密钥轮换后解不开的份数（诊断用，不含密钥）。 */
  persistence(): { vaultEnabled: boolean; stored: number; undecryptable: number } {
    this.ensureVaultLoaded();
    return {
      vaultEnabled: modelKeyVaultEnabled(),
      stored: modelKeyCount(),
      undecryptable: this.vaultUndecryptable,
    };
  }

  /** 落盘里有这个 actor 的 key（用于区分"从没配过"和"配了但解不开"）。 */
  hasStoredKey(actorId: string): boolean {
    return hasModelKey(actorId);
  }

  /** 首次取用时把落盘绑定读回内存（同步、只读一次；主密钥缺失时是空操作）。 */
  private ensureVaultLoaded(): void {
    if (this.vaultLoaded) return;
    this.vaultLoaded = true;
    const { entries, undecryptable } = loadModelKeys();
    this.vaultUndecryptable = undecryptable;
    for (const stored of entries) {
      if (this.entries.has(stored.actorId)) continue;
      const baseUrl = validateByokBaseUrl(stored.baseUrl);
      if (!baseUrl) continue;
      const binding: ActorModelBinding = { baseUrl, apiKey: stored.apiKey, model: stored.model };
      this.entries.set(stored.actorId, { binding, provider: new UserByokProvider(binding) });
    }
  }
}

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

