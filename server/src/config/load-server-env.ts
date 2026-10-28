import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 解析当前部署的区域版本。
 *
 * 优先级：进程环境变量 `REGION` > `.env` 中的 `REGION` > 默认 `domestic`。
 *
 * - `domestic` / `cn` / `china` / 空 → domestic
 * - `intl` / `international` / `global` / `overseas` → intl
 *
 * 区域只影响**默认值**（如未显式设 `EXTERNAL_MODEL_PROVIDER` 时按区域推断），
 * 显式配置的环境变量始终优先。
 */
export function resolveRegion(env: NodeJS.ProcessEnv = process.env): "domestic" | "intl" {
  const raw = (env.REGION ?? "").trim().toLowerCase();
  switch (raw) {
    case "intl":
    case "international":
    case "global":
    case "overseas":
      return "intl";
    case "domestic":
    case "cn":
    case "china":
    case "":
      return "domestic";
    default:
      console.warn(
        `[load-server-env] Unknown REGION="${raw}", falling back to domestic.`,
      );
      return "domestic";
  }
}

/**
 * 加载 server 环境变量，顺序（后者覆盖前者）：
 *
 * 1. `.env` —— 通用基础（可提交示例/通用项）
 * 2. `.env.{region}` —— 区域特定（domestic / intl，非密钥的开关与默认值）
 * 3. `.env.local` —— 本地密钥（覆盖一切，已 gitignore；用 override:true 避免
 *    注册表 / Process 级 env（如 IDE 终端或 dev 工具注入的）抢走本地密钥）
 *
 * 区域文件不存在时静默跳过，保持向后兼容。
 */
export function loadServerEnv(): void {
  const envPath = join(serverRoot, ".env");
  const localPath = join(serverRoot, ".env.local");

  if (existsSync(envPath)) {
    loadEnv({ path: envPath, quiet: true });
  }

  // 先读 .env 里的 REGION（若 .env.local 后续覆盖也无妨，区域只影响默认值）
  const region = resolveRegion(process.env);
  const regionPath = join(serverRoot, `.env.${region}`);
  if (existsSync(regionPath)) {
    loadEnv({ path: regionPath, override: true, quiet: true });
  }

  if (existsSync(localPath)) {
    // override:true 让 .env.local 覆盖 Process 级 / User 级 env，确保本地密钥优先。
    loadEnv({ path: localPath, override: true, quiet: true });
  }
}

// 捆绑布局随包带可执行文件：<runtime>\node.exe 与 <runtime>\bin\*（ffmpeg 等）。
// code.shell / code.run 用 PATH 查找命令，装机机器 PATH 上没有这些工具，
// 这里把它们前置进本进程 PATH，子进程继承后即可直接调用。
function prependBundledToolsToPath(): void {
  if (process.platform !== "win32") return;
  const dirs = [
    existsSync(join(serverRoot, "bin")) ? join(serverRoot, "bin") : null,
    existsSync(join(serverRoot, "node.exe")) ? serverRoot : null,
  ].filter((d): d is string => d !== null);
  if (dirs.length === 0) return;
  const current = process.env.PATH ?? "";
  const entries = new Set(current.split(";").filter(Boolean));
  const fresh = dirs.filter((d) => !entries.has(d));
  if (fresh.length === 0) return;
  process.env.PATH = current ? `${fresh.join(";")};${current}` : fresh.join(";");
}

prependBundledToolsToPath();

// Playwright 浏览器目录：相对值按 Playwright 自身规则解析到进程 cwd，换 cwd 就找不到
// 浏览器。这里统一锚定到 runtime 根，让首启与运行目录无关。
function anchorPlaywrightBrowsersPath(): void {
  const raw = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!raw || isAbsolute(raw)) return;
  const abs = resolve(serverRoot, raw);
  if (existsSync(abs)) process.env.PLAYWRIGHT_BROWSERS_PATH = abs;
}

anchorPlaywrightBrowsersPath();

// 模块加载时立即执行：确保在任何其他模块 import 之前环境变量已就绪。
// 有些模块（如 chat-user-message.ts）在模块顶层调用 getAgentRuntimeConfig()，
// 如果 loadServerEnv() 被推迟到 index.ts 显式调用，那个缓存就已经写死了。
loadServerEnv();
