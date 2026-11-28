import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getToolSearchConfig } from "../env.js";
import {
  isLocalRerankerDisabled,
  LOCAL_RERANKER_MODEL_ID,
  resolveLocalRerankerModelDir,
} from "./local-reranker-engine.js";
import type { LocalRerankerEndpoint } from "./local-reranker-server.js";

type HostMessage =
  | { ok: true; endpoint: LocalRerankerEndpoint }
  | { ok: false; reason?: string }
  | { type: "engine"; ok: boolean; reason?: string };

const HOST_READY_TIMEOUT_MS = 15_000;
let endpointPromise: Promise<LocalRerankerEndpoint | null> | null = null;
let started: LocalRerankerEndpoint | null = null;

export function getLocalRerankerEndpoint(): LocalRerankerEndpoint | null {
  return started;
}

export function ensureLocalRerankerEndpoint(): Promise<LocalRerankerEndpoint | null> {
  if (!endpointPromise) {
    const pending = doEnsure();
    endpointPromise = pending;
    void pending.then((endpoint) => {
      if (!endpoint && endpointPromise === pending) endpointPromise = null;
    });
  }
  return endpointPromise;
}

export async function warmLocalReranker(timeoutMs = 30_000): Promise<boolean> {
  const endpoint = await ensureLocalRerankerEndpoint();
  if (!endpoint) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint.baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok && (await response.json() as { ok?: boolean }).ok) {
        const inference = await fetch(`${endpoint.baseUrl}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            query: "warmup",
            documents: [
              "local reranker readiness probe",
              "查询用户当前所在城市和位置",
              "创建或查询日程会议待办与提醒",
            ],
          }),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (!inference.ok) throw new Error(`local reranker warmup HTTP ${inference.status}`);
        const payload = await inference.json() as { data?: Array<{ score?: number }> };
        if (payload.data?.length === 3 && payload.data.every((row) => Number.isFinite(row.score))) return true;
      }
    } catch {
      // 模型仍在独立子进程内装载。
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  return false;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal=${signal}`;
  if (code === null) return "code=unknown";
  if (code < 0) return `code=${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
  return `code=${code}`;
}

function resolveHostPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "local-reranker-host.js"), join(here, "local-reranker-host.ts")];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

async function doEnsure(): Promise<LocalRerankerEndpoint | null> {
  if (getToolSearchConfig().neuralRerankEnabled === "off" || isLocalRerankerDisabled()) return null;
  if (!resolveLocalRerankerModelDir()) {
    console.warn(`[local-reranker] 模型资产缺失（models/${LOCAL_RERANKER_MODEL_ID}），重排维持基线降级`);
    return null;
  }

  const child: ChildProcess = fork(resolveHostPath(), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.unref();
  child.channel?.unref();
  process.once("exit", () => {
    try {
      child.kill();
    } catch {
      // 父进程已在退出路径上。
    }
  });

  const result = await new Promise<HostMessage>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: `宿主未在 ${HOST_READY_TIMEOUT_MS}ms 内就绪` }), HOST_READY_TIMEOUT_MS);
    child.once("message", (message: HostMessage) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `宿主进程退出 ${describeExit(code, signal)}` });
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
  });

  if (!("endpoint" in result)) {
    console.warn(`[local-reranker] 交叉编码端点不可用（${result.reason ?? "未知原因"}），重排维持基线降级`);
    try {
      child.kill();
    } catch {
      // 已自行退出。
    }
    return null;
  }

  started = result.endpoint;
  console.info(`[local-reranker] 回环重排端点就绪 ${started.baseUrl} (host pid=${child.pid})`);
  child.on("message", (message: HostMessage) => {
    if (!("type" in message) || message.type !== "engine") return;
    if (message.ok) console.info("[local-reranker] 交叉编码引擎装载完成");
    else console.warn(`[local-reranker] 交叉编码引擎不可用（${message.reason ?? "未知原因"}），重排维持基线降级`);
  });
  child.once("exit", (code, signal) => {
    if (started) console.warn(`[local-reranker] 重排宿主退出 ${describeExit(code, signal)}，重排降级`);
    started = null;
    endpointPromise = null;
  });
  return started;
}
