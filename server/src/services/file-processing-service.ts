import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

/**
 * `xlsx@0.18.5` 的运行时**只有** `XLSX.utils.sheet_to_json`，顶层没有这个函数
 * （但类型声明把它挂在了顶层，写 `XLSX.sheet_to_json` 能过 tsc、运行时直接
 * "is not a function"）。这个坑曾让 `file.parse_office` 的 xlsx 分支 100% 失败
 * 并被 catch 成"xlsx 解析失败"，看起来像文件坏了。修于 2026-10-22。
 */
const xlsxSheetToJson = (
  XLSX.utils as unknown as {
    sheet_to_json: <T>(sheet: unknown, opts?: Record<string, unknown>) => T[];
  }
).sheet_to_json;

/**
 * 文件 / 文档处理能力服务。
 *
 * 设计要点（对齐 voice-message-service / image-generation-service 的模式）：
 *   1. **作为 Agent 底层能力**：与社交动态 / 语音消息解耦，独立目录 `data/user-files/`。
 *   2. **可下载**：每个文件名 = `{actorId}/{fileName}`，客户端通过
 *      `GET /agent/files/:actorId/:fileName` 反复拉流（参考 image-files 路由）。
 *   3. **路径穿越防护**：actorId 清洗非法字符为 `_`；fileName 严格校验
 *      `^[a-zA-Z0-9_\\-.]+$`，并禁止 `.`、`..`。
 *   4. **截断策略**：read_text / parse_pdf 返回内容统一截断到 8KB，
 *      避免把超大文档全量灌给 LLM 上下文。
 *
 * 文件布局：
 *   data/user-files/
 *     └── {actorId}/
 *         ├── notes.md
 *         ├── export.xlsx
 *         └── ...
 */
export class FileProcessingService {
  /** 落盘根目录（绝对路径）。 */
  private readonly rootDir: string;
  /** 文本读取 / PDF 解析返回内容上限（字节）。 */
  private readonly maxTextBytes = 8 * 1024;

  constructor(rootDir?: string) {
    // 默认 <server>/data/user-files/
    this.rootDir = resolve(rootDir ?? join(process.cwd(), "data", "user-files"));
    try {
      mkdirSync(this.rootDir, { recursive: true });
    } catch {
      // 并发初始化时可能已创建
    }
  }

  /** 落盘根目录（绝对路径，供路由层做路径穿越防护比对）。 */
  getRoot(): string {
    return this.rootDir;
  }

  /**
   * 读取文本文件：支持 path / url / base64 三种输入（按优先级择一）。
   *
   * 返回内容截断到 {@link maxTextBytes} 字节；超出时 `truncated=true`。
   */
  async readText(input: {
    path?: string;
    url?: string;
    base64?: string;
    encoding?: BufferEncoding;
  }): Promise<ReadTextResult> {
    const encoding: BufferEncoding = (input.encoding as BufferEncoding) || "utf-8";

    let buffer: Buffer;
    let source: "path" | "url" | "base64";

    if (input.path && input.path.trim()) {
      // 本地路径：沙箱下用户已授权，直接读
      const filePath = input.path.trim();
      try {
        buffer = await readFile(filePath);
        source = "path";
      } catch (e) {
        return {
          ok: false,
          error: `读取本地文件失败：${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
        };
      }
    } else if (input.url && input.url.trim()) {
      const url = input.url.trim();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          return {
            ok: false,
            error: `下载 URL 失败：HTTP ${res.status} ${res.statusText}`,
            retryable: true,
          };
        }
        buffer = Buffer.from(await res.arrayBuffer());
        source = "url";
      } catch (e) {
        return {
          ok: false,
          error: `fetch URL 失败：${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        };
      }
    } else if (input.base64 && input.base64.trim()) {
      try {
        buffer = Buffer.from(input.base64.trim(), "base64");
        source = "base64";
      } catch (e) {
        return {
          ok: false,
          error: `base64 解码失败：${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
        };
      }
    } else {
      return {
        ok: false,
        error: "缺少输入：须提供 path / url / base64 之一",
      };
    }

    const totalBytes = buffer.length;
    const truncated = totalBytes > this.maxTextBytes;
    const sliced = truncated ? buffer.subarray(0, this.maxTextBytes) : buffer;
    let content: string;
    try {
      content = sliced.toString(encoding);
    } catch (e) {
      return {
        ok: false,
        error: `解码失败（encoding=${encoding}）：${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }

    return {
      ok: true,
      content,
      truncated,
      totalBytes,
      returnedBytes: sliced.length,
      source,
      encoding,
      summary: `已读取文本（来源 ${source}，${totalBytes} 字节${truncated ? `，已截断到 ${this.maxTextBytes}` : ""}）`,
    };
  }

  /**
   * 写文本到本地 `data/user-files/{actorId}/{fileName}`。
   *
   * @returns 成功返回可访问的 `fileUrl`（`/agent/files/{actorId}/{fileName}`）。
   */
  async writeText(input: {
    content: string;
    actorId: string;
    fileName: string;
    encoding?: BufferEncoding;
  }): Promise<WriteTextResult> {
    const fileName = sanitizeFileName(input.fileName);
    if (!fileName) {
      return { ok: false, error: "非法文件名：仅允许字母、数字、下划线、连字符、点号" };
    }
    const safeActor = sanitizeActorId(input.actorId);
    const actorDir = join(this.rootDir, safeActor);
    mkdirSync(actorDir, { recursive: true });

    const fullPath = join(actorDir, fileName);
    const normalized = resolve(fullPath);
    // 路径穿越防护：确保最终路径仍在 rootDir/{actor} 下
    const baseDir = resolve(actorDir);
    if (!normalized.startsWith(baseDir)) {
      return { ok: false, error: "非法路径：检测到路径穿越" };
    }

    const encoding: BufferEncoding = (input.encoding as BufferEncoding) || "utf-8";
    const buffer = Buffer.from(input.content, encoding);
    writeFileSync(normalized, buffer);

    const fileUrl = `/agent/files/${safeActor}/${fileName}`;
    return {
      ok: true,
      fileUrl,
      fileName,
      bytes: buffer.length,
      summary: `已写入文件 ${fileName}（${buffer.length} 字节）。可访问 URL：${fileUrl}`,
    };
  }

  /**
   * PDF 解析：提取纯文本 + 页数 + 简单结构（按 \f 分页）。
   *
   * 输入支持 path / url / base64（与 readText 同规则）。
   */
  async parsePdf(input: {
    path?: string;
    url?: string;
    base64?: string;
  }): Promise<ParsePdfResult> {
    const bufferResult = await loadBuffer(input);
    if (!bufferResult.ok) {
      return { ok: false, error: bufferResult.error, retryable: bufferResult.retryable };
    }
    const buffer = bufferResult.buffer;

    try {
      const result = await pdfParse(buffer);
      const fullText = result.text || "";
      // PDF 文本中 \f (form feed) 通常作为分页符
      const pages = fullText.split("\f");
      const totalBytes = Buffer.byteLength(fullText, "utf-8");
      const truncated = totalBytes > this.maxTextBytes;
      const slicedText = truncated
        ? Buffer.from(fullText, "utf-8").subarray(0, this.maxTextBytes).toString("utf-8")
        : fullText;

      return {
        ok: true,
        text: slicedText,
        pageCount: result.numpages || pages.length,
        pageBreaks: pages.length,
        truncated,
        totalBytes,
        info: result.info,
        summary: `已解析 PDF（约 ${result.numpages || pages.length} 页，${totalBytes} 字节文本${truncated ? `，已截断到 ${this.maxTextBytes}` : ""}）`,
      };
    } catch (e) {
      return {
        ok: false,
        error: `PDF 解析失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }
  }

  /**
   * Office 文档解析：docx → HTML / xlsx → 各 sheet 行 JSON / pptx 暂不支持。
   *
   * 输入支持 path / url / base64。
   */
  async parseOffice(input: {
    path?: string;
    url?: string;
    base64?: string;
    format?: "docx" | "xlsx" | "pptx";
  }): Promise<ParseOfficeResult> {
    const bufferResult = await loadBuffer(input);
    if (!bufferResult.ok) {
      return { ok: false, error: bufferResult.error, retryable: bufferResult.retryable };
    }
    const buffer = bufferResult.buffer;

    // 显式传 format 优先；否则按 base64 / url 后缀推断；都没有则尝试 docx
    const format = inferOfficeFormat(input, bufferResult.source);

    if (format === "docx") {
      try {
        const result = await mammoth.convertToHtml({ buffer });
        const html = result.value || "";
        const totalBytes = Buffer.byteLength(html, "utf-8");
        const truncated = totalBytes > this.maxTextBytes;
        const sliced = truncated
          ? Buffer.from(html, "utf-8").subarray(0, this.maxTextBytes).toString("utf-8")
          : html;
        return {
          ok: true,
          format: "docx",
          html: sliced,
          truncated,
          totalBytes,
          messages: result.messages.map((m) => ({ type: m.type, message: m.message })),
          summary: `已解析 docx（HTML 长度 ${totalBytes} 字节${truncated ? `，已截断到 ${this.maxTextBytes}` : ""}）`,
        };
      } catch (e) {
        return {
          ok: false,
          error: `docx 解析失败：${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
        };
      }
    }

    if (format === "xlsx") {
      try {
        const wb = XLSX.read(buffer, { type: "buffer" });
        const sheets = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const rows = xlsxSheetToJson<Record<string, unknown>>(ws);
          return { name, rowCount: rows.length, rows: rows.slice(0, 200) };
        });
        return {
          ok: true,
          format: "xlsx",
          sheetNames: wb.SheetNames,
          sheets,
          summary: `已解析 xlsx（${wb.SheetNames.length} 个 sheet：${wb.SheetNames.join(", ")}）`,
        };
      } catch (e) {
        return {
          ok: false,
          error: `xlsx 解析失败：${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
        };
      }
    }

    if (format === "pptx") {
      return {
        ok: false,
        error: "pptx 解析暂不支持：建议转换为 pdf 或 docx 后再用 file.parse_pdf / file.parse_office",
        retryable: false,
      };
    }

    return {
      ok: false,
      error: `不支持的 Office 格式：${format ?? "(unknown)"}`,
      retryable: false,
    };
  }

  /**
   * 把文本 / 结构化数据导出为目标格式并落盘。
   *
   * 支持格式：md / json / csv / xlsx / txt。
   * pdf / docx 暂不支持生成（需额外排版库），返回 ok=false 明确告知。
   */
  async exportFormat(input: {
    content: string | Record<string, unknown> | unknown[];
    format: "md" | "json" | "csv" | "xlsx" | "txt" | "pdf" | "docx";
    actorId: string;
    fileName?: string;
    /** xlsx 导出时若 content 为对象，按其 keys 取列；为数组时按行展开。 */
    sheetName?: string;
  }): Promise<ExportFormatResult> {
    const { format, actorId, content } = input;
    if (!actorId) {
      return { ok: false, error: "缺少 actorId" };
    }

    // pdf / docx 生成暂不支持（避免引入额外重型排版库）
    if (format === "pdf" || format === "docx") {
      return {
        ok: false,
        error: `暂不支持导出为 ${format}：当前支持 md / json / csv / xlsx / txt`,
        retryable: false,
      };
    }

    // 计算落盘文件名
    const baseName = input.fileName
      ? sanitizeFileName(input.fileName)
      : `export-${Date.now()}`;
    if (!baseName) {
      return { ok: false, error: "非法文件名：仅允许字母、数字、下划线、连字符、点号" };
    }
    const finalName = ensureExtension(baseName, format);
    const safeActor = sanitizeActorId(actorId);
    const actorDir = join(this.rootDir, safeActor);
    mkdirSync(actorDir, { recursive: true });

    const fullPath = join(actorDir, finalName);
    const normalized = resolve(fullPath);
    if (!normalized.startsWith(resolve(actorDir))) {
      return { ok: false, error: "非法路径：检测到路径穿越" };
    }

    let buffer: Buffer;
    try {
      switch (format) {
        case "txt":
        case "md": {
          buffer = Buffer.from(toText(content), "utf-8");
          break;
        }
        case "json": {
          buffer = Buffer.from(JSON.stringify(content, null, 2), "utf-8");
          break;
        }
        case "csv": {
          buffer = Buffer.from(toCsv(content), "utf-8");
          break;
        }
        case "xlsx": {
          const wb = XLSX.utils.book_new();
          const rows = normalizeRows(content);
          const ws = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(wb, ws, input.sheetName || "Sheet1");
          // XLSX.write 返回 Buffer（type="buffer"）/ string（type="binary"）等
          const wbOut = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
          buffer = Buffer.isBuffer(wbOut)
            ? wbOut
            : Buffer.from(wbOut as ArrayBuffer);
          break;
        }
        default: {
          // 兜底：当字符串处理
          buffer = Buffer.from(toText(content), "utf-8");
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: `导出失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }

    writeFileSync(normalized, buffer);
    const fileUrl = `/agent/files/${safeActor}/${finalName}`;
    return {
      ok: true,
      fileUrl,
      format,
      fileName: finalName,
      bytes: buffer.length,
      summary: `已导出 ${finalName}（${format}，${buffer.length} 字节）。可访问 URL：${fileUrl}`,
    };
  }

  /**
   * 拉流：返回指定文件的绝对路径（若存在且校验通过）。
   * 路由层用 createReadStream 读取后 reply.send(stream)。
   */
  resolveFilePath(actorId: string, fileName: string): string | null {
    const safeActor = sanitizeActorId(actorId);
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;
    const fullPath = join(this.rootDir, safeActor, safeName);
    const normalized = resolve(fullPath);
    const baseDir = resolve(join(this.rootDir, safeActor));
    // 防穿越：最终路径必须在 rootDir/{actor} 下
    if (!normalized.startsWith(baseDir)) return null;
    if (!existsSync(normalized) || !statSync(normalized).isFile()) return null;
    return normalized;
  }

  /** 提供给 HTTP 路由用：返回 readable stream。 */
  createReadStream(path: string) {
    return createReadStream(path);
  }

  /** 提供给 HTTP 路由用：根据文件扩展名推断 Content-Type。 */
  static guessContentType(fileName: string): string {
    const ext = extname(fileName).toLowerCase();
    switch (ext) {
      case ".txt": return "text/plain; charset=utf-8";
      case ".md": return "text/markdown; charset=utf-8";
      case ".json": return "application/json; charset=utf-8";
      case ".csv": return "text/csv; charset=utf-8";
      case ".html":
      case ".htm": return "text/html; charset=utf-8";
      case ".xml": return "application/xml; charset=utf-8";
      case ".log": return "text/plain; charset=utf-8";
      case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case ".xls": return "application/vnd.ms-excel";
      case ".pdf": return "application/pdf";
      default: return "application/octet-stream";
    }
  }
}

// ---- 内部辅助类型 ----

type ReadTextResult =
  | {
      ok: true;
      content: string;
      truncated: boolean;
      totalBytes: number;
      returnedBytes: number;
      source: "path" | "url" | "base64";
      encoding: BufferEncoding;
      summary: string;
    }
  | { ok: false; error: string; retryable?: boolean };

type WriteTextResult =
  | {
      ok: true;
      fileUrl: string;
      fileName: string;
      bytes: number;
      summary: string;
    }
  | { ok: false; error: string; retryable?: boolean };

type ParsePdfResult =
  | {
      ok: true;
      text: string;
      pageCount: number;
      pageBreaks: number;
      truncated: boolean;
      totalBytes: number;
      info?: Record<string, unknown>;
      summary: string;
    }
  | { ok: false; error: string; retryable?: boolean };

type ParseOfficeResult =
  | {
      ok: true;
      format: "docx" | "xlsx" | "pptx";
      html?: string;
      sheets?: Array<{
        name: string;
        rowCount: number;
        rows: Record<string, unknown>[];
      }>;
      sheetNames?: string[];
      truncated?: boolean;
      totalBytes?: number;
      messages?: Array<{ type: string; message: string }>;
      summary: string;
    }
  | { ok: false; error: string; retryable?: boolean };

type ExportFormatResult =
  | {
      ok: true;
      fileUrl: string;
      format: string;
      fileName: string;
      bytes: number;
      summary: string;
    }
  | { ok: false; error: string; retryable?: boolean };

// ---- 内部辅助函数 ----

/** 把 actorId 中的非法字符替换为下划线，防止目录穿越。 */
function sanitizeActorId(actorId: string): string {
  if (!actorId) return "anonymous";
  const cleaned = actorId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "anonymous";
}

/**
 * 文件名严格校验：仅允许字母 / 数字 / 下划线 / 连字符 / 点号。
 * 禁止 `.` / `..`（路径穿越）。
 * 通过返回清洗后的文件名，否则返回 null。
 */
function sanitizeFileName(fileName: string): string | null {
  if (!fileName || typeof fileName !== "string") return null;
  const trimmed = fileName.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("..")) return null;
  // 禁止以 . 开头（隐藏文件）
  if (trimmed.startsWith(".")) return null;
  return trimmed;
}

/** 确保文件名带正确扩展名。 */
function ensureExtension(name: string, format: string): string {
  const ext = format === "md" ? ".md"
    : format === "json" ? ".json"
    : format === "csv" ? ".csv"
    : format === "xlsx" ? ".xlsx"
    : format === "txt" ? ".txt"
    : format === "pdf" ? ".pdf"
    : format === "docx" ? ".docx"
    : "";
  if (!ext) return name;
  if (name.toLowerCase().endsWith(ext)) return name;
  return name + ext;
}

/** 把任意输入归一化为文本。 */
function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/** 把数组 / 对象归一化为 csv 字符串（第一层 keys 作为表头）。 */
function toCsv(content: unknown): string {
  const rows = normalizeRows(content);
  if (rows.length === 0) return "";
  const headerKeys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k);
          headerKeys.push(k);
        }
      }
    }
  }
  const escape = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines: string[] = [headerKeys.map(escape).join(",")];
  for (const row of rows) {
    const cells = headerKeys.map((k) =>
      escape((row as Record<string, unknown>)?.[k]),
    );
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

/** 把任意 content 归一化为「行数组」用于 xlsx / csv 导出。 */
function normalizeRows(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) {
    return content.map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : { value: item },
    );
  }
  if (content && typeof content === "object") {
    return [content as Record<string, unknown>];
  }
  if (typeof content === "string") {
    // 字符串 → 每行一个 { line }
    return content.split(/\r?\n/).map((line, i) => ({ line: i + 1, text: line }));
  }
  return [];
}

/** 加载 buffer：复用 readText 的 path/url/base64 优先级逻辑（无截断）。 */
async function loadBuffer(input: {
  path?: string;
  url?: string;
  base64?: string;
}): Promise<
  | { ok: true; buffer: Buffer; source: "path" | "url" | "base64" }
  | { ok: false; error: string; retryable?: boolean }
> {
  if (input.path && input.path.trim()) {
    try {
      const buffer = await readFile(input.path.trim());
      return { ok: true, buffer, source: "path" };
    } catch (e) {
      return {
        ok: false,
        error: `读取本地文件失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }
  }
  if (input.url && input.url.trim()) {
    try {
      const res = await fetch(input.url.trim(), { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        return {
          ok: false,
          error: `下载 URL 失败：HTTP ${res.status} ${res.statusText}`,
          retryable: true,
        };
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { ok: true, buffer, source: "url" };
    } catch (e) {
      return {
        ok: false,
        error: `fetch URL 失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      };
    }
  }
  if (input.base64 && input.base64.trim()) {
    try {
      const buffer = Buffer.from(input.base64.trim(), "base64");
      return { ok: true, buffer, source: "base64" };
    } catch (e) {
      return {
        ok: false,
        error: `base64 解码失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }
  }
  return { ok: false, error: "缺少输入：须提供 path / url / base64 之一" };
}

/** 根据显式 format / 输入源扩展名推断 Office 格式。 */
function inferOfficeFormat(
  input: { format?: "docx" | "xlsx" | "pptx" },
  source: "path" | "url" | "base64",
): "docx" | "xlsx" | "pptx" | null {
  if (input.format) return input.format;
  // base64 无法推断，回退 docx（最常见的 Office 输入）
  if (source === "base64") return "docx";
  // path / url 走不到这里推断（loadBuffer 没保留扩展名），保守返回 docx
  return "docx";
}
