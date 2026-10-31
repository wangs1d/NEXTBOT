import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  buildOrderedPathRateLimitRules,
  resolvePathRateLimitRule,
  type PathRateLimitRule,
} from "./path-rate-limit-rules.js";
import { createRedisHttpRateLimiter, type RateLimitDecision } from "./redis-rate-limit.js";

export type { RateLimitDecision };

export type HttpRateLimitRuntime = {
  enabled: boolean;
  trustForwardedFor: boolean;
  slidingWindowMs: number;
  slidingMax: number;
  bucketCapacity: number;
  bucketRefillPerSecond: number;
  maxTrackedClients: number;
  /** 设置后使用 Redis 分布式限流（多副本共享配额） */
  redisUrl: string | null;
  redisKeyPrefix: string;
  /** Redis 命令失败时是否放行（默认 true，避免 Redis 故障拖垮 API） */
  redisFailOpen: boolean;
};

type ClientState = {
  tokens: number;
  lastRefillMs: number;
  windowTimestamps: number[];
  lastTouchMs: number;
  slidingWindowMs: number;
  bucketCapacity: number;
};

function refillTokens(state: ClientState, now: number, capacity: number, refillPerSec: number): void {
  const elapsedSec = (now - state.lastRefillMs) / 1000;
  if (elapsedSec <= 0) return;
  state.lastRefillMs = now;
  state.tokens = Math.min(capacity, state.tokens + elapsedSec * refillPerSec);
}

function pruneWindow(state: ClientState, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  const q = state.windowTimestamps;
  let i = 0;
  while (i < q.length && q[i]! <= cutoff) i++;
  if (i > 0) state.windowTimestamps = q.slice(i);
}

function tryConsumeComposite(state: ClientState, now: number, limits: PathRateLimitRule): RateLimitDecision {
  refillTokens(state, now, limits.bucketCapacity, limits.bucketRefillPerSecond);
  pruneWindow(state, now, limits.slidingWindowMs);

  if (state.tokens < 1) {
    const need = 1 - state.tokens;
    const retryAfterMs = Math.ceil((need / limits.bucketRefillPerSecond) * 1000);
    return { ok: false, retryAfterMs: Math.max(1, retryAfterMs), layer: "token_bucket" };
  }

  if (state.windowTimestamps.length >= limits.slidingMax) {
    const oldest = state.windowTimestamps[0]!;
    const retryAfterMs = Math.ceil(oldest + limits.slidingWindowMs - now);
    return { ok: false, retryAfterMs: Math.max(1, retryAfterMs), layer: "sliding_window" };
  }

  state.tokens -= 1;
  state.windowTimestamps.push(now);
  return { ok: true };
}

function resolveClientKey(
  req: FastifyRequest,
  trustForwardedFor: boolean,
  verifiedActor: string | null,
): string {
  // 已验证身份优先：移动端用户大量挂在运营商 NAT / 公司出口后面，按 IP 分桶会让
  // 几十个人共用一个配额，硬件还空着就先 429。身份必须来自 token 验证，
  // 不能取自报的 userId/query——那等于给攻击者无限开桶。
  if (verifiedActor) return `actor:${verifiedActor}`;
  if (trustForwardedFor) {
    const raw = req.headers["x-forwarded-for"];
    if (typeof raw === "string") {
      const first = raw.split(",")[0]?.trim();
      if (first) return `ip:${first}`;
    } else if (Array.isArray(raw) && raw[0]) {
      const first = raw[0].split(",")[0]?.trim();
      if (first) return `ip:${first}`;
    }
  }
  const socketIp = req.socket.remoteAddress;
  if (socketIp) return `ip:${socketIp}`;
  return "unknown";
}

const SKIP_PATHS = new Set(["/health"]);

function shouldSkipRateLimit(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return SKIP_PATHS.has(path);
}

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

export class HttpRateLimitStore {
  private readonly clients = new Map<string, ClientState>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly maxTrackedClients: number,
    private readonly maxSweepWindowMs: number,
  ) {}

  tryConsume(storageKey: string, rule: PathRateLimitRule, now: number): RateLimitDecision {
    let state = this.clients.get(storageKey);
    if (!state) {
      state = {
        tokens: rule.bucketCapacity,
        lastRefillMs: now,
        windowTimestamps: [],
        lastTouchMs: now,
        slidingWindowMs: rule.slidingWindowMs,
        bucketCapacity: rule.bucketCapacity,
      };
      this.evictIfNeeded();
      this.clients.set(storageKey, state);
    } else {
      state.lastTouchMs = now;
      this.clients.delete(storageKey);
      this.clients.set(storageKey, state);
    }

    return tryConsumeComposite(state, now, rule);
  }

  private evictIfNeeded(): void {
    if (this.clients.size < this.maxTrackedClients) return;
    const first = this.clients.keys().next().value as string | undefined;
    if (first !== undefined) this.clients.delete(first);
  }

  startIdleSweep(): void {
    if (this.sweepTimer !== null) return;
    const idleMs = Math.max(this.maxSweepWindowMs * 3, 120_000);
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, s] of this.clients) {
        pruneWindow(s, now, s.slidingWindowMs);
        const idle = now - s.lastTouchMs;
        if (idle > idleMs && s.windowTimestamps.length === 0 && s.tokens >= s.bucketCapacity - 1e-6) {
          this.clients.delete(k);
        }
      }
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  stopIdleSweep(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

type RateLimitBackend = {
  tryConsume(clientKey: string, rule: PathRateLimitRule): Promise<RateLimitDecision>;
  close(): Promise<void>;
};

function maxRuleWindowMs(ordered: readonly PathRateLimitRule[]): number {
  let m = 60_000;
  for (const r of ordered) m = Math.max(m, r.slidingWindowMs);
  return m;
}

async function createRateLimitBackend(
  orderedRules: PathRateLimitRule[],
  cfg: HttpRateLimitRuntime,
): Promise<RateLimitBackend> {
  const maxSweep = maxRuleWindowMs(orderedRules);

  if (cfg.redisUrl) {
    const redis = await createRedisHttpRateLimiter({
      redisUrl: cfg.redisUrl,
      redisKeyPrefix: cfg.redisKeyPrefix,
      redisFailOpen: cfg.redisFailOpen,
    });
    return {
      tryConsume(clientKey, rule) {
        return redis.tryConsume(clientKey, rule.id, rule);
      },
      close: () => redis.close(),
    };
  }

  const store = new HttpRateLimitStore(cfg.maxTrackedClients, maxSweep);
  store.startIdleSweep();
  return {
    tryConsume(clientKey, rule) {
      const storageKey = `${clientKey}::${rule.id}`;
      return Promise.resolve(store.tryConsume(storageKey, rule, Date.now()));
    },
    async close() {
      store.stopIdleSweep();
    },
  };
}

/**
 * 身份解析钩子：返回「已验证」的 actor id（未验证必须返回 null —— body/query 里的
 * userId 是调用方可伪造的，拿它分键等于给攻击者无限开桶）。
 */
export interface HttpRateLimitIdentityResolver {
  resolveVerifiedActor(req: FastifyRequest): string | null;
}

export async function registerHttpRateLimit(
  app: FastifyInstance,
  cfg: HttpRateLimitRuntime,
  identity: HttpRateLimitIdentityResolver = { resolveVerifiedActor: () => null },
): Promise<void> {
  if (!cfg.enabled) return;

  const orderedRules = buildOrderedPathRateLimitRules({
    slidingWindowMs: cfg.slidingWindowMs,
    slidingMax: cfg.slidingMax,
    bucketCapacity: cfg.bucketCapacity,
    bucketRefillPerSecond: cfg.bucketRefillPerSecond,
  });
  const backend = await createRateLimitBackend(orderedRules, cfg);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (shouldSkipRateLimit(req.url)) return;

    const path = requestPath(req.url);
    const rule = resolvePathRateLimitRule(path, orderedRules);
    const key = resolveClientKey(req, cfg.trustForwardedFor, identity.resolveVerifiedActor(req));
    const result = await backend.tryConsume(key, rule);
    if (result.ok) return;

    const retrySec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    return reply
      .code(429)
      .header("Retry-After", String(retrySec))
      .header("X-RateLimit-Reject-Layer", result.layer)
      .header("X-RateLimit-Tier", rule.id)
      .send({
        error: "too_many_requests",
        message: "请求过于频繁，请稍后再试",
        retryAfterMs: result.retryAfterMs,
        tier: rule.id,
      });
  });

  app.addHook("onClose", async () => {
    await backend.close();
  });
}
