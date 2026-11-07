/**
 * 本地嵌入端点编排：Embedding 首选端点（零外部依赖，云端/离线形态都不吃供应商账户状态）。
 *
 * - bootstrap 在装配记忆系统前调用 ensureLocalEmbeddingEndpoint()（本地引擎是
 *   嵌入端点首选，无论远端是否配置都拉起；AGENT_LOCAL_EMBEDDING_DISABLED=1 关闭）；
 * - openai-embedding-client.resolveEmbeddingEndpoint() 首位读取
 *   getLocalEmbeddingEndpoint()——本地就绪即首选，远端仅作不可用时的兜底；
 * - 引擎跑在独立子进程（local-embedding-host），父进程只拿 baseUrl/token：
 *   ONNX 原生崩溃只影响本能力，不会带走后端；
 * - 任何失败（模型缺失 / AGENT_LOCAL_EMBEDDING_DISABLED=1 / 宿主崩溃）一律
 *   返回 null，回退到旧行为（嵌入消费方跳过、agentic-memory 禁用）。
 */

import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isLocalEmbeddingDisabled } from "./local-embedding-engine.js";
import type { LocalEmbeddingEndpoint } from "./local-embedding-server.js";

type HostMessage =
  | { ok: true; endpoint: LocalEmbeddingEndpoint }
  | { ok: false; reason?: string }
  | { type: "engine"; ok: boolean; reason?: string };

/** 宿主只需在超时内绑好回环端口（模型在后台加载，不计入就绪） */
const HOST_READY_TIMEOUT_MS = 15_000;

let endpointPromise: Promise<LocalEmbeddingEndpoint | null> | null = null;
let started: LocalEmbeddingEndpoint | null = null;

export function getLocalEmbeddingEndpoint(): LocalEmbeddingEndpoint | null {
  return started;
}

/** 幂等；同一进程只拉起一次宿主 */
export function ensureLocalEmbeddingEndpoint(): Promise<LocalEmbeddingEndpoint | null> {
  if (!endpointPromise) endpointPromise = doEnsure();
  return endpointPromise;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal=${signal}`;
  if (code === null) return "code=unknown";
  if (code < 0) return `code=${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
  return `code=${code}`;
}

/** 宿主入口：打包后与 bundle 同级（.js），源码态与模块同目录（.ts，tsx 继承 loader） */
function resolveHostPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "local-embedding-host.js"), join(here, "local-embedding-host.ts")];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

async function doEnsure(): Promise<LocalEmbeddingEndpoint | null> {
  if (isLocalEmbeddingDisabled()) {
    console.info("[local-embedding] AGENT_LOCAL_EMBEDDING_DISABLED=1，内置向量引擎关闭");
    return null;
  }
  const hostPath = resolveHostPath();
  const child = fork(hostPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  // 不占住调用方的进程生命周期：测试/脚本跑完可以正常退出，宿主由 exit 钩子回收
  child.unref();
  child.channel?.unref();
  process.once("exit", () => {
    try {
      child.kill();
    } catch {
      // 父进程已在退出路径上，杀不掉也无所谓
    }
  });

  const result = await new Promise<HostMessage>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: `宿主未在 ${HOST_READY_TIMEOUT_MS}ms 内就绪` }),
      HOST_READY_TIMEOUT_MS,
    );
    child.once("message", (msg: HostMessage) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `宿主进程退出 ${describeExit(code, signal)}` });
    });
    child.once("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
  });

  if (!("endpoint" in result)) {
    console.warn(
      `[local-embedding] 内置向量引擎不可用（${result.reason ?? "未知原因"}），` +
        "记忆向量化维持禁用；可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY 走远端",
    );
    try {
      child.kill();
    } catch {
      // 已自行退出
    }
    return null;
  }
  started = result.endpoint;
  console.info(
    `[local-embedding] 零配置向量端点就绪 ${started.baseUrl} ` +
      `(model=${started.model}, dims=${started.dims}, host pid=${child.pid})`,
  );
  child.on("message", (msg: HostMessage) => {
    if (!("type" in msg) || msg.type !== "engine") return;
    if (msg.ok) console.info("[local-embedding] 内置向量引擎装载完成");
    else {
      console.warn(
        `[local-embedding] 内置向量引擎不可用（${msg.reason ?? "未知原因"}），` +
          "记忆向量化维持禁用；可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY 走远端",
      );
    }
  });
  child.once("exit", (code, signal) => {
    if (started) console.warn(`[local-embedding] 向量宿主退出 ${describeExit(code, signal)}，嵌入请求降级`);
    started = null;
  });
  return started;
}

/** 进程内调用方（非 OpenAI SDK）经宿主端点做嵌入；端点不可用返回 null */
export async function embedViaLocalEndpoint(texts: string[]): Promise<number[][] | null> {
  const ep = started;
  if (!ep) return null;
  try {
    const res = await fetch(`${ep.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ input: texts, model: ep.model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: { embedding?: number[] }[] };
    if (!Array.isArray(payload.data)) return null;
    const vectors = payload.data.map((d) => d.embedding);
    if (vectors.some((v) => !Array.isArray(v))) return null;
    return vectors as number[][];
  } catch {
    return null;
  }
}
