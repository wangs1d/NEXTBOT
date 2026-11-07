import type { ToolRegistry } from "./tool-registry.js";
import * as iconv from "iconv-lite";

/**
 * market.quote —— 股票/指数实时报价（2026-11-06 新增）。
 *
 * 为什么需要专用行情工具：行情类事实走 search_web 拿到的是新闻快照，
 * 无发布日期、新旧混杂（2026-11-06 事故：11·5 大跌被搜成「大涨」，模型把
 * 旧文里的反弹数据当最新收盘）。报价这种「一个数字就是一个事实」的查询，
 * 正路是行情接口直出，搜索只负责「为什么涨跌」。
 *
 * 数据源：腾讯行情 qt.gtimg.cn（免 key、免鉴权，GBK 编码）。
 * 回执纪律：每条报价自带 quoteTime（交易所最近成交时刻），模型必须把
 * 「数据是哪天的」说清楚——这是对 search_web 时代「静默拿旧数据当今天」
 * 的结构性纠正。
 */

/** 常用别名 → 交易所代码。覆盖口语高频标的；长尾直接传代码。 */
const SYMBOL_ALIASES: Record<string, string> = {
  上证指数: "sh000001",
  上证: "sh000001",
  大盘: "sh000001",
  沪指: "sh000001",
  深证成指: "sz399001",
  深成指: "sz399001",
  创业板指: "sz399006",
  创业板: "sz399006",
  沪深300: "sh000300",
  科创50: "sh000688",
  恒生指数: "hkHSI",
  恒指: "hkHSI",
  道琼斯: "usDJI",
  道指: "usDJI",
  纳斯达克: "usIXIC",
  纳指: "usIXIC",
  标普500: "usINX",
  标普: "usINX",
  罗素2000: "usRUT",
  特斯拉: "usTSLA",
  苹果: "usAAPL",
  英伟达: "usNVDA",
  微软: "usMSFT",
  亚马逊: "usAMZN",
  谷歌: "usGOOG",
  Meta: "usMETA",
};

/** 直接代码形态：两位市场前缀 + 4-6 位数字 / 或市场前缀 + 字母代码（usDJI/hkHSI）。 */
const RAW_CODE_RE = /^[a-z]{2}[A-Za-z0-9]{2,6}$/i;

const MARKET_LABELS: Record<string, string> = {
  sh: "A股",
  sz: "A股",
  hk: "港股",
  us: "美股",
};

function resolveSymbol(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const alias = SYMBOL_ALIASES[s] ?? SYMBOL_ALIASES[s.toLowerCase()] ?? SYMBOL_ALIASES[s.toUpperCase()];
  if (alias) return alias;
  if (RAW_CODE_RE.test(s)) return s;
  return null;
}

/** 解析行情时间戳：A 股 `20261106150003` / 美股港股 `2026-11-05 17:15:59` 或 `2026/11/6 15:00:03`（均为北京时间）。 */
function parseQuoteTime(raw: string | undefined): string | undefined {
  const s = raw?.trim() ?? "";
  if (!s) return undefined;
  const pad = (v: string): string => v.padStart(2, "0");
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  }
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${(m[6] ?? "00").padStart(2, "0")}+08:00`;
  }
  return undefined;
}

type TencentQuoteLine = {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  quoteTime?: string;
};

/** 解析一行 `v_sh000001="1~上证指数~000001~3245.60~..."`。
 *  字段口径（0 起）：1=名称 3=最新价 4=昨收 30=时间 31=涨跌 32=涨跌幅。
 *  涨跌/涨跌幅自算（最新价 vs 昨收），不依赖 31/32——各市场字段布局有差异，
 *  但 3/4 两位全市场稳定，方向性数据必须用最稳的口径。 */
function parseQuoteLine(code: string, fields: string[]): TencentQuoteLine | null {
  const name = fields[1]?.trim() ?? "";
  const price = Number(fields[3]);
  const prevClose = Number(fields[4]);
  if (!name || !Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose) || prevClose <= 0) {
    return null;
  }
  const change = price - prevClose;
  const changePct = (change / prevClose) * 100;
  return {
    code,
    name,
    price,
    prevClose,
    change,
    changePct,
    quoteTime: parseQuoteTime(fields[30]),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function registerMarketQuoteTools(registry: ToolRegistry): void {
  registry.register("market.quote", async (input) => {
    const rawList = Array.isArray(input.symbols)
      ? input.symbols.map((s) => String(s))
      : String(input.symbols ?? "")
          .split(/[,，\s]+/)
          .filter(Boolean);
    const seen = new Set<string>();
    const codes: Array<{ code: string; source: string }> = [];
    const unresolved: string[] = [];
    for (const raw of rawList) {
      if (codes.length >= 8) break;
      const code = resolveSymbol(raw);
      if (!code) {
        unresolved.push(raw);
        continue;
      }
      const key = code.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      codes.push({ code, source: raw });
    }

    if (codes.length === 0) {
      return {
        ok: false,
        error:
          "没有可识别的标的代码。支持常见别名（上证指数/纳指/道指/特斯拉等）或交易所代码（sh000001/usIXIC/hk00700），请核对后重试。",
        unresolved,
      };
    }

    const url = `https://qt.gtimg.cn/q=${codes.map((c) => c.code).join(",")}`;
    let text: string;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Nextbot market.quote)" },
      });
      if (!res.ok) {
        return { ok: false, error: `行情接口 HTTP ${res.status}` };
      }
      // 腾讯行情是 GBK 编码，必须显式解码，否则中文名全是乱码
      text = iconv.decode(Buffer.from(await res.arrayBuffer()), "gbk");
    } catch (err) {
      return { ok: false, error: `行情接口请求失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const quotes: Array<Record<string, unknown>> = [];
    const missing: string[] = [];
    for (const { code, source } of codes) {
      const m = new RegExp(`v_${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`).exec(text);
      const fields = m?.[1]?.split("~") ?? [];
      const parsed = parseQuoteLine(code, fields);
      if (!parsed) {
        missing.push(source);
        continue;
      }
      const prefix = code.slice(0, 2).toLowerCase();
      quotes.push({
        query: source,
        symbol: code,
        name: parsed.name,
        market: MARKET_LABELS[prefix] ?? "未知",
        price: round2(parsed.price),
        prevClose: round2(parsed.prevClose),
        change: round2(parsed.change),
        changePct: `${parsed.changePct >= 0 ? "+" : ""}${round2(parsed.changePct)}%`,
        quoteTime: parsed.quoteTime,
      });
    }

    if (quotes.length === 0) {
      return {
        ok: false,
        error: "行情接口没有返回任何有效报价（标的代码可能不存在）。",
        missing,
      };
    }

    return {
      ok: true,
      quotes,
      ...(missing.length > 0 ? { missing } : {}),
      note: "price 是交易所最近成交快照。quoteTime 是该报价的时间：不是今天就是最近收盘，回复中必须说明数据是哪天的；报价只回答「多少」，涨跌原因仍需 search_web。",
    };
  });
}
