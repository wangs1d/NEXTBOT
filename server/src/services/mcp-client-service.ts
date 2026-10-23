/**
 * MCP 客户端服务 —— 与 MCP Server 交互
 *
 * 支持三种连接方式：
 * 1. mcporter 模式：通过 mcporter CLI 代理调用（与 UpstreamSearchService 一致）
 * 2. stdio 模式：直接 spawn MCP Server 子进程，通过 JSON-RPC 2.0 / stdio 通信
 * 3. http 模式：远程 streamable-http 端点（如滴滴/瑞幸等远程 MCP），请求头鉴权
 */

import { getDataDir } from "../config/data-dir.js";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------- 类型 ----------

export type McpServerConfig = {
  /** server 别名 */
  alias: string;
  /** 可选描述 */
  description?: string;
  /** 启用/禁用，默认 true */
  enabled?: boolean;
  /** 连接类型：mcporter（通过 mcporter CLI）| npm（直接 stdio 子进程）| http（远程 streamable-http 端点） */
  type?: "mcporter" | "npm" | "http";
  /** npm 模式：启动命令（如 npx） */
  command?: string;
  /** npm 模式：命令参数 */
  args?: string[];
  /** npm 模式：环境变量 */
  env?: Record<string, string>;
  /** http 模式：MCP streamable-http 端点 URL */
  url?: string;
  /** http 模式：附加请求头（值支持 ${ENV_VAR} 形式展开环境变量） */
  headers?: Record<string, string>;
  /** http 模式：单次请求超时毫秒（默认 30000；搜索类服务可调大，取 max(调用方超时, 此值)） */
  timeoutMs?: number;
  /** 备注 */
  notes?: string;
};

export type McpToolSchema = {
  /** 工具注册名，格式 mcp.<alias>.<tool_name> */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 所属 server alias */
  serverAlias: string;
  /** 原始工具名（不含 alias 前缀） */
  rawToolName: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** stdio MCP 子进程实例 */
type StdioServerInstance = {
  process: ChildProcess;
  requestId: number;
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  initialized: boolean;
};

/** http MCP 会话（streamable-http：session id 由服务端通过响应头下发，需在后续请求回传） */
type HttpSession = {
  sessionId?: string;
  initialized: boolean;
};

// ---------- 配置加载 ----------

const DEFAULT_CONFIG_PATH = join(getDataDir(), "mcp-servers.json");

function loadServerConfigs(): McpServerConfig[] {
  const configPath = process.env.MCP_SERVERS_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isValidServerConfig);
      if (parsed.servers && Array.isArray(parsed.servers)) return parsed.servers.filter(isValidServerConfig);
    } catch {
      // 解析失败
    }
  }

  // 环境变量回退
  const envServers = process.env.MCP_SERVERS?.trim();
  if (envServers) {
    return envServers.split(",").map((s) => s.trim()).filter(Boolean).map((alias) => ({ alias }));
  }

  return [];
}

function isValidServerConfig(obj: unknown): obj is McpServerConfig {
  return typeof obj === "object" && obj !== null && typeof (obj as McpServerConfig).alias === "string";
}

// ---------- mcporter 二进制路径 ----------

function resolveMcporterBin(): string {
  return process.env.MCPORTER_BIN?.trim() || "mcporter";
}

/** 从 SSE 文本中解析 data: 载荷（取最后一条可解析的 JSON，单请求响应通常只有一条） */
function parseSseDataPayload(raw: string): unknown {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload);
    } catch {
      // 继续向前找
    }
  }
  return null;
}

// ---------- 服务类 ----------

export class McpClientService {
  private readonly servers: McpServerConfig[];
  private readonly toolCache = new Map<string, McpToolSchema>();
  private cachePopulated = false;
  private cachePopulating: Promise<void> | null = null;
  /** stdio 模式的活跃子进程池 */
  private readonly stdioInstances = new Map<string, StdioServerInstance>();
  /** http 模式的会话池 */
  private readonly httpSessions = new Map<string, HttpSession>();
  private httpRequestId = 0;

  constructor() {
    this.servers = loadServerConfigs().filter((s) => s.enabled !== false);
  }

  listServers(): McpServerConfig[] {
    return [...this.servers];
  }

  listTools(): McpToolSchema[] {
    return Array.from(this.toolCache.values());
  }

  getTool(name: string): McpToolSchema | undefined {
    return this.toolCache.get(name);
  }

  /**
   * 发现所有已配置 server 的可用工具
   * - mcporter 类型：调用 `mcporter list <alias>`
   * - npm/stdio 类型：spawn 子进程 → initialize → tools/list
   * - http 类型：POST initialize → tools/list（streamable-http）
   */
  async discoverTools(): Promise<void> {
    if (this.cachePopulating) return this.cachePopulating;

    this.cachePopulating = (async () => {
      // 各 server 发现互相独立（写 toolCache 为并发安全的 Map.set），并行执行，
      // 避免多 server 串行等待（每 server 最长 15s 超时）拖慢启动。
      await Promise.all(
        this.servers.map(async (server) => {
          try {
            if (server.type === "http") {
              if (!server.url) return;
              await this.discoverHttpTools(server);
            } else if (server.type === "npm") {
              await this.discoverStdioTools(server);
            } else {
              // 默认 mcporter 模式
              await this.discoverMcporterTools(server);
            }
          } catch {
            // 单个 server 发现失败不影响其他
          }
        }),
      );
      this.cachePopulated = true;
    })();

    return this.cachePopulating;
  }

  /**
   * 调用 MCP 工具
   * 根据服务器类型自动选择 http / mcporter / stdio 路径
   */
  async callTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const server = this.servers.find((s) => s.alias === serverAlias);

    if (server?.type === "http") {
      return this.callHttpTool(serverAlias, toolName, args, timeoutMs);
    }
    if (server?.type === "npm") {
      return this.callStdioTool(serverAlias, toolName, args, timeoutMs);
    }
    // 默认 mcporter 模式
    return this.callMcporterTool(serverAlias, toolName, args, timeoutMs);
  }

  async executeByRegistryName(
    registryName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const parsed = this.parseRegistryName(registryName);
    if (!parsed) {
      return { ok: false, result: { error: `无效的 MCP 工具名: ${registryName}` } };
    }
    return this.callTool(parsed.serverAlias, parsed.toolName, args, timeoutMs);
  }

  async healthCheck(): Promise<{
    ok: boolean;
    detail: string;
    servers: Record<string, { ok: boolean; toolCount: number; mode: string }>;
  }> {
    const bin = resolveMcporterBin();
    const versionResult = await this.runCommand(bin, ["--version"], 6_000).catch(() => ({
      ok: false, stdout: "", stderr: "mcporter 未安装", code: 1,
    }));

    const servers: Record<string, { ok: boolean; toolCount: number; mode: string }> = {};
    for (const server of this.servers) {
      const tools = Array.from(this.toolCache.values()).filter((t) => t.serverAlias === server.alias);
      servers[server.alias] = {
        ok: tools.length > 0,
        toolCount: tools.length,
        mode: server.type === "npm" ? "stdio" : server.type === "http" ? "http" : "mcporter",
      };
    }

    return {
      ok: versionResult.ok || Object.values(servers).some((s) => s.ok),
      detail: versionResult.ok
        ? (versionResult.stdout || "ok").split(/\r?\n/)[0] ?? "ok"
        : "mcporter 不可用，部分 stdio 服务可能正常",
      servers,
    };
  }

  /** 关闭所有 stdio 子进程并清理 http 会话 */
  closeAll(): void {
    for (const [alias, instance] of this.stdioInstances) {
      try {
        instance.process.kill();
      } catch {
        // ignore
      }
      this.stdioInstances.delete(alias);
    }
    this.httpSessions.clear();
  }

  // ========== mcporter 模式 ==========

  private async discoverMcporterTools(server: McpServerConfig): Promise<void> {
    const bin = resolveMcporterBin();
    const result = await this.runCommand(bin, ["list", server.alias], 15_000);
    if (!result.ok) return;

    const tools = this.parseMcporterToolList(result.stdout, server.alias);
    for (const tool of tools) {
      this.toolCache.set(tool.name, tool);
    }
  }

  private async callMcporterTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const bin = resolveMcporterBin();
    const callExpr = this.buildCallExpression(serverAlias, toolName, args);
    const result = await this.runCommand(bin, ["call", callExpr], timeoutMs);

    if (!result.ok) {
      return {
        ok: false,
        result: {
          error: `MCP 工具调用失败(${serverAlias}.${toolName}): ${result.stderr || result.stdout || "未知错误"}`,
        },
      };
    }

    try {
      const parsed = JSON.parse(result.stdout);
      return { ok: true, result: typeof parsed === "object" && parsed !== null ? parsed : { data: parsed } };
    } catch {
      return { ok: true, result: { text: result.stdout } };
    }
  }

  // ========== stdio 模式（JSON-RPC 2.0 over stdin/stdout）==========

  private async discoverStdioTools(server: McpServerConfig): Promise<void> {
    const instance = await this.getOrCreateStdioInstance(server);
    if (!instance) return;

    try {
      const response = await this.sendStdioRequest(instance, "tools/list", {}) as {
        tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
      } | null;
      if (response?.tools) {
        for (const tool of response.tools) {
          if (typeof tool !== "object" || !tool.name) continue;
          this.toolCache.set(`mcp.${server.alias}.${tool.name}`, {
            name: `mcp.${server.alias}.${tool.name}`,
            description: tool.description || `${server.alias} MCP 工具: ${tool.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} },
            serverAlias: server.alias,
            rawToolName: tool.name,
          });
        }
      }
    } catch (e) {
      // discover 失败
    }
  }

  private async callStdioTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    _timeoutMs: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const instance = this.stdioInstances.get(serverAlias);
    if (!instance || !instance.initialized) {
      return { ok: false, result: { error: `MCP stdio 服务 ${serverAlias} 未就绪` } };
    }

    try {
      const response = await this.sendStdioRequest(instance, "tools/call", {
        name: toolName,
        arguments: args,
      }) as { content?: Array<{ type?: string; text?: string }> } | null;

      // MCP tools/call 返回 { content: [{ type: "text", text: "..." }] }
      if (response?.content) {
        const texts = response.content
          .filter((c: { type?: string; text?: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text)
          .join("\n");

        // 尝试解析为 JSON
        try {
          const parsed = JSON.parse(texts);
          return { ok: true, result: typeof parsed === "object" ? parsed : { text: texts } };
        } catch {
          return { ok: true, result: { text: texts } };
        }
      }

      return { ok: true, result: (response as Record<string, unknown>) || {} };
    } catch (e) {
      return {
        ok: false,
        result: { error: `MCP stdio 调用失败(${serverAlias}.${toolName}): ${(e as Error).message}` },
      };
    }
  }

  /** 获取或创建 stdio 子进程实例 */
  private async getOrCreateStdioInstance(server: McpServerConfig): Promise<StdioServerInstance | null> {
    const existing = this.stdioInstances.get(server.alias);
    if (existing) return existing;

    const command = server.command || "npx";
    const args = server.args || [];
    const envVars = { ...process.env, ...server.env };

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: envVars,
        windowsHide: true,
      });

      const instance: StdioServerInstance = {
        process: child,
        requestId: 0,
        pendingRequests: new Map(),
        buffer: "",
        initialized: false,
      };

      child.on("error", (err) => {
        console.error(`[MCP] stdio 进程启动失败 (${server.alias}):`, err.message);
        resolve(null);
      });

      // stderr 日志输出
      child.stderr?.on("data", (chunk) => {
        const msg = String(chunk).trim();
        if (msg) console.debug(`[MCP][${server.alias}] stderr: ${msg}`);
      });

      // stdout 数据收集 + JSON-RPC 响应解析
      child.stdout?.on("data", (chunk) => {
        instance.buffer += String(chunk);
        this.tryParseStdioResponses(instance);
      });

      child.on("exit", (code) => {
        console.warn(`[MCP] stdio 进程退出 (${server.alias}), code=${code}`);
        this.stdioInstances.delete(server.alias);
        // 拒绝所有待处理请求
        for (const [, pending] of instance.pendingRequests) {
          pending.reject(new Error(`MCP 进程 ${server.alias} 已退出`));
        }
      });

      // 等待进程就绪后发送 initialize
      setTimeout(async () => {
        try {
          const initResponse = await this.sendStdioRequest(instance, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "nextbot", version: "1.0.0" },
          });

          if (initResponse) {
            // 发送 initialized 通知
            this.sendStdioNotification(instance, "notifications/initialized");
            instance.initialized = true;
            this.stdioInstances.set(server.alias, instance);
            resolve(instance);
          } else {
            resolve(null);
          }
        } catch (e) {
          console.error(`[MCP] stdio 初始化失败 (${server.alias}):`, e);
          resolve(null);
        }
      }, 1000); // 给子进程一点启动时间
    });
  }

  /** 发送 JSON-RPC 请求（有响应） */
  private sendStdioRequest(
    instance: StdioServerInstance,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++instance.requestId;
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      instance.pendingRequests.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        instance.pendingRequests.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, 30_000);

      // 替换 resolve/reject 以便超时时清理
      const origResolve = resolve;
      const origReject = reject;
      instance.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });

      instance.process.stdin!.write(message + "\n");
    });
  }

  /** 发送 JSON-RPC 通知（无响应） */
  private sendStdioNotification(
    instance: StdioServerInstance,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    instance.process.stdin!.write(message + "\n");
  }

  /** 尝试从缓冲区解析完整的 JSON-RPC 响应 */
  private tryParseStdioResponses(instance: StdioServerInstance): void {
    let pos = 0;
    while (pos < instance.buffer.length) {
      const newlineIdx = instance.buffer.indexOf("\n", pos);
      if (newlineIdx === -1) break;

      const line = instance.buffer.slice(pos, newlineIdx).trim();
      pos = newlineIdx + 1;

      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id != null && instance.pendingRequests.has(msg.id)) {
          const pending = instance.pendingRequests.get(msg.id)!;
          instance.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "MCP 错误"));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // 非完整 JSON 行，跳过
      }
    }

    instance.buffer = instance.buffer.slice(pos);
  }

  // ========== http 模式（streamable-http：JSON-RPC 2.0 over HTTP POST）==========

  private async discoverHttpTools(server: McpServerConfig): Promise<void> {
    try {
      const response = await this.sendHttpRpc(server, "tools/list", {}) as {
        tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
      } | null;
      if (response?.tools) {
        for (const tool of response.tools) {
          if (typeof tool !== "object" || !tool.name) continue;
          this.toolCache.set(`mcp.${server.alias}.${tool.name}`, {
            name: `mcp.${server.alias}.${tool.name}`,
            description: tool.description || `${server.alias} MCP 工具: ${tool.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} },
            serverAlias: server.alias,
            rawToolName: tool.name,
          });
        }
      }
    } catch (e) {
      console.warn(`[MCP] http 工具发现失败 (${server.alias}): ${(e as Error).message}`);
    }
  }

  private async callHttpTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const server = this.servers.find((s) => s.alias === serverAlias);
    if (!server?.url) {
      return { ok: false, result: { error: `MCP http 服务 ${serverAlias} 未配置 url` } };
    }

    try {
      await this.ensureHttpSession(server);

      // http 工具调用（如酒店实时搜索）可能比默认 30s 慢，取调用方与配置中的较大值
      const effectiveTimeout = Math.max(timeoutMs, server.timeoutMs ?? 0);
      let response = await this.sendHttpRpc(server, "tools/call", {
        name: toolName,
        arguments: args,
      }, effectiveTimeout) as { content?: Array<{ type?: string; text?: string }> } | null;

      // MCP tools/call 返回 { content: [{ type: "text", text: "..." }] }
      if (response?.content) {
        const texts = response.content
          .filter((c: { type?: string; text?: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text)
          .join("\n");

        // 尝试解析为 JSON
        try {
          const parsed = JSON.parse(texts);
          return { ok: true, result: typeof parsed === "object" && parsed !== null ? parsed : { text: texts } };
        } catch {
          return { ok: true, result: { text: texts } };
        }
      }

      return { ok: true, result: (response as Record<string, unknown>) || {} };
    } catch (e) {
      // 会话失效（404）时重置会话并重试一次
      if (this.isSessionExpiredError(e)) {
        this.httpSessions.delete(serverAlias);
        try {
          await this.ensureHttpSession(server);
          const retry = await this.sendHttpRpc(server, "tools/call", {
            name: toolName,
            arguments: args,
          }) as { content?: Array<{ type?: string; text?: string }> } | null;

          if (retry?.content) {
            const texts = retry.content
              .filter((c: { type?: string; text?: string }) => c.type === "text")
              .map((c: { text?: string }) => c.text)
              .join("\n");
            try {
              const parsed = JSON.parse(texts);
              return { ok: true, result: typeof parsed === "object" && parsed !== null ? parsed : { text: texts } };
            } catch {
              return { ok: true, result: { text: texts } };
            }
          }
          return { ok: true, result: (retry as Record<string, unknown>) || {} };
        } catch (retryErr) {
          return {
            ok: false,
            result: { error: `MCP http 调用失败(${serverAlias}.${toolName}): ${(retryErr as Error).message}` },
          };
        }
      }

      return {
        ok: false,
        result: { error: `MCP http 调用失败(${serverAlias}.${toolName}): ${(e as Error).message}` },
      };
    }
  }

  /** 确保 http 会话已初始化（initialize + notifications/initialized） */
  private async ensureHttpSession(server: McpServerConfig): Promise<void> {
    const existing = this.httpSessions.get(server.alias);
    if (existing?.initialized) return;

    await this.sendHttpRpc(server, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nextbot", version: "1.0.0" },
    });

    const session: HttpSession = this.httpSessions.get(server.alias) ?? { initialized: false };
    session.initialized = true;
    this.httpSessions.set(server.alias, session);

    // initialized 通知：服务端通常返回 202 空响应，失败不影响后续调用
    try {
      await this.httpPost(server, { jsonrpc: "2.0", method: "notifications/initialized" }, 5_000);
    } catch {
      // ignore
    }
  }

  /** 发送 JSON-RPC 请求（有响应）；session id 由 httpPost 从响应头捕获 */
  private async sendHttpRpc(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = ++this.httpRequestId;
    const { status, data } = await this.httpPost(
      server,
      { jsonrpc: "2.0", id, method, params },
      timeoutMs ?? server.timeoutMs ?? 30_000,
    );

    if (status === 404 || status === 410) {
      // streamable-http 约定：404/410 表示会话过期或不存在
      const err = new Error(`MCP http 会话失效 (HTTP ${status}): ${method}`);
      (err as Error & { sessionExpired?: boolean }).sessionExpired = true;
      throw err;
    }
    if (status >= 400) {
      throw new Error(`MCP http 请求失败 (HTTP ${status}): ${method}`);
    }

    const msg = data as { id?: unknown; error?: { message?: string }; result?: unknown } | null;
    if (msg && typeof msg === "object" && msg.error) {
      throw new Error(msg.error.message || "MCP http 错误");
    }
    return msg?.result ?? msg;
  }

  /** 底层 HTTP POST：附加鉴权头与会话头，兼容纯 JSON 与 SSE 两种响应格式 */
  private async httpPost(
    server: McpServerConfig,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // streamable-http 要求同时接受 JSON 与 SSE
      Accept: "application/json, text/event-stream",
    };
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      headers[key] = this.expandEnvVars(value);
    }
    const session = this.httpSessions.get(server.alias);
    if (session?.sessionId) {
      headers["Mcp-Session-Id"] = session.sessionId;
    }

    // url 中的 query 参数（如滴滴 MCP 的 ?key=）同样支持 ${ENV_VAR} 展开
    const response = await fetch(this.expandEnvVars(server.url!), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 捕获服务端下发的会话 id
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      const sessionEntry: HttpSession = this.httpSessions.get(server.alias) ?? { initialized: false };
      sessionEntry.sessionId = sessionId;
      this.httpSessions.set(server.alias, sessionEntry);
    }

    const raw = await response.text();
    let data: unknown = null;
    if (raw) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        data = parseSseDataPayload(raw);
      } else {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { text: raw };
        }
      }
    }

    return { status: response.status, data };
  }

  private isSessionExpiredError(e: unknown): boolean {
    return Boolean((e as Error & { sessionExpired?: boolean })?.sessionExpired);
  }

  /** 展开 ${ENV_VAR} 形式的环境变量引用 */
  private expandEnvVars(value: string): string {
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => process.env[name] ?? match);
  }

  // ========== 通用工具方法 ==========

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 6,
        windowsHide: true,
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      if (err.code === "ENOENT") {
        return { ok: false, stdout: "", stderr: `${command} 未安装或不在 PATH 中`, code };
      }
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? "命令执行失败"),
        code,
      };
    }
  }

  /** 解析 mcporter list 输出 */
  private parseMcporterToolList(stdout: string, serverAlias: string): McpToolSchema[] {
    const tools: McpToolSchema[] = [];

    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== "object" || item === null) continue;
          const rawName = item.name || item.tool_name || "";
          if (!rawName) continue;
          tools.push({
            name: `mcp.${serverAlias}.${rawName}`,
            description: item.description || `${serverAlias} MCP 工具: ${rawName}`,
            parameters: item.parameters || item.inputSchema || { type: "object", properties: {} },
            serverAlias,
            rawToolName: rawName,
          });
        }
        return tools;
      }
    } catch {
      // 非 JSON
    }

    // 文本格式回退
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\w+)\s*\(([^)]*)\)\s*(?:-\s*)?(.*)$/);
      if (match) {
        tools.push({
          name: `mcp.${serverAlias}.${match[1]}`,
          description: match[3] || `${serverAlias} MCP 工具: ${match[1]}`,
          parameters: this.parseParamsString(match[2]),
          serverAlias,
          rawToolName: match[1],
        });
      } else if (/^\w+$/.test(line)) {
        tools.push({
          name: `mcp.${serverAlias}.${line}`,
          description: `${serverAlias} MCP 工具: ${line}`,
          parameters: { type: "object", properties: {} },
          serverAlias,
          rawToolName: line,
        });
      }
    }

    return tools;
  }

  private parseParamsString(paramsStr: string): Record<string, unknown> {
    if (!paramsStr.trim()) return { type: "object", properties: {} };

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of paramsStr.split(",").map((p) => p.trim()).filter(Boolean)) {
      const parts = param.split(":").map((s) => s.trim());
      const name = parts[0];
      if (!name) continue;

      const typeStr = parts[1]?.toLowerCase() || "string";
      let type = "string";
      if (/int|num|float/.test(typeStr) || typeStr === "number") type = "number";
      else if (typeStr.includes("bool")) type = "boolean";
      else if (/arr|list/.test(typeStr)) type = "array";

      properties[name] = { type, description: `${name} 参数` };
      required.push(name);
    }

    return { type: "object", properties, required, additionalProperties: false };
  }

  private buildCallExpression(serverAlias: string, toolName: string, args: Record<string, unknown>): string {
    const argsStr = Object.entries(args)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    return `${serverAlias}.${toolName}(${argsStr})`;
  }

  private parseRegistryName(registryName: string): { serverAlias: string; toolName: string } | null {
    if (!registryName.startsWith("mcp.")) return null;
    const rest = registryName.slice(4);
    const dotIndex = rest.indexOf(".");
    if (dotIndex === -1) return null;
    return { serverAlias: rest.slice(0, dotIndex), toolName: rest.slice(dotIndex + 1) };
  }
}
