import { getDataDir } from "../config/data-dir.js";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir as fsMkdir,
  writeFile as fsWriteFile,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  rm as fsRm,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

/**
 * 代码执行沙盒服务。
 *
 * 设计要点：
 *   1. **目录隔离**：每个 actorId 在 `data/sandbox/{actorId}/{workspaceId}/` 下有独立工作目录，
 *      按 workspaceId（一般是 sessionId 或任务 ID）子目录隔离，便于多轮文件操作复用同一目录。
 *   2. **代码执行**：用 `node:child_process.spawn` 启动子进程执行 Python / Node 代码
 *      （不用 exec，避免 shell 注入）。代码先写入工作目录下临时脚本文件再执行，
 *      便于 Python traceback 定位行号。
 *   3. **资源限制**：超时（默认 30000ms，可经 `CODE_SANDBOX_TIMEOUT_MS` 配置，上限 120000）、
 *      stdout/stderr 各截断 8KB、读写文件大小上限 10MB。
 *   4. **网络控制**：默认禁网（`SANDBOX_ALLOW_NETWORK=0`），通过移除 HTTP_PROXY 等环境变量
 *      过滤代理 + Python `-I` 隔离模式（忽略用户 site-packages / PYTHONPATH）。
 *      ⚠️ 真正的网络隔离需 OS 级（网络命名空间 / cgroup），此处仅做环境变量层过滤，
 *      适用于可信单用户 Agent 场景。
 *
 * 文件布局：
 *   data/sandbox/
 *     └── {actorId}/
 *         └── {workspaceId}/
 *             ├── output.png      ← 脚本生成的产物（持久）
 *             ├── data.csv        ← 用户经 code.write_file 写入
 *             └── __run_*.py      ← 运行脚本（执行后自动清理）
 */

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 超时上限（毫秒）。 */
const MAX_TIMEOUT_MS = 120_000;
/** 单流（stdout / stderr）截断阈值（字节）。 */
const DEFAULT_OUTPUT_LIMIT = 8 * 1024;
/** 单文件读写大小上限（字节）。 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 禁网时需移除的环境变量键（覆盖代理相关）。 */
const NETWORK_ENV_KEYS: readonly string[] = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

export interface CodeRunParams {
  /** 执行语言。 */
  language: "python" | "node";
  /** 要执行的源代码。 */
  code: string;
  /** 工作目录标识（一般是 sessionId 或任务 ID），同标识复用同一目录便于多轮操作。 */
  workspaceId?: string;
  /** 超时毫秒，默认 30000（受 `CODE_SANDBOX_TIMEOUT_MS` 环境变量与 120000 上限约束）。 */
  timeoutMs?: number;
  /** stdin 输入（可选）。 */
  stdin?: string;
  /** 环境变量覆盖（可选，覆盖子进程默认 env）。 */
  env?: Record<string, string>;
}

export interface CodeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  workspacePath: string;
  error?: string;
}

export interface CodeFileResult {
  ok: boolean;
  path?: string;
  content?: string;
  size?: number;
  error?: string;
}

/** Shell 命令执行参数。 */
export interface ShellRunParams {
  /** 要执行的命令名（如 `ls` / `curl` / `pip`）。会先过白名单/黑名单/正则三道闸。 */
  command: string;
  /** 命令参数数组（每个元素单独传入，不经 shell 解析，避免注入）。 */
  args?: string[];
  /** 工作目录标识（一般是 sessionId 或任务 ID），同标识复用同一目录。 */
  workspaceId?: string;
  /** 超时毫秒，默认 30000（受 `CODE_SANDBOX_TIMEOUT_MS` 环境变量与 120000 上限约束）。 */
  timeoutMs?: number;
  /** stdin 输入（可选）。 */
  stdin?: string;
  /** 环境变量覆盖（可选）。 */
  env?: Record<string, string>;
}

/** Shell 命令执行结果（与 CodeRunResult 同构，便于复用截断/超时逻辑）。 */
export type ShellRunResult = CodeRunResult;

/**
 * Shell 命令白名单（首段命令名必须命中）。
 *
 * 设计原则：
 *   - 只放只读 / 文件操作 / 包管理 / 通用工具类命令，不放任何破坏性命令
 *   - 破坏性命令（rm/del/format/mkfs/dd/shutdown 等）一律拒绝
 *   - 与 `desktop.run_shell` 不同，本沙箱在隔离工作目录内执行，
 *     但仍保留白名单以防误调系统级命令
 */
const SHELL_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // 文件/目录操作（只读 + 轻量写）
  "ls", "dir", "cat", "type", "head", "tail", "wc", "file", "stat",
  "find", "grep", "rg", "ag", "tree", "du", "df",
  "echo", "printf", "date", "whoami", "hostname", "uname", "pwd",
  "mkdir", "touch", "cp", "copy", "mv", "move", "ln",
  "zip", "unzip", "tar", "gzip", "gunzip", "7z",
  // 文本处理
  "sort", "uniq", "cut", "paste", "tr", "sed", "awk", "jq", "xq",
  "diff", "comm", "fold", "fmt", "column", "tsort",
  // 包管理（pip / npm / yarn，允许 install/list/show，禁止 uninstall）
  "pip", "pip3", "python", "python3", "node", "npm", "npx", "yarn", "pnpm",
  // 网络（仅 curl/wget，受禁网策略约束）
  "curl", "wget",
  // 编码/格式转换
  "base64", "xxd", "md5sum", "sha256sum", "iconv", "file",
  "ffmpeg", "ffprobe", "convert", "magick",
  // 版本控制（只读子命令由正则约束）
  "git",
  // Windows 专用（在 Windows 上 dir/type/copy 等已覆盖）
  "where", "tasklist",
]);

/**
 * Shell 命令黑名单（即使白名单命中也不允许的子命令）。
 *
 * 用于拦截 `pip uninstall` / `npm uninstall` / `git push --force` 等危险操作。
 */
const SHELL_SUBCOMMAND_BLOCKLIST: ReadonlySet<string> = new Set([
  "uninstall", "remove", "rm", "del", "rmdir", "rmtree",
  "format", "mkfs", "dd", "shred",
  "shutdown", "reboot", "halt", "poweroff",
  "kill", "killall", "taskkill",
  "chmod", "chown", "chattr",
  "sudo", "su", "runas",
  "push", "force", "reset", "clean", "checkout",
]);

/**
 * 危险参数正则：拦截任何形式的 `rm -rf` / `del /s` / `format C:` 等。
 * 命中即拒绝整个命令。
 */
const SHELL_DANGEROUS_ARG_RE = [
  /(^|[\/\s])rm\s+(-[a-z]*r[a-z]*f?|--recursive)\s/i,        // rm -rf
  /\brm\s+-[a-z]*f[a-z]*r/i,                                  // rm -fr
  /(^|[\/\s])del\s+\/[a-z]*s/i,                               // del /s
  /(^|[\/\s])rmdir\s+\/s/i,                                   // rmdir /s
  /(^|[\/\s])format\s+[a-z]:/i,                               // format C:
  /(^|[\/\s])mkfs\./i,                                        // mkfs.*
  /(^|[\/\s])dd\s+.*of=\/dev\//i,                             // dd of=/dev/
  /\b(sudo|su|runas)\b/i,                                    // 提权
  /;\s*(rm|del|format|mkfs|dd|shutdown|reboot|halt)\b/i,     // 链式危险命令
  /\|\s*(rm|del|format|mkfs|dd|shutdown|reboot|halt)\b/i,    // 管道危险命令
  /\$\(/i,                                                     // 命令替换 $(...)
  /\$\{.*\}/i,                                                 // 变量展开 ${...}
  /\b(rm|del)\s+-[a-z]*r[a-z]*\s+\/(?!tmp|var\/tmp)/i,        // rm -r / 非 tmp
];

/** shell 命令执行结果。 */
export interface ShellPolicyDecision {
  allowed: boolean;
  reason?: string;
}

interface SpawnCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

export class CodeSandboxService {
  /** 落盘根目录（绝对路径）。 */
  private readonly rootDir: string;
  /** Python 命令探测缓存：`string` 命令名 / `null` 探测失败 / `undefined` 未探测。 */
  private pythonCmdCache: string | null | undefined;

  constructor(rootDir?: string) {
    this.rootDir = resolve(rootDir ?? join(getDataDir(), "sandbox"));
  }

  /** 落盘根目录（绝对路径，供路由层做路径穿越防护比对）。 */
  getRoot(): string {
    return this.rootDir;
  }

  /**
   * 执行代码。
   *
   * 把代码写入工作目录下临时脚本文件，spawn 子进程执行，捕获 stdout/stderr/exitCode。
   * 超时用 `setTimeout + kill(SIGKILL)`。stdout/stderr 各截断到 8KB。
   */
  async runCode(actorId: string, params: CodeRunParams): Promise<CodeRunResult> {
    const startedAt = Date.now();
    const workspaceId = params.workspaceId?.trim() || randomUUID();

    const wsEnsure = await this.ensureWorkspace(actorId, workspaceId);
    if ("error" in wsEnsure) {
      return {
        ok: false, stdout: "", stderr: "", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath: "", error: wsEnsure.error,
      };
    }
    const workspacePath = wsEnsure.path;

    if (!params.code) {
      return {
        ok: false, stdout: "", stderr: "code 为空", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath, error: "code 为空",
      };
    }

    const timeoutMs = Math.min(
      Math.max(1, params.timeoutMs ?? this.getDefaultTimeoutMs()),
      MAX_TIMEOUT_MS,
    );

    // 写入临时脚本文件（便于 traceback 定位行号，不污染系统 /tmp）
    const ext = params.language === "python" ? ".py" : ".js";
    const scriptName = `__run_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
    const scriptPath = join(workspacePath, scriptName);
    try {
      await fsWriteFile(scriptPath, params.code, "utf-8");
    } catch (e) {
      return {
        ok: false, stdout: "", stderr: "", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath, error: `写入脚本失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // 解析命令
    const cmd = params.language === "node"
      ? "node"
      : await this.resolvePythonCommand();
    if (!cmd) {
      // 清理临时脚本
      try { await fsRm(scriptPath, { force: true }); } catch { /* ignore */ }
      return {
        ok: false, stdout: "", stderr: "", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath,
        error: `未找到 ${params.language} 运行时（请安装 python3 或 node）`,
      };
    }

    // Python 用 -I 隔离模式（忽略 PYTHONPATH / PYTHONHOME / 用户 site-packages）
    const args = params.language === "python" ? ["-I", scriptPath] : [scriptPath];

    // 构造子进程环境
    const childEnv = this.buildChildEnv(workspacePath, params.env);

    const cap = await this.spawnCapture(cmd, args, {
      cwd: workspacePath,
      env: childEnv,
      timeoutMs,
      stdin: params.stdin,
    });

    // 清理临时脚本（用户产物保留）
    try { await fsRm(scriptPath, { force: true }); } catch { /* ignore */ }

    return {
      ok: cap.exitCode === 0 && !cap.timedOut,
      stdout: cap.stdout,
      stderr: cap.stderr,
      exitCode: cap.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: cap.timedOut,
      truncated: cap.truncated,
      workspacePath,
      ...(cap.error ? { error: cap.error } : {}),
    };
  }

  /**
   * 执行 shell 命令（在沙箱工作目录内，带白名单+黑名单+正则三道闸）。
   *
   * 与 {@link runCode} 的区别：
   *   - runCode 把代码写入临时脚本文件再执行；runShell 直接 spawn 命令 + 参数数组
   *   - runShell 走三道闸策略校验（白名单命令名 / 黑名单子命令 / 危险参数正则）
   *   - 适用于：ls/grep/curl/pip install/ffmpeg/git log 等系统命令
   *
   * 安全策略：
   *   1. 命令名必须在 {@link SHELL_COMMAND_ALLOWLIST} 内
   *   2. 参数中不能出现 {@link SHELL_SUBCOMMAND_BLOCKLIST} 列出的子命令
   *   3. 整条命令（command + args 拼接）不能命中 {@link SHELL_DANGEROUS_ARG_RE}
   *   4. 在隔离工作目录内执行（cwd = workspacePath）
   *   5. 复用 spawnCapture 的超时/截断/禁网逻辑
   *
   * @param params 命令参数，详见 {@link ShellRunParams}
   * @returns 执行结果，结构与 {@link runCode} 一致
   */
  async runShell(actorId: string, params: ShellRunParams): Promise<ShellRunResult> {
    const startedAt = Date.now();
    const workspaceId = params.workspaceId?.trim() || randomUUID();

    const wsEnsure = await this.ensureWorkspace(actorId, workspaceId);
    if ("error" in wsEnsure) {
      return {
        ok: false, stdout: "", stderr: "", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath: "", error: wsEnsure.error,
      };
    }
    const workspacePath = wsEnsure.path;

    const command = (params.command ?? "").trim();
    if (!command) {
      return {
        ok: false, stdout: "", stderr: "command 为空", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath, error: "command 为空",
      };
    }

    const args = Array.isArray(params.args) ? params.args.map(String) : [];

    // 三道闸策略校验
    const policy = this.checkShellPolicy(command, args);
    if (!policy.allowed) {
      return {
        ok: false, stdout: "", stderr: "", exitCode: null,
        durationMs: Date.now() - startedAt, timedOut: false, truncated: false,
        workspacePath,
        error: `SHELL_POLICY_DENIED: ${policy.reason ?? "命令被安全策略拒绝"}`,
      };
    }

    const timeoutMs = Math.min(
      Math.max(1, params.timeoutMs ?? this.getDefaultTimeoutMs()),
      MAX_TIMEOUT_MS,
    );

    const childEnv = this.buildChildEnv(workspacePath, params.env);

    const cap = await this.spawnCapture(command, args, {
      cwd: workspacePath,
      env: childEnv,
      timeoutMs,
      stdin: params.stdin,
    });

    return {
      ok: cap.exitCode === 0 && !cap.timedOut,
      stdout: cap.stdout,
      stderr: cap.stderr,
      exitCode: cap.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: cap.timedOut,
      truncated: cap.truncated,
      workspacePath,
      ...(cap.error ? { error: cap.error } : {}),
    };
  }

  /**
   * 校验 shell 命令是否符合安全策略（三道闸）。
   *
   * 1. 命令名白名单：`command` 必须在 {@link SHELL_COMMAND_ALLOWLIST} 内
   * 2. 子命令黑名单：`args` 中不能出现 {@link SHELL_SUBCOMMAND_BLOCKLIST} 列出的子命令
   * 3. 危险参数正则：整条命令不能命中 {@link SHELL_DANGEROUS_ARG_RE}
   *
   * @param command 命令名（已 trim）
   * @param args 参数数组
   * @returns `{ allowed: true }` 或 `{ allowed: false, reason }`
   */
  checkShellPolicy(command: string, args: readonly string[]): ShellPolicyDecision {
    // 1. 命令名白名单
    if (!SHELL_COMMAND_ALLOWLIST.has(command)) {
      return {
        allowed: false,
        reason: `命令 "${command}" 不在白名单内（允许: ls/grep/curl/pip/npm/ffmpeg/git 等通用工具命令）`,
      };
    }

    // 2. 子命令黑名单（检查首个非选项参数，如 `pip uninstall` 的 `uninstall`）
    for (const a of args) {
      const lower = a.toLowerCase().replace(/^-+/, "");
      if (SHELL_SUBCOMMAND_BLOCKLIST.has(lower)) {
        return {
          allowed: false,
          reason: `子命令 "${a}" 在黑名单内（禁止 uninstall/remove/push --force 等危险操作）`,
        };
      }
    }

    // 3. 危险参数正则（整条命令拼接后匹配）
    const fullCmd = [command, ...args].join(" ");
    for (const re of SHELL_DANGEROUS_ARG_RE) {
      if (re.test(fullCmd)) {
        return {
          allowed: false,
          reason: `命令匹配危险模式 ${re.source}（禁止 rm -rf / del /s / format / sudo / 命令替换等）`,
        };
      }
    }

    return { allowed: true };
  }

  /** 列出工作目录文件。 */
  async listFiles(actorId: string, workspaceId: string): Promise<CodeFileResult[]> {
    const wsPath = this.resolveWorkspacePath(actorId, workspaceId);
    if (!wsPath) return [{ ok: false, error: "无效的工作目录标识（路径穿越被拒）" }];
    try {
      const entries = await fsReaddir(wsPath, { withFileTypes: true });
      const results: CodeFileResult[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        // 跳过运行脚本残留
        if (entry.name.startsWith("__run_")) continue;
        try {
          const s = await fsStat(join(wsPath, entry.name));
          results.push({ ok: true, path: entry.name, size: s.size });
        } catch {
          // 单个文件 stat 失败忽略，继续列其他
        }
      }
      return results;
    } catch (e) {
      return [{
        ok: false,
        error: `列出文件失败：${e instanceof Error ? e.message : String(e)}`,
      }];
    }
  }

  /** 读取工作目录文件。 */
  async readFile(actorId: string, workspaceId: string, fileName: string): Promise<CodeFileResult> {
    const full = this.resolveWorkspacePath(actorId, workspaceId, fileName);
    if (!full) return { ok: false, error: "无效的文件名（路径穿越被拒）" };
    try {
      const s = await fsStat(full);
      if (!s.isFile()) return { ok: false, error: "不是常规文件" };
      if (s.size > MAX_FILE_SIZE) {
        return { ok: false, error: `文件过大（${s.size} 字节，上限 ${MAX_FILE_SIZE}）` };
      }
      const content = await fsReadFile(full, "utf-8");
      return { ok: true, path: fileName, content, size: s.size };
    } catch (e) {
      return { ok: false, error: `读取文件失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 写入工作目录文件。 */
  async writeFile(
    actorId: string,
    workspaceId: string,
    fileName: string,
    content: string,
  ): Promise<CodeFileResult> {
    const full = this.resolveWorkspacePath(actorId, workspaceId, fileName);
    if (!full) return { ok: false, error: "无效的文件名（路径穿越被拒）" };
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
      return { ok: false, error: `写入内容过大（上限 ${MAX_FILE_SIZE} 字节）` };
    }
    const wsEnsure = await this.ensureWorkspace(actorId, workspaceId);
    if ("error" in wsEnsure) return { ok: false, error: wsEnsure.error };
    try {
      await fsWriteFile(full, content, "utf-8");
      const size = (await fsStat(full)).size;
      return { ok: true, path: fileName, size };
    } catch (e) {
      return { ok: false, error: `写入文件失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * 解析工作目录路径（防穿越）。
   *
   * @param fileName 可选；传入时返回该文件的绝对路径，不传时返回工作目录本身
   * @returns 合法路径返回绝对路径字符串；非法（路径穿越 / 非法字符）返回 `null`
   */
  resolveWorkspacePath(
    actorId: string,
    workspaceId: string,
    fileName?: string,
  ): string | null {
    const safeActor = this.sanitizeSegment(actorId, "anonymous");
    const safeWs = this.sanitizeSegment(workspaceId, "default");
    const base = resolve(this.rootDir, safeActor, safeWs).normalize();
    const actorBase = resolve(this.rootDir, safeActor).normalize();
    if (!this.isWithin(actorBase, base)) return null;
    if (!fileName) return base;
    // fileName 严格校验：不允许路径分隔符 / `.` / `..`
    if (/[\\/]/.test(fileName)) return null;
    if (fileName === "." || fileName === "..") return null;
    const full = resolve(base, fileName).normalize();
    if (!this.isWithin(base, full)) return null;
    return full;
  }

  // ─────────────────────────── 私有工具 ───────────────────────────

  /** 清洗路径段：仅保留 `[a-zA-Z0-9_-]`，空则回退 fallback。 */
  private sanitizeSegment(s: string, fallback: string): string {
    const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  }

  /** `child` 是否位于 `parent` 之内（含相等）。用 `relative` 避免前缀误匹配。 */
  private isWithin(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    if (rel === "") return true;
    if (rel === "..") return false;
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  /** 读取默认超时（受 `CODE_SANDBOX_TIMEOUT_MS` 环境变量与上限约束）。 */
  private getDefaultTimeoutMs(): number {
    const env = Number(process.env.CODE_SANDBOX_TIMEOUT_MS);
    if (Number.isFinite(env) && env > 0) {
      return Math.min(Math.floor(env), MAX_TIMEOUT_MS);
    }
    return DEFAULT_TIMEOUT_MS;
  }

  /** 构造子进程环境变量：基于 process.env，禁网时移除代理变量，注入工作目录标记。 */
  private buildChildEnv(
    workspacePath: string,
    userEnv?: Record<string, string>,
  ): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const allowNetwork = /^(1|true|yes)$/i.test(process.env.SANDBOX_ALLOW_NETWORK ?? "");
    if (!allowNetwork) {
      for (const k of NETWORK_ENV_KEYS) delete env[k];
      env.SANDBOX_NETWORK = "disabled";
    } else {
      env.SANDBOX_NETWORK = "enabled";
    }
    env.SANDBOX_WORKSPACE = workspacePath;
    if (userEnv) {
      for (const [k, v] of Object.entries(userEnv)) env[k] = v;
    }
    return env;
  }

  /** 探测可用的 Python 命令（优先 `python`，回退 `python3`），结果缓存。 */
  private async resolvePythonCommand(): Promise<string | null> {
    if (this.pythonCmdCache !== undefined) return this.pythonCmdCache;
    this.pythonCmdCache = await this.detectCommand(["python", "python3"]);
    return this.pythonCmdCache;
  }

  /** 依次尝试候选命令的 `--version`，返回第一个可用的。 */
  private async detectCommand(candidates: readonly string[]): Promise<string | null> {
    for (const cmd of candidates) {
      // spawn 对缺失命令不会同步抛错，而是异步触发 'error' 事件；
      // 同步抛错仅见于参数类型错误（此处 cmd 恒为 string），故无需 try/catch。
      const child: ChildProcess = spawn(cmd, ["--version"], { stdio: "ignore", shell: false });
      const ok = await new Promise<boolean>((resolveFn) => {
        child.on("error", () => resolveFn(false));
        child.on("exit", (code) => resolveFn(code === 0));
      });
      if (ok) return cmd;
    }
    return null;
  }

  /**
   * spawn 子进程并捕获 stdout/stderr/exitCode。
   *
   * - stdout/stderr 各截断到 8KB，超出设 `truncated=true`，但仍持续消费避免管道阻塞。
   * - 超时发 SIGKILL。
   * - stdin 写入后立即 end（EOF）。
   */
  private spawnCapture(
    cmd: string,
    args: readonly string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      stdin?: string;
    },
  ): Promise<SpawnCaptureResult> {
    return new Promise((resolveFn) => {
      let child: ChildProcessWithoutNullStreams;
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
          error: `启动子进程失败：${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number | null, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveFn({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode, timedOut, truncated, error,
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= DEFAULT_OUTPUT_LIMIT) return; // 已满，仅消费不存储
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
      child.stderr.on("data", (chunk: Buffer) => {
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

      // stdin：有输入则写入，随后 end（EOF）
      if (opts.stdin != null) {
        try { child.stdin.write(opts.stdin); } catch { /* 进程可能已退出 */ }
      }
      try { child.stdin.end(); } catch { /* ignore */ }

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, opts.timeoutMs);

      child.on("error", (err: Error) => {
        finish(null, `子进程错误：${err.message}`);
      });
      child.on("close", (code: number | null) => {
        finish(code);
      });
    });
  }

  /** 确保工作目录存在。成功返回 `{ path }`，失败返回 `{ error }`。 */
  private async ensureWorkspace(
    actorId: string,
    workspaceId: string,
  ): Promise<{ path: string } | { error: string }> {
    const wsPath = this.resolveWorkspacePath(actorId, workspaceId);
    if (!wsPath) return { error: "无效的工作目录标识（路径穿越被拒）" };
    try {
      await fsMkdir(wsPath, { recursive: true });
      return { path: wsPath };
    } catch (e) {
      return { error: `创建工作目录失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
