/**
 * 飞猪 FlyAI 报价源：把飞猪官方 flyai CLI（search-hotel / search-flight）适配成 QuoteSource。
 *
 * flyai 是飞猪 AI 开放平台的官方 CLI/skill（flyai.open.fliggy.com，npm: @fly-ai/flyai-cli），
 * 底层连飞猪 MCP API，覆盖酒店/机票等全品类实时查询，结果自带预订链接：
 *   - 酒店 itemList[].detailUrl（酒店详情/预订页）
 *   - 机票 itemList[].jumpUrl（订票跳转链接）
 * 无需 API Key 即可使用；安装：npm install -g @fly-ai/flyai-cli（或 FLYAI_BIN 指定路径）。
 *
 * 结构：FlyAiRunner 是最小执行依赖面（mock 测试注入桩，见 test/travel-booking-golden-path.test.ts）；
 * 两个工厂函数把 CLI 参数与返回 JSON（data.itemList）解析成 TravelQuote。
 *
 * 诚实边界：CLI 结果标 priceSource=api（真实平台接口），note 说明「以飞猪下单页实价为准」；
 * 预订链接放 quote.bookingUrl（随选项 extra 透出，可直接作 travel_booking.book 的 cashierUrl）；
 * CLI 未安装/调用失败/解析失败返回 ok:false 或空 quotes，绝不编造。
 */

import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  QuoteRequest,
  QuoteSource,
  QuoteSourceResult,
  QuoteType,
  TravelQuote,
} from "./quote-source.js";

/** flyai CLI 最小执行依赖面（便于测试注入桩）。 */
export interface FlyAiRunResult {
  ok: boolean;
  /** CLI stdout（单行 JSON） */
  stdout: string;
  stderr: string;
}

export type FlyAiRunner = (args: string[], timeoutMs?: number) => Promise<FlyAiRunResult>;

const SOURCE_LABEL = "飞猪 FlyAI（实时API）";
const DEFAULT_TIMEOUT_MS = 18_000;

interface ExecOnceResult {
  /** true = 可执行文件不存在（未安装） */
  missing: boolean;
  stdout: string;
  stderr: string;
}

function execOnce(cmd: string, args: string[], timeoutMs: number): Promise<ExecOnceResult> {
  // Windows 上 npm 全局 shim 是 .cmd 批处理：Node ≥20.12 出于 CVE-2024-27980 禁止
  // 直接 spawn 批处理（EINVAL），必须经 cmd.exe 执行并按 cmd 规则手工加引号。
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const q = (a: string) => (/^[\w.\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    const cmdline = [cmd, ...args].map(q).join(" ");
    return new Promise((resolve) => {
      exec(cmdline, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const stderrText = String(stderr ?? "");
        if (err && ((err as NodeJS.ErrnoException).code === "ENOENT" || /不是内部或外部命令|is not recognized/.test(stderrText))) {
          resolve({ missing: true, stdout: "", stderr: "" });
          return;
        }
        resolve({ missing: false, stdout: String(stdout ?? ""), stderr: stderrText || err?.message || "" });
      });
    });
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ missing: true, stdout: "", stderr: "" });
          return;
        }
        // 非零退出码也交回 stdout（flyai 结果走 stdout、错误走 stderr；Windows 上 CLI
        // 退出时偶发 libuv 断言崩溃 exit=127，但 stdout 已完整输出），由调用方判定
        resolve({ missing: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
      },
    );
  });
}

/**
 * 在 PATH 目录里定位 flyai 可执行文件（存在性判定，不依赖本地化报错文本——
 * Windows cmd.exe 的「不是内部或外部命令」是 GBK 编码，按 UTF-8 解码成乱码后
 * 文本匹配永远失败）。返回绝对路径；找不到返回 null。
 */
function resolveFlyAiBin(bin: string): string | null {
  if (bin.includes("\\") || bin.includes("/")) {
    return existsSync(bin) ? bin : null;
  }
  const exts =
    process.platform === "win32"
      ? /\.(cmd|bat|exe)$/i.test(bin)
        ? [""]
        : [".cmd", ".exe", ""]
      : [""];
  const dirs = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const findIn = (list: string[]): string | null => {
    for (const dir of list) {
      if (!dir) continue;
      for (const ext of exts) {
        const full = join(dir, bin + ext);
        if (existsSync(full)) return full;
      }
    }
    return null;
  };
  const onPath = findIn(dirs);
  if (onPath) return onPath;

  // 桌面应用从资源管理器启动时 PATH 往往不含 npm 全局目录（本机实测
  // D:\cache\npm-global 不在 PATH），只靠 PATH 会把已安装的 flyai 判成未安装。
  // 依次补：NPM_CONFIG_PREFIX → ~/.npmrc 的 prefix → 各平台默认全局目录。
  const prefixDirs: string[] = [];
  const envPrefix = process.env.NPM_CONFIG_PREFIX?.trim();
  if (envPrefix) prefixDirs.push(envPrefix);
  try {
    const npmrc = readFileSync(join(homedir(), ".npmrc"), "utf-8");
    for (const line of npmrc.split(/\r?\n/)) {
      const m = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
      if (m?.[1]) prefixDirs.push(m[1].replace(/^["']|["']$/g, ""));
    }
  } catch {
    /* 没有 .npmrc 就走默认目录 */
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) prefixDirs.push(join(appData, "npm"));
  } else {
    prefixDirs.push("/usr/local/bin", "/usr/local/lib/node_modules/.bin");
  }
  return findIn(prefixDirs);
}

/** 默认 runner：调 PATH 里的 flyai（Windows 下 npm 全局 shim 是 flyai.cmd）。 */
export function createDefaultFlyAiRunner(): FlyAiRunner {
  return async (args, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const bin = process.env.FLYAI_BIN?.trim() || "flyai";
    const cmd = resolveFlyAiBin(bin);
    if (!cmd) {
      return {
        ok: false,
        stdout: "",
        stderr: "flyai CLI 未安装（npm install -g @fly-ai/flyai-cli，或用 FLYAI_BIN 指定可执行文件路径）",
      };
    }
    const r = await execOnce(cmd, args, timeoutMs);
    if (r.missing) {
      return {
        ok: false,
        stdout: "",
        stderr: "flyai CLI 未安装（npm install -g @fly-ai/flyai-cli，或用 FLYAI_BIN 指定可执行文件路径）",
      };
    }
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  };
}

// ── 返回 JSON 解析（flyai 顶层信封：{ data: { itemList }, message, systemMessage, status }） ──

interface FlyAiEnvelope {
  status?: number;
  message?: string;
  systemMessage?: string;
  data?: { itemList?: unknown } | null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function strOf(rec: Record<string, unknown> | null, key: string): string {
  return rec && typeof rec[key] === "string" ? (rec[key] as string).trim() : "";
}

function parseEnvelope(stdout: string): { envelope: FlyAiEnvelope | null; error?: string } {
  const text = stdout.trim();
  if (!text) return { envelope: null, error: "flyai 无输出" };
  try {
    return { envelope: JSON.parse(text) as FlyAiEnvelope };
  } catch {
    return { envelope: null, error: "flyai 输出不是合法 JSON" };
  }
}

function itemList(envelope: FlyAiEnvelope): Array<Record<string, unknown>> {
  const list = envelope.data?.itemList;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/** "¥618" / "¥400.0" / 618 / "618" → number；体验模式脱敏价（"¥2x"/"¥2xx"）与非数一律 NaN。 */
export function parsePriceCny(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string") {
    // 必须是完整数字：脱敏价「¥2x」若宽松匹配会谎报成 ¥2，这里直接拒绝
    const m = v.replace(/,/g, "").trim().match(/^¥?\s*(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
  }
  return NaN;
}

function nightsBetween(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn.replace(" ", "T"));
  const b = Date.parse(checkOut.replace(" ", "T"));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/** 公共失败分支：runner 失败 / 非 JSON / status 非 0，一律 ok:false 如实带原因。 */
export async function callFlyAi(
  runner: FlyAiRunner,
  args: string[],
): Promise<{ items: Array<Record<string, unknown>>; systemMessage: string } | { error: string }> {
  const run = await runner(args);
  if (!run.ok) return { error: run.stderr.trim() || "flyai 调用失败" };
  const parsed = parseEnvelope(run.stdout);
  if (!parsed.envelope) return { error: parsed.error ?? "flyai 输出解析失败" };
  const envelope = parsed.envelope;
  if (typeof envelope.status === "number" && envelope.status !== 0) {
    return { error: envelope.message || envelope.systemMessage || `flyai status=${envelope.status}` };
  }
  return { items: itemList(envelope), systemMessage: envelope.systemMessage ?? "" };
}

/** 体验模式（未配 FLYAI_API_KEY）：价格被脱敏（「¥2x」），必须如实说明而非当作实价。 */
function isTrialMode(systemMessage: string): boolean {
  return systemMessage.includes("体验模式");
}

// ── 酒店：flyai search-hotel ──

export function createFlyAiHotelSource(runner: FlyAiRunner): QuoteSource {
  const id = "flyai.hotel";
  return {
    id,
    label: SOURCE_LABEL,
    supports: (t: QuoteType) => t === "hotel",
    async fetch(req: QuoteRequest): Promise<QuoteSourceResult> {
      const city = (req.city || req.to || "").trim();
      if (!city) return { ok: true, quotes: [], note: `${SOURCE_LABEL} 不处理该查询（缺 city）` };
      const args = ["search-hotel", "--dest-name", city, "--sort", "price_asc"];
      if (req.checkInDate) args.push("--check-in-date", req.checkInDate.slice(0, 10));
      if (req.checkOutDate) args.push("--check-out-date", req.checkOutDate.slice(0, 10));
      if (req.hotelName) args.push("--key-words", req.hotelName);

      const res = await callFlyAi(runner, args);
      if ("error" in res) return { ok: false, error: `${SOURCE_LABEL}：${res.error}` };

      const now = Date.now();
      const nights = nightsBetween(req.checkInDate, req.checkOutDate);
      const trial = isTrialMode(res.systemMessage);
      const note = trial ? "飞猪体验模式报价（部分结果受限，以飞猪下单页实价为准）" : "飞猪实时报价，以飞猪下单页实价为准";
      const quotes: TravelQuote[] = [];
      for (const item of res.items) {
        const name = strOf(item, "name");
        const price = parsePriceCny(item.price ?? item.adultPrice);
        if (!name || !Number.isFinite(price) || price <= 0) continue;
        const rating = parsePriceCny(item.rate ?? item.score);
        quotes.push({
          source: id,
          sourceLabel: SOURCE_LABEL,
          type: "hotel",
          name,
          to: city,
          checkInDate: req.checkInDate,
          seat: strOf(item, "star") || undefined,
          amountCny: Math.round(price),
          nights,
          currency: "CNY",
          priceSource: "api",
          bookingUrl: strOf(item, "detailUrl") || undefined,
          mainPicUrl: strOf(item, "mainPic") || undefined,
          rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
          note,
          fetchedAt: now,
        });
      }
      if (quotes.length === 0 && trial) {
        return { ok: false, error: `${SOURCE_LABEL} 体验模式价格已脱敏，未取到可报价项（配置 FLYAI_API_KEY 解锁实价）` };
      }
      return { ok: true, quotes, note: quotes.length > 0 ? undefined : `${SOURCE_LABEL} 本次未取到报价` };
    },
  };
}

// ── 机票：flyai search-flight ──

export function createFlyAiFlightSource(runner: FlyAiRunner): QuoteSource {
  const id = "flyai.flight";
  return {
    id,
    label: SOURCE_LABEL,
    supports: (t: QuoteType) => t === "flight",
    async fetch(req: QuoteRequest): Promise<QuoteSourceResult> {
      const from = (req.from || "").trim();
      const to = (req.to || "").trim();
      if (!from || !to) return { ok: true, quotes: [], note: `${SOURCE_LABEL} 不处理该查询（缺 from/to）` };
      const args = ["search-flight", "--origin", from, "--destination", to, "--sort-type", "3"];
      const dep = (req.departTime ?? "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dep)) args.push("--dep-date", dep);
      if (req.code) args.push("--transport-no", req.code);
      if (req.seat) args.push("--seat-class-name", req.seat);

      const res = await callFlyAi(runner, args);
      if ("error" in res) return { ok: false, error: `${SOURCE_LABEL}：${res.error}` };

      const now = Date.now();
      const trial = isTrialMode(res.systemMessage);
      const note = trial ? "飞猪体验模式报价（部分结果受限，以飞猪下单页实价为准）" : "飞猪实时报价，以飞猪下单页实价为准";
      const quotes: TravelQuote[] = [];
      for (const item of res.items) {
        // 文档写 adultPrice，实机（1.0.6 实测）返回 ticketPrice——两个字段都试
        const price = parsePriceCny(item.adultPrice ?? item.ticketPrice ?? item.price);
        const journey = Array.isArray(item.journeys) && isRecord(item.journeys[0]) ? (item.journeys[0] as Record<string, unknown>) : null;
        const segments = journey && Array.isArray(journey.segments) ? journey.segments : [];
        const seg = isRecord(segments[0]) ? (segments[0] as Record<string, unknown>) : null;
        const code = strOf(seg, "marketingTransportNo");
        if (!code || !Number.isFinite(price) || price <= 0) continue;
        quotes.push({
          source: id,
          sourceLabel: SOURCE_LABEL,
          type: "flight",
          code,
          from: strOf(seg, "depCityName") || from,
          to: strOf(seg, "arrCityName") || to,
          departTime: strOf(seg, "depDateTime") || undefined,
          arriveTime: strOf(seg, "arrDateTime") || undefined,
          seat: strOf(seg, "seatClassName") || req.seat,
          amountCny: Math.round(price),
          currency: "CNY",
          priceSource: "api",
          bookingUrl: strOf(item, "jumpUrl") || undefined,
          note,
          fetchedAt: now,
        });
      }
      if (quotes.length === 0 && trial) {
        return { ok: false, error: `${SOURCE_LABEL} 体验模式价格已脱敏，未取到可报价项（配置 FLYAI_API_KEY 解锁实价）` };
      }
      return { ok: true, quotes, note: quotes.length > 0 ? undefined : `${SOURCE_LABEL} 本次未取到报价` };
    },
  };
}
