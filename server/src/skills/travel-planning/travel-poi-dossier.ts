/**
 * POI 核实闸（travel 主线 F3：逐点核实开放时间 / 闭馆日 / 预约规则 / 排程密度）
 *
 * 为什么需要它：规划引擎把 POI 排进日历时只看时长与坐标，从不看「那天这个点开不开门、
 * 要不要提前预约」。真实旅行里最常见的翻车正是这两类——周一闭馆撞上博物馆日、
 * 布达拉宫/莫高窟这类必须提前预约的场次到了门口进不去。本模块把核实做成
 * **规划后的确定性一遍**，产出可展示的冲突与建议，落盘进冷层供桌面端与回复共同消费。
 *
 * 数据诚实原则（与全仓一致）：
 *   - 开放时间只吃 POI 自带的 openingHours 文本（高德/评论/知识库），解析不出
 *     就标 unknown 并提示「以官方为准」，绝不编造时段；
 *   - 预约规则用内置知识表（少量确有把握的知名场馆）+ 类目规则（博物馆类
 *     周一闭馆是行业惯例），每条都带 source 与 verifiedAt，话术必须写「出发前自查官方」；
 *   - 核实是**建议闸**不是硬拦截：冲突会显著提示，但不删点、不改时（改由用户或编辑路径决定）。
 *
 * 纯函数模块：不触网、不读存储。
 */
import { weekdayOfISO } from "./travel-date.js";

// ======================== 开放时间解析 ========================

export interface OpenRange {
  /** 生效星期（0=周日…6=周六）；空数组 = 每天 */
  days: number[];
  /** 开门/闭馆（当日分钟数） */
  openMin: number;
  closeMin: number;
}

export interface HoursParse {
  raw: string;
  /** 是否解析出可用时段 */
  parsed: boolean;
  /** 全天开放 / 24 小时 */
  allDay: boolean;
  ranges: OpenRange[];
  /** 明确闭馆/休息的星期 */
  closedDays: number[];
  /** 停止入场时刻（早于闭馆的那道闸） */
  lastEntryMin: number | null;
}

const WEEK_INDEX: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[：:：]/g, ":")
    .replace(/[–—~]/g, "-")
    .replace(/至|到/g, "-");
}

function minutesOf(hour: string, minute: string): number {
  return Math.min(24 * 60 - 1, Math.max(0, Number(hour) * 60 + Number(minute)));
}

/**
 * 解析营业时间文本（`周二至周日 09:00-17:00 周一闭馆` / `08:30-17:00(16:30停止入场)` /
 * `全天开放` / `09:00-12:00,14:00-17:30`）。
 * 解析不出任何时段 → parsed=false（调用方按 unknown 处理，不猜）。
 */
export function parseOpeningHours(raw: string): HoursParse {
  const out: HoursParse = { raw, parsed: false, allDay: false, ranges: [], closedDays: [], lastEntryMin: null };
  const text = toHalfWidth(raw ?? "").trim();
  if (!text) return out;

  if (/全天开放|全天营业|24小时|全年无休|开放时间为全天/.test(text)) {
    out.parsed = true;
    out.allDay = true;
    return out;
  }

  // 闭馆日：周一闭馆 / 每周一休息 / 周一不开放
  const closedRe = /(每)?(周|星期|礼拜)([日一二三四五六天])\s*(?:闭馆|休馆|不开放|休息|歇业|停业)/g;
  let cm: RegExpExecArray | null;
  while ((cm = closedRe.exec(text)) !== null) {
    const idx = WEEK_INDEX[cm[3] ?? ""];
    if (idx != null && !out.closedDays.includes(idx)) out.closedDays.push(idx);
  }

  // 停止入场
  const le = text.match(/(\d{1,2}):(\d{2})\s*(?:停止入场|停止入园|停止售票|最后入场|截止入场|最晚入场)/);
  if (le) out.lastEntryMin = minutesOf(le[1] ?? "0", le[2] ?? "0");

  // 时段（按分隔切成片段，片段内可带星期范围前缀）
  const segments = text.split(/[,，;；、\n]+/);
  for (const seg of segments) {
    const times = [...seg.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (times.length === 0) continue;
    const days = daysScopeOf(seg);
    for (const t of times) {
      out.ranges.push({ days, openMin: minutesOf(t[1] ?? "0", t[2] ?? "0"), closeMin: minutesOf(t[3] ?? "0", t[4] ?? "0") });
      out.parsed = true;
    }
  }
  // 「09:00-17:00 周一闭馆」这类写法里闭馆片段本身不含时段，上面已单独处理
  return out;
}

/** 片段里的星期范围（周一 / 周一至周五 / 周末 / 每天）；无则返回 []（表示每天） */
function daysScopeOf(seg: string): number[] {
  if (/每天|每日|周一至周日|周二至周日/.test(seg) && !/^(周|星期|礼拜)[一二三四五六日天]/.test(seg.trim())) {
    // 「周一至周日 09:00-17:00」全周生效
    if (/周一至周日|周二至周日|每天|每日/.test(seg)) return [];
  }
  const range = seg.match(/(?:每)?(?:周|星期|礼拜)([日一二三四五六天])\s*-\s*(?:周|星期|礼拜)?([日一二三四五六天])/);
  if (range) {
    const from = WEEK_INDEX[range[1] ?? ""];
    const to = WEEK_INDEX[range[2] ?? ""];
    if (from != null && to != null) {
      const days: number[] = [];
      let cur = from;
      for (let guard = 0; guard < 7; guard++) {
        days.push(cur);
        if (cur === to) break;
        cur = (cur + 1) % 7;
      }
      return days;
    }
  }
  const single = [...seg.matchAll(/(?:每)?(?:周|星期|礼拜)([日一二三四五六天])/g)];
  if (single.length === 1) {
    const d = WEEK_INDEX[single[0]![1] ?? ""];
    if (d != null) return [d];
  }
  if (/周末/.test(seg)) return [0, 6];
  return [];
}

/** `2026-11-03T09:00:00` / `09:00` / `上午9点` → 当日分钟数（拿不到时刻返回 null） */
export function minutesOfTime(value: string | undefined, dateHint?: string): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/T(\d{1,2}):(\d{2})/);
  if (iso) return minutesOf(iso[1] ?? "0", iso[2] ?? "0");
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (hm) return minutesOf(hm[1] ?? "0", hm[2] ?? "0");
  const cn = raw.match(/(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[点时]\s*(半|\d{1,2})?/);
  if (cn) {
    let h = Number(cn[2]);
    const mer = cn[1];
    if ((mer === "下午" || mer === "晚上") && h < 12) h += 12;
    if (mer === "中午" && h < 11) h += 12;
    const m = cn[3] === "半" ? 30 : Number(cn[3] ?? 0);
    return Math.min(1439, Math.max(0, h * 60 + (Number.isFinite(m) ? m : 0)));
  }
  if (dateHint) {
    const fromHint = raw.match(new RegExp(`${dateHint}T?(\\d{1,2}):(\\d{2})`));
    if (fromHint) return minutesOf(fromHint[1] ?? "0", fromHint[2] ?? "0");
  }
  return null;
}

/** 日期串（`2026-11-03` 或 `2026-11-03T09:00:00`）→ 星期 */
function weekdayOf(value: string | undefined): number {
  if (!value) return -1;
  return weekdayOfISO(value.slice(0, 10));
}

// ======================== 预约规则知识库 ========================

export interface ReservationRule {
  /** 匹配到的规则名（场馆/类目） */
  name: string;
  /** yes=必须提前预约；likely=热门日建议预约；no=现场即可（仅对已知确定的点） */
  required: "yes" | "likely" | "no" | "unknown";
  /** 建议提前天数 */
  leadDays?: number;
  /** 放票时刻（已知才填） */
  releaseTime?: string;
  /** 限流说明 */
  capNote?: string;
  /** 规则来源（builtin-knowledge / category-rule / poi-opening-hours） */
  source: "builtin-knowledge" | "category-rule" | "poi-opening-hours";
  /** 知识条目核验基准日（内置知识会过期，话术必须提示以官方为准） */
  verifiedAt: string;
  advice: string;
}

const KNOWLEDGE_VERIFIED_AT = "2026-10-24";

/**
 * 内置知识表：只收确实有把握的知名场馆（预约制 + 周一闭馆），
 * 每条都指向官方渠道，不写死价格与放票细节——那类信息每天在变。
 */
const KNOWN_RULES: Array<{ re: RegExp; rule: Omit<ReservationRule, "source" | "verifiedAt"> }> = [
  {
    re: /布达拉宫/,
    rule: {
      name: "布达拉宫",
      required: "yes",
      leadDays: 7,
      capNote: "分时段限量进山，旺季票紧张",
      advice: "布达拉宫须提前预约（官方小程序「布达拉宫票务预约系统」或委托旅行社），按预约时段进山，旺季建议提前一周以上盯票。",
    },
  },
  {
    re: /莫高窟|鸣沙山莫高/,
    rule: {
      name: "莫高窟",
      required: "yes",
      leadDays: 14,
      capNote: "A 类正常票限量，旺季常提前售罄",
      advice: "莫高窟必须提前在官方「莫高窟参观预约网」订票（A 类票含实体中心观影+洞窟），旺季建议提前两周，应急票只能看少量洞窟。",
    },
  },
  {
    re: /故宫(博物院)?/,
    rule: {
      name: "故宫博物院",
      required: "yes",
      leadDays: 7,
      releaseTime: "提前 7 日 20:00（官方小程序）",
      capNote: "全网实名预约、每日限量",
      advice: "故宫须提前在「故宫博物院」小程序实名预约，通常提前 7 日晚 8 点放票，周一闭馆（法定节假日除外）。",
    },
  },
  {
    re: /中国国家博物馆|国博/,
    rule: {
      name: "中国国家博物馆",
      required: "yes",
      leadDays: 7,
      releaseTime: "提前 7 日 17:00（官方预约）",
      advice: "国博免费但须提前实名预约场次，热门日放票后很快约满，周一闭馆。",
    },
  },
  {
    re: /陕西历史博物馆|陕历博/,
    rule: {
      name: "陕西历史博物馆",
      required: "yes",
      leadDays: 5,
      capNote: "每日限量，周末节假日极难约",
      advice: "陕历博须提前官方预约，票量有限且抢手；约不上可改大唐芙蓉园/西安博物院等替代。",
    },
  },
  {
    re: /南京博物院/,
    rule: {
      name: "南京博物院",
      required: "yes",
      leadDays: 7,
      advice: "南京博物院免费但须提前官方预约场次，周一闭馆。",
    },
  },
  {
    re: /三星堆/,
    rule: {
      name: "三星堆博物馆",
      required: "yes",
      leadDays: 5,
      advice: "三星堆博物馆须线上实名预约购票，节假日票紧张。",
    },
  },
  {
    re: /环球影城/,
    rule: {
      name: "环球影城",
      required: "likely",
      leadDays: 3,
      advice: "主题乐园建议提前官方购票并绑定入园日期，现场票价与余票都不稳定。",
    },
  },
  {
    re: /迪士尼/,
    rule: {
      name: "迪士尼乐园",
      required: "likely",
      leadDays: 3,
      advice: "迪士尼建议提前官方购票选定日期，入园需预约。",
    },
  },
  {
    re: /天文馆|科技馆|海洋馆/,
    rule: {
      name: "场馆类（天文馆/科技馆/海洋馆）",
      required: "likely",
      leadDays: 3,
      advice: "这类场馆多数需分时段预约购票，周一常闭馆，出发前查官方公众号确认。",
    },
  },
];

/** 类目规则：博物馆/美术馆/纪念馆类的周一闭馆是行业惯例（标 category-rule，仍提示核实） */
const CATEGORY_RE = /(博物馆|美术馆|纪念馆|展览馆|博物院|艺术馆|图书馆|故居|陵|遗址公园)/;

export function findReservationRule(name: string, openingHoursRaw?: string): ReservationRule | null {
  const hay = name.trim();
  if (!hay) return null;
  const known = KNOWN_RULES.find((k) => k.re.test(hay));
  if (known) return { ...known.rule, source: "builtin-knowledge", verifiedAt: KNOWLEDGE_VERIFIED_AT };
  // 开放时间文本里写了「需预约/提前预约/网上预约」→ 直接采信该 POI 的字段
  const raw = (openingHoursRaw ?? "").trim();
  if (/预约|提前.{0,4}(订票|抢票)/.test(raw)) {
    return {
      name: hay,
      required: "yes",
      advice: `该点标注需预约（原文：${raw}），按官方渠道提前订票再排入日程。`,
      source: "poi-opening-hours",
      verifiedAt: KNOWLEDGE_VERIFIED_AT,
    };
  }
  if (CATEGORY_RE.test(hay)) {
    return {
      name: hay,
      required: "likely",
      leadDays: 3,
      advice: "场馆类景点普遍需实名预约、周一闭馆，出发前用官方公众号核实场次。",
      source: "category-rule",
      verifiedAt: KNOWLEDGE_VERIFIED_AT,
    };
  }
  return null;
}

// ======================== 行程核实 ========================

export interface DossierStop {
  name: string;
  type: string;
  startTime: string;
  endTime?: string;
  visitDuration?: number;
  openingHours?: string;
  tags?: string[];
  priceInfo?: string;
}

export interface DossierDay {
  date?: string;
  items: DossierStop[];
}

export type IssueKind =
  | "closed_day"
  | "outside_hours"
  | "late_entry"
  | "short_window"
  | "reservation"
  | "unknown_hours"
  | "density"
  | "night_only"
  | "route"
  | "weather";

export interface DossierIssue {
  level: "block" | "warn" | "info";
  kind: IssueKind;
  /** 0 基天索引 */
  day: number;
  /** 0 基站内索引 */
  stop: number;
  name: string;
  message: string;
  suggestion?: string;
}

export interface VerifyInput {
  days: DossierDay[];
  /** 每日站点上限（人格分型决定；缺省不按密度提示） */
  maxStopsPerDay?: number;
  /** 只对景点做核实（酒店/餐厅的时间是排程约定，不是场馆开放约束） */
  verifyRestaurants?: boolean;
}

const WEEKDAY_NAME = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 逐站核实一遍。返回问题清单（不修改输入）：
 *   block = 那天那个点大概率进不去（闭馆日/整段在非开放时段/错过停止入场）；
 *   warn  = 能去但要调整（窗口不足以容纳建议时长、需预约未提示、排得太满）；
 *   info  = 只作诚实交代（开放时间没取到，需自查官方）。
 */
export function verifyItinerary(input: VerifyInput): DossierIssue[] {
  const issues: DossierIssue[] = [];
  const days = input.days ?? [];
  for (let d = 0; d < days.length; d++) {
    const day = days[d]!;
    const items = day.items ?? [];
    if (input.maxStopsPerDay && input.maxStopsPerDay > 0) {
      const sightseeing = items.filter((it) => it.type === "attraction").length;
      if (sightseeing > input.maxStopsPerDay) {
        issues.push({
          level: "warn",
          kind: "density",
          day: d,
          stop: -1,
          name: `Day ${d + 1}`,
          message: `Day ${d + 1} 排了 ${sightseeing} 个景点，超过 ${input.maxStopsPerDay} 个的舒适上限——排太满当天必然崩`,
          suggestion: "砍掉 1~2 个点，或把其中一个换成晚间自由活动的备选",
        });
      }
    }
    for (let s = 0; s < items.length; s++) {
      const item = items[s]!;
      if (item.type === "hotel") continue;
      if (item.type === "restaurant" && !input.verifyRestaurants) continue;
      const parsed = parseOpeningHours(item.openingHours ?? "");
      const wd = weekdayOf(item.startTime) >= 0 ? weekdayOf(item.startTime) : weekdayOf(day.date);
      const startMin = minutesOfTime(item.startTime, day.date);
      const endMin = item.endTime
        ? minutesOfTime(item.endTime, day.date)
        : startMin != null && item.visitDuration
          ? startMin + item.visitDuration
          : null;

      if (wd >= 0 && parsed.closedDays.includes(wd)) {
        issues.push({
          level: "block",
          kind: "closed_day",
          day: d,
          stop: s,
          name: item.name,
          message: `${item.name} ${WEEKDAY_NAME[wd]}闭馆（Day ${d + 1}正是${WEEKDAY_NAME[wd]}）`,
          suggestion: `把这天与后面某天对调，或当天换成${WEEKDAY_NAME[wd]}照常开放的户外/夜景点位`,
        });
        continue;
      }

      if (!parsed.parsed) {
        // 没取到官方开放时间时，场馆类的周一闭馆是行业惯例——排到周一要明确提示，
        // 不能因为「数据没跑到」就当它一定开门（用户要的是哪天闭馆说清楚）。
        if (item.type === "attraction" && CATEGORY_RE.test(item.name) && wd === 1) {
          issues.push({
            level: "warn",
            kind: "closed_day",
            day: d,
            stop: s,
            name: item.name,
            message: `${item.name} 属场馆类，行业惯例周一闭馆；Day ${d + 1} 正是周一，且未取到官方闭馆日`,
            suggestion: "与后一天对调，或出发前用官方公众号确认当天是否开放",
          });
        } else if (item.type === "attraction" && /门票|收费|¥|元/.test(item.priceInfo ?? "")) {
          issues.push({
            level: "info",
            kind: "unknown_hours",
            day: d,
            stop: s,
            name: item.name,
            message: `${item.name} 的开放时间没取到，排程按建议游览时长估算`,
            suggestion: "出发前查官方公众号确认场次与闭馆日",
          });
        }
        continue;
      }
      if (parsed.allDay || startMin == null) continue;

      const todayRanges = parsed.ranges.filter((r) => r.days.length === 0 || r.days.includes(wd));
      if (todayRanges.length === 0 && parsed.ranges.length > 0) {
        // 只给了别的工作日时段（如「周五至周日 10:00-22:00」）→ 今天大概率不开
        issues.push({
          level: "warn",
          kind: "outside_hours",
          day: d,
          stop: s,
          name: item.name,
          message: `${item.name} 的营业时间只标注了 ${parsed.ranges.map((r) => r.days.map((x) => WEEKDAY_NAME[x]).join("/") || "每天").join("、")}，${WEEKDAY_NAME[wd] ?? "当天"}未见开放`,
          suggestion: "换到标注的日子，或替换成当天开放的点",
        });
        continue;
      }
      const hit = todayRanges.find((r) => startMin >= r.openMin && (endMin ?? startMin) <= r.closeMin);
      const insideButLateEntry =
        !hit && parsed.lastEntryMin != null && startMin > parsed.lastEntryMin;
      if (insideButLateEntry) {
        issues.push({
          level: "block",
          kind: "late_entry",
          day: d,
          stop: s,
          name: item.name,
          message: `${item.name} ${fmt(parsed.lastEntryMin!)} 停止入场，Day ${d + 1} 的 ${fmt(startMin)} 到点进不去`,
          suggestion: `把这一站提前到 ${fmt(Math.max(0, parsed.lastEntryMin! - 30))} 之前`,
        });
        continue;
      }
      if (!hit) {
        const covering = todayRanges.find((r) => startMin >= r.openMin && startMin < r.closeMin);
        if (covering) {
          const slack = covering.closeMin - startMin;
          const need = endMin != null ? endMin - startMin : (item.visitDuration ?? 0);
          if (need > slack) {
            issues.push({
              level: "warn",
              kind: "short_window",
              day: d,
              stop: s,
              name: item.name,
              message: `${item.name} ${fmt(covering.closeMin)} 闭馆，${fmt(startMin)} 到只剩 ${slack} 分钟，不够原计划的 ${need} 分钟`,
              suggestion: `把这一站提到 ${fmt(Math.max(covering.openMin, covering.closeMin - need))}，或压缩后面的安排`,
            });
          } else {
            issues.push({
              level: "block",
              kind: "outside_hours",
              day: d,
              stop: s,
              name: item.name,
              message: `${item.name} 营业时间 ${fmt(covering.openMin)}-${fmt(covering.closeMin)}，Day ${d + 1} 的 ${fmt(startMin)} 不在时段内`,
              suggestion: `改到 ${fmt(covering.openMin)} 之后入园`,
            });
          }
        } else {
          const r0 = todayRanges[0];
          issues.push({
            level: "block",
            kind: "outside_hours",
            day: d,
            stop: s,
            name: item.name,
            message: `${item.name} 开放时间 ${r0 ? `${fmt(r0.openMin)}-${fmt(r0.closeMin)}` : "未知"}，与 Day ${d + 1} 的 ${fmt(startMin)} 对不上`,
            suggestion: r0 ? `改到 ${fmt(r0.openMin)}-${fmt(r0.closeMin)} 之间` : "出发前核实场次",
          });
        }
        continue;
      }
      if (parsed.lastEntryMin != null && endMin != null && endMin > parsed.lastEntryMin && startMin <= parsed.lastEntryMin) {
        issues.push({
          level: "warn",
          kind: "short_window",
          day: d,
          stop: s,
          name: item.name,
          message: `${item.name} ${fmt(parsed.lastEntryMin)} 停止入场，本站停留到 ${fmt(endMin)} 会被请出去`,
          suggestion: `停留压到 ${parsed.lastEntryMin - startMin} 分钟内`,
        });
      }
    }

    // 预约核实（每站一条，最多 3 条按天汇总，避免卡片被刷满）
    const needBook = items.filter((it) => it.type === "attraction").map((it) => findReservationRule(it.name, it.openingHours));
    const first = needBook.findIndex((r) => r && r.required !== "no");
    if (first >= 0) {
      const rule = needBook[first]!;
      if (rule && rule.required !== "no") {
        issues.push({
          level: rule.source === "category-rule" ? "info" : "warn",
          kind: "reservation",
          day: d,
          stop: items.findIndex((it) => it.name === rule.name),
          name: items[first]!.name,
          message: rule.advice,
          suggestion: rule.leadDays ? `出发前 ${rule.leadDays} 天处理${rule.releaseTime ? `（${rule.releaseTime}）` : ""}` : "出发前确认预约入口",
        });
      }
    }
  }
  return issues;
}

/** 汇总给 LLM/卡片的一行话（0 条返回 null，不硬凑） */
export function summarizeIssues(issues: DossierIssue[]): string | null {
  if (issues.length === 0) return null;
  const block = issues.filter((i) => i.level === "block").length;
  const warn = issues.filter((i) => i.level === "warn").length;
  const info = issues.filter((i) => i.level === "info").length;
  const parts: string[] = [];
  if (block > 0) parts.push(`${block} 处时间冲突`);
  if (warn > 0) parts.push(`${warn} 处需调整`);
  if (info > 0) parts.push(`${info} 处待核实`);
  return parts.join(" · ");
}

/** 按天归组（桌面端在站点卡上打徽章用）：day → 该天问题 */
export function groupIssuesByDay(issues: DossierIssue[]): Record<number, DossierIssue[]> {
  const out: Record<number, DossierIssue[]> = {};
  for (const it of issues) (out[it.day] ??= []).push(it);
  return out;
}

export function issuesForDay(issues: DossierIssue[], day: number, stop: number): DossierIssue[] {
  return issues.filter((i) => i.day === day && (i.stop === stop || (i.stop === -1 && stop === -1)));
}
