import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 代码执行沙盒能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `code.*`）：
 *   - code.run         执行 Python / Node 代码，返回 stdout/stderr/exitCode
 *   - code.shell       执行白名单 shell 命令（ls/grep/curl/pip/ffmpeg/git 等），三道闸安全策略
 *   - code.list_files  列出工作目录文件
 *   - code.read_file   读取工作目录文件
 *   - code.write_file  写入工作目录文件
 *
 * 走 deferred（延迟目录）：
 *   1. LLM 不会每轮都跑代码，进核心会浪费 token
 *   2. 关键词触发（"运行代码" / "算一下" / "写个脚本"）时由 tool_discover 拉出
 *
 * 工作目录隔离：每个 actorId + workspaceId 独立目录 `data/sandbox/{actorId}/{workspaceId}/`，
 * 脚本生成的产物（如图片 / csv）持久保留，可被 image-files 路由访问（若生成图片）。
 * 默认禁网，需显式开启 `SANDBOX_ALLOW_NETWORK=1`。
 */
export const CODE_SANDBOX_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "code.run",
      description:
        "执行 Python 或 Node 代码并返回 stdout / stderr / exitCode。代码在隔离工作目录中运行，" +
        "可读写该目录下的文件（产物持久保留，便于多轮操作）。\n" +
        "适用场景：复杂数学计算、数据清洗、格式转换、算法验证、批量文件操作、" +
        "数据可视化（matplotlib / pandas）、正则批量替换、JSON / CSV 处理等。\n" +
        "约束：默认禁止网络访问（除非服务端显式开启 SANDBOX_ALLOW_NETWORK）；" +
        "stdout/stderr 各截断到 8KB；默认超时 30s（可经 timeoutMs 调整，上限 120s）。" +
        "工作目录隔离：每个 actorId + workspaceId 独立，同 workspaceId 复用同一目录。",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["python", "node"],
            description: "执行语言。python 走 `python -I`（隔离模式，忽略用户 site-packages）；node 走 `node`。",
          },
          code: {
            type: "string",
            description: "要执行的源代码。Python 可直接用 matplotlib/pandas/numpy（若已安装）；Node 可用内置模块。",
          },
          workspaceId: {
            type: "string",
            description:
              "工作目录标识（一般是 sessionId 或任务 ID）。同标识复用同一目录，便于多轮读写文件。" +
              "未传则服务端生成随机 UUID，返回结果中带 workspacePath 供后续工具引用。",
          },
          timeoutMs: {
            type: "integer",
            description: "超时毫秒，默认 30000，上限 120000。超时后子进程被 SIGKILL，timedOut=true。",
          },
          stdin: {
            type: "string",
            description: "标准输入内容（可选）。脚本可通过 input() / readline 读取。",
          },
        },
        required: ["language", "code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code.shell",
      description:
        "在沙箱工作目录内执行白名单 shell 命令（不经 shell 解析，参数数组直接传入避免注入）。\n" +
        "适用场景：\n" +
        "  - 文件操作：ls / cat / grep / find / tree / du（查看目录结构、搜索内容）\n" +
        "  - 文本处理：sort / uniq / cut / sed / awk / jq（处理 csv/json/log）\n" +
        "  - 包管理：pip install pandas / npm install lodash（按需引入依赖）\n" +
        "  - 格式转换：ffmpeg / iconv / base64 / zip / tar（转码压缩）\n" +
        "  - 网络抓取：curl / wget（受 SANDBOX_ALLOW_NETWORK 控制，默认禁网时不可用）\n" +
        "  - 版本控制：git log / git status / git diff（只读子命令）\n" +
        "安全策略（三道闸）：\n" +
        "  1. 命令名必须在白名单内（ls/grep/curl/pip/npm/ffmpeg/git 等通用工具）\n" +
        "  2. 子命令不能在黑名单内（uninstall/remove/push --force 等危险操作）\n" +
        "  3. 整条命令不能匹配危险正则（rm -rf / del /s / format / sudo / $(...) 等）\n" +
        "约束：stdout/stderr 各截断到 8KB；默认超时 30s（可经 timeoutMs 调整，上限 120s）；" +
        "工作目录隔离：每个 actorId + workspaceId 独立，同 workspaceId 复用同一目录。" +
        "与 code.run 的区别：code.run 适合跑完整脚本，code.shell 适合跑单条命令（尤其装包/文件操作/格式转换）。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "要执行的命令名（不含参数）。必须在白名单内，允许的命令包括：\n" +
              "ls/dir/cat/type/head/tail/wc/file/stat/find/grep/rg/tree/du/df\n" +
              "echo/printf/date/whoami/hostname/uname/pwd\n" +
              "mkdir/touch/cp/copy/mv/move/ln/zip/unzip/tar/gzip/gunzip/7z\n" +
              "sort/uniq/cut/paste/tr/sed/awk/jq/diff/comm/column\n" +
              "pip/pip3/python/python3/node/npm/npx/yarn/pnpm\n" +
              "curl/wget/base64/xxd/md5sum/sha256sum/iconv\n" +
              "ffmpeg/ffprobe/convert/magick/git/where/tasklist",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              "命令参数数组（每个元素单独传入，不经 shell 解析）。\n" +
              "示例：command=\"pip\", args=[\"install\",\"pandas\"]\n" +
              "示例：command=\"ls\", args=[\"-la\"]\n" +
              "示例：command=\"curl\", args=[\"-sL\",\"https://example.com\"]（需 SANDBOX_ALLOW_NETWORK=1）",
          },
          workspaceId: {
            type: "string",
            description:
              "工作目录标识（一般是 sessionId 或任务 ID）。同标识复用同一目录，便于多轮操作。" +
              "未传则服务端生成随机 UUID，返回结果中带 workspacePath 供后续工具引用。",
          },
          timeoutMs: {
            type: "integer",
            description: "超时毫秒，默认 30000，上限 120000。超时后子进程被 SIGKILL，timedOut=true。",
          },
          stdin: {
            type: "string",
            description: "标准输入内容（可选）。",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code.list_files",
      description:
        "列出指定工作目录下的文件（名称 + 字节数）。仅列常规文件，跳过子目录与运行脚本残留。\n" +
        "适用场景：code.run 生成产物后查看文件名，再决定用 code.read_file 读哪个。",
      parameters: {
        type: "object",
        properties: {
          workspaceId: {
            type: "string",
            description: "工作目录标识（与 code.run 使用的 workspaceId 一致）。",
          },
        },
        required: ["workspaceId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code.read_file",
      description:
        "读取工作目录下的文件内容（utf-8 文本）。文件大小上限 10MB，超出返回错误。\n" +
        "读法（mode）：\n" +
        "  - 默认：小文件（≤2000 字符）直接返回全文；大文件返回结构目录（标题/表头/函数清单）+ 头部预览，\n" +
        "    先看结构再定向读，避免整份大文件挤占上下文；\n" +
        "  - mode=\"range\"：按 offset/limit 读取指定片段（大文件分段读，配合结构目录的 [offset] 标注使用）；\n" +
        "  - mode=\"full\"：强制返回全文（明确需要完整内容时使用，会消耗较多上下文）。\n" +
        "适用场景：查看 code.run 生成的 csv / json / txt / log 文件内容。",
      parameters: {
        type: "object",
        properties: {
          workspaceId: {
            type: "string",
            description: "工作目录标识（与 code.run 使用的 workspaceId 一致）。",
          },
          fileName: {
            type: "string",
            description: "文件名（仅允许 [a-zA-Z0-9_\\-.]，禁止路径分隔符与 `..`）。",
          },
          mode: {
            type: "string",
            enum: ["full", "range"],
            description: "full=全文；range=按 offset/limit 读片段。默认自动：小文件全文、大文件先返回结构目录。",
          },
          offset: {
            type: "integer",
            description: "mode=\"range\" 时的起始字符偏移（结构目录中 [N] 标注即偏移量）。",
          },
          limit: {
            type: "integer",
            description: "mode=\"range\" 时的读取字符数，默认 4000，上限 16000。",
          },
        },
        required: ["workspaceId", "fileName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code.workspace_map",
      description:
        "返回工作区结构地图：每个文件的结构概要（类型 / 大小 / 标题树或表头 / 函数清单，含字符偏移标注）。\n" +
        "适用场景：多文件工作区先看全景再定向读，替代「list_files → 逐个盲读全文」。" +
        "概要仅供导航，引用细节前先用 code.read_file 读取对应文件/片段。未变更文件走增量缓存，调用廉价。",
      parameters: {
        type: "object",
        properties: {
          workspaceId: {
            type: "string",
            description: "工作目录标识（与 code.run 使用的 workspaceId 一致）。",
          },
        },
        required: ["workspaceId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code.write_file",
      description:
        "把文本内容写入工作目录下的文件（覆盖同名）。写入上限 10MB。\n" +
        "适用场景：先写入数据文件，再 code.run 让脚本读取处理；或保存脚本产物副本。",
      parameters: {
        type: "object",
        properties: {
          workspaceId: {
            type: "string",
            description: "工作目录标识（与 code.run 使用的 workspaceId 一致）。",
          },
          fileName: {
            type: "string",
            description: "目标文件名（仅允许 [a-zA-Z0-9_\\-.]，禁止路径分隔符与 `..`）。",
          },
          content: {
            type: "string",
            description: "要写入的文本内容（utf-8）。",
          },
        },
        required: ["workspaceId", "fileName", "content"],
        additionalProperties: false,
      },
    },
  },
];
