import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { serverRoot } from "../config/paths.js";

import type {
  DesktopVisualPort,
  DesktopVisualRunInput,
  DesktopVisualRunResult,
  DesktopVisualRunShellInput,
  DesktopVisualRunShellResult,
  DesktopVisualOpenInput,
  DesktopVisualOpenResult,
  DesktopVisualUiaQueryInput,
  DesktopVisualUiaQueryResult,
  DesktopVisualScreenshotInput,
  DesktopVisualScreenshotResult,
  DesktopVisualRunInputInput,
  DesktopVisualRunInputResult,
  DesktopVisualRunAutomationInput,
  DesktopVisualRunAutomationResult,
  DesktopVisualHttpGetInput,
  DesktopVisualHttpGetResult,
  DesktopVisualWebSearchInput,
  DesktopVisualWebSearchResult,
  DesktopVisualWebFetchInput,
  DesktopVisualWebFetchResult,
  DesktopVisualWindowInput,
  DesktopVisualWindowResult,
  DesktopVisualClipboardInput,
  DesktopVisualClipboardResult,
  DesktopVisualReadDocumentInput,
  DesktopVisualReadDocumentResult,
  DesktopVisualSetDndInput,
  DesktopVisualSetDndResult,
} from "./desktop-visual-port.js";
import { resolveDesktopVisualVlmConfig } from "./desktop-visual-vlm-config.js";
import { isVisualEnabled } from "./desktop-visual-env.js";

// 纯 env 判定收敛到叶子模块 desktop-visual-env.ts（避免 env 谓词随本模块的重依赖被静态引出）。
export { isLocalDesktopVisualEnabledFromEnv } from "./desktop-visual-env.js";

function envStr(env: NodeJS.ProcessEnv, key: string, legacyKey: string, fallback = ""): string {
  return env[key]?.trim() || env[legacyKey]?.trim() || fallback;
}

function packageDirExists(root: string): boolean {
  return (
    existsSync(join(root, "desktop_visual")) ||
    existsSync(join(root, "desktop_visual_agent"))
  );
}

function defaultPackageRoot(): string {
  return join(serverRoot(), "desktop-visual");
}

function resolvePackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envStr(env, "DESKTOP_VISUAL_ROOT", "DESKTOP_VISUAL_AGENT_ROOT");
  if (fromEnv && packageDirExists(fromEnv)) {
    return fromEnv;
  }
  const rel = defaultPackageRoot();
  if (packageDirExists(rel)) {
    return rel;
  }
  return rel;
}

/** 供桥接自启动与子进程共用 Python 路径与包根目录。 */
export function getDesktopVisualPaths(env: NodeJS.ProcessEnv = process.env): {
  pythonExe: string;
  packageRoot: string;
} {
  return {
    pythonExe: envStr(env, "DESKTOP_VISUAL_PYTHON", "DESKTOP_VISUAL_AGENT_PYTHON", "python"),
    packageRoot: resolvePackageRoot(env),
  };
}

type StdioWorkerResult = { ok: boolean; error?: string; [key: string]: unknown };

function parseLastJsonLine(stdout: string): StdioWorkerResult | null {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as StdioWorkerResult;
  } catch {
    return null;
  }
}

function spawnStdioWorker(payload: Record<string, unknown>, pythonExe: string, packageRoot: string) {
  return spawn(pythonExe, ["-u", "-m", "desktop_visual.stdio_worker"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: packageRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function withVlmPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const vlm = resolveDesktopVisualVlmConfig();
  return vlm ? { ...payload, vlm } : payload;
}

async function runStdioWorker<T extends StdioWorkerResult>(
  payload: Record<string, unknown>,
  opts: { pythonExe: string; packageRoot: string; timeoutMs: number; timeoutLabel: string },
): Promise<T> {
  const child = spawnStdioWorker(withVlmPayload(payload), opts.pythonExe, opts.packageRoot);

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;

  const exitPromise = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 0));
  });

  const resultPromise = new Promise<T>((resolve) => {
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
      const parsed = parseLastJsonLine(stdout);
      if (parsed) finish(parsed as T);
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });

    child.stdin.end(`${JSON.stringify(payload)}\n`, "utf8");

    timer = setTimeout(() => {
      finish({ ok: false, error: `${opts.timeoutLabel}（>${opts.timeoutMs}ms）` } as T);
    }, opts.timeoutMs);

    void exitPromise.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `python 退出码 ${code}` } as T);
        return;
      }
      const parsed = parseLastJsonLine(stdout);
      if (parsed) {
        resolve(parsed as T);
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      resolve({ ok: false, error: `无法解析子进程输出：${line.slice(0, 400)}` } as T);
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) } as T);
    });
  });

  return resultPromise;
}

export class SubprocessDesktopVisual implements DesktopVisualPort {
  private readonly enabled: boolean;
  private readonly pythonExe: string;
  private readonly packageRoot: string;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = isVisualEnabled(env);
    const paths = getDesktopVisualPaths(env);
    this.pythonExe = paths.pythonExe;
    this.packageRoot = paths.packageRoot;
    const t = Number.parseInt(
      envStr(env, "DESKTOP_VISUAL_TIMEOUT_MS", "DESKTOP_VISUAL_AGENT_TIMEOUT_MS"),
      10,
    );
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : 600_000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualRunResult>(
      {
        action: "run_task",
        task: input.task,
        maxSteps: input.maxSteps ?? 40,
        region: input.region ?? null,
        stub: Boolean(input.stub),
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: this.timeoutMs,
        timeoutLabel: "子进程超时",
      },
    );
  }

  async screenshot(input?: DesktopVisualScreenshotInput): Promise<DesktopVisualScreenshotResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }

    return runStdioWorker<DesktopVisualScreenshotResult>(
      {
        action: "screenshot",
        region: input?.region ?? null,
        display: input?.display ?? null,
        maxDim: input?.maxDim ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: Math.min(30_000, this.timeoutMs),
        timeoutLabel: "截图超时",
      },
    );
  }

  async runShell(input: DesktopVisualRunShellInput): Promise<DesktopVisualRunShellResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // 给工具调用方一点 buffer，Python 内部 5min 硬上限这里不重复夹
    const timeoutMs = Math.max(
      1_000,
      Math.min(300_000, Math.floor(input.timeoutMs ?? 30_000)),
    );
    return runStdioWorker<DesktopVisualRunShellResult>(
      {
        action: "run_shell",
        command: input.command,
        shell: input.shell ?? null,
        cwd: input.cwd ?? null,
        timeoutMs,
        allowDestructive: Boolean(input.allowDestructive),
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: timeoutMs + 5_000,
        timeoutLabel: "run_shell 子进程超时",
      },
    );
  }

  async open(input: DesktopVisualOpenInput): Promise<DesktopVisualOpenResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // 原生打开不走 shell，10s 足够
    return runStdioWorker<DesktopVisualOpenResult>(
      {
        action: "open",
        target: input.target,
        path: input.path,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 15_000,
        timeoutLabel: "open 子进程超时",
      },
    );
  }

  async uiaQuery(
    input: DesktopVisualUiaQueryInput,
  ): Promise<DesktopVisualUiaQueryResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // UIA 查询走 stdio_worker，给 30s（read_children / snapshot 可能慢）
    return runStdioWorker<DesktopVisualUiaQueryResult>(
      {
        action: "uia_query",
        mode: input.mode,
        selector: input.selector ?? null,
        point: input.point ?? null,
        windowTitle: input.windowTitle ?? null,
        maxDepth: input.maxDepth ?? null,
        topOnly: input.topOnly ?? null,
        limit: input.limit ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 30_000,
        timeoutLabel: "uia_query 子进程超时",
      },
    );
  }

  async runInput(input: DesktopVisualRunInputInput): Promise<DesktopVisualRunInputResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // wait（≤10s）/ 剪贴板粘贴长文本都在预算内，30s 足够
    return runStdioWorker<DesktopVisualRunInputResult>(
      {
        action: "run_input",
        inputAction: input.action,
        x: input.x ?? null,
        y: input.y ?? null,
        toX: input.toX ?? null,
        toY: input.toY ?? null,
        button: input.button ?? null,
        text: input.text ?? null,
        key: input.key ?? null,
        keys: input.keys ?? null,
        scrollClicks: input.scrollClicks ?? null,
        scrollX: input.scrollX ?? null,
        waitMs: input.waitMs ?? null,
        holdSeconds: input.holdSeconds ?? null,
        interval: input.interval ?? null,
        moveDuration: input.moveDuration ?? null,
        imageWidth: input.imageWidth ?? null,
        imageHeight: input.imageHeight ?? null,
        coordSpace: input.coordSpace ?? null,
        display: input.display ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 30_000,
        timeoutLabel: "run_input 子进程超时",
      },
    );
  }

  async runAutomation(
    input: DesktopVisualRunAutomationInput,
  ): Promise<DesktopVisualRunAutomationResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // run_automation 内部完成 query + pattern 操作,给 20s(query 遍历可能慢)
    return runStdioWorker<DesktopVisualRunAutomationResult>(
      {
        action: "run_automation",
        // stdio_worker 内部用 action_name 避免和顶层 action 冲突
        action_name: input.action,
        selector: input.selector,
        value: input.value ?? null,
        index: input.index ?? 0,
        topOnly: input.topOnly ?? true,
        windowTitle: input.windowTitle ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 20_000,
        timeoutLabel: "run_automation 子进程超时",
      },
    );
  }

  async httpGet(
    input: DesktopVisualHttpGetInput,
  ): Promise<DesktopVisualHttpGetResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    // http_get 默认 15s,客户端可调到 60s
    const clientTimeout = input.timeoutMs ?? 15_000;
    const workerTimeout = Math.min(clientTimeout + 5_000, 65_000);
    return runStdioWorker<DesktopVisualHttpGetResult>(
      {
        action: "http_get",
        url: input.url,
        headers: input.headers ?? null,
        timeoutMs: input.timeoutMs ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: workerTimeout,
        timeoutLabel: "http_get 子进程超时",
      },
    );
  }

  async webSearch(
    input: DesktopVisualWebSearchInput,
  ): Promise<DesktopVisualWebSearchResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualWebSearchResult>(
      {
        action: "web_search",
        query: input.query,
        limit: input.limit ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 25_000,
        timeoutLabel: "web_search 子进程超时",
      },
    );
  }

  async webFetch(
    input: DesktopVisualWebFetchInput,
  ): Promise<DesktopVisualWebFetchResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualWebFetchResult>(
      {
        action: "web_fetch",
        url: input.url,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 25_000,
        timeoutLabel: "web_fetch 子进程超时",
      },
    );
  }

  async window(input: DesktopVisualWindowInput): Promise<DesktopVisualWindowResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualWindowResult>(
      {
        action: "window",
        windowOp: input.op,
        title: input.title ?? null,
        index: input.index ?? null,
        hwnd: input.hwnd ?? null,
        x: input.x ?? null,
        y: input.y ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 10_000,
        timeoutLabel: "window 子进程超时",
      },
    );
  }

  async clipboard(input: DesktopVisualClipboardInput): Promise<DesktopVisualClipboardResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualClipboardResult>(
      {
        action: "clipboard",
        clipboardOp: input.op,
        text: input.text ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 5_000,
        timeoutLabel: "clipboard 子进程超时",
      },
    );
  }

  async readDocument(input: DesktopVisualReadDocumentInput): Promise<DesktopVisualReadDocumentResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualReadDocumentResult>(
      {
        action: "read_document",
        path: input.path,
        maxChars: input.maxChars ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 20_000,
        timeoutLabel: "read_document 子进程超时",
      },
    );
  }

  async setDnd(input: DesktopVisualSetDndInput): Promise<DesktopVisualSetDndResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面操控未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualSetDndResult>(
      {
        action: "set_dnd",
        dndOp: input.op,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: 8_000,
        timeoutLabel: "set_dnd 子进程超时",
      },
    );
  }
}

/** 单例式工厂：按当前进程环境构造子进程桥接实现。 */
export function createDesktopVisualFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopVisualPort {
  return new SubprocessDesktopVisual(env);
}

