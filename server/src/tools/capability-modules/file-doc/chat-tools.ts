import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 文件 / 文档处理能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `file.*`）：
 *   - file.read_text     读文本（txt/md/json/csv/log 等），支持 path / url / base64
 *   - file.write_text    写文本到 data/user-files/{actorId}/{fileName}
 *   - file.parse_pdf     PDF 解析为纯文本 + 页数
 *   - file.parse_office  docx → HTML / xlsx → 各 sheet 行 JSON / pptx 暂不支持
 *   - file.export_format 导出为 md / json / csv / xlsx / txt（pdf / docx 暂不支持生成）
 *
 * 走 deferred（延迟目录）：
 *   1. LLM 不会每轮都处理文件，进核心会浪费 token
 *   2. 关键词触发（"读这个文件" / "解析 PDF" / "导出 Excel"）时由 tool_discover 拉出
 *
 * 与客户端无特殊 UI 联动；返回的 fileUrl 为本地静态 URL，可被通用渲染。
 */
export const FILE_DOC_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "file.read_text",
      description:
        "读取文本文件内容（txt / md / json / csv / log / xml / html 等）。" +
        "支持三种输入（按优先级）：path（本地绝对路径）/ url（公网 URL）/ base64（base64 编码内容）。" +
        "返回内容会截断到 8KB，并附字节数 / 是否截断 / 来源类型等元信息。\n" +
        "适用场景：用户给你一个文件路径或链接，让你读出来 / 总结 / 提取信息。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "本地文件绝对路径，例如 \"C:/users/me/notes.md\" 或 \"/home/me/data.json\"。",
          },
          url: {
            type: "string",
            description:
              "公网可访问的文件 URL，例如 \"https://example.com/spec.json\"。",
          },
          base64: {
            type: "string",
            description:
              "base64 编码的文件内容（不含 data: 前缀）。当用户直接粘贴文件二进制时使用。",
          },
          encoding: {
            type: "string",
            description: "文本编码，默认 utf-8。如 gbk / latin1 等。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file.write_text",
      description:
        "把文本内容写入本地文件（落盘到 data/user-files/{actorId}/{fileName}），返回可永久访问的 fileUrl。" +
        "文件名严格校验：仅允许字母 / 数字 / 下划线 / 连字符 / 点号（禁止路径穿越）。\n" +
        "适用场景：把生成的笔记 / 摘要 / 代码片段保存成可下载文件给用户。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "要写入的文本内容。",
          },
          fileName: {
            type: "string",
            description:
              "目标文件名，例如 \"summary.md\" / \"report.json\"。仅允许 [a-zA-Z0-9_\\-.]。",
          },
          encoding: {
            type: "string",
            description: "文本编码，默认 utf-8。",
          },
        },
        required: ["content", "fileName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file.parse_pdf",
      description:
        "解析 PDF 文档：提取纯文本 + 页数 + 元信息（作者 / 标题等）。" +
        "输入支持 path / url / base64（与 file.read_text 同规则）。返回文本截断到 8KB。\n" +
        "适用场景：用户给你一份 PDF 让你读 / 总结 / 提取要点。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "本地 PDF 文件绝对路径。" },
          url: { type: "string", description: "公网可访问的 PDF URL。" },
          base64: { type: "string", description: "base64 编码的 PDF 内容（不含 data: 前缀）。" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file.parse_office",
      description:
        "解析 Office 文档：docx → HTML / xlsx → 各 sheet 行 JSON / pptx 暂不支持。" +
        "输入支持 path / url / base64。docx HTML 与 xlsx rows 都会截断到合理上限。\n" +
        "适用场景：用户给你一份 Word / Excel 文档让你读 / 总结 / 提取表格数据。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "本地 Office 文件绝对路径。" },
          url: { type: "string", description: "公网可访问的 Office 文档 URL。" },
          base64: { type: "string", description: "base64 编码的 Office 文档内容。" },
          format: {
            type: "string",
            enum: ["docx", "xlsx", "pptx"],
            description:
              "显式指定文档格式。未传时默认按 docx 处理（pptx 暂不支持，会返回明确错误）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file.export_format",
      description:
        "把文本或结构化数据导出为目标格式文件并落盘，返回可下载的 fileUrl。" +
        "支持格式：md / json / csv / xlsx / txt。pdf / docx 暂不支持生成（会返回明确错误，建议改用 md / xlsx）。\n" +
        "适用场景：用户说「导出成 Excel」「存成 json 文件」「给我一份 csv」。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "要导出的内容。字符串导出为 txt/md 时原样写入；导出为 json/csv/xlsx 时按行解析（按 \\n 分行）。",
          },
          format: {
            type: "string",
            enum: ["md", "json", "csv", "xlsx", "txt", "pdf", "docx"],
            description: "目标格式。pdf / docx 暂不支持生成。",
          },
          fileName: {
            type: "string",
            description:
              "目标文件名（可选）。未传则自动生成 export-<timestamp>.<ext>。仅允许 [a-zA-Z0-9_\\-.]。",
          },
          sheetName: {
            type: "string",
            description: "导出 xlsx 时的 sheet 名，默认 \"Sheet1\"。",
          },
        },
        required: ["content", "format"],
        additionalProperties: false,
      },
    },
  },
];
