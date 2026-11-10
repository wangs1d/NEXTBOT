import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { FileProcessingService } from "../../../services/file-processing-service.js";

/**
 * file-doc 工具 handler 工厂集合。
 *
 * 每个 handler 调用 {@link FileProcessingService} 对应方法，
 * 统一返回：
 *   - 成功：`{ ok: true, ..., summary: string }`
 *   - 失败：`{ ok: false, error: string, retryable?: boolean }`
 */

/** file.read_text —— 读文本文件（path / url / base64 三选一）。 */
export function createFileReadTextHandler(
  service: FileProcessingService,
): ToolHandler {
  return async (input: Record<string, unknown>, _context: ToolContext) => {
    const path = typeof input.path === "string" ? input.path : undefined;
    const url = typeof input.url === "string" ? input.url : undefined;
    const base64 = typeof input.base64 === "string" ? input.base64 : undefined;
    const encoding = typeof input.encoding === "string" ? input.encoding : undefined;

    const result = await service.readText({ path, url, base64, encoding: encoding as BufferEncoding | undefined });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.retryable != null ? { retryable: result.retryable } : {}) };
    }
    return {
      ok: true,
      content: result.content,
      truncated: result.truncated,
      totalBytes: result.totalBytes,
      returnedBytes: result.returnedBytes,
      source: result.source,
      encoding: result.encoding,
      summary: result.summary,
    };
  };
}

/** file.write_text —— 写文本到本地 data/user-files/{actorId}/{fileName}。 */
export function createFileWriteTextHandler(
  service: FileProcessingService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const content = typeof input.content === "string" ? input.content : "";
    const fileName = typeof input.fileName === "string" ? input.fileName : "";
    const encoding = typeof input.encoding === "string" ? input.encoding : undefined;

    if (!content) {
      return { ok: false, error: "缺少 content（要写入的文本内容）" };
    }
    if (!fileName.trim()) {
      return { ok: false, error: "缺少 fileName（目标文件名）" };
    }

    const actorId = resolveActorId(context);
    const result = await service.writeText({
      content,
      actorId,
      fileName,
      encoding: encoding as BufferEncoding | undefined,
      sessionId: context.sessionId,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.retryable != null ? { retryable: result.retryable } : {}) };
    }
    return {
      ok: true,
      fileUrl: result.fileUrl,
      fileName: result.fileName,
      bytes: result.bytes,
      summary: result.summary,
    };
  };
}

/** file.parse_pdf —— PDF 解析为纯文本 + 页数。 */
export function createFileParsePdfHandler(
  service: FileProcessingService,
): ToolHandler {
  return async (input: Record<string, unknown>, _context: ToolContext) => {
    const path = typeof input.path === "string" ? input.path : undefined;
    const url = typeof input.url === "string" ? input.url : undefined;
    const base64 = typeof input.base64 === "string" ? input.base64 : undefined;

    const result = await service.parsePdf({ path, url, base64 });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.retryable != null ? { retryable: result.retryable } : {}) };
    }
    return {
      ok: true,
      text: result.text,
      pageCount: result.pageCount,
      pageBreaks: result.pageBreaks,
      truncated: result.truncated,
      totalBytes: result.totalBytes,
      ...(result.info != null ? { info: result.info } : {}),
      summary: result.summary,
    };
  };
}

/** file.parse_office —— docx / xlsx / pptx 解析。 */
export function createFileParseOfficeHandler(
  service: FileProcessingService,
): ToolHandler {
  return async (input: Record<string, unknown>, _context: ToolContext) => {
    const path = typeof input.path === "string" ? input.path : undefined;
    const url = typeof input.url === "string" ? input.url : undefined;
    const base64 = typeof input.base64 === "string" ? input.base64 : undefined;
    const format =
      input.format === "docx" || input.format === "xlsx" || input.format === "pptx"
        ? input.format
        : undefined;

    const result = await service.parseOffice({ path, url, base64, format });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.retryable != null ? { retryable: result.retryable } : {}) };
    }
    return {
      ok: true,
      format: result.format,
      ...(result.html != null ? { html: result.html } : {}),
      ...(result.sheets != null ? { sheets: result.sheets } : {}),
      ...(result.sheetNames != null ? { sheetNames: result.sheetNames } : {}),
      ...(result.truncated != null ? { truncated: result.truncated } : {}),
      ...(result.totalBytes != null ? { totalBytes: result.totalBytes } : {}),
      ...(result.messages != null ? { messages: result.messages } : {}),
      summary: result.summary,
    };
  };
}

/** file.export_format —— 导出为 md / json / csv / xlsx / txt。 */
export function createFileExportFormatHandler(
  service: FileProcessingService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const rawContent = input.content;
    const format = typeof input.format === "string" ? input.format : "";
    const fileName = typeof input.fileName === "string" ? input.fileName : undefined;
    const sheetName = typeof input.sheetName === "string" ? input.sheetName : undefined;

    if (rawContent == null || (typeof rawContent === "string" && rawContent === "")) {
      return { ok: false, error: "缺少 content（要导出的内容）" };
    }
    const validFormats = ["md", "json", "csv", "xlsx", "txt", "pdf", "docx"] as const;
    if (!validFormats.includes(format as (typeof validFormats)[number])) {
      return { ok: false, error: `不支持的 format：${format || "(空)"}` };
    }

    // content 统一规整为 string | object
    const content: string | Record<string, unknown> | unknown[] =
      typeof rawContent === "string"
        ? rawContent
        : (rawContent as Record<string, unknown>);

    const actorId = resolveActorId(context);
    const result = await service.exportFormat({
      content,
      format: format as "md" | "json" | "csv" | "xlsx" | "txt" | "pdf" | "docx",
      actorId,
      fileName,
      sheetName,
      sessionId: context.sessionId,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.retryable != null ? { retryable: result.retryable } : {}) };
    }
    return {
      ok: true,
      fileUrl: result.fileUrl,
      format: result.format,
      fileName: result.fileName,
      bytes: result.bytes,
      summary: result.summary,
    };
  };
}
