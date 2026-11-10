/**
 * 旅游能力自检（供 GET /travel/capabilities）。
 *
 * 目的：把「查价为什么没有价」从隐式降级变成可查询的事实。
 *
 * 此前 flyai CLI 未安装时，查价链路一律落成「待核价」文案，界面与运维
 * 都无法区分「服务没装 / 没配 key / 平台无货」三种完全不同的原因——用户
 * 只能看到满屏待核价，运维只能猜。本模块只做进程级探测（二进制存在性 +
 * 版本 + 配置存在性），不发起任何真实查询，因此可以安全地在页面打开时调用。
 *
 * 时间口径：不使用 Date.now()/new Date()（服务端时间必须可注入，见
 * AGENT 约束），缓存年龄一律用 monotonic 的 process.hrtime 计算。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDataDir } from "../../config/data-dir.js";
import { resolveFlyAiBin } from "../../services/booking/quote/flyai-quote-source.js";

/** 查价降级原因的机器可读枚举（前端据此选文案，不做字符串猜测）。 */
export type PricingDegradeReason = "missing-cli" | "no-key" | "pricing-unknown";

export interface TravelCapabilities {
  ok: true;
  flyai: {
    /** 二进制是否可达（PATH / FLYAI_BIN / npm 全局目录） */
    installed: boolean;
    bin: string | null;
    version: string | null;
    /** 是否配置了 FLYAI_API_KEY（缺失时 CLI 仍可用，但价格可能脱敏） */
    keyConfigured: boolean;
  };
  pricing: {
    /** 价格库模式（PRICING_MODE，默认 real-database） */
    mode: string;
    /** true = 实时查价不可用，界面必须明示而不是静默写「待核价」 */
    degraded: boolean;
    reason: PricingDegradeReason | null;
  };
  poi: {
    db: boolean;
    path: string;
  };
  map: {
    tileCacheDir: string;
    tileCacheWarm: boolean;
    styleUrl: string;
  };
  /** 本次结果在缓存里存在了多久（ms）；0 = 刚探测 */
  cacheAgeMs: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const VERSION_TIMEOUT_MS = 2000;

let cache: { at: bigint; value: Omit<TravelCapabilities, "cacheAgeMs"> } | null = null;

function hrtimeToMs(at: bigint): number {
  return Number(at / 1_000_000n);
}

/** 读 flyai 自己的配置文件，判断是否设过 key（不读环境变量以外的密钥内容）。 */
function keyConfiguredFromDisk(): boolean {
  const candidates = [
    path.join(os.homedir(), ".flyai", "config.json"),
    path.join(os.homedir(), ".config", "flyai", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf8");
      if (/"FLYAI_API_KEY"\s*:\s*"[^"]+"/.test(raw)) return true;
    } catch {
      // 配置不可读按未配置处理：宁可多报一次「未配 key」，也不假装有实价能力
    }
  }
  return false;
}

function probeFlyAi(): TravelCapabilities["flyai"] {
  const bin = resolveFlyAiBin((process.env.FLYAI_BIN ?? "").trim() || "flyai");
  if (!bin) {
    return { installed: false, bin: null, version: null, keyConfigured: false };
  }
  let version: string | null = null;
  try {
    const out = execFileSync(bin, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
    });
    version = out.trim().split(/\r?\n/)[0]?.slice(0, 40) || null;
  } catch {
    // 装上了但 --version 失败（权限/包装脚本异常）：仍算 installed，
    // 版本未知不影响可用性判断，真实查询会自己暴露问题。
  }
  const keyConfigured =
    !!(process.env.FLYAI_API_KEY ?? "").trim() || keyConfiguredFromDisk();
  return { installed: true, bin, version, keyConfigured };
}

function probePoi(): TravelCapabilities["poi"] {
  const dbPath = path.join(getDataDir(), "travel-poi.db");
  return { db: existsSync(dbPath), path: dbPath };
}

function probeMap(): TravelCapabilities["map"] {
  const dir = process.env.TRAVEL_TILE_CACHE_DIR?.trim()
    || path.join(getDataDir(), "tile-cache");
  return {
    tileCacheDir: dir,
    tileCacheWarm: existsSync(dir),
    styleUrl: "/travel-basemap/style/dark",
  };
}

/**
 * 探测一次（带 5 分钟缓存）。
 *
 * 缓存的意义：进入「行程规划」页会调一次，底部面板切换可能再调；
 * spawn `flyai --version` 在冷启动机器上约 200-400ms，不缓存会拖慢首屏。
 */
export function probeTravelCapabilities(): TravelCapabilities {
  const nowMono = process.hrtime.bigint();
  if (cache && hrtimeToMs(nowMono - cache.at) < CACHE_TTL_MS) {
    return { ...cache.value, cacheAgeMs: hrtimeToMs(nowMono - cache.at) };
  }

  const flyai = probeFlyAi();
  const mode = (process.env.PRICING_MODE ?? "").trim() || "real-database";
  const reason: PricingDegradeReason | null = !flyai.installed
    ? "missing-cli"
    : flyai.keyConfigured
      ? null
      : "no-key";

  const value: Omit<TravelCapabilities, "cacheAgeMs"> = {
    ok: true,
    flyai,
    pricing: {
      mode,
      // 只有「二进制不可达」才算硬降级（查询必然失败）；
      // 未配 key 是能力受限（价格可能脱敏），由前端展示为「仅参考价」而非「不可用」。
      degraded: !flyai.installed,
      reason,
    },
    poi: probePoi(),
    map: probeMap(),
  };

  cache = { at: nowMono, value };
  return { ...value, cacheAgeMs: 0 };
}

/** 测试用：清空缓存。 */
export function resetTravelCapabilitiesCache(): void {
  cache = null;
}
