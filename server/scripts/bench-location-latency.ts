/**
 * 位置解析（逆地理）延迟基准 —— 2026-10-12 延迟优化配套。
 *
 * 背景：真机日志 `[ctx-timing] userLocation` p50≈2052ms 是「首字前固定成本」里
 * 最大的一根杆，且它 = `resolveUserLocationPrompt` → `geoFromClientLocation`
 * → `reverseGeocodeCoordinates`（BigDataCloud + open-meteo 两次外网），此前**无缓存**、
 * 且**无视前端已解析好的字段**——每条消息都要重查一次。
 *
 * 本脚本复现「优化前」这条每轮冷查路径，并对比「优化后」的两条零网络路径，
 * 输出可复现的前后耗时。
 *
 * 用法：
 *   node --import tsx scripts/bench-location-latency.ts            # 打真实外网
 *   node --import tsx scripts/bench-location-latency.ts --stub=800 # 注入固定网络延迟（可复现）
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";

import {
  resetReverseGeocodeCacheForTest,
} from "../src/services/reverse-geocode-service.js";
import { resolveUserLocationPrompt } from "../src/services/user-location-service.js";

type FetchLike = typeof globalThis.fetch;

// 兴义市梦乐城附近（与真机用户所在城市一致）
const LAT = 25.0911;
const LON = 104.9011;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const stubMs = Number.parseInt(args.get("stub") ?? "", 10);

/** 包装 fetch：计数 + 可选注入固定延迟。 */
function instrumentFetch(injectMs: number): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls++;
    if (injectMs > 0) await new Promise((r) => setTimeout(r, injectMs));
    return original(input as never, init as never);
  }) as FetchLike;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function summarize(ms: number[]): string {
  const v = [...ms].sort((a, b) => a - b);
  const n = v.length;
  const mean = Math.round(v.reduce((s, x) => s + x, 0) / n);
  return `p50=${Math.round(v[Math.floor(n / 2)])}ms mean=${mean}ms n=${n}`;
}

async function main(): Promise<void> {
  console.log(`\n=== 位置解析延迟基准（兴义 ${LAT}, ${LON}）===`);
  console.log(
    stubMs > 0
      ? `模式：注入固定网络延迟 ${stubMs}ms/次（可复现，不依赖外网抖动）\n`
      : `模式：真实外网（BigDataCloud + open-meteo）\n`,
  );

  const wrapped = instrumentFetch(Number.isFinite(stubMs) ? stubMs : 0);
  const resolvedPayload = {
    latitude: LAT,
    longitude: LON,
    city: "黔西南布依族苗族自治州",
    district: "兴义市",
    region: "贵州省",
    country: "中国",
    timezone: "Asia/Shanghai",
  };

  try {
    // ── 场景 A：优化前 —— 纯坐标（服务端无视前端字段，每轮冷查两次外网）
    resetReverseGeocodeCacheForTest();
    const beforeMs: number[] = [];
    const beforeCalls: number[] = [];
    for (let i = 0; i < 3; i++) {
      resetReverseGeocodeCacheForTest();
      const c0 = wrapped.calls();
      const r = await time(() =>
        resolveUserLocationPrompt({ clientLocation: { latitude: LAT, longitude: LON } }),
      );
      beforeMs.push(r.ms);
      beforeCalls.push(wrapped.calls() - c0);
    }

    // ── 场景 B：优化后-① 复用前端已解析字段（零网络）
    resetReverseGeocodeCacheForTest();
    const reuseMs: number[] = [];
    const c1 = wrapped.calls();
    for (let i = 0; i < 5; i++) {
      const r = await time(() =>
        resolveUserLocationPrompt({ clientLocation: { ...resolvedPayload } }),
      );
      reuseMs.push(r.ms);
    }
    const reuseCalls = wrapped.calls() - c1;

    // ── 场景 C：优化后-② 仅坐标（逆地理失败兜底）→ 首次冷查、其后命中进程缓存
    resetReverseGeocodeCacheForTest();
    const cold = await time(() =>
      resolveUserLocationPrompt({ clientLocation: { latitude: LAT, longitude: LON } }),
    );
    const warmMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      // 坐标同桶（取整 3 位小数）→ 命中缓存
      const r = await time(() =>
        resolveUserLocationPrompt({
          clientLocation: { latitude: LAT + 0.0001, longitude: LON - 0.0001 },
        }),
      );
      warmMs.push(r.ms);
    }

    console.log("场景                                  结果");
    console.log("-------------------------------------- ------------------------------------------");
    console.log(`A 优化前：每轮冷查（2 次外网）    ${summarize(beforeMs)}  外网调用/次≈${Math.round(beforeCalls.reduce((s, x) => s + x, 0) / beforeCalls.length)}`);
    console.log(`B 优化后：复用前端已解析字段      ${summarize(reuseMs)}  外网调用=${reuseCalls}`);
    console.log(`C 优化后：纯坐标 首次冷查         ${Math.round(cold.ms)}ms`);
    console.log(`C 优化后：纯坐标 同坐标再查(缓存)  ${summarize(warmMs)}`);

    const beforeAvg = beforeMs.reduce((s, x) => s + x, 0) / beforeMs.length;
    const afterAvg = reuseMs.reduce((s, x) => s + x, 0) / reuseMs.length;
    console.log(
      `\n每轮节省：≈ ${Math.round(beforeAvg - afterAvg)}ms（${Math.round(beforeAvg)} → ${Math.round(afterAvg)}），` +
        `外网调用 ${Math.round(beforeCalls.reduce((s, x) => s + x, 0) / beforeCalls.length)} → 0 次/轮`,
    );
  } finally {
    wrapped.restore();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
