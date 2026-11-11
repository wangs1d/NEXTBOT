// HTTP 路由：客户端远程配置（远程配置下发的地基，2026-11-10）
//
// GET /api/client/config —— 下发客户端运行期地址覆盖（远程配置下发·方式二）：
// 客户端编译期只烤一个引导锚点（控制面域名），主服务/控制面等地址在运行期
// 从这里拿，换机房 / 迁域名 / 故障切换 = 改一条配置，客户端下次启动生效，
// 不再依赖重烤包 + 发版。
//
// 发版流程：改 config/client-config.json。文件每次请求实时读取，改完即生效
// （无需重启、无需重新构建），与 client-manifest.json 同一套约定。
// 环境变量 CLIENT_CONFIG_* 可逐字段覆盖文件值（部署期不改文件的临时调整）。
//
// 兜底语义（对齐 client-manifest）：文件缺失/损坏回退内置兜底（全空），
// 接口必须始终可用。**全空 = 客户端保持烤入值**——地基阶段字段留空即
// 零行为变化，逐字段灰度放开。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

type ClientConfigDto = {
  /** 主服务 HTTP 根地址（客户端 httpBase 运行期覆盖）；空 = 保持烤入值 */
  httpBase: string;
  /** 控制面地址（反馈/站内信/网页登录页）；空 = 保持烤入值 */
  controlPlaneUrl: string;
  /** 版本清单地址（更新检查）；空 = 保持烤入值 */
  updateManifestUrl: string;
};

/** 内置兜底：全空 = 不覆盖任何烤入值（地基阶段默认形态，零行为变化）。 */
const DEFAULT_CLIENT_CONFIG: ClientConfigDto = {
  httpBase: "",
  controlPlaneUrl: "",
  updateManifestUrl: "",
};

const ENV_BY_FIELD = {
  httpBase: "CLIENT_CONFIG_HTTP_BASE",
  controlPlaneUrl: "CLIENT_CONFIG_CONTROL_PLANE_URL",
  updateManifestUrl: "CLIENT_CONFIG_UPDATE_MANIFEST_URL",
} as const;

/**
 * 合并三层配置源：内置兜底 ← 文件 ← 环境变量（后者逐字段覆盖前者）。
 * 提取为纯函数便于单测；trim 后空串视为「未配置」，一律归一成空串。
 */
export function mergeClientConfig(
  file: Partial<Record<keyof ClientConfigDto, unknown>>,
  env: Record<string, string | undefined> = process.env,
): ClientConfigConfigured {
  const merged = { ...DEFAULT_CLIENT_CONFIG };
  for (const field of Object.keys(DEFAULT_CLIENT_CONFIG) as (keyof ClientConfigDto)[]) {
    const fromFile = file[field];
    if (typeof fromFile === "string" && fromFile.trim().length > 0) {
      merged[field] = fromFile.trim();
    }
    const fromEnv = env[ENV_BY_FIELD[field]];
    if (fromEnv && fromEnv.trim().length > 0) {
      merged[field] = fromEnv.trim();
    }
  }
  return merged as ClientConfigConfigured;
}

/** mergeClientConfig 的返回类型：结构同 ClientConfigDto（导出给测试/客户端对齐用）。 */
export type ClientConfigConfigured = ClientConfigDto;

/**
 * 读取并合并客户端远程配置。`dir` 仅供单测注入（默认进程 cwd 下 config/）。
 * 文件缺失/损坏/字段类型不对时按「未配置」处理——接口永不抛错。
 */
export async function readClientConfig(dir: string = process.cwd()): Promise<ClientConfigConfigured> {
  let file: Partial<Record<keyof ClientConfigDto, unknown>> = {};
  try {
    file = JSON.parse(await readFile(join(dir, "config", "client-config.json"), "utf8")) as
      Partial<Record<keyof ClientConfigDto, unknown>>;
  } catch {
    // 文件缺失/损坏：按全空处理。接口必须始终可用，客户端启动链路强依赖它。
  }
  return mergeClientConfig(file);
}

export function registerClientConfigRoutes(app: FastifyInstance): void {
  app.get("/api/client/config", async () => {
    const config = await readClientConfig();
    return { ok: true, ...config };
  });
}
