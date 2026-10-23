/**
 * code.run Worker 脚本：在独立线程中执行代码沙盒。
 *
 * 接收 { id, type, payload } 消息，执行后返回 { id, ok, result | error }。
 * 故障隔离：脚本崩溃不影响主进程。
 *
 * payload: { actorId, params: { language, code, workspaceId?, timeoutMs?, stdin? } }
 */

import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT = 8 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const NETWORK_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

// 数据目录由主进程经 workerData 注入（config/data-dir 统一解析）
const rootDir = resolve(workerData.dataDir, "sandbox");
let pythonCmdCache = null;

async function detectCommand(candidates) {
  for (const cmd of candidates) {
    const child = spawn(cmd, ["--version"], { stdio: "ignore", shell: false });
    const ok = await new Promise((resolveFn) => {
      child.on("error", () => resolveFn(false));
      child.on("exit", (code) => resolveFn(code === 0));
    });
    if (ok) return cmd;
  }
  return null;
}

async function resolvePythonCommand() {
  if (pythonCmdCache !== undefined) return pythonCmdCache;
  pythonCmdCache = await detectCommand(["python", "python3"]);
  return pythonCmdCache;
}

function buildChildEnv() {
  const env = { ...process.env };
  if (process.env.SANDBOX_ALLOW_NETWORK !== "1") {
    for (const key of NETWORK_ENV_KEYS) delete env[key];
  }
  return env;
}

function spawnCapture(cmd, args, opts) {
  return new Promise((resolveFn) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (e) {
      resolveFn({
        stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false,
        error: `启动子进程失败：${e.message}`,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode, timedOut, truncated, error,
      });
    };

    child.stdout.on("data", (chunk) => {
      if (stdoutBytes >= DEFAULT_OUTPUT_LIMIT) return;
      const remaining = DEFAULT_OUTPUT_LIMIT - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= DEFAULT_OUTPUT_LIMIT) return;
      const remaining = DEFAULT_OUTPUT_LIMIT - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); } catch {}
    }
    try { child.stdin.end(); } catch {}

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, opts.timeoutMs);

    child.on("error", (err) => finish(null, `子进程错误：${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

async function runCode(actorId, params) {
  const startedAt = Date.now();
  const workspaceId = params.workspaceId?.trim() || randomUUID();
  const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
  const workspacePath = join(rootDir, safeActorId, workspaceId);

  await mkdir(workspacePath, { recursive: true });

  if (!params.code) {
    return { ok: false, stdout: "", stderr: "code 为空", exitCode: null, durationMs: Date.now() - startedAt, timedOut: false, truncated: false, workspacePath, error: "code 为空" };
  }

  const timeoutMs = Math.min(Math.max(1, params.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const ext = params.language === "python" ? ".py" : ".js";
  const scriptName = `__run_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const scriptPath = join(workspacePath, scriptName);

  await writeFile(scriptPath, params.code, "utf-8");

  const cmd = params.language === "node" ? "node" : await resolvePythonCommand();
  if (!cmd) {
    try { await rm(scriptPath, { force: true }); } catch {}
    return { ok: false, stdout: "", stderr: "", exitCode: null, durationMs: Date.now() - startedAt, timedOut: false, truncated: false, workspacePath, error: `未找到 ${params.language} 运行时` };
  }

  const args = params.language === "python" ? ["-I", scriptPath] : [scriptPath];
  const env = buildChildEnv();

  const result = await spawnCapture(cmd, args, { cwd: workspacePath, env, timeoutMs, stdin: params.stdin });

  try { await rm(scriptPath, { force: true }); } catch {}

  return {
    ...result,
    durationMs: Date.now() - startedAt,
    workspacePath,
    ok: !result.error && !result.timedOut && result.exitCode === 0,
  };
}

parentPort.on("message", async (msg) => {
  const { id, payload } = msg;
  try {
    const result = await runCode(payload.actorId, payload.params);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
