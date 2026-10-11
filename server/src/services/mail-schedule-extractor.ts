/**
 * 票务/日历邮件 → 日程提取与物化（mail-schedule-extractor）。
 *
 * 挂在 MailWatchService.onNewMessage 分级之后的支路（模式同财务账单邮件通道）：
 *   粗筛命中（发件人/主题像票务）→ 原始 MIME 里拿全文与 ICS 附件 →
 *   ① ICS 附件直取（零 LLM，最高置信）→ ② 模板规则（发件人域+主题+正文正则）→
 *   物化桥落日程（source=email）。
 *
 * 市面定调（2026-09-24 调研）：静默写入 + 一条汇总提醒可撤销；宁漏不误报——
 * 规则没命中就静默跳过，绝不猜。LLM 兜底层留待规则层跑出漏检率数据后再接。
 *
 * matchKey 约定：`${ruleId}:${订单号}`（12306 购票/改签/退票三邮件共享同一订单号，
 * 同一 matchKey 反查即可完成 建→改期→取消 的全生命周期）；无订单号退化为
 * `${ruleId}:raw:${指纹}`（只建不后续）。ICS 附件用 `ics:${uid}/${startMs}`。
 *
 * 规则校准说明：正则按 12306 / 航司 / OTA 公开模板撰写（参考开源 TrainCalendar 的
 * 12306 解析实践），需要真实邮件持续校准；任何解析失败一律返回 null（漏建优于误建）。
 */

import { createHash } from "node:crypto";

import { parseIcsCalendar, resolveIcsOccurrences } from "./ics-subscription-service.js";
import { extractMailCalendarParts, type IncomingMail } from "./mail-watch-service.js";
import type { ProactiveIntent } from "../proactivity/proactivity-types.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";

// ---------------------------------------------------------------------- //
// 草案与规则表
// ---------------------------------------------------------------------- //

export type MailScheduleIntent = "create" | "reschedule" | "cancel";

export type MailScheduleDraft = {
  /** 稳定事件键（sourceRefId），同一订单全生命周期复用 */
  matchKey: string;
  intent: MailScheduleIntent;
  ruleId: string;
  /** 含【火车票】/【航班】/【酒店】/【日历】前缀的展示标题 */
  title: string;
  /** ≤12 字紧凑短标题（今日安排） */
  shortTitle: string;
  runAtIso: string;
  durationMinutes?: number;
  location?: string;
  reminderMessage: string;
};

type TicketRuleParse = {
  orderId: string | null;
  title: string;
  shortTitle: string;
  runAtIso: string;
  durationMinutes?: number;
  location?: string;
  reminderMessage: string;
};

type MailTicketRule = {
  id: string;
  /** matchKey 前缀：同一订单生命周期内的多条规则（购票/改签/退票）必须共享同一前缀 */
  keyPrefix: string;
  /** 粗筛 + 命中：发件人须命中 fromRe，主题须命中 subjectRe */
  fromRe: RegExp;
  subjectRe: RegExp;
  intent: MailScheduleIntent;
  /** 从正文提取结构化草案；返回 null = 本次不建（宁漏不误报） */
  parse: (bodyText: string) => TicketRuleParse | null;
};

/** 快捷正则族（模板级通用字段） */
const RE = {
  orderId: /(?:订单号|订单编号|订单ID|orderNo)[：:\s]*([A-Za-z0-9-]{8,24})/,
  train: /([GDKCTZPYL]\d{1,5})\s*次/,
  ymd: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  ymdDash: /(\d{4})-(\d{1,2})-(\d{1,2})/,
  hmKai: /(\d{1,2}):(\d{2})\s*开/,
  hm: /(\d{1,2}):(\d{2})/,
  route: /([\u4e00-\u9fa5A-Za-z]{2,12}?(?:站|机场))\s*(?:至|到|—|——|->|→)\s*([\u4e00-\u9fa5A-Za-z]{2,12}?(?:站|机场))/,
  flightNo: /\b([A-Z]{2}\d{3,4})\b/,
  hmTakeoff: /(\d{1,2}):(\d{2})\s*(?:起飞|起飞时间)/,
  hotelName: /([\u4e00-\u9fa5A-Za-z0-9]{4,24}(?:酒店|饭店|民宿))/,
};

function ymdhmToIso(y: number, mo: number, d: number, h: number, mi: number): string {
  // 邮件时间全是本地墙钟无时区：按 +08:00 固定偏移解释（同 ICS 浮点时间约定，中国无夏令时）
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+08:00`;
  return new Date(Date.parse(iso)).toISOString();
}

function fallbackOrderId(from: string, subject: string, bodyText: string): string {
  const fp = createHash("sha1").update(`${from}|${subject}|${bodyText}`).digest("hex").slice(0, 12);
  return `raw:${fp}`;
}

/** 12306 购票/改签共用解析（新票的车次时刻都完整在正文中）。 */
function parse12306(bodyText: string): TicketRuleParse | null {
  const train = RE.train.exec(bodyText)?.[1];
  const ymd = RE.ymd.exec(bodyText);
  if (!train || !ymd) return null;
  const hm = RE.hmKai.exec(bodyText) ?? RE.hm.exec(bodyText);
  if (!hm) return null;
  const route = RE.route.exec(bodyText);
  const orderId = RE.orderId.exec(bodyText)?.[1] ?? null;
  const runAtIso = ymdhmToIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), Number(hm[1]), Number(hm[2]));
  const routeText = route ? `${route[1]}→${route[2]}` : "";
  const location = route?.[1];
  return {
    orderId,
    title: `【火车票】${train}次${routeText ? ` ${routeText}` : ""}`,
    shortTitle: `${train}次`.slice(0, 12),
    runAtIso,
    durationMinutes: undefined,
    location,
    reminderMessage: `火车 ${train}次 ${routeText} 将于 ${String(hm[1]).padStart(2, "0")}:${hm[2]} 开`,
  };
}

/** 航司/OTA 出票：航班号 + 起飞时间必填，航线尽量带。 */
function parseFlight(bodyText: string): TicketRuleParse | null {
  const flight = RE.flightNo.exec(bodyText)?.[1];
  if (!flight) return null;
  const ymd = RE.ymd.exec(bodyText) ?? RE.ymdDash.exec(bodyText);
  if (!ymd) return null;
  const hm = RE.hmTakeoff.exec(bodyText) ?? RE.hm.exec(bodyText);
  if (!hm) return null;
  const route = RE.route.exec(bodyText);
  const orderId = RE.orderId.exec(bodyText)?.[1] ?? null;
  const runAtIso = ymdhmToIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), Number(hm[1]), Number(hm[2]));
  const routeText = route ? `${route[1]}→${route[2]}` : "";
  return {
    orderId,
    title: `【航班】${flight}${routeText ? ` ${routeText}` : ""}`,
    shortTitle: flight,
    runAtIso,
    location: route?.[1],
    reminderMessage: `航班 ${flight} ${routeText} 计划 ${hm[1]}:${hm[2]} 起飞，建议提前 2 小时到机场`,
  };
}

/** 酒店确认：入住日期必填（默认 14:00 入住时刻），酒店名尽量带。 */
function parseHotel(bodyText: string): TicketRuleParse | null {
  const checkIn = /入住(?:日期)?[：:\s]*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(bodyText) ?? RE.ymd.exec(bodyText);
  if (!checkIn) return null;
  const hotel = RE.hotelName.exec(bodyText)?.[1];
  const orderId = RE.orderId.exec(bodyText)?.[1] ?? null;
  return {
    orderId,
    title: `【酒店】入住${hotel ? ` · ${hotel}` : ""}`,
    shortTitle: (hotel ? `${hotel.slice(0, 10)}入住` : "酒店入住").slice(0, 12),
    runAtIso: ymdhmToIso(Number(checkIn[1]), Number(checkIn[2]), Number(checkIn[3]), 14, 0),
    location: hotel,
    reminderMessage: `今天可办理酒店入住${hotel ? `：${hotel}` : ""}（一般 14:00 后）`,
  };
}

/** 退票：按订单号取消即可（不必有车次时刻——取消路径只查 matchKey）。 */
function parse12306Refund(bodyText: string): TicketRuleParse | null {
  const orderId = RE.orderId.exec(bodyText)?.[1];
  if (!orderId) return null;
  return {
    orderId,
    title: "【火车票】已退票",
    shortTitle: "已退票",
    runAtIso: new Date(0).toISOString(), // cancel 路径不使用
    reminderMessage: "车票已退",
  };
}

/**
 * 第一批规则（市面调研排序的高价值类）：12306 三意图、航司/OTA 出票、酒店确认。
 * 顺序即优先级：退票/改签在最前（主题词更具体，防购票规则抢先命中）。
 * 电影/演出/医院预约、航司退票类放第二批；schema.org 标记层不做（国内商户不注册）。
 */
export const MAIL_TICKET_RULES: MailTicketRule[] = [
  {
    id: "rail-12306-refund",
    keyPrefix: "rail-12306",
    fromRe: /12306@rails\.com\.cn|@rails\.com\.cn/i,
    subjectRe: /退票/,
    intent: "cancel",
    parse: parse12306Refund,
  },
  {
    id: "rail-12306-reschedule",
    keyPrefix: "rail-12306",
    fromRe: /12306@rails\.com\.cn|@rails\.com\.cn/i,
    subjectRe: /改签/,
    intent: "reschedule",
    parse: (body) => parse12306(body),
  },
  {
    id: "rail-12306",
    keyPrefix: "rail-12306",
    fromRe: /12306@rails\.com\.cn|@rails\.com\.cn/i,
    subjectRe: /网上购票|购票成功/,
    intent: "create",
    parse: (body) => parse12306(body),
  },
  {
    id: "flight-ticket",
    keyPrefix: "flight-ticket",
    fromRe: /(ctrip|trip\.com|fliggy|qunar|ly\.com|tuniu|csair|ceair|airchina|shandongair|juneyao|springairlines|xiamenair)/i,
    subjectRe: /出票成功|电子客票|行程单|机票/,
    intent: "create",
    parse: parseFlight,
  },
  {
    id: "hotel-confirm",
    keyPrefix: "hotel-confirm",
    fromRe: /(ctrip|trip\.com|fliggy|qunar|huazhu|atour|meituan|jinjiang)/i,
    subjectRe: /预订成功|预订确认|订单确认|酒店/,
    intent: "create",
    parse: parseHotel,
  },
];

/** 廉价预筛：发件人或主题像票务才动原始 MIME（其余邮件零成本跳过）。 */
export function isTicketLikeMail(from: string, subject: string): boolean {
  const f = from ?? "";
  const s = subject ?? "";
  return (
    /rails\.com\.cn|12306@/i.test(f) ||
    /(ctrip|trip\.com|fliggy|qunar|ly\.com|tuniu|csair|ceair|airchina|juneyao|springairlines|xiamenair|huazhu|atour|jinjiang)/i.test(f) ||
    /(购票|改签|退票|出票|电子客票|行程单|机票|预订成功|预订确认|订单确认)/.test(s)
  );
}

// ---------------------------------------------------------------------- //
// 提取（纯函数，可单测）
// ---------------------------------------------------------------------- //

export function extractMailScheduleDrafts(
  input: { from: string; subject: string; bodyText: string; icsTexts: string[] },
  opts?: { nowMs?: number; lookaheadDays?: number },
): MailScheduleDraft[] {
  const drafts: MailScheduleDraft[] = [];
  const nowMs = opts?.nowMs ?? Date.now();
  const lookaheadDays = opts?.lookaheadDays ?? 35;

  // ① ICS 附件直取：会议邀请/航司行程附件，字段结构化，置信最高
  for (const icsText of input.icsTexts) {
    try {
      const events = parseIcsCalendar(icsText);
      const occ = resolveIcsOccurrences(events, nowMs, nowMs + lookaheadDays * 24 * 3_600_000);
      for (const o of occ) {
        const runAtMs = o.allDay ? o.startMs + 8.5 * 3_600_000 : o.startMs;
        drafts.push({
          matchKey: `ics:${o.key}`,
          intent: "create",
          ruleId: "ics-attachment",
          title: `【日历】${o.summary}`,
          shortTitle: o.summary.slice(0, 12),
          runAtIso: new Date(runAtMs).toISOString(),
          durationMinutes: o.durationMinutes ?? undefined,
          location: o.location,
          reminderMessage: o.summary,
        });
      }
    } catch {
      /* 单个附件解析失败不影响其余（宁漏不误） */
    }
  }

  // ② 模板规则：首个命中的规则产出一份草案（退票/改签在前，防购票规则抢先命中）
  for (const rule of MAIL_TICKET_RULES) {
    if (!rule.fromRe.test(input.from)) continue;
    if (!rule.subjectRe.test(input.subject)) continue;
    try {
      const parsed = rule.parse(input.bodyText);
      if (!parsed) continue;
      const orderId = parsed.orderId ?? fallbackOrderId(input.from, input.subject, input.bodyText);
      drafts.push({
        matchKey: `${rule.keyPrefix}:${orderId}`,
        intent: rule.intent,
        ruleId: rule.id,
        title: parsed.title,
        shortTitle: parsed.shortTitle,
        runAtIso: parsed.runAtIso,
        durationMinutes: parsed.durationMinutes,
        location: parsed.location,
        reminderMessage: parsed.reminderMessage,
      });
    } catch {
      /* 单条规则异常跳过 */
    }
    break; // 同一封邮件只走一条规则（购票/改签/退票由 subject 分流，互斥设计）
  }
  return drafts;
}

// ---------------------------------------------------------------------- //
// 物化桥（样板同 schedule-booking-bridge / commitment-schedule-outlet）
// ---------------------------------------------------------------------- //

/** 物化时间闸：仅落未来事件（过去行程/历史邮件导入不建日程，宁漏不误）。 */
const MATERIALIZE_MIN_LEAD_MS = 60_000;

export type MailScheduleSyncReport = {
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
};

/**
 * 邮件提醒闸门决策（2026-10-05 邮箱=信息采集定调）：邮件只要被成功识别为
 * 票务/预订（提取出草稿——哪怕全被时间闸 skipped，如过期票/退票通知），
 * 就免当场 high 打扰：提醒交给日程策略层按事件时间自动排。
 * 返回 null（非票务/提取失败，如航班延误通知未命中模板）→ 保持原闸门当场提醒。
 */
export function suppressMailInterrupt(
  report: MailScheduleSyncReport | null | undefined,
): boolean {
  return report != null;
}

// ---------------------------------------------------------------------- //
// 漏检埋点（2026-10-11）
// ---------------------------------------------------------------------- //
//
// 「规则命中」是宁漏不误的保守策略：粗筛判定"像票务"、规则却解不出结构化字段时，
// 邮件被静默跳过（不建日程）。此时系统**不知道自己漏了什么**——注释里那句
// "LLM 兜底层留待规则层跑出漏检率数据后再接" 的前提就是先有度量。
// 本埋点只回答一个问题：**预筛命中却零产出的邮件有多少、长什么样**，
// 供评估要不要为这一小撮开一次有边界的 LLM 兜底。埋点纯观测，不改变任何行为。

/** 漏检原因：① 预筛命中但规则/ICS 均未产出草稿；② 仅靠 ICS 探针进来的邮件没解出事件。 */
export type MailTicketMissReason = "prefilter_hit_no_draft" | "ics_probe_no_draft";

/** 单条漏检样本（有界保留，供人工抽查模板漂移）。 */
export type MailTicketMiss = {
  at: string;
  actorId: string;
  reason: MailTicketMissReason;
  from: string;
  subject: string;
  /** 正文纯文本长度：为 0 常见于纯图片/HTML 卡片邮件——规则天生读不到，是最该关注的形态 */
  bodyChars: number;
};

export type MailTicketMissStats = {
  total: number;
  byReason: Record<MailTicketMissReason, number>;
  lastAt: string | null;
  /** 最近若干条样本（上限 {@link MISS_SAMPLE_CAP}） */
  samples: MailTicketMiss[];
};

/** 漏检样本有界保留上限（只留最近 N 条，防内存无界增长）。 */
const MISS_SAMPLE_CAP = 50;

export class MailScheduleBridge {
  private readonly tasks: ScheduleTaskService;
  private readonly notify: ((intent: ProactiveIntent) => void) | null;
  private readonly now: () => Date;
  private readonly onMiss: ((miss: MailTicketMiss) => void) | null;
  private missTotal = 0;
  private readonly missByReason: Record<MailTicketMissReason, number> = {
    prefilter_hit_no_draft: 0,
    ics_probe_no_draft: 0,
  };
  private missLastAt: string | null = null;
  private readonly missSamples: MailTicketMiss[] = [];

  constructor(deps: {
    tasks: ScheduleTaskService;
    notify?: ((intent: ProactiveIntent) => void) | null;
    now?: () => Date;
    /** 漏检回调（装配层接日志；缺省仅进程内计数）。回调异常被吞，绝不影响主链路。 */
    onMiss?: ((miss: MailTicketMiss) => void) | null;
  }) {
    this.tasks = deps.tasks;
    this.notify = deps.notify ?? null;
    this.now = deps.now ?? (() => new Date());
    this.onMiss = deps.onMiss ?? null;
  }

  /** 记录一次漏检：仅计数 + 有界样本 + 可选回调，零业务副作用。 */
  private recordMiss(
    mail: Pick<IncomingMail, "actorId" | "from" | "subject">,
    reason: MailTicketMissReason,
    bodyChars: number,
  ): void {
    const miss: MailTicketMiss = {
      at: this.now().toISOString(),
      actorId: mail.actorId,
      reason,
      from: mail.from,
      subject: mail.subject,
      bodyChars,
    };
    this.missTotal += 1;
    this.missByReason[reason] += 1;
    this.missLastAt = miss.at;
    this.missSamples.push(miss);
    if (this.missSamples.length > MISS_SAMPLE_CAP) this.missSamples.shift();
    try {
      this.onMiss?.(miss);
    } catch {
      /* 埋点回调异常绝不影响邮件主链路 */
    }
  }

  /** 漏检统计快照：评估"要不要上 LLM 兜底"的数据面（total / 分因 / 最近样本）。 */
  missStats(): MailTicketMissStats {
    return {
      total: this.missTotal,
      byReason: { ...this.missByReason },
      lastAt: this.missLastAt,
      samples: this.missSamples.slice(),
    };
  }

  /**
   * 单封邮件入口：粗筛 → 提取 → 物化。非票务邮件零成本返回 null；
   * 任何异常由调用方吞掉记日志（提取失败不阻断邮件主链路）。
   * 会议邀请（ICS 附件）主题任意，预筛额外做一次 text/calendar 子串探针。
   */
  async onMail(
    mail: Pick<IncomingMail, "actorId" | "from" | "subject" | "source">,
  ): Promise<MailScheduleSyncReport | null> {
    // 预筛判定与最终产出之间的落差即「疑似票务却没识别出」——埋点记录，不改变返回。
    const prefilterHit = isTicketLikeMail(mail.from, mail.subject);
    if (!mail.source || mail.source.length === 0) {
      if (prefilterHit) this.recordMiss(mail, "prefilter_hit_no_draft", 0);
      return null;
    }
    const rawProbe = mail.source.toString("latin1");
    const icsProbe = rawProbe.includes("text/calendar") || /\.ics\b/i.test(rawProbe.slice(0, 8192));
    if (!prefilterHit && !icsProbe) return null;
    const parts = extractMailCalendarParts(mail.source);
    const drafts = extractMailScheduleDrafts({
      from: mail.from,
      subject: mail.subject,
      bodyText: parts.fullText,
      icsTexts: parts.icsTexts,
    });
    if (drafts.length === 0) {
      this.recordMiss(
        mail,
        prefilterHit ? "prefilter_hit_no_draft" : "ics_probe_no_draft",
        parts.fullText.length,
      );
      return null;
    }
    return this.syncDrafts(mail.actorId, drafts);
  }

  /** 按 draft.intent 物化：create 建 / reschedule 改期（无原票则建）/ cancel 软取消。 */
  async syncDrafts(actorId: string, drafts: MailScheduleDraft[]): Promise<MailScheduleSyncReport> {
    const report: MailScheduleSyncReport = { created: 0, updated: 0, cancelled: 0, skipped: 0 };
    const nowMs = this.now().getTime();
    for (const draft of drafts) {
      const runAtMs = Date.parse(draft.runAtIso);
      const existing = this.tasks.findTaskBySourceRefId(draft.matchKey);
      if (draft.intent === "cancel") {
        if (existing && existing.status === "active") {
          await this.tasks.updateTask(existing.taskId, { status: "cancelled" });
          report.cancelled += 1;
        } else {
          report.skipped += 1;
        }
        continue;
      }
      // create / reschedule 的时间闸
      if (!Number.isFinite(runAtMs) || runAtMs <= nowMs + MATERIALIZE_MIN_LEAD_MS) {
        report.skipped += 1;
        continue;
      }
      if (existing) {
        if (existing.status !== "active") {
          report.skipped += 1; // 用户已取消/已结束 → 不自动重建
          continue;
        }
        if (Date.parse(existing.runAt) !== runAtMs) {
          await this.tasks.updateTask(existing.taskId, {
            runAt: draft.runAtIso,
            ...(draft.durationMinutes ? { durationMinutes: draft.durationMinutes } : {}),
          });
          report.updated += 1;
        } else {
          report.skipped += 1; // 幂等：同订单同时间，什么都不做
        }
        continue;
      }
      await this.tasks.createTask({
        sessionId: actorId,
        title: draft.title,
        shortTitle: draft.shortTitle,
        description: `票务邮件自动创建（${draft.ruleId}）`,
        kind: "reminder",
        category: "itinerary",
        runAt: draft.runAtIso,
        recurrence: "none",
        timezone: "Asia/Shanghai",
        reminderMessage: draft.reminderMessage,
        durationMinutes: draft.durationMinutes,
        source: "email",
        sourceRefId: draft.matchKey,
      });
      report.created += 1;
    }
    this.notifySummary(actorId, report);
    return report;
  }

  private notifySummary(actorId: string, report: MailScheduleSyncReport): void {
    const changed = report.created + report.updated + report.cancelled;
    if (changed === 0 || !this.notify) return;
    const parts: string[] = [];
    if (report.created > 0) parts.push(`新增 ${report.created} 条`);
    if (report.updated > 0) parts.push(`改期 ${report.updated} 条`);
    if (report.cancelled > 0) parts.push(`取消 ${report.cancelled} 条`);
    this.notify({
      actorId,
      kind: "life_reminder",
      importance: "medium",
      title: "从邮件加入了日程",
      summary: `票务邮件已同步到日程：${parts.join("、")}。像顺口交代一句一样自然提起即可；用户说不要时直接删除对应日程。`,
      mode: "speak",
      source: "email",
    });
  }
}
