/**
 * 客户端版本更新推送（2026-10-21，webhook 语义、零轮询）：变「客户端定时轮询
 * manifest」为「发布方改文件 → 事件流秒推 → 沿 wss 广播」。
 *
 * 链路（事件驱动，无任何周期性拉取）：
 *   1. 更新控制面（ECS）watch config/client-manifest*.json，文件被改立即沿 SSE
 *      长连接推变化清单（routes/http/internal-manifest-events.ts）；
 *   2. 本进程订阅该事件流（UPDATE_MANIFEST_SOURCE_URL + UPDATE_MANIFEST_EVENT_TOKEN），
 *      收到与自身 UPDATE_MANIFEST_EDITION 匹配的清单后与内存缓存比对，变化即经
 *      WsConnectionRegistry 全量广播 `update.available` 给全部在线客户端——
 *      发布方改完文件，在线客户端秒级收到提示，无操作、无延迟；
 *   3. SSE 断线自动重连（3s 退避），重连后控制面全量重推 → 与缓存比对：
 *      相同则静默，不同（断连期间漏掉的变化）则补广播——无事件丢失窗口；
 *   4. 离线上线补推：session.init 成功后对聊天主通道连接单发当前清单
 *      （{@link notifySessionInit}），覆盖「发布期间不在线」的用户。
 *
 * 客户端收到后自比版本：可升级 → 灵动岛简短提示；低于 minVersion → 强更弹窗；
 * 已最新 → 撤下岛上提示。0.1.3 及更早客户端不认识该事件，按未知消息静默忽略
 * （继续走各自的旧机制直至下次升级）。
 *
 * 未配置 UPDATE_MANIFEST_SOURCE_URL / UPDATE_MANIFEST_EVENT_TOKEN 时整体不启用：
 * 开发环境、旧部署零影响。更新控制面自己配回环地址（http://127.0.0.1:<port>），
 * 于是握着客户端 wss 的那台机器既是清单源也是广播方，不需要任何外部订阅端。
 * 服务启动首帧只入缓存不广播（重启不该打扰在线用户；用户升级与否由客户端
 * 启动检查兜底）。
 */

import { MANIFEST_EVENT_TOKEN_HEADER } from "../routes/http/internal-manifest-events.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";

const RECONNECT_DELAY_MS = 3_000;

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
let started = false;
/** 停机用：置真后不再重连，并 abort 在途的 SSE 读——否则本进程握着自家事件流的
 *  长连接，Fastify 的 app.close() 永远等不到这个请求结束，停服拖到 SIGKILL。 */
let stopping = false;
let subscription: AbortController | null = null;

/** 订阅端自身关心的清单分发版（UPDATE_MANIFEST_EDITION，未配置 = 主清单事件） */
const WANT_EDITION: string | null = process.env.UPDATE_MANIFEST_EDITION?.trim() || null;

/** 订阅目标：清单不拼进 URL——query 串会整份落进对端 nginx access.log 与服务日志。 */
export function subscribeTarget(): { url: string; token: string } | null {
  const source = process.env.UPDATE_MANIFEST_SOURCE_URL?.trim();
  const token = process.env.UPDATE_MANIFEST_EVENT_TOKEN?.trim();
  if (!source || !token) return null;
  return { url: `${source.replace(/\/+$/, "")}/api/internal/manifest-events`, token };
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

function applyManifest(m: UpdatePushManifest): void {
  if (!m.latest || !m.minVersion) return; // 字段不完整的清单视为异常事件
  const key = manifestKey(m);
  if (key === currentKey) return;
  const hadPrevious = currentManifest !== null;
  currentManifest = m;
  currentKey = key;
  // 首帧（服务启动）只入缓存不广播；此后每次变化（含重连校准补上的漏帧）即广播
  if (hadPrevious) broadcastCurrent();
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
    /* 广播失败不影响订阅循环 */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 控制面按口令拒绝：重连不会自愈，别再每 3 秒敲一次门（公网订阅方曾这样一天刷出上万条 403）。 */
class ManifestSubscriptionRejected extends Error {}

/** 解析一帧 SSE data（JSON {edition, manifest}），edition 不匹配自身配置则忽略 */
function handleEventData(raw: string): void {
  let parsed: { edition?: string | null; manifest?: UpdatePushManifest };
  try {
    parsed = JSON.parse(raw) as { edition?: string | null; manifest?: UpdatePushManifest };
  } catch {
    return;
  }
  const edition = parsed.edition ?? null;
  if (WANT_EDITION ? edition !== WANT_EDITION : edition !== null) return;
  if (!parsed.manifest || typeof parsed.manifest !== "object") return;
  applyManifest(parsed.manifest);
}

/** 消费一条 SSE 连接直到断开（断开由 connectLoop 捕获后重连） */
async function consumeEventStream(target: { url: string; token: string }): Promise<void> {
  const res = await fetch(target.url, {
    headers: { accept: "text/event-stream", [MANIFEST_EVENT_TOKEN_HEADER]: target.token },
    signal: subscription?.signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw new ManifestSubscriptionRejected(`清单事件流被拒绝（HTTP ${res.status}）`);
  }
  if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧以空行分隔；帧内取 data: 行（本端点每帧单行 data，多行 data 拼接兜底）
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) handleEventData(data);
    }
  }
}

async function connectLoop(target: { url: string; token: string }): Promise<void> {
  while (!stopping) {
    try {
      await consumeEventStream(target);
    } catch (err) {
      if (stopping) break; // 停机 abort 打断在途读，属正常收尾
      if (err instanceof ManifestSubscriptionRejected) {
        console.warn(
          `[update-pusher] ${err.message}，订阅终止——核对 MANIFEST_EVENT_TOKEN 与 UPDATE_MANIFEST_EVENT_TOKEN 是否同值、源地址是否为控制面`,
        );
        break;
      }
      // 其余断线静默（fail-open）：重连后控制面全量重推，漏掉的变化自动校准
    }
    await sleep(RECONNECT_DELAY_MS);
  }
}

/** bootstrap 调用：订阅更新控制面的清单事件流（未配置 env 时不启用）。 */
export function startClientUpdatePusher(registry: WsConnectionRegistry): void {
  const target = subscribeTarget();
  if (!target || (started && !stopping)) return; // 幂等
  started = true;
  stopping = false;
  registryRef = registry;
  subscription = new AbortController();
  void connectLoop(target);
}

/**
 * 停机调用：终止订阅循环并 abort 在途的 SSE 读。缺这一步时，本进程既是事件流的
 * 服务端又是客户端，app.close() 会一直等自己那条永不结束的请求，停服拖满
 * TimeoutStopSec 后被 SIGKILL。
 */
export function stopClientUpdatePusher(): void {
  stopping = true;
  subscription?.abort();
  subscription = null;
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
