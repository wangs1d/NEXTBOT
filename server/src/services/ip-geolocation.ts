/**
 * IP 定位（服务端直接拉取，无 LLM、无用户配置）。
 *
 * 用途：用户没有配置天气城市时，晨报/简报的天气兜底——按服务器出口 IP
 * 定位城市（桌面应用场景服务器即用户本机，定位结果即用户所在城市）。
 *
 * 设计：
 *  - 多源依次兜底（ip-api 中文 → ipapi.co → freeipapi），单源 4s 超时；
 *  - 成功结果缓存 24h、失败负缓存 1h（data/ip-location-cache.json），
 *    避免每次生成简报都打公网；
 *  - 任何失败返回 null（调用方省略天气块，不阻塞简报）。
 */

import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface IpLocation {
  latitude: number;
  longitude: number;
  /** 展示用城市名（如「杭州市」） */
  label: string;
  /** IANA 时区（如 Asia/Shanghai） */
  timezone: string;
}

interface CacheShape {
  location?: IpLocation | null;
  fetchedAt?: string;
  failedAt?: string;
}

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_000;

function cachePath(): string {
  return (
    process.env.IP_LOCATION_CACHE_FILE ??
    join(getDataDir(), "ip-location-cache.json")
  );
}

type RawEndpoint = {
  url: string;
  parse: (data: Record<string, unknown>) => IpLocation | null;
};

/** 定位源依次兜底；ip-api 免费源仅 http，服务端直连无碍，中文城市名体验最好 */
const ENDPOINTS: RawEndpoint[] = [
  {
    url: "http://ip-api.com/json/?lang=zh-CN",
    parse: (d) =>
      d.status === "success" &&
      typeof d.lat === "number" &&
      typeof d.lon === "number"
        ? {
            latitude: d.lat,
            longitude: d.lon,
            label: `${d.city ?? ""}${d.country === "中国" ? "" : `，${d.country ?? ""}`}`.replace(/，$/, ""),
            timezone: typeof d.timezone === "string" ? d.timezone : "Asia/Shanghai",
          }
        : null,
  },
  {
    url: "https://ipapi.co/json/",
    parse: (d) =>
      typeof d.latitude === "number" && typeof d.longitude === "number"
        ? {
            latitude: d.latitude,
            longitude: d.longitude,
            label: typeof d.city === "string" ? d.city : "",
            timezone: typeof d.timezone === "string" ? d.timezone : "Asia/Shanghai",
          }
        : null,
  },
  {
    url: "https://freeipapi.com/api/json",
    parse: (d) =>
      typeof d.latitude === "number" && typeof d.longitude === "number"
        ? {
            latitude: d.latitude,
            longitude: d.longitude,
            label: typeof d.cityName === "string" ? d.cityName : "",
            timezone:
              typeof d.timeZone === "string" && d.timeZone
                ? d.timeZone
                : "Asia/Shanghai",
          }
        : null,
  },
];

let inflight: Promise<IpLocation | null> | null = null;

/**
 * 取出口 IP 定位（带缓存）。失败/超时 → null。
 */
export async function fetchIPLocation(): Promise<IpLocation | null> {
  if (inflight) return inflight;
  inflight = fetchIPLocationUncached().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchIPLocationUncached(): Promise<IpLocation | null> {
  const cached = await readCache();
  if (cached) {
    if (cached.location && cached.fetchedAt) {
      if (Date.now() - Date.parse(cached.fetchedAt) < SUCCESS_TTL_MS) {
        return cached.location;
      }
    } else if (cached.failedAt) {
      if (Date.now() - Date.parse(cached.failedAt) < FAILURE_TTL_MS) return null;
    }
  }

  const location = await probeEndpoints();
  await writeCache(location);
  return location;
}

async function probeEndpoints(): Promise<IpLocation | null> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint.url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      const parsed = endpoint.parse(data);
      if (parsed && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
        return parsed;
      }
    } catch {
      // 单源失败 → 试下一源
    }
  }
  return null;
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    return JSON.parse(raw) as CacheShape;
  } catch {
    return null;
  }
}

async function writeCache(location: IpLocation | null): Promise<void> {
  try {
    const path = cachePath();
    const data: CacheShape = location
      ? { location, fetchedAt: new Date().toISOString() }
      : { failedAt: new Date().toISOString() };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // 缓存写失败不影响本次结果
  }
}
