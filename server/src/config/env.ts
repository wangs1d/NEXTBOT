import type { HttpRateLimitRuntime } from "../http-rate-limit/http-rate-limit.js";

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return n;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export type RuntimeConfig = {
  port: number;
  allowWorldHttpMutations: boolean;
  agentRelayRequirePair: boolean;
  worldPlaceholderRegister: boolean;
  realFundsInitialBalance: number;
  realFundsDefaultCurrency: string;
};

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const portRaw = parseInteger(env.PORT, 3000);
  const port = portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
  const currency = env.REAL_FUNDS_DEFAULT_CURRENCY?.trim() || "CNY";
  return {
    port,
    allowWorldHttpMutations: parseBoolean(env.ALLOW_WORLD_HTTP_MUTATIONS, false),
    agentRelayRequirePair: parseBoolean(env.AGENT_RELAY_REQUIRE_PAIR, false),
    worldPlaceholderRegister: parseBoolean(env.AGENT_WORLD_PLACEHOLDER_REGISTER, false),
    realFundsInitialBalance: parsePositiveNumber(env.REAL_FUNDS_INITIAL_BALANCE, 1000),
    realFundsDefaultCurrency: currency,
  };
}

/**
 * 进程拓扑配置（Agent runtime 独立后台进程）：
 *   embedded —— 单进程（今天的形态）：server 同时承担 runtime 与对外网关
 *   remote   —— 双进程：runtime-main 绑内部 HTTP/WS 端口 + 链路端口；
 *               gateway-main 绑对外端口做 WS 隧道 + HTTP 反代（可替换的外壳适配器）
 */
export type RuntimeTopologyConfig = {
  mode: "embedded" | "remote";
  /** runtime 进程内部 HTTP/WS 监听端口（remote 模式；仅本机回环） */
  runtimeHttpPort: number;
  /** runtime 链路端口（RuntimeFacade RPC over WS，供非隧道型网关/外壳使用） */
  runtimeLinkPort: number;
  /** 链路鉴权 token；设置后客户端须在连接 query 中携带 token */
  runtimeLinkToken: string | null;
  /** gateway 对外监听端口（remote 模式） */
  gatewayPort: number;
};

export function getRuntimeTopologyConfig(env: NodeJS.ProcessEnv = process.env): RuntimeTopologyConfig {
  // 缺省 embedded：保持既有单进程行为（npm start / dev:all 不受影响）；
  // remote 由 runtime-main / gateway-main 入口显式声明
  const modeRaw = (env.RUNTIME_MODE ?? "embedded").trim().toLowerCase();
  return {
    mode: modeRaw === "remote" ? "remote" : "embedded",
    runtimeHttpPort: parseInteger(env.RUNTIME_HTTP_PORT, 3211),
    runtimeLinkPort: parseInteger(env.RUNTIME_LINK_PORT, 3210),
    runtimeLinkToken: env.RUNTIME_LINK_TOKEN?.trim() || null,
    gatewayPort: parseInteger(env.GATEWAY_PORT, parseInteger(env.PORT, 3000)),
  };
}

/** 令牌桶 + 滑动窗口 HTTP 限流；默认关闭，生产可设 HTTP_RATE_LIMIT_ENABLED=1。 */export function getHttpRateLimitRuntime(env: NodeJS.ProcessEnv = process.env): HttpRateLimitRuntime {
  const slidingWindowMs = parsePositiveNumber(env.HTTP_RATE_LIMIT_SLIDING_WINDOW_MS, 60_000);
  const slidingMax = parseInteger(env.HTTP_RATE_LIMIT_SLIDING_MAX, 600);
  const bucketCapacity = parseInteger(env.HTTP_RATE_LIMIT_BUCKET_CAPACITY, 80);
  const bucketRefillPerSecond = parsePositiveNumber(env.HTTP_RATE_LIMIT_BUCKET_REFILL_PER_SEC, 40);
  const maxTrackedClients = parseInteger(env.HTTP_RATE_LIMIT_MAX_CLIENT_KEYS, 100_000);

  const redisUrlRaw = env.HTTP_RATE_LIMIT_REDIS_URL?.trim();
  const redisKeyPrefix = env.HTTP_RATE_LIMIT_REDIS_KEY_PREFIX?.trim() || "http_rl:v1";

  return {
    enabled: parseBoolean(env.HTTP_RATE_LIMIT_ENABLED, false),
    trustForwardedFor: parseBoolean(env.HTTP_RATE_LIMIT_TRUST_FORWARDED_FOR, false),
    slidingWindowMs,
    slidingMax: slidingMax > 0 ? slidingMax : 600,
    bucketCapacity: bucketCapacity > 0 ? bucketCapacity : 80,
    bucketRefillPerSecond: bucketRefillPerSecond > 0 ? bucketRefillPerSecond : 40,
    maxTrackedClients: maxTrackedClients > 1000 ? maxTrackedClients : 100_000,
    redisUrl: redisUrlRaw && redisUrlRaw.length > 0 ? redisUrlRaw : null,
    redisKeyPrefix,
    redisFailOpen: parseBoolean(env.HTTP_RATE_LIMIT_REDIS_FAIL_OPEN, true),
  };
}

export type HttpsRuntimeConfig = {
  enabled: boolean;
  port: number;
  /** null → 默认 server/certs/ */
  certDir: string | null;
  /** 启动时自动把本地根 CA 装入 Windows 用户信任库（Chrome/Edge 出锁标） */
  autoTrust: boolean;
  opensslBin: string | null;
};

/**
 * 本地 HTTPS 双监听（utils/dev-https.ts）：默认开启，HTTP 端口行为零变化。
 *   HTTPS_ENABLED=0   关闭 HTTPS 监听
 *   HTTPS_PORT=3443   HTTPS 端口
 *   TLS_CERT_DIR      证书目录（默认 server/certs/）
 *   TLS_AUTO_TRUST=0  跳过 CA 自动装入 Windows 用户信任库
 *   OPENSSL_BIN       指定 openssl 路径（默认 PATH / Git 自带副本）
 */
export function getHttpsRuntimeConfig(env: NodeJS.ProcessEnv = process.env): HttpsRuntimeConfig {
  const portRaw = parseInteger(env.HTTPS_PORT, 3443);
  return {
    enabled: parseBoolean(env.HTTPS_ENABLED, true),
    port: portRaw > 0 && portRaw < 65536 ? portRaw : 3443,
    certDir: env.TLS_CERT_DIR?.trim() || null,
    autoTrust: parseBoolean(env.TLS_AUTO_TRUST, true),
    opensslBin: env.OPENSSL_BIN?.trim() || null,
  };
}

/**
 * Loop Orchestrator 启用开关。
 *
 * 默认**开启**：plan_execute 路径走 LoopOrchestrator，启用
 * ProgressTracker / Recovery / Escalation / Termination 策略与 assess→replan 反思环节。
 *
 * 设 `AGENT_LOOP_ORCHESTRATOR=0|off|false|no` 可回退到原 runPlanExecuteLoop 路径
 * （保留降级开关，便于回滚与对照测试）。
 */
export function isLoopOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENT_LOOP_ORCHESTRATOR?.trim().toLowerCase();
  // 未设置 → 默认开启
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * plan_execute 路径的 replan 上限（统一配置源）。
 *
 * LoopOrchestrator 与 PlanExecuteLoopStrategy 共享此值，避免双处默认值不同步。
 * 设 `AGENT_LOOP_MAX_REPLANS=N` 覆盖默认值 2。
 * 取值范围 [0, 5]，超出范围 clamp 到边界；0 表示禁止 replan。
 */
export function getLoopMaxReplans(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_LOOP_MAX_REPLANS?.trim();
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(5, n));
}

/**
 * 统一读取「默认关闭」的环境变量开关（实验性子系统装配用）。
 *
 * 仅当主变量（或任一兼容旧变量）被显式设为 1/true/yes/on 时视为开启；
 * 其余取值（未设置 / 0 / false / off / no 等）一律关闭。
 *
 * @param name 主变量名
 * @param legacyNames 兼容旧变量名列表（任一为真值即等效开启）
 */
export function envFlagEnabled(name: string, legacyNames: readonly string[] = []): boolean {
  const isTruthy = (raw: string | undefined): boolean => {
    const v = raw?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  };
  return isTruthy(process.env[name]) || legacyNames.some((legacy) => isTruthy(process.env[legacy]));
}

/**
 * 发行版本（NEXTBOT_EDITION）：
 *   internal —— 内测版（默认）：能力全量，开发机 / ECS / 内测安装包零变化；
 *   oss      —— 开源版（GitHub 发行）：剔除内测独占能力家族（旅游 / 虚拟电话 /
 *               好友社交 / 购物比价 / 社交外联 / 手机桥接），闸口四处：
 *               capability-modules internalOnly 过滤、create-app-services 家族注册块、
 *               tool-search core 常驻名单、HTTP 路由注册。
 *
 * 默认 internal：存量部署不写该变量，行为不变；开源安装包在 staging 的 server .env
 * 写 NEXTBOT_EDITION=oss。函数运行时读取（非启动期常量），保证测试与装配层可动态判定。
 */
export type ServerEdition = "internal" | "oss";

export function getServerEdition(env: NodeJS.ProcessEnv = process.env): ServerEdition {
  return (env.NEXTBOT_EDITION ?? "").trim().toLowerCase() === "oss" ? "oss" : "internal";
}

export function isOssEdition(): boolean {
  return getServerEdition() === "oss";
}

/**
 * AGENT_WORLD_SOCIAL_ENABLED：Agent World 社交经济域开关。
 * 实验性子系统，默认 0=关闭：跳过 world-free-market / world-music / world-social /
 * a2a-outsourcing / community-skill-store，保留 identity / pairing / registration 最小集。
 */
export function isAgentWorldSocialEnabled(): boolean {
  return envFlagEnabled("AGENT_WORLD_SOCIAL_ENABLED");
}

/**
 * ACCESS_AUTH_REQUIRED：设备自绑定鉴权（/api/* 周界鉴权）总开关。
 *
 * 默认**关闭**（零行为变更）：身份仍由 userId/sessionId 客户端声明（resolveActorId）。
 * 设 `ACCESS_AUTH_REQUIRED=1|true|on` 开启后：
 *   - /api/* 请求须携带有效设备 token（Bearer 头或 ?token=），无效/缺失 → 401；
 *   - WS 连接须在 upgrade query 或 session.init payload 携带有效 token；
 *   - 首台设备引导（bootstrap）：token 库为空时，/api/auth/pairing-code 免鉴权，
 *     启动时会在控制台打印一枚引导配对码。
 */
export function isAccessAuthRequired(): boolean {
  return envFlagEnabled("ACCESS_AUTH_REQUIRED");
}
