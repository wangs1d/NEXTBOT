import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { join } from "node:path";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { CodeSandboxService } from "../../../services/code-sandbox-service.js";
import {
  getSandboxWorkspaceIndex,
  WORKSPACE_MAP_MAX_FILES,
} from "../../../services/sandbox-workspace-index.js";

/**
 * code-sandbox 工具 handler 工厂集合 + 注册入口。
 *
 * 每个 handler 调用 {@link CodeSandboxService} 对应方法，统一返回：
 *   - 成功：`{ ok: true, ..., summary: string }`
 *   - 失败：`{ ok: false, error: string, retryable?: boolean }`
 *
 * 注册入口见本文件 {@link registerCodeSandboxTools}，由 `./index.ts` 的
 * `buildCodeSandboxModule` 在 `CapabilityModule.register` 中调用。
 */

/** code-sandbox 模块依赖（局部类型，避免修改全局 CapabilityModuleDeps）。 */
export interface CodeSandboxModuleDeps {
  codeSandboxService: CodeSandboxService;
}

/** code.run —— 执行 Python / Node 代码。 */
export function createCodeRunHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const language = input.language === "node" ? "node" : "python";
    const code = typeof input.code === "string" ? input.code : "";
    if (!code) {
      return { ok: false, error: "缺少 code（要执行的源代码）" };
    }
    const workspaceId =
      typeof input.workspaceId === "string" && input.workspaceId.trim()
        ? input.workspaceId.trim()
        : undefined;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.floor(input.timeoutMs)
        : undefined;
    const stdin = typeof input.stdin === "string" ? input.stdin : undefined;

    const actorId = resolveActorId(context);

    const result = await service.runCode(actorId, {
      language,
      code,
      workspaceId,
      timeoutMs,
      stdin,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "代码执行失败",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        workspacePath: result.workspacePath,
        retryable: result.timedOut,
        summary: result.timedOut
          ? `代码执行超时（${result.durationMs}ms），可简化代码或缩短运行时间后重试`
          : `代码执行失败（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
      };
    }
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      workspacePath: result.workspacePath,
      summary: result.truncated
        ? `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）stdout/stderr 已截断到 8KB，如需完整输出请用 code.write_file 写产物再 code.read_file 分段读`
        : `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
    };
  };
}

/** code.shell —— 执行白名单 shell 命令（在沙箱工作目录内，三道闸安全策略）。 */
export function createCodeShellHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) {
      return { ok: false, error: "缺少 command（要执行的命令名）" };
    }
    const args = Array.isArray(input.args)
      ? input.args.map((a) => (typeof a === "string" ? a : String(a)))
      : [];
    const workspaceId =
      typeof input.workspaceId === "string" && input.workspaceId.trim()
        ? input.workspaceId.trim()
        : undefined;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.floor(input.timeoutMs)
        : undefined;
    const stdin = typeof input.stdin === "string" ? input.stdin : undefined;

    const actorId = resolveActorId(context);

    // shell 命令直接 spawn 外部进程执行
    const result = await service.runShell(actorId, {
      command,
      args,
      workspaceId,
      timeoutMs,
      stdin,
    });

    if (!result.ok) {
      // 策略拒绝时给出更友好的提示
      const isPolicyDenied = result.error?.startsWith("SHELL_POLICY_DENIED");
      return {
        ok: false,
        error: result.error ?? "shell 命令执行失败",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        workspacePath: result.workspacePath,
        retryable: !isPolicyDenied && result.timedOut,
        summary: isPolicyDenied
          ? `命令被安全策略拒绝：${result.error?.replace("SHELL_POLICY_DENIED: ", "")}`
          : result.timedOut
            ? `命令执行超时（${result.durationMs}ms），可简化命令或缩短运行时间后重试`
            : `命令执行失败（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
      };
    }
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      workspacePath: result.workspacePath,
      summary: result.truncated
        ? `命令执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）stdout/stderr 已截断到 8KB，如需完整输出请重定向到文件再 code.read_file 分段读`
        : `命令执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
    };
  };
}

/** code.list_files —— 列出工作目录文件。 */
export function createCodeListFilesHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (!workspaceId) {
      return { ok: false, error: "缺少 workspaceId" };
    }
    const actorId = resolveActorId(context);
    const files = await service.listFiles(actorId, workspaceId);
    const failed = files.filter((f) => !f.ok);
    if (failed.length > 0 && files.length === failed.length) {
      return { ok: false, error: failed[0]?.error ?? "列出文件失败" };
    }
    return {
      ok: true,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        ...(f.ok ? {} : { error: f.error }),
      })),
      workspacePath: service.resolveWorkspacePath(actorId, workspaceId) ?? "",
      summary: `列出 ${files.length} 个文件`,
    };
  };
}

/**
 * code.read_file —— 读取工作目录文件（WP3：三种读法）。
 *
 *  - mode="full"：读全文（旧行为，显式选择）；
 *  - mode="range"：按 offset/limit 读片段（大文件分段读）；
 *  - 默认（无 mode）：≤2000 字符直接全文；更大时返回结构目录 outline + 头部预览，
 *    让模型先看结构再定向读——借鉴 codebase-memory-mcp「outline 先于原文」。
 */
export function createCodeReadFileHandler(
  service: CodeSandboxService,
): ToolHandler {
  const OUTLINE_THRESHOLD_CHARS = 2_000;
  const RANGE_DEFAULT_LIMIT = 4_000;
  const RANGE_MAX_LIMIT = 16_000;
  const PREVIEW_CHARS = 300;

  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
    if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
    if (!fileName) return { ok: false, error: "缺少 fileName" };

    const actorId = resolveActorId(context);
    const result = await service.readFile(actorId, workspaceId, fileName);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const content = result.content ?? "";
    const mode = typeof input.mode === "string" ? input.mode : "";

    // mode="full"：显式全文（能力不变）
    if (mode === "full") {
      return {
        ok: true,
        path: result.path,
        mode: "full",
        content,
        size: result.size,
        summary: `读取文件 ${result.path} 全文（${result.size} 字节）`,
      };
    }

    // mode="range"：分段读
    if (mode === "range") {
      let offset = Number.parseInt(String(input.offset ?? 0), 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      let limit = Number.parseInt(String(input.limit ?? RANGE_DEFAULT_LIMIT), 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = RANGE_DEFAULT_LIMIT;
      limit = Math.min(limit, RANGE_MAX_LIMIT);
      const start = Math.min(offset, content.length);
      const slice = content.slice(start, start + limit);
      return {
        ok: true,
        path: result.path,
        mode: "range",
        totalChars: content.length,
        offset: start,
        returnedChars: slice.length,
        nextOffset: start + slice.length < content.length ? start + slice.length : null,
        content: slice,
        size: result.size,
        summary: `读取 ${result.path} 片段 [${start}, ${start + slice.length})（全文 ${content.length} 字符）`,
      };
    }

    // 默认：小文件全文；大文件 outline-first（结构目录 + 预览 + 定向读指引）
    if (content.length <= OUTLINE_THRESHOLD_CHARS) {
      return {
        ok: true,
        path: result.path,
        mode: "full",
        content,
        size: result.size,
        summary: `读取文件 ${result.path}（${result.size} 字节）`,
      };
    }
    const wsPath = service.resolveWorkspacePath(actorId, workspaceId);
    const index = getSandboxWorkspaceIndex();
    const outlineInfo = wsPath
      ? await index.getFileOutline(wsPath, fileName, join(wsPath, fileName))
      : null;
    if (!outlineInfo) {
      // 索引构建失败 → 保守回退全文（能力不降级，只是不省 token）
      return {
        ok: true,
        path: result.path,
        mode: "full",
        content,
        size: result.size,
        summary: `读取文件 ${result.path}（${result.size} 字节）`,
      };
    }
    return {
      ok: true,
      path: result.path,
      mode: "outline",
      kind: outlineInfo.kind,
      totalChars: content.length,
      preview: content.slice(0, PREVIEW_CHARS),
      outline: outlineInfo.outline,
      hint:
        `文件较大（${content.length} 字符），已返回结构目录。` +
        `用 mode="range" + offset/limit 读取具体段落，或明确需要时 mode="full" 读全文。` +
        `outline 仅供导航，引用细节前必须先读取对应段落原文。`,
      size: result.size,
      summary: `返回 ${result.path} 结构目录（全文 ${content.length} 字符，未注入全文）`,
    };
  };
}

/**
 * code.workspace_map —— 工作区结构地图（WP3，借鉴 codebase-memory-mcp 的
 * get_architecture）：一次调用返回全部文件的结构概要，替代「list_files →
 * 逐个 read_file 盲读」的探索循环。
 */
export function createWorkspaceMapHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
    const actorId = resolveActorId(context);
    const wsPath = service.resolveWorkspacePath(actorId, workspaceId);
    if (!wsPath) return { ok: false, error: "无效的工作目录标识（路径穿越被拒）" };

    const files = await service.listFiles(actorId, workspaceId);
    const failed = files.filter((f) => !f.ok);
    if (failed.length > 0 && files.length === failed.length) {
      return { ok: false, error: failed[0]?.error ?? "列出文件失败" };
    }
    const index = getSandboxWorkspaceIndex();
    const entries: Array<Record<string, unknown>> = [];
    let cachedCount = 0;
    for (const f of files.filter((f) => f.ok).slice(0, WORKSPACE_MAP_MAX_FILES)) {
      if (!f.path) continue;
      const outline = await index.getFileOutline(wsPath, f.path, join(wsPath, f.path));
      if (outline) {
        if (outline.cached) cachedCount++;
        entries.push({
          path: outline.path,
          size: outline.size,
          kind: outline.kind,
          outline: outline.outline,
          ...(outline.headTruncated ? { headTruncated: true } : {}),
        });
      } else {
        entries.push({ path: f.path, size: f.size, kind: "unknown", outline: "（索引构建失败，用 code.read_file 读取）" });
      }
    }
    return {
      ok: true,
      fileCount: entries.length,
      truncated: files.filter((f) => f.ok).length > WORKSPACE_MAP_MAX_FILES,
      cachedCount,
      files: entries,
      workspacePath: wsPath,
      hint:
        `outline 仅供导航。需要某文件的细节时：小文件直接 code.read_file；` +
        `大文件用 code.read_file 的 mode="range" + offset（offset 见 outline 中的 [行] 标注）分段读取。`,
      summary: `工作区地图：${entries.length} 个文件（${cachedCount} 个命中增量缓存）`,
    };
  };
}

/** code.write_file —— 写入工作目录文件。 */
export function createCodeWriteFileHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
    if (!fileName) return { ok: false, error: "缺少 fileName" };
    if (!content) return { ok: false, error: "缺少 content（要写入的文本）" };

    const actorId = resolveActorId(context);
    const result = await service.writeFile(actorId, workspaceId, fileName, content);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      path: result.path,
      size: result.size,
      summary: `写入文件 ${result.path}（${result.size} 字节）`,
    };
  };
}

/**
 * 注册 code-sandbox 全部工具到 ToolRegistry。
 *
 * 调用方：`buildCodeSandboxModule` 的 `CapabilityModule.register` 闭包，
 * 最终由 `registerAllCapabilityModules` 在启动阶段统一调用。
 */
export function registerCodeSandboxTools(
  registry: ToolRegistry,
  deps: CodeSandboxModuleDeps,
): void {
  const { codeSandboxService } = deps;
  registry.register("code.run", createCodeRunHandler(codeSandboxService));
  registry.register("code.shell", createCodeShellHandler(codeSandboxService));
  registry.register("code.list_files", createCodeListFilesHandler(codeSandboxService));
  registry.register("code.read_file", createCodeReadFileHandler(codeSandboxService));
  registry.register("code.write_file", createCodeWriteFileHandler(codeSandboxService));
  registry.register("code.workspace_map", createWorkspaceMapHandler(codeSandboxService));
}
