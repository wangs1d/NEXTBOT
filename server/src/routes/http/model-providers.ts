// HTTP 路由：模型接入目录（provider 目录式选择）
//
// GET /api/model-providers —— 下发可选模型服务商目录（base URL / 模型清单 / key 申请引导）。
// 首启向导「模型接入」与设置页「模型服务」共用：用户只需选服务商、选模型、填 API Key，
// base URL 由本目录统一下发（本文件即配置：改 config/model-providers.json 即生效，
// 每次请求实时读取，无需重启、无需重新构建客户端——与 client-manifest 同一模式）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

export type ModelProviderChoiceDto = {
  id: string;
  label?: string;
  recommended?: boolean;
};

/**
 * 前缀缓存行为能力位（2026-10-07）：声明该 provider 服务端缓存的路由形态，
 * 供选型/成本侧参考。实测依据见 scripts/report-cache-hit.ts 的命中率报表。
 */
export type ModelProviderPromptCacheDto = {
  /** shared=集群共享隐式缓存（DeepSeek）；per-node=副本各自缓存（MiniMax，命中随机）；explicit=支持显式断点标记 */
  mode: "shared" | "per-node" | "explicit" | "none";
  note?: string;
};

export type ModelProviderDto = {
  id: string;
  name: string;
  tagline?: string;
  baseUrl: string;
  defaultModel: string;
  models: ModelProviderChoiceDto[];
  consoleUrl?: string;
  guide?: string[];
  note?: string;
  promptCache?: ModelProviderPromptCacheDto;
};

export type ModelProviderCatalog = {
  version: number;
  providers: ModelProviderDto[];
};

/** 兜底目录（config/model-providers.json 缺失/损坏时使用，保证接口始终可用） */
const FALLBACK_PROVIDERS: ModelProviderDto[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    models: [{ id: "deepseek-flash", recommended: true }, { id: "deepseek-v4-pro" }],
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3",
    models: [{ id: "kimi-k3", recommended: true }, { id: "kimi-k2.6" }],
    consoleUrl: "https://platform.kimi.com/console/api-keys",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.3-flash",
    models: [{ id: "glm-5.3-flash", recommended: true }, { id: "glm-5.3" }, { id: "glm-4.7-flash" }],
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.1",
    models: [{ id: "gpt-5.1", recommended: true }, { id: "gpt-5.1-mini" }],
    consoleUrl: "https://platform.openai.com/api-keys",
  },
];

function isProviderDto(value: unknown): value is ModelProviderDto {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<ModelProviderDto>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.name === "string" &&
    typeof p.baseUrl === "string" &&
    typeof p.defaultModel === "string" &&
    Array.isArray(p.models) &&
    p.models.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as ModelProviderChoiceDto).id === "string",
    )
  );
}

/**
 * 读取模型服务商目录：config/model-providers.json 每次实时读取，缺失/损坏回退内置兜底。
 * @param dir 目录所在文件夹（默认 `cwd/config`，测试可注入）
 */
export async function readModelProviderCatalog(
  dir: string = join(process.cwd(), "config"),
): Promise<ModelProviderCatalog> {
  let file: { version?: number; providers?: unknown } = {};
  try {
    file = JSON.parse(await readFile(join(dir, "model-providers.json"), "utf8"));
  } catch {
    // 文件缺失/损坏：回退内置兜底
  }
  const providers = Array.isArray(file.providers)
    ? file.providers.filter(isProviderDto)
    : [];
  return {
    version: typeof file.version === "number" ? file.version : 1,
    providers: providers.length > 0 ? providers : FALLBACK_PROVIDERS,
  };
}

export function registerModelProviderRoutes(app: FastifyInstance): void {
  app.get("/api/model-providers", async () => {
    const catalog = await readModelProviderCatalog();
    return { ok: true, ...catalog };
  });
}
