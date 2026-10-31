/**
 * 支付宝 AI 支付能力服务 —— 封装项目内置 alipay-bot CLI。
 *
 * CLI 已迁移到 `server/alipay-bot-cli/`（用户级目录安装已清理），
 * 本服务通过 `node:child_process` 调用其入口 `bin/alipay-bot.cmd`（win32）
 * 或 `runtime/dist/cli.js`，完成：
 *   - 钱包生命周期：check-wallet / apply-wallet / bind-wallet / close-wallet
 *   - 收银台支付：submit-payment / query-payment-status
 *   - HTTP 402 协议支付：402-buyer-pay / 402-query-payment-status / 402-buyer-fulfillment-ack
 *   - 问题反馈：problem-feedback
 *
 * 钱包按用户隔离：所有真实操作都通过 {@link AlipayBotService.forUser} 获取
 * 用户级实例，其状态目录为 `<stateHome>/users/<userId>/`，每个终端用户
 * 扫码授权自己的支付宝、支付从本人账户扣款，互不干扰。
 *
 * 所有命令均以真实 CLI 输出为准，不模拟结果。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serverRoot } from "../config/paths.js";

const execFileAsync = promisify(execFile);

/** 命令执行结果。 */
export type AlipayBotCommandResult = {
  ok: boolean;
  /** 原始输出（stdout，含 JSON 或对客文本）。 */
  stdout: string;
  /** stderr（诊断用，不对客展示）。 */
  stderr?: string;
  /** 解析后的 JSON（若输出为 JSON）。 */
  json?: Record<string, unknown>;
  /** 输出中提取的 MEDIA 图片路径（二维码等）。 */
  media?: string[];
  error?: string;
};

/** 钱包状态摘要。 */
export type AlipayWalletStatus = {
  code: 200 | 500 | "unknown";
  message: string;
  status: "enabled" | "applied_unbound" | "not_opened" | "unknown";
  reason?: string;
};

export interface AlipayBotServiceOptions {
  /** CLI 目录（含 bin/ 与 runtime/）。默认探测项目内 `server/alipay-bot-cli`。 */
  cliRoot?: string;
  /** 命令超时（毫秒），默认 60s。 */
  timeoutMs?: number;
  /**
   * 项目独立的状态目录（钱包/授权/日志等）。
   *
   * CLI 默认把状态写到用户主目录（`~/.alipay-bot-cli`，且按运行框架隔离，
   * 如 trae 环境写 `claws/trae/`）。传入本项目内目录后，通过覆盖
   * `USERPROFILE`/`HOME` 环境变量，让授权状态落到项目内、与 trae 完全隔离，
   * 项目 agent 获得独立身份。默认 `server/data/alipay-bot-state`。
   */
  stateHome?: string;
}

/** 探测项目内 CLI 根目录：优先 env，其次模块相对路径，最后 cwd 上溯。 */
function resolveCliRoot(): string {
  const fromEnv = process.env.ALIPAY_BOT_CLI_ROOT?.trim();
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);

  const candidates: string[] = [join(serverRoot(), "alipay-bot-cli")];
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "alipay-bot-cli"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const hit = candidates.find((c) => existsSync(join(c, "runtime", "dist", "cli.js")));
  if (hit) return hit;
  throw new Error("alipay-bot-cli 未找到。请将 alipay-bot-cli 目录放到 server/ 下，或设置 ALIPAY_BOT_CLI_ROOT 环境变量。");
}

/** 探测项目内状态目录：优先 env，其次模块相对路径（server/data/alipay-bot-state）。 */
function resolveStateHome(): string {
  const fromEnv = process.env.ALIPAY_BOT_STATE_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);

  const candidates = [join(serverRoot(), "data", "alipay-bot-state")];
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "data", "alipay-bot-state"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(candidates[0]);
}

/**
 * 把用户标识清洗成安全的目录名（用于 `<stateHome>/users/<dirName>/`）。
 *
 * - 仅保留 `[A-Za-z0-9._-]`，其余替换为 `_`；剥离前导点（防 `.`/`..` 穿越）；
 * - 截断到 64 字符后拼接 8 位 sha256 短哈希，保证不同 userKey 清洗后不会碰撞，
 *   避免两个用户共用一个钱包目录。
 */
function sanitizeUserKey(userKey: string): string {
  const trimmed = userKey.trim();
  if (!trimmed) {
    throw new Error("alipay forUser: userKey 不能为空，无法确定用户钱包目录");
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 64);
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  return `${safe || "user"}_${hash}`;
}

export class AlipayBotService {
  /** CLI 根目录；未补齐 dist 时为 null（服务降级，不阻断启动）。 */
  private readonly cliRoot: string | null;
  private readonly timeoutMs: number;
  private readonly stateHome: string;
  /** 按用户缓存的钱包实例（每个用户独立 stateHome 目录）。 */
  private readonly userInstances = new Map<string, AlipayBotService>();

  constructor(options?: AlipayBotServiceOptions) {
    if (options?.cliRoot) {
      this.cliRoot = resolve(options.cliRoot);
    } else {
      try {
        this.cliRoot = resolveCliRoot();
      } catch (err) {
        // CLI 入口（runtime/dist/cli.js）缺失时不阻断服务启动，仅在真正调用支付命令时上报。
        this.cliRoot = null;
        console.warn(`[alipay-bot] ${(err as Error).message} —— 支付宝 AI 支付能力暂不可用（服务已进入降级模式，不影响其它能力）；补齐 server/alipay-bot-cli/runtime/dist 后重启即恢复。`);
      }
    }
    this.timeoutMs = options?.timeoutMs ?? 60_000;
    this.stateHome = options?.stateHome ? resolve(options.stateHome) : resolveStateHome();
    // 确保状态目录存在，CLI 会把钱包/授权状态写到这里
    mkdirSync(this.stateHome, { recursive: true });
  }

  /**
   * 获取指定用户的独立钱包实例（钱包按用户隔离）。
   *
   * 返回的实例使用独立状态目录 `<stateHome>/users/<sanitizedUserId>/`，
   * 该用户授权的支付宝钱包、收银台支付、402 支付状态都只落在这个目录，
   * 与其它用户完全隔离 —— 终端用户各自扫码授权自己的支付宝，扣款走本人账户。
   * 实例按用户缓存复用；userKey 为空时抛错，避免退化成共享目录。
   */
  forUser(userKey: string): AlipayBotService {
    const dirName = sanitizeUserKey(userKey);
    let inst = this.userInstances.get(dirName);
    if (!inst) {
      inst = new AlipayBotService({
        cliRoot: this.cliRoot ?? undefined,
        timeoutMs: this.timeoutMs,
        stateHome: join(this.stateHome, "users", dirName),
      });
      this.userInstances.set(dirName, inst);
    }
    return inst;
  }

  /**
   * CLI 可执行命令：统一用 node 直跑 cli.js。
   * （execFile 在 Windows 上无法直接执行 .cmd，故不走 bin/alipay-bot.cmd）
   */
  private buildExec(): { command: string; argsPrefix: string[] } {
    if (!this.cliRoot) {
      throw new Error(
        "alipay-bot-cli 未找到（runtime/dist/cli.js 缺失）。请将 server/alipay-bot-cli/runtime/dist 补齐，或设置 ALIPAY_BOT_CLI_ROOT 环境变量。",
      );
    }
    const cliJs = join(this.cliRoot, "runtime", "dist", "cli.js");
    if (!existsSync(cliJs)) {
      throw new Error(`alipay-bot-cli 入口不存在: ${cliJs}`);
    }
    return { command: process.execPath, argsPrefix: [cliJs] };
  }

  /**
   * 执行一条 alipay-bot 命令。
   *
   * @param args CLI 参数数组
   * @param cwd 工作目录（默认 process.cwd()）
   */
  async run(args: string[], cwd?: string): Promise<AlipayBotCommandResult> {
    const { command, argsPrefix } = this.buildExec();
    const fullArgs = [...argsPrefix, ...args];
    try {
      const { stdout, stderr } = await execFileAsync(command, fullArgs, {
        cwd: cwd ?? process.cwd(),
        encoding: "utf8",
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        // 项目独立身份：把 CLI 的用户主目录指向项目内状态目录，
        // 授权/钱包状态写到这里，与 trae 用户级目录完全隔离
        env: {
          ...process.env,
          USERPROFILE: this.stateHome,
          HOME: this.stateHome,
        },
      });
      const json = parseJsonOutput(stdout);
      return {
        ok: true,
        stdout,
        stderr: stderr || undefined,
        json,
        media: extractMedia(stdout),
      };
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
        code?: string | number;
      };
      const stdout = err.stdout ?? "";
      return {
        ok: false,
        stdout,
        stderr: err.stderr,
        json: parseJsonOutput(stdout),
        media: extractMedia(stdout),
        error: buildErrorMessage(err, command),
      };
    }
  }

  // ================= 钱包生命周期 =================

  /** 查询当前钱包授权状态（只读）。 */
  async checkWallet(): Promise<AlipayWalletStatus> {
    const result = await this.run(["check-wallet"]);
    const json = result.json;
    if (json) {
      const code: AlipayWalletStatus["code"] =
        json.code === 200 ? 200 : json.code === 500 ? 500 : "unknown";
      return {
        code,
        message: String(json.message ?? ""),
        status: code === 200
          ? (json.status === "applied_unbound" ? "applied_unbound" : "enabled")
          : code === 500
            ? "not_opened"
            : "unknown",
        reason: typeof json.reason === "string" ? json.reason : undefined,
      };
    }
    return { code: "unknown", message: result.stdout.trim() || "查询失败", status: "unknown" };
  }

  /** 申请开通支付功能；带 enrollment code 时使用 `-c`。 */
  async applyWallet(options?: { agentName?: string; code?: string }): Promise<AlipayBotCommandResult> {
    const args = ["apply-wallet"];
    if (options?.code) args.push("-c", options.code);
    else if (options?.agentName) args.push("--agent-name", options.agentName);
    return this.run(args);
  }

  /** 绑定开通码（OTP / 验证码 / 六位授权码）。 */
  async bindWallet(code: string): Promise<AlipayBotCommandResult> {
    return this.run(["bind-wallet", "-c", code]);
  }

  /** 关闭支付功能（返回管理入口或未绑定状态）。 */
  async closeWallet(): Promise<AlipayBotCommandResult> {
    return this.run(["close-wallet"]);
  }

  // ================= 商家下单代理（像千问一样直接发起购买） =================

  /**
   * 代理商家交易请求：调用商家的下单接口（HTTP / MCP），从响应中提取支付宝支付
   * payload（orderStr 订单串或收银台链接），返回 `alipay_` 别名供 submit-payment 使用。
   *
   * 这是「像千问一样直接发起购买」的关键链路：agent 先通过本方法向商家下单，
   * 拿到收银台链接/订单串后，再调用 submitPayment 完成真实支付。
   *
   * @param options.protocol 协议：http（标准 HTTP 下单接口）或 mcp（MCP Streamable HTTP）
   * @param options.url 商家下单接口 URL（必填）
   * @param options.sessionId 业务会话 ID（默认由调用方传入）
   * @param options.extractPath 提取支付 payload 的 JSON 路径（默认 $.alipayMetadata.orderStr）
   * @param options.payloadType payload 类型：link / orderString / auto（默认 auto）
   * @param options.method HTTP method（默认 POST）
   * @param options.query 查询参数（JSON 对象字符串）
   * @param options.body 请求体（JSON 或纯文本）
   * @param options.headers 请求头列表，格式 ['key:value', ...]
   * @param options.mcpMethod MCP JSON-RPC method（mcp 协议必填）
   * @param options.params MCP JSON-RPC params（JSON）
   * @param options.timeoutMs 单请求超时（默认 10000）
   */
  async proxyTradeRequest(options: {
    protocol: "http" | "mcp";
    url: string;
    sessionId?: string;
    extractPath?: string;
    payloadType?: "link" | "orderString" | "auto";
    method?: string;
    query?: string;
    body?: string;
    headers?: string[];
    mcpMethod?: string;
    params?: string;
    timeoutMs?: number;
  }): Promise<AlipayBotCommandResult> {
    const args = ["proxy-trade-request", options.protocol, "--url", options.url];
    if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.extractPath) args.push("--extract-path", options.extractPath);
    if (options.payloadType) args.push("--payload-type", options.payloadType);
    if (options.method) args.push("-X", options.method);
    if (options.query) args.push("--query", options.query);
    if (options.body) args.push("-d", options.body);
    for (const h of options.headers ?? []) args.push("-H", h);
    if (options.mcpMethod) args.push("--mcp-method", options.mcpMethod);
    if (options.params) args.push("--params", options.params);
    if (options.timeoutMs) args.push("--timeout-ms", String(options.timeoutMs));
    return this.run(args);
  }

  // ================= 收银台支付 =================

  /**
   * 提交收银台支付。
   *
   * @param sessionId 真实业务会话 ID（UUID）
   * @param paymentLink 收银台链接或订单串（cashier*.alipay.com / qr.alipay.com 等）
   * @param intentSummary 意图摘要，格式：`服务内容：xxx，支付金额：¥xx，支付对象：xxx`
   */
  async submitPayment(
    sessionId: string,
    paymentLink: string,
    intentSummary: string,
  ): Promise<AlipayBotCommandResult> {
    return this.run([
      "submit-payment",
      "--session-id", sessionId,
      "--payment-link", paymentLink,
      "--intent-summary", intentSummary,
    ]);
  }

  /** 查询收银台支付状态（outShakeNo 或 launchUrl 二选一）。 */
  async queryPaymentStatus(options: { outShakeNo?: string; launchUrl?: string }): Promise<AlipayBotCommandResult> {
    const args = ["query-payment-status"];
    if (options.outShakeNo) args.push("--out-shake-no", options.outShakeNo);
    else if (options.launchUrl) args.push("-p", options.launchUrl);
    else throw new Error("query-payment-status 需要 outShakeNo 或 launchUrl");
    return this.run(args);
  }

  // ================= HTTP 402 协议支付 =================

  /**
   * HTTP 402 买家支付（官方 A2M 协议流程）。
   *
   * 调用规范（对齐官方 `402-payment.md`）：
   * - `Payment-Needed` 必须**原样保存到本地文件**，用 `-f` 传入；直接传
   *   `--amt-payment-link` 会被支付宝网关拒绝（INVALID_PARAMETER）。
   *   传入 amtPaymentLink 时，本方法自动写入 stateHome 下的 `402_needed_<ts>.txt`。
   * - `intentSummary` 固定格式：`原始请求：xxx`（来自触发 402 的用户请求/工具目标）。
   * - 支付前禁止先执行 check-wallet。
   *
   * @param sessionId 真实业务会话 ID
   * @param options amtPaymentLink 与 file 只能出现一个；resourceUrl 必传。
   */
  async pay402(
    sessionId: string,
    options: {
      amtPaymentLink?: string;
      file?: string;
      resourceUrl: string;
      intentSummary: string;
      method?: string;
      data?: string;
      headers?: string[];
    },
  ): Promise<AlipayBotCommandResult> {
    // 官方流程：Payment-Needed 原样存文件，-f 传入（--amt-payment-link 直传会被网关拒绝）
    let file = options.file;
    if (!file && options.amtPaymentLink) {
      file = join(this.stateHome, `402_needed_${Date.now()}.txt`);
      writeFileSync(file, options.amtPaymentLink, "utf8");
    }
    const args = ["402-buyer-pay", "--session-id", sessionId];
    if (file) args.push("-f", file);
    else throw new Error("402-buyer-pay 需要 amtPaymentLink 或 file");
    args.push("--resource-url", options.resourceUrl, "--intent-summary", options.intentSummary);
    if (options.method) args.push("--method", options.method);
    if (options.data) args.push("--data", options.data);
    for (const h of options.headers ?? []) args.push("--header", h);
    return this.run(args);
  }

  /** 查询 402 支付状态（outShakeNo 或 tradeNo 二选一）。 */
  async query402Status(
    options: {
      outShakeNo?: string;
      tradeNo?: string;
      resourceUrl?: string;
      method?: string;
      data?: string;
      headers?: string[];
    },
  ): Promise<AlipayBotCommandResult> {
    const args = ["402-query-payment-status"];
    if (options.outShakeNo) args.push("--out-shake-no", options.outShakeNo);
    else if (options.tradeNo) args.push("--trade-no", options.tradeNo);
    else throw new Error("402-query-payment-status 需要 outShakeNo 或 tradeNo");
    if (options.resourceUrl) args.push("--resource-url", options.resourceUrl);
    if (options.method) args.push("--method", options.method);
    if (options.data) args.push("--data", options.data);
    for (const h of options.headers ?? []) args.push("--header", h);
    return this.run(args);
  }

  /** 恢复部分履约回执。 */
  async fulfillmentAck(tradeNo: string): Promise<AlipayBotCommandResult> {
    return this.run(["402-buyer-fulfillment-ack", "--trade-no", tradeNo]);
  }

  // ================= 其他 =================

  /** 提交问题反馈。 */
  async problemFeedback(problemText: string): Promise<AlipayBotCommandResult> {
    return this.run(["problem-feedback", problemText]);
  }

  /** 缓存一行支付意图摘要。 */
  async paymentIntent(summary: string): Promise<AlipayBotCommandResult> {
    return this.run(["payment-intent", summary]);
  }

  /** CLI 版本。 */
  async version(): Promise<string> {
    const result = await this.run(["-v"]);
    return result.stdout.trim() || "unknown";
  }
}

/** 从输出中提取 `MEDIA: <path-or-url>` 行。 */
function extractMedia(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*MEDIA:\s*(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 尽力解析 stdout 中的 JSON 对象（可能混有日志前缀行）。 */
function parseJsonOutput(stdout: string): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  // 找最后一个以 { 开头的完整 JSON 对象
  const start = stdout.lastIndexOf("{");
  if (start < 0) return undefined;
  const tail = stdout.slice(start);
  try {
    return JSON.parse(tail) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildErrorMessage(err: { message?: string; killed?: boolean; code?: string | number }, command: string): string {
  if (err.killed) return `命令超时（>60s）: ${command}`;
  const msg = err.message ?? "未知错误";
  return `命令执行失败: ${msg}`;
}
