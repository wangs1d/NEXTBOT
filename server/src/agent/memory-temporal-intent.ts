/**
 * 记忆时间意图（2026-10-19 P1）。
 *
 * 问题：检索是纯语义的，「2024 年 6 月我住哪」里的时间词不会变成任何约束，
 * 只能靠 embedding 碰运气，很容易把今年和去年的事混在一起。
 *
 * 本模块做两件事（纯规则、零 LLM、零网络）：
 *   1. `extractTemporalIntent`：把「去年 / 上个月 / 2024年6月 / 2021-2023 /
 *      以前」解析成可比的时间区间；
 *   2. `buildTemporalFactAddressing`：时间问句命中档案字段时，直接走
 *      `getFactsAsOf` 给出"那个时间点有效的值"——这是确定性答案，不靠召回猜。
 *
 * 时间语义刻意保守：解析不出来就返回 null（不做模糊加权），宁可退化成
 * 普通语义检索，也不要用一个猜出来的区间错误地压制记忆。
 */

import type { StructuredFactStore } from "../agentic-memory/structured-fact-store.js";

export type TemporalIntentKind = "year" | "month" | "range" | "recent" | "past_open";

export interface TemporalIntent {
  kind: TemporalIntentKind;
  /** 用户原话里的时间词（诊断/渲染用） */
  label: string;
  /** 区间起点 YYYY-MM-DD；past_open 时为 null */
  from: string | null;
  /** 区间终点 YYYY-MM-DD；past_open 时为 null */
  to: string | null;
}

const DAY = 86_400_000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function yearRange(y: number): { from: string; to: string } {
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function monthRange(y: number, m: number): { from: string; to: string } {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

/** 时间词表：命中即返回（顺序即优先级，越具体越先匹配） */
export function extractTemporalIntent(
  text: string,
  now: Date,
  hints?: { birthYear?: number },
): TemporalIntent | null {
  const t = text?.trim();
  if (!t) return null;
  const y = now.getFullYear();
  const m = now.getMonth() + 1;

  // 人生阶段（P1-7）：需要生日才能推算，没有就不猜——"大学期间"没有出生年
  // 是解不出区间的，宁可不介入也不编一个 18-22 岁。
  const birthYear = hints?.birthYear;
  if (birthYear && birthYear >= 1900 && birthYear <= y - 10) {
    const stage = t.match(/小时候|童年|小学|初中|高中|大学/);
    if (stage) {
      const w = stage[0];
      const span =
        w === "小时候" || w === "童年"
          ? [0, 12]
          : w === "小学"
            ? [6, 12]
            : w === "初中"
              ? [12, 15]
              : w === "高中"
                ? [15, 18]
                : [18, 23];
      return {
        kind: "range",
        label: w,
        from: `${birthYear + span[0]}-01-01`,
        to: `${birthYear + span[1]}-12-31`,
      };
    }
  }

  // 显式年月：2024年6月 / 2024-06
  const ym = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/) ?? t.match(/(\d{4})[-/](\d{1,2})(?![-/\d])/);
  if (ym) {
    const yy = Number(ym[1]);
    const mm = Number(ym[2]);
    if (yy >= 1900 && yy <= 2200 && mm >= 1 && mm <= 12) {
      return { kind: "month", label: ym[0], ...monthRange(yy, mm) };
    }
  }

  // 显式区间：2021-2023
  const span = t.match(/(\d{4})\s*年?\s*[-~～到至]\s*(\d{4})\s*年?/);
  if (span) {
    const a = Number(span[1]);
    const b = Number(span[2]);
    if (a <= b) return { kind: "range", label: span[0], from: `${a}-01-01`, to: `${b}-12-31` };
  }

  // 显式年份：2024年
  const yr = t.match(/(\d{4})\s*年/);
  if (yr) {
    const yy = Number(yr[1]);
    if (yy >= 1900 && yy <= 2200) return { kind: "year", label: yr[0], ...yearRange(yy) };
  }

  // 相对年
  if (/前年/.test(t)) return { kind: "year", label: "前年", ...yearRange(y - 2) };
  if (/去年/.test(t)) return { kind: "year", label: "去年", ...yearRange(y - 1) };
  if (/今年|本年/.test(t)) return { kind: "year", label: "今年", ...yearRange(y) };

  // 相对月
  if (/(上个?月)/.test(t)) {
    const d = new Date(Date.UTC(y, m - 2, 1));
    return {
      kind: "month",
      label: "上个月",
      ...monthRange(d.getUTCFullYear(), d.getUTCMonth() + 1),
    };
  }
  if (/(这个月|本月)/.test(t)) return { kind: "month", label: "这个月", ...monthRange(y, m) };

  // 现在态（P0-2 补）："我现在住哪"是问当前——只有区间覆盖今天的条目才加分，
  // 旧区间（已失效）被自然降权。这是与"过去"对称的另一半。
  if (/(现在|目前|如今|当前)/.test(t)) {
    const day = iso(now);
    return { kind: "recent", label: "现在", from: day, to: day };
  }

  // 近 N 天 / 周
  const recent = t.match(/(前两天|这几天|最近|这两天|前几天|上周|上礼拜|这几天)/);
  if (recent) {
    const days = /上周|上礼拜/.test(recent[0]) ? 14 : 3;
    const from = new Date(now.getTime() - days * DAY);
    return { kind: "recent", label: recent[0], from: iso(from), to: iso(now) };
  }

  // 开放过去：以前/过去/曾经/小时候 —— 没有确定区间，只表达"偏过去"
  if (/(以前|过去|曾经|从前|小时候|当年)/.test(t)) {
    return { kind: "past_open", label: "以前", from: null, to: null };
  }

  return null;
}

/**
 * 时间问句的确定性定位块：用户问「2024 年 6 月我住哪」时，直接查档案
 * 在那个时间点有效的值，给模型一个不用猜的答案。
 *
 * 只在「既有时间词、又命中档案字段」或「既有时间词、问题明显指向档案」时生成；
 * 无结果也明确说"没有记录"，防止模型自己脑补。
 */
export function buildTemporalFactAddressing(
  store: Pick<
    StructuredFactStore,
    "getFactsAsOf" | "matchFieldsInText" | "getActiveFacts" | "getFact"
  >,
  actorId: string,
  text: string,
  now: Date,
): string | undefined {
  // 人生阶段词（"大学期间住哪"）需要生日推算，能取到就传 hints
  let birthYear: number | undefined;
  try {
    const birth = store.getFact(actorId, "生日");
    const y = birth?.value?.match(/(\d{4})/)?.[1];
    if (y) birthYear = Number(y);
  } catch {
    birthYear = undefined;
  }
  const intent = extractTemporalIntent(text, now, { birthYear });
  if (!intent || !intent.from) return undefined;

  const hitFields = store
    .matchFieldsInText(actorId, text)
    .map((f) => f.field)
    .filter(Boolean);
  // 没命中字段名时，用全部字段兜底（"2024 年 6 月我在哪"不会说"居住地"三个字）
  const fields =
    hitFields.length > 0 ? hitFields : store.getActiveFacts(actorId).map((f) => f.field);
  if (fields.length === 0) return undefined;

  // 取区间中点做点位查询（月/年粒度都能落在区间内部）
  const midDay =
    intent.from === intent.to
      ? intent.from!
      : (() => {
          const a = Date.parse(`${intent.from}T00:00:00Z`);
          const b = Date.parse(`${intent.to!}T00:00:00Z`);
          if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return intent.from!;
          return iso(new Date(a + Math.floor((b - a) / 2)));
        })();

  const lines: string[] = [];
  for (const field of fields.slice(0, 6)) {
    const at = store.getFactsAsOf(actorId, midDay, { field });
    if (at.length === 0) continue;
    lines.push(`- ${field}：${at[0]!.value}（${intent.label}有效）`);
  }

  if (lines.length === 0) {
    return [
      "【时间问句定位】",
      `（用户问的时间点是 ${intent.label}；档案里该时间点没有记录）`,
      "回答时如实说明那段时间没有记录，不要用现在的值冒充当时。",
    ].join("\n");
  }

  return [
    "【时间问句定位】",
    `（以下是用户问的「${intent.label}」当时有效的值，来自结构化档案的区间记录；`,
    "回答「那时候」就用这些值，不要拿当前值替代）",
    ...lines,
  ].join("\n");
}

/**
 * 检索侧时间意图加权（软调制，不硬过滤）：
 * - 有确定区间：落在区间内的条目 ×1.2，区间外 ×0.85；
 * - 开放过去：早于今年的 ×1.1。
 * 区间外的条目不丢弃——用户问去年，不代表今年的事一定无关。
 */
export function temporalIntentFactor(
  intent: TemporalIntent | null,
  itemTimestamp: string | undefined,
  now: Date,
): number {
  if (!intent) return 1;
  const ts = itemTimestamp ? Date.parse(itemTimestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return 1;
  const day = iso(new Date(ts));

  if (intent.kind === "past_open") {
    return day < `${now.getFullYear()}-01-01` ? 1.1 : 0.95;
  }
  if (!intent.from || !intent.to) return 1;
  return day >= intent.from && day <= intent.to ? 1.2 : 0.85;
}

/**
 * 带元数据的时间意图加权（2026-10-19 P0-2 修复）。
 *
 * 之前用 `createdAt` 判断"这条记忆说的是哪个时期"——但那是**记录时间**：
 * 一条 2020 年的事 2026 年才被记下，问「2020 年」时它会被误判成区间外而降权。
 *
 * 修复：写入时把事实的结构化区间存进 metadata（factValidFrom/factValidTo），
 * 检索时优先用**区间重叠**判断——条目描述的时期与用户问的时期有交集就加分。
 * 没有区间元数据的旧条目退回 createdAt 兜底（此时无更优解）。
 */
export function temporalIntentFactorForItem(
  intent: TemporalIntent | null,
  item: { metadata?: Record<string, unknown>; createdAt?: string; updatedAt?: string },
  now: Date,
): number {
  if (!intent) return 1;
  const meta = item.metadata ?? {};
  const vfRaw = typeof meta.factValidFrom === "string" ? meta.factValidFrom : "";
  const vtRaw = typeof meta.factValidTo === "string" ? meta.factValidTo : "";
  const hasRange = Boolean(vfRaw || vtRaw);
  if (!hasRange) {
    return temporalIntentFactor(intent, item.createdAt ?? item.updatedAt, now);
  }

  const vf = (vfRaw || "0000-01-01").slice(0, 10);
  const vt = (vtRaw || "9999-12-31").slice(0, 10);

  if (intent.kind === "past_open") {
    // 开放过去：条目描述的时期整体在过去才算"过去的记忆"
    return vt < `${now.getFullYear()}-01-01` ? 1.1 : 0.95;
  }
  if (!intent.from || !intent.to) return 1;
  // 区间重叠：条目时期 [vf, vt] 与询问时期 [from, to] 有交集 → 相关
  const overlaps = vf <= intent.to && vt >= intent.from;
  return overlaps ? 1.2 : 0.85;
}
