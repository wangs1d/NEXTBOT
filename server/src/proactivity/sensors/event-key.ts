// 事件键派生（2026-11-25 跨源汇聚）——把"同一件现实世界的事"在入库时认出来。
//
// 只认**可核验的锚点**：航班号 / 车次 / 订单号 / 邮件主题线程。不做语义猜测——
// 宁可少合并（两条），也不要把无关的两件事合成一条（那是信息丢失）。
//
// 典型收益：机票确认邮件（mail 流）与日历行程（schedule 流）如果都带 CA1234，
// 进 SourceStore 后是同一条事件（refs=[mail, calendar]），判断与开口只面对一件事。

/** 航司二字码黑名单：这些前缀后面跟数字通常是编号而不是航班 */
const NON_AIRLINE_PREFIX = new Set(["ID", "NO", "HT", "IP", "TV", "PC", "OK"]);

/** 航班号：CA1234 / MU 5678（必须是大写字母前缀 + 3-4 位数字；调用方先转大写） */
const FLIGHT_RE = /\b([A-Z]{2})\s?(\d{3,4})\b/g;
/** 车次：G1234 / D2345 / C3 / Z12 —— 至少 3 位数字，避开高速公路编号 G2/G4 */
const TRAIN_RE = /\b([GDCZTK])\s?(\d{3,4})\b/g;
/** 订单号：订单号/订单编号/order 后面的 8 位以上字母数字 */
const ORDER_RE = /(?:订单号|订单编号|order\s*(?:no|number|id)?)\s*[:：#]?\s*([A-Za-z0-9]{8,})/i;

/**
 * 从文本里取事件日期（YYYY-MM-DD）。航班/车次号每天重复，**不带日期就会把
 * 「明天的 CA1234」和「下周的 CA1234」认成同一件事**，所以日期是事件键的一部分。
 *
 * 取不到文本日期时退回 fallbackMs 的日期（邮件=收件日，日历=事件开始日）；
 * 两处都取不到返回 null（该信号不参与跨源合并）。
 */
export function dateKeyOf(text: string, fallbackMs?: number): string | null {
  const s = String(text ?? "");
  const pad = (n: number) => String(n).padStart(2, "0");
  const withYear = /(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/.exec(s);
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  let y: number | undefined;
  let m = 0;
  let d = 0;
  if (withYear) {
    y = Number(withYear[1]);
    m = Number(withYear[2]);
    d = Number(withYear[3]);
  } else if (cn) {
    m = Number(cn[1]);
    d = Number(cn[2]);
  }
  if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
    if (y === undefined) {
      const base = fallbackMs ? new Date(fallbackMs) : new Date();
      y = base.getFullYear();
      const candidate = new Date(y, m - 1, d).getTime();
      // 无年份的「1月5日」在 12 月读到，指的是明年
      if (candidate - base.getTime() < -180 * 86_400_000) y += 1;
    }
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  if (fallbackMs) {
    const f = new Date(fallbackMs);
    return `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}`;
  }
  return null;
}

/**
 * 从一段文本里派生可跨源共用的事件键（带事件日期）。
 * 返回 null = 这段文本没有可核验的锚点（调用方退回各流自己的键）。
 */
export function transportEventKey(text: string, fallbackMs?: number): string | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const upper = raw.toUpperCase();
  const day = dateKeyOf(raw, fallbackMs);
  if (!day) return null;
  for (const m of upper.matchAll(FLIGHT_RE)) {
    const prefix = m[1]!;
    if (NON_AIRLINE_PREFIX.has(prefix)) continue;
    return `flight:${prefix}${m[2]}:${day}`;
  }
  for (const m of upper.matchAll(TRAIN_RE)) {
    return `train:${m[1]}${m[2]}:${day}`;
  }
  return null;
}

/** 订单/账单锚点（邮件"订单号 12345678"与账单流水可能指向同一笔） */
export function orderEventKey(text: string): string | null {
  const m = ORDER_RE.exec(String(text ?? ""));
  return m ? `order:${m[1]!.toLowerCase()}` : null;
}

/**
 * 邮件线程键：同一主题的来回（Re/Fwd/【】前缀、空白差异）算同一件事。
 * 带日期桶——同一个主题隔几周再出现（续签/新一期）不该并成一件。
 * 只用于 mail 流内部合并；跨源仍靠 transportEventKey。
 */
export function mailThreadKey(actorId: string, subject: string, atMs?: number): string {
  const normalized = String(subject ?? "")
    .replace(/^\s*(?:(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+/gi, "")
    .replace(/[【】\[\]（）()\s]/g, "")
    .slice(0, 60)
    .toLowerCase();
  const day = dateKeyOf("", atMs ?? Date.now()) ?? "undated";
  return `mail-thread:${actorId}:${normalized || "no-subject"}:${day}`;
}

/** 邮件的事件键：优先真实锚点（航班/车次/订单），否则线程 */
export function mailEventKey(
  actorId: string,
  subject: string,
  body?: string,
  receivedAtMs?: number,
): string {
  const text = `${subject} ${body ?? ""}`;
  return (
    transportEventKey(text, receivedAtMs) ??
    orderEventKey(text) ??
    mailThreadKey(actorId, subject, receivedAtMs)
  );
}
