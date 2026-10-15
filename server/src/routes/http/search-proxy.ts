import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * 云端搜索代理（AnySearch 协议透传）——ECS（47.98.122.29）专用能力。
 *
 * 背景：发行安装包（内测/公测）默认走运营方自营的云端搜索 API，真实
 * AnySearch key 只存在云端，客户端零 key、零配置。主服务内以路由形态实现
 * （复用现有 systemd/nginx 链路，不新增进程），nginx :80 的 location / 已把
 * /v1/* 全量转发到本服务，无需改 nginx。
 *
 * 端点（与 AnySearch 官方协议同形，客户端 search-providers/anysearch.ts 直连）：
 *   - POST /v1/search        搜索（body 原样透传，带 10min TTL 缓存）
 *   - GET  /v1/sub-domains   能力拓扑查询（图片垂直 tag 自发现用）
 *
 * 防滥用（三层，按序短路；令牌/形态不过关不消耗限流窗口，防共享出口 IP 被 DoS 挤占）：
 *   1. 访问令牌：ANYSEARCH_PROXY_ACCESS_TOKEN 配置后，请求必须带
 *      authorization: Bearer <token>（发行安装包烤入 SEARCH_API_KEY，客户端
 *      anysearchHeaders 自动携带；扫描器/爬虫无令牌一律 403，真实 key 仍只存云端）
 *   2. 形态校验：POST body 必须是 {query: 非空字符串}，否则 400 快拒（不打上游）
 *   3. 按 IP 滑动窗口限流（默认 30 req/min，nginx 传 X-Real-IP / X-Forwarded-For），
 *      超限 429 {code:-1}。上游失败 502，客户端按契约优雅降级到爬虫兜底。
 * 反探测：GET /v1/search 恒 404（伪装不存在，405 会暴露路径）；响应带
 * X-Robots-Tag: noindex（搜索引擎不索引）。
 *
 * 挂载条件（二者缺一则本模块不注册任何路由，安装包/开发机零副作用）：
 *   - ANYSEARCH_PROXY_ENABLED=1
 *   - ANYSEARCH_PROXY_UPSTREAM_KEY=<真实 AnySearch key>
 * 可选：ANYSEARCH_PROXY_UPSTREAM_ENDPOINT（默认 https://api.anysearch.com）、
 *       ANYSEARCH_PROXY_ACCESS_TOKEN（访问令牌，不配则不校验）、
 *       ANYSEARCH_PROXY_RATE_PER_MIN（默认 30）、
 *       ANYSEARCH_PROXY_CACHE_TTL_MS（默认 600000）、
 *       ANYSEARCH_PROXY_UPSTREAM_TIMEOUT_MS（默认 4500，须低于客户端 5s 预算）
 */

const CACHE_MAX_ENTRIES = 500;
const RATE_WINDOW_MS = 60_000;

type SearchProxyConfig = {
  upstreamBase: string;
  upstreamKey: string;
  /** 访问令牌（空 = 不校验）：发行安装包烤入 SEARCH_API_KEY，客户端自动携带 */
  accessToken: string;
  ratePerMin: number;
  cacheTtlMs: number;
  upstreamTimeoutMs: number;
};

/** 注册时读 env（非 import 时锁定）：测试可逐用例改环境变量构造不同配置。 */
function readProxyConfig(): SearchProxyConfig {
  return {
    upstreamBase:
      (process.env.ANYSEARCH_PROXY_UPSTREAM_ENDPOINT ?? "https://api.anysearch.com").trim().replace(/\/+$/, "") ||
      "https://api.anysearch.com",
    upstreamKey: (process.env.ANYSEARCH_PROXY_UPSTREAM_KEY ?? "").trim(),
    accessToken: (process.env.ANYSEARCH_PROXY_ACCESS_TOKEN ?? "").trim(),
    ratePerMin: Math.max(1, Number.parseInt(process.env.ANYSEARCH_PROXY_RATE_PER_MIN ?? "30", 10) || 30),
    cacheTtlMs: Math.max(0, Number.parseInt(process.env.ANYSEARCH_PROXY_CACHE_TTL_MS ?? "600000", 10) || 0),
    upstreamTimeoutMs:
      Math.max(500, Number.parseInt(process.env.ANYSEARCH_PROXY_UPSTREAM_TIMEOUT_MS ?? "4500", 10) || 4500),
  };
}

/** 访问令牌校验："ok" | "forbidden"。未配置令牌时恒 ok（不校验）。 */
function checkAccess(request: FastifyRequest, cfg: SearchProxyConfig): "ok" | "forbidden" {
  if (!cfg.accessToken) return "ok";
  const auth = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match && match[1].trim() === cfg.accessToken ? "ok" : "forbidden";
}

/** query 缓存：key = 原始 body 串。FIFO 淘汰，TTL 过期惰性清除。 */
const searchCache = new Map<string, { at: number; status: number; contentType: string; body: string }>();
/** 每个 IP 的请求时间戳窗口（搜索 + 能力查询都计数）。 */
const rateWindows = new Map<string, number[]>();

/** 仅供测试：清空缓存与限流窗口，隔离用例间模块级状态。 */
export function resetSearchProxyStateForTests(): void {
  searchCache.clear();
  rateWindows.clear();
}

function clientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  const real = request.headers["x-real-ip"];
  const first = typeof xff === "string" ? xff.split(",")[0]?.trim() : "";
  if (first) return first;
  if (typeof real === "string" && real.trim()) return real.trim();
  return request.ip;
}

/** 滑动窗口限流：true = 放行，false = 超限。 */
function consumeRate(ip: string, ratePerMin: number): boolean {
  const now = Date.now();
  const window = (rateWindows.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (window.length >= ratePerMin) {
    rateWindows.set(ip, window);
    return false;
  }
  window.push(now);
  rateWindows.set(ip, window);
  // 防失控：窗口表按 IP 累积，超 1 万 IP 全量重置（公网代理低风险兜底）
  if (rateWindows.size > 10_000) rateWindows.clear();
  return true;
}

async function forwardUpstream(
  cfg: SearchProxyConfig,
  path: string,
  init: { method: "POST" | "GET"; body?: string; query?: string },
): Promise<{ status: number; contentType: string; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
  const url = `${cfg.upstreamBase}${path}${init.query ? `?${init.query}` : ""}`;
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${cfg.upstreamKey}`,
        "content-type": "application/json",
      },
      body: init.body,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json; charset=utf-8",
      body: text,
    };
  } catch (e) {
    console.warn(`[SearchProxy] 上游异常/超时(${cfg.upstreamTimeoutMs}ms) -> ${init.method} ${path}  err=${(e as Error)?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerSearchProxyRoutes(app: FastifyInstance): void {
  // 闸控：注册时读 env。未启用（缺开关或缺 key）不挂载任何路由——安装包/开发机零副作用
  const cfg = readProxyConfig();
  const enabled = (process.env.ANYSEARCH_PROXY_ENABLED ?? "").trim() === "1";
  if (!enabled || !cfg.upstreamKey) {
    if (enabled && !cfg.upstreamKey) {
      console.warn("[SearchProxy] ANYSEARCH_PROXY_ENABLED=1 但缺 ANYSEARCH_PROXY_UPSTREAM_KEY，搜索代理不挂载");
    }
    return;
  }
  console.log(`[SearchProxy] 已挂载 /v1/search + /v1/sub-domains -> ${cfg.upstreamBase}（限流 ${cfg.ratePerMin}/min/IP，缓存 TTL ${Math.round(cfg.cacheTtlMs / 1000)}s）`);

  // 反探测：GET /v1/search 恒 404（fastify 默认 405 会向扫描器暴露「路径存在」）
  app.get("/v1/search", async (_request, reply) => {
    return reply.code(404).type("application/json; charset=utf-8").send({ code: -1, message: "not found" });
  });

  app.post("/v1/search", async (request, reply) => {
    // 1. 访问令牌（不消耗限流窗口，防止共享出口 IP 被扫描器挤占）
    if (checkAccess(request, cfg) === "forbidden") {
      return reply.code(403).type("application/json; charset=utf-8").header("x-robots-tag", "noindex, nofollow").send({ code: -1, message: "forbidden" });
    }
    // 2. 形态校验：{query: 非空字符串}，快拒不打上游
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.query !== "string" || !body.query.trim()) {
      return reply.code(400).type("application/json; charset=utf-8").header("x-robots-tag", "noindex, nofollow").send({ code: -1, message: "invalid request" });
    }
    const ip = clientIp(request);
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const querySnippet = body.query.slice(0, 40);

    // 3. 限流
    if (!consumeRate(ip, cfg.ratePerMin)) {
      console.warn(`[SearchProxy] 限流 429 ip=${ip} query="${querySnippet}"`);
      return reply.code(429).type("application/json; charset=utf-8").send({ code: -1, message: "rate limited" });
    }

    // 缓存命中：直接回放（不计上游）
    if (cfg.cacheTtlMs > 0) {
      const hit = searchCache.get(rawBody);
      if (hit && Date.now() - hit.at < cfg.cacheTtlMs) {
        console.log(`[SearchProxy] cache hit ip=${ip} query="${querySnippet}"`);
        return reply.code(hit.status).type(hit.contentType).header("x-robots-tag", "noindex, nofollow").send(hit.body);
      }
    }

    const started = Date.now();
    const upstream = await forwardUpstream(cfg, "/v1/search", { method: "POST", body: rawBody });
    if (!upstream) {
      return reply.code(502).type("application/json; charset=utf-8").send({ code: -1, message: "upstream unavailable" });
    }
    console.log(`[SearchProxy] ${upstream.status} ${Date.now() - started}ms ip=${ip} query="${querySnippet}"`);

    // 只缓存成功响应（4xx/5xx 透传给客户端降级，不缓存防错误钉死）
    if (cfg.cacheTtlMs > 0 && upstream.status === 200) {
      if (searchCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = searchCache.keys().next().value;
        if (oldest !== undefined) searchCache.delete(oldest);
      }
      searchCache.set(rawBody, { at: Date.now(), ...upstream });
    }
    return reply.code(upstream.status).type(upstream.contentType).header("x-robots-tag", "noindex, nofollow").send(upstream.body);
  });

  app.get("/v1/sub-domains", async (request, reply) => {
    if (checkAccess(request, cfg) === "forbidden") {
      return reply.code(403).type("application/json; charset=utf-8").header("x-robots-tag", "noindex, nofollow").send({ code: -1, message: "forbidden" });
    }
    const ip = clientIp(request);
    if (!consumeRate(ip, cfg.ratePerMin)) {
      return reply.code(429).type("application/json; charset=utf-8").send({ code: -1, message: "rate limited" });
    }
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";
    const upstream = await forwardUpstream(cfg, "/v1/sub-domains", { method: "GET", query });
    if (!upstream) {
      return reply.code(502).type("application/json; charset=utf-8").send({ code: -1, message: "upstream unavailable" });
    }
    return reply.code(upstream.status).type(upstream.contentType).header("x-robots-tag", "noindex, nofollow").send(upstream.body);
  });
}
