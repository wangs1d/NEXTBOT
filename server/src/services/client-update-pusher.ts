/**
 * 客户端版本更新推送（2026-10-21）：变「客户端定时轮询 manifest」为「服务端沿 wss 推送」。
 *
 * - 版本事实源：更新控制面的 GET /api/client/manifest（edition 可配，云端版 =
 *   client-manifest.cloud.json，byok = 主清单）。
 * - 轮询方换成服务端：配置 UPDATE_MANIFEST_SOURCE_URL 后，本进程每 10 分钟拉一次
 *   清单，与上次结果逐字段比对，变化即经 WsConnectionRegistry 全量广播
 *   `update.available` 给全部在线客户端——发布 = 改清单文件，用户秒级收到提示，
 *   发布方无需任何额外操作。
 * - 离线上线补推：session.init 成功后对聊天主通道连接单发当前清单
 *   （{@link notifySessionInit}），覆盖「发布期间不在线」的用户——连上即知。
 * - 客户端收到后自比版本：可升级 → 灵动岛简短提示；低于 minVersion → 强更弹窗；
 *   已最新 → 撤下岛上提示。0.1.3 及更早客户端不认识该事件，按未知消息静默忽略
 *   （继续走各自的旧轮询直至下次升级）。
 * - 未配置 UPDATE_MANIFEST_SOURCE_URL 时整体不启用：ECS 本体（清单源自己）、
 *   开发环境、旧部署零影响。
 * - 服务启动首查只入缓存不广播（重启不该打扰在线用户；用户升级与否由客户端
 *   启动检查兜底），之后检测到变化才广播。
 */

import type { WsConnectionRegistry } from "./ws-connection-registry.js";

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;

/** 下发给客户端的更新清单（与服务端 manifest 接口字段一致） */
export type UpdatePushManifest = {
  latest: string;
  minVersion: string;
  url: string;
  notes: string;
  channel: string;
};

let registryRef: WsConnectionRegistry | null = null;
let currentManifest: UpdatePushManifest | null = null;
let currentKey = "";
let timer: ReturnType<typeof setInterval> | null = null;

function manifestSourceUrl(): string | null {
  const source = process.env.UPDATE_MANIFEST_SOURCE_URL?.trim();
  if (!source) return null;
  const edition = process.env.UPDATE_MANIFEST_EDITION?.trim();
  return `${source.replace(/\/+$/, "")}/api/client/manifest${edition ? `?edition=${encodeURIComponent(edition)}` : ""}`;
}

function manifestKey(m: UpdatePushManifest): string {
  return JSON.stringify([
    m.latest,
    m.minVersion,
    m.url,
    m.notes,
    m.channel,
  ]);
}

async function fetchManifest(url: string): Promise<UpdatePushManifest | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const manifest: UpdatePushManifest = {
      latest: String(body.latest ?? ""),
      minVersion: String(body.minVersion ?? ""),
      url: String(body.url ?? ""),
      notes: String(body.notes ?? ""),
      channel: String(body.channel ?? ""),
    };
    // 字段不完整的清单视为异常响应（接口必须始终可用，但防半截写入的文件）
    if (!manifest.latest || !manifest.minVersion) return null;
    return manifest;
  } catch {
    // 拉取失败静默：保持上次缓存，下一轮再试（fail-open，与客户端检查同语义）
    return null;
  }
}

async function checkOnce(): Promise<void> {
  const url = manifestSourceUrl();
  if (!url || !registryRef) return;
  const manifest = await fetchManifest(url);
  if (!manifest) return;
  const key = manifestKey(manifest);
  if (key === currentKey) return;
  const isFirstFetch = currentManifest === null;
  currentManifest = manifest;
  currentKey = key;
  // 首查（服务启动）只入缓存不广播；此后每次变化即广播
  if (isFirstFetch) return;
  broadcastCurrent();
}

function broadcastCurrent(): void {
  if (!registryRef || !currentManifest) return;
  try {
    registryRef.broadcastAll(
      JSON.stringify({
        type: "update.available",
        payload: { manifest: currentManifest },
      }),
    );
  } catch {
    /* 广播失败不影响轮询循环 */
  }
}

/** bootstrap 调用：启动更新清单轮询（未配置 UPDATE_MANIFEST_SOURCE_URL 时不启用）。 */
export function startClientUpdatePusher(registry: WsConnectionRegistry): void {
  if (!manifestSourceUrl()) return;
  if (timer) return; // 幂等
  registryRef = registry;
  setTimeout(() => {
    void checkOnce();
    timer = setInterval(() => {
      void checkOnce();
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_CHECK_DELAY_MS).unref?.();
}

/**
 * session.init 成功后的上线补推：当前有缓存清单且连接 open 才发；单发失败吞掉
 * （下次 session.init 重连自然重试）。桥接通道由调用方过滤。
 */
export function notifySessionInit(socket: { send(data: string): void; readyState?: number }): void {
  if (!currentManifest) return;
  const open = socket.readyState === undefined || socket.readyState === 1;
  if (!open) return;
  try {
    socket.send(
      JSON.stringify({
        type: "update.available",
        payload: { manifest: currentManifest },
      }),
    );
  } catch {
    /* 上线补推失败不打扰主流程 */
  }
}
