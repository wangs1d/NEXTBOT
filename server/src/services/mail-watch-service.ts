/**
 * 邮箱 IMAP 轮询服务（MailWatchService）——"Agent 帮用户盯消息"的入站邮件地基。
 *
 * 为什么是轮询而非 IDLE 长连接：
 *   - 私人管家场景分钟级延迟足够；轮询每轮新建连接、用完即弃，没有长连接状态机，
 *     断线语义清晰（连不上就是连续失败 + 退避重试），对家用/企业邮箱的 IMAP 限制也最友好。
 *   - 自适应节奏：收件箱安静时逐级拉长到 MAIL_WATCH_IDLE_MAX_SEC（默认 5min），
 *     拉到新邮件后先快节奏跟进两轮（可能还有同批/补发），再回到基础间隔。
 *     外部提示（手动刷新/重连/唤醒）调 wake() 立即拉一轮，不等退避走完。
 *   - 每轮 poll：连接 → 打开邮箱 → 取最新 N 封（uid/信封/正文摘要）→ 与落盘的
 *     已处理 UID 集合（data/mail-watch/processed-uids.json，原子写）做差量 →
 *     新邮件逐条分级（VIP 白名单 → 关键词规则 → normal，仅用于营销过滤与
 *     消息中心标注；说不说由情报链路的模型判断）→ onNewMessage 回调 + message-hub 落库。
 *
 * 诚实失败约定：未启用 / 未配置 / 连不上邮箱都如实反映在 status()（reason / lastError /
 * consecutiveFailures），绝不假装在盯；任何失败只退避重试，不 crash 主进程。
 *
 * UID 幂等约定：默认不标记邮件已读（MAIL_WATCH_MARK_SEEN=0），"处理过没有"只看本地
 * 已处理 UID 集合——用户邮箱里的已读状态不被 Agent 污染。UIDVALIDITY 变化（服务器
 * 重建邮箱）或首次接入时，把当前窗口整体记为已处理基线，只盯之后到达的新邮件，
 * 避免开启开关瞬间把历史邮件轰炸给用户。
 *
 * env 键（文档由主任务统一写进 .env.example）：
 *   MAIL_WATCH_ENABLED     默认 0（显式开启才工作）
 *   MAIL_WATCH_HOST        IMAP 服务器地址（启用时必填）
 *   MAIL_WATCH_PORT        默认 993（IMAPS）
 *   MAIL_WATCH_USER        登录账号（启用时必填）
 *   MAIL_WATCH_PASS        登录密码/授权码（启用时必填）
 *   MAIL_WATCH_MAILBOX     默认 INBOX
 *   MAIL_WATCH_POLL_SEC    基础轮询间隔秒，默认 120，下限 30（防把服务器拉黑）
 *   MAIL_WATCH_IDLE_MAX_SEC 收件箱安静时的间隔上限秒，默认 300（自适应退避封顶）
 *   MAIL_WATCH_MARK_SEEN   默认 0：不标已读，只在本地记录已处理 UID
 *   MAIL_WATCH_ACTOR_ID    消息归属用户；默认沿用消息桥的既有约定
 *                          MESSAGE_BRIDGE_DEFAULT_ACTOR_ID，再兜底 "default_user"
 *   MAIL_WATCH_VIP_SENDERS 逗号分隔的发件人白名单（命中即 critical），支持 @domain 整域
 *   MAIL_WATCH_FILTER_PROMO 默认 1：营销/广告邮件自动过滤（不推送、不进消息中心）；置 0 关闭
 */
import { getDataDir } from "../config/data-dir.js";
import { createHash } from "node:crypto";
import { join } from "node:path";

import iconv from "iconv-lite";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import type { MessageHubService } from "./message-hub-service.js";

// ---------------------------------------------------------------------- //
// 类型
// ---------------------------------------------------------------------- //

/** 邮件重要性：critical（VIP 直接置顶提醒）/ high（命中确定性重要场景）/ normal / promotional（营销邮件，过滤不推送）。 */
export type MailImportance = "critical" | "high" | "normal" | "promotional";

export interface MailWatchClassification {
  importance: MailImportance;
  /** 命中原因（规则标签 / VIP 地址），供 ProactivityHub 提案 evidence 与排障用 */
  reasons: string[];
}

/** 轮询取到的一封邮件（生产实现来自 imapflow envelope + 正文摘要）。 */
export interface MailWatchFetchedMail {
  uid: number;
  from: string;
  to: string;
  subject: string;
  /** ISO 时间（信封 Date 优先，退 internalDate） */
  date?: string;
  textSnippet?: string;
  /** 原始 RFC822 字节（截 256KB）：票务/日历提取从这里面拿全文与附件 */
  source?: Buffer;
}

/** handleIncoming 入参（对外稳定形状；uid/messageId 为轮询层可选补充，用于判重）。 */
export interface IncomingMail {
  actorId: string;
  from: string;
  to: string;
  subject: string;
  date?: string;
  textSnippet?: string;
  /** 原始 RFC822 字节（与 MailWatchFetchedMail.source 同源；提取层用） */
  source?: Buffer;
  /** 邮箱 UID：拼进 message-hub external_message_id 做稳定判重 */
  uid?: number;
  /** 未提供 uid 时的替代判重键 */
  messageId?: string;
}

/**
 * 最小 IMAP 客户端接口：按 imapflow 实际方法（connect/logout/mailboxOpen/
 * fetch/messageFlagsAdd）抽象出的最小面。测试注入假实现，生产用
 * {@link createImapflowClient}。
 */
export interface MailWatchClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** 打开邮箱；uidValidity 用于检测服务器端 UID 空间重置（重建邮箱后旧 UID 作废） */
  mailboxOpen(mailbox: string): Promise<{ uidValidity: number | bigint; exists: number }>;
  /** 取最新 limit 封（按 uid 升序返回），含信封与正文文本摘要 */
  fetchRecentMessages(limit: number): Promise<MailWatchFetchedMail[]>;
  /** 标记 \Seen（仅 MAIL_WATCH_MARK_SEEN=1 时被调用） */
  markSeen(uid: number): Promise<void>;
}

export type MailWatchLogger = (level: "info" | "warn" | "error", message: string) => void;

export interface MailWatchDeps {
  /** 每轮 poll 调用一次，产出一个全新连接的客户端（测试注入假实现，不发真网络请求） */
  clientFactory?: (cfg: {
    host: string;
    port: number;
    user: string;
    pass: string;
    mailbox: string;
  }) => MailWatchClient | Promise<MailWatchClient>;
  /** 新邮件分级完成后的回调（ProactivityHub 主动提醒接线点）；异常被吞掉，不阻断落库 */
  onNewMessage?: (mail: IncomingMail, classification: MailWatchClassification) => void | Promise<void>;
  /** 可选：邮件同步 ingest 进消息聚合中心（bootstrap 传 messageHubService） */
  messageHub?: Pick<MessageHubService, "ingestInbound"> | null;
  logger?: MailWatchLogger;
  /** 配置来源 env（默认 process.env；测试注入） */
  env?: NodeJS.ProcessEnv;
  /** processed-uids.json 落盘路径（默认 data/mail-watch/processed-uids.json，相对 cwd） */
  persistPath?: string;
  /** 差量窗口大小（每轮取最新 N 封），默认 50 */
  windowSize?: number;
}

export interface MailWatchConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox: string;
  pollSec: number;
  /** 安静时的间隔上限秒（自适应退避封顶） */
  idleMaxSec: number;
  markSeen: boolean;
  actorId: string;
  vipSenders: string[];
  /** 营销邮件过滤开关（默认开；MAIL_WATCH_FILTER_PROMO=0 显式关闭） */
  filterPromotional: boolean;
}

export interface MailWatchStatus {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  /** 是否有一轮拉取正在进行 */
  polling: boolean;
  /** 未运行时的如实原因（未启用/未配置/手动停止）；运行中为 null */
  reason: string | null;
  host: string;
  port: number;
  user: string;
  mailbox: string;
  pollSec: number;
  idleMaxSec: number;
  markSeen: boolean;
  actorId: string;
  vipSenderCount: number;
  /** 营销邮件过滤开关状态（与 cfg.filterPromotional 一致，供设置页展示） */
  filterPromotional: boolean;
  /** 已累计过滤的营销邮件数（观测过滤是否生效） */
  promotionalFiltered: number;
  windowSize: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  /** 最近一轮失败原因（诚实失败：连不上就如实暴露，不假装在盯） */
  lastError: string | null;
  consecutiveFailures: number;
  /** 下一轮计划间隔秒（退避时大于 pollSec）；未运行时为 null */
  retryDelaySec: number | null;
  /** 连续空轮数（自适应退避的当前档位） */
  idleRounds: number;
  /** 新邮件后的快节奏跟进剩余轮数 */
  burstRounds: number;
  processedUidCount: number;
  uidValidity: string | null;
  newMessagesHandled: number;
}

// ---------------------------------------------------------------------- //
// 配置
// ---------------------------------------------------------------------- //

/** 与 message-bridge-service 同一套布尔 env 解析（1/true/yes/on）。 */
function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const DEFAULT_POLL_SEC = 120;
const MIN_POLL_SEC = 30;
const MAX_POLL_SEC = 3600;
/** 收件箱安静时的间隔上限（自适应退避封顶；再长就等于"不盯"了） */
const DEFAULT_IDLE_MAX_SEC = 300;
/** 新邮件后的快节奏跟进间隔（可能还有同批/补发邮件） */
const BURST_INTERVAL_MS = 60_000;
const BURST_ROUNDS = 2;
/** 外部唤醒的最小间隔（防手动连点把邮箱拉黑） */
const MIN_WAKE_INTERVAL_MS = 5_000;
const DEFAULT_WINDOW_SIZE = 50;

/**
 * 自适应轮询间隔（ms）：新邮件后快节奏跟进，空轮逐级翻倍，封顶 idleMaxSec。
 * 远程订阅类信源的通用节奏：省的是空转，不是该看的时刻。
 */
export function adaptiveMailDelayMs(pollSec: number, idleRounds: number, idleMaxSec: number, burstRounds: number): number {
  const baseMs = pollSec * 1000;
  if (burstRounds > 0) return Math.max(MIN_POLL_SEC * 1000, Math.min(baseMs, BURST_INTERVAL_MS));
  if (idleRounds <= 0) return baseMs;
  return Math.min(idleMaxSec * 1000, baseMs * 2 ** Math.min(idleRounds, 4));
}

export function readMailWatchConfig(env: NodeJS.ProcessEnv = process.env): MailWatchConfig {
  const portRaw = Number(env.MAIL_WATCH_PORT ?? "");
  const pollRaw = Number(env.MAIL_WATCH_POLL_SEC ?? "");
  const idleRaw = Number(env.MAIL_WATCH_IDLE_MAX_SEC ?? "");
  const pollSec = Math.min(
    MAX_POLL_SEC,
    Math.max(MIN_POLL_SEC, Number.isFinite(pollRaw) && pollRaw > 0 ? Math.trunc(pollRaw) : DEFAULT_POLL_SEC),
  );
  return {
    enabled: parseBooleanEnv(env.MAIL_WATCH_ENABLED),
    host: env.MAIL_WATCH_HOST?.trim() ?? "",
    port: Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : 993,
    user: env.MAIL_WATCH_USER?.trim() ?? "",
    pass: env.MAIL_WATCH_PASS?.trim() ?? "",
    mailbox: env.MAIL_WATCH_MAILBOX?.trim() || "INBOX",
    // 下限 30s：太频繁的轮询容易被邮箱服务商判定滥用封号；上限 1h 防止配置成"永不盯"
    pollSec,
    // 安静上限不低于基础间隔、不超过 1h
    idleMaxSec: Math.min(MAX_POLL_SEC, Math.max(pollSec, Number.isFinite(idleRaw) && idleRaw > 0 ? Math.trunc(idleRaw) : DEFAULT_IDLE_MAX_SEC)),
    markSeen: parseBooleanEnv(env.MAIL_WATCH_MARK_SEEN),
    // actorId 归属约定：优先显式 MAIL_WATCH_ACTOR_ID；否则沿用消息桥的默认用户 env；
    // 都没有时兜底 default_user（私人管家单用户场景的约定名）
    actorId: env.MAIL_WATCH_ACTOR_ID?.trim() || env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim() || "default_user",
    vipSenders: (env.MAIL_WATCH_VIP_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // 营销过滤默认开启；仅显式 MAIL_WATCH_FILTER_PROMO=0/false 才关闭（误杀兜底阀门）
    filterPromotional: !["0", "false", "off", "no"].includes(env.MAIL_WATCH_FILTER_PROMO?.trim().toLowerCase() ?? ""),
  };
}

// ---------------------------------------------------------------------- //
// 重要性分级（零 LLM，确定性规则，数据驱动便于扩充）
// ---------------------------------------------------------------------- //

/**
 * 确定性重要邮件关键词规则表：按序匹配，命中第一条即返回 high。
 * 覆盖国内高频重要场景（验证码/账单/逾期/传票/面试/机票/火车票/登机牌/快递驿站等），
 * 中英文都收。新增场景直接在数组里加一行即可，无需改逻辑。
 * fields 控制该规则看哪些字段（默认主题 + 正文摘要都看）。
 */
const IMPORTANCE_RULES: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  fields?: ReadonlyArray<"subject" | "text">;
}> = [
  // —— 账户安全类（时效最强，过期即作废）——
  { label: "验证码/安全码", pattern: /(验证码|校验码|动态码|确认码|安全码|verification\s*code|security\s*code|one[-\s]?time\s*(?:code|password)|\botp\b)/i },
  // —— 财务类 ——
  { label: "账单/还款", pattern: /(账单|扣款|还款|付款提醒|代扣|对账单|invoice|payment\s*(?:due|reminder)|billing)/i },
  { label: "逾期/欠费", pattern: /(逾期|欠费|滞纳|违约金|overdue|past\s*due)/i },
  // —— 法律类（传票/法院文书，绝不许漏看）——
  { label: "传票/法院文书", pattern: /(传票|开庭|应诉|起诉|立案通知|法院|法律文书|subpoena|court\s*(?:summons|notice))/i },
  // —— 求职/职业类 ——
  { label: "面试/入职", pattern: /(面试|入职通知|offer\s*(?:确认|通知)|interview\s*(?:invitation|invite|confirmation))/i },
  // —— 出行类 ——
  { label: "机票/航班", pattern: /(机票|航班|登机牌|值机|出票|flight|boarding\s*pass)/i },
  { label: "火车票/车票", pattern: /(火车票|高铁|动车|车票|列车时刻|train\s*ticket)/i },
  // —— 生活服务类（国内快递驿站取件是高频重要事项）——
  { label: "快递/驿站取件", pattern: /(快递|包裹|取件码|驿站|parcel|pickup\s*code)/i },
  // —— 日程/预约类 ——
  { label: "预约/日程变动", pattern: /(预约(?:成功|确认|变动)|改期|改签|日程调整|appointment\s*(?:confirmed|changed)|reschedul)/i },
  // —— 教育/升学类 ——
  { label: "成绩/录取/考试", pattern: /(成绩单?|录取|准考证|admission|exam\s*result)/i },
];

/** 从 "Name <a@b>" / "a@b" 形态提取纯邮箱地址。 */
export function extractEmailAddress(from: string): string {
  const m = (from ?? "").match(/<([^>]+)>/);
  return (m?.[1] ?? from ?? "").trim();
}

/** 从 "Name <a@b>" 提取显示名（无则返回空串）。 */
export function extractDisplayName(from: string): string {
  const m = (from ?? "").match(/^\s*"?([^"<]*?)"?\s*</);
  return m?.[1]?.trim() ?? "";
}

/** VIP 白名单匹配：支持精确地址与 "@domain" 整域两种写法；命中返回命中项，未命中 null。 */
function matchesVipSender(from: string, vipSenders: readonly string[]): string | null {
  const addr = extractEmailAddress(from).toLowerCase();
  if (!addr) return null;
  for (const entry of vipSenders) {
    const t = entry.trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith("@") ? addr.endsWith(t) : addr === t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------- //
// 营销/广告邮件识别（零 LLM 确定性规则；命中即过滤：不推送、不进消息中心）
// ---------------------------------------------------------------------- //

/**
 * 主题级营销关键词：命中即判营销。只看主题不看正文——验证码/账单这类
 * 事务性邮件正文里也可能带营销尾巴，主题误杀率最低。
 * 中英文都收；英文用词边界防 "wholesale" 这类子串误伤。
 */
const PROMO_SUBJECT_PATTERN =
  /(促销|优惠|折扣|特惠|秒杀|满减|满赠|立减|返现|返券|红包|优惠券|代金券|大促|清仓|闪购|拼团|免单|0元购|0元领|免费领|扫码领|立省|抽奖|专享|会员日|双十一|双11|黑五|年货节|购物节|退订|取消订阅|\b(?:sale|promos?|promotions?|discount|discounts|coupon|coupons|deals?|cashback|clearance|newsletter|unsubscribe|exclusive\s+offer|limited[-\s]?time\s+offer)\b)/i;

/** 发件人地址营销位特征（local part）：promo@/marketing@/newsletter@ 这类明显营销身份。 */
const PROMO_FROM_LOCAL_PATTERN = /(?:^|[._-])(?:promo|promotion|marketing|newsletter|edm|deals|offers|sales|advertising)(?:[._-]|$)/i;

/** 正文退订尾巴：营销邮件的行业标配信号（RFC 合规要求带退订入口）。 */
const PROMO_UNSUBSCRIBE_TEXT_PATTERN = /(退订|取消订阅|不再接收|停止接收|拒收此类邮件|unsubscribe|opt[-\s]?out\s+of\s+(?:these\s+)?emails)/i;

/** 正文营销关键词（与退订尾巴组合使用才判营销，单独出现不判）。 */
const PROMO_TEXT_KEYWORD_PATTERN = /(促销|优惠|折扣|特惠|秒杀|满减|立减|返现|红包|优惠券|大促|清仓|闪购|拼团|抽奖|\b(?:sale|promos?|promotions?|discount|coupon|deals?|cashback|clearance)\b)/i;

/**
 * List-Unsubscribe 头探测（RFC 2369/8058）：合规营销邮件的最强信号，
 * 误杀率极低（事务性邮件不带此头）。只扫顶部头区（首个空行之前），
 * 防止正文里恰好出现同样字样造成误判。
 */
function hasListUnsubscribeHeader(source: Buffer | null | undefined): boolean {
  if (!source || source.length === 0) return false;
  try {
    const head = source.subarray(0, 32768).toString("latin1");
    const sep = head.indexOf("\r\n\r\n") >= 0 ? head.indexOf("\r\n\r\n") : head.indexOf("\n\n");
    const headerBlock = sep >= 0 ? head.slice(0, sep) : head;
    return /^list-unsubscribe(?:-post)?:/im.test(headerBlock);
  } catch {
    return false;
  }
}

/**
 * 营销/广告邮件识别（确定性规则，数据驱动便于扩充）：
 *   a) List-Unsubscribe 头（最强信号，直接命中）；
 *   b) 主题命中营销关键词（营销邮件的主题必带钩子词）；
 *   c) 发件人是营销位地址（promo@/newsletter@）且正文带退订尾巴；
 *   d) 正文同时带退订尾巴与营销关键词（有退订入口兜底的优惠内容）。
 * 保守策略：纯正文关键词不判营销（事务邮件也会提"优惠"），必须主题/头/发件人佐证。
 */
export function detectPromotionalMail(
  mail: Pick<IncomingMail, "from" | "subject" | "textSnippet" | "source">,
): { promotional: boolean; reason: string } {
  if (hasListUnsubscribeHeader(mail.source)) {
    return { promotional: true, reason: "promo:list_unsubscribe_header" };
  }
  const subject = mail.subject ?? "";
  if (PROMO_SUBJECT_PATTERN.test(subject)) {
    return { promotional: true, reason: "promo:subject_keyword" };
  }
  const text = mail.textSnippet ?? "";
  const addr = extractEmailAddress(mail.from);
  const local = addr.split("@")[0] ?? "";
  const fromPromo = PROMO_FROM_LOCAL_PATTERN.test(local);
  const unsubTail = PROMO_UNSUBSCRIBE_TEXT_PATTERN.test(text);
  if (fromPromo && unsubTail) {
    return { promotional: true, reason: "promo:from_role+unsub_footer" };
  }
  if (unsubTail && PROMO_TEXT_KEYWORD_PATTERN.test(text)) {
    return { promotional: true, reason: "promo:unsub_footer+promo_keyword" };
  }
  return { promotional: false, reason: "" };
}

/**
 * 邮件重要性分级：
 *   a) VIP 白名单命中 → "critical"（用户钦点的发件人，永远最高优先级，
 *      即便发的是营销邮件也照常提醒——白名单是用户的显式意志）；
 *   b) 营销/广告邮件识别命中且过滤开关开启 → "promotional"（不推送不落库）；
 *   c) 确定性关键词规则命中 → "high"（按 IMPORTANCE_RULES 顺序，命中第一条即返回）；
 *   d) 其余 → "normal"。
 * 返回 { importance, reasons[] }，reasons 记录命中来源便于解释与排障。
 */
export function classifyMailImportance(
  mail: Pick<IncomingMail, "from" | "subject" | "textSnippet" | "source">,
  vipSenders: readonly string[] = [],
  opts: { filterPromotional?: boolean } = {},
): MailWatchClassification {
  const vipHit = matchesVipSender(mail.from ?? "", vipSenders);
  if (vipHit) {
    return { importance: "critical", reasons: [`vip_sender:${vipHit}`] };
  }
  if (opts.filterPromotional !== false) {
    const promo = detectPromotionalMail(mail);
    if (promo.promotional) {
      return { importance: "promotional", reasons: [promo.reason] };
    }
  }
  const subject = mail.subject ?? "";
  const text = mail.textSnippet ?? "";
  for (const rule of IMPORTANCE_RULES) {
    const fields = rule.fields ?? (["subject", "text"] as const);
    if (fields.includes("subject") && rule.pattern.test(subject)) {
      return { importance: "high", reasons: [`rule:${rule.label}`, "field:subject"] };
    }
    if (fields.includes("text") && rule.pattern.test(text)) {
      return { importance: "high", reasons: [`rule:${rule.label}`, "field:text"] };
    }
  }
  return { importance: "normal", reasons: [] };
}

// ---------------------------------------------------------------------- //
// 原始邮件正文摘要提取（生产适配器用；尽力而为，失败返回空串）
// ---------------------------------------------------------------------- //

const MAIL_TEXT_SNIPPET_MAX = 1500;

/**
 * 从原始邮件字节中尽力提取正文文本摘要（text/plain 优先，退 HTML 去标签）。
 * 为什么自写而不用 mailparser：这里只需要"摘要"级文本（给规则分级用），不值得多引一个
 * 重依赖；任何解析失败一律返回 ""（分类退化为只看主题，不影响主链路）。
 * 仅处理 latin1 字符串域的切分（字节 1:1 往返无损），真正解码时再转回 Buffer。
 */
export function extractMailTextSnippet(source: Buffer | null | undefined, maxLen = MAIL_TEXT_SNIPPET_MAX): string {
  if (!source || source.length === 0) return "";
  try {
    const raw = source.toString("latin1");
    const top = splitHeaderBody(raw);
    const found = extractPartText(top.headers, top.body, 0);
    if (!found) return "";
    return found.text.length > maxLen ? `${found.text.slice(0, maxLen)}…` : found.text;
  } catch {
    return "";
  }
}

function splitHeaderBody(raw: string): { headers: string; body: string } {
  const iCrlf = raw.indexOf("\r\n\r\n");
  const iLf = raw.indexOf("\n\n");
  let idx = -1;
  let sepLen = 0;
  if (iCrlf >= 0 && iLf >= 0) {
    if (iCrlf <= iLf) {
      idx = iCrlf;
      sepLen = 4;
    } else {
      idx = iLf;
      sepLen = 2;
    }
  } else if (iCrlf >= 0) {
    idx = iCrlf;
    sepLen = 4;
  } else if (iLf >= 0) {
    idx = iLf;
    sepLen = 2;
  }
  if (idx < 0) return { headers: raw, body: "" };
  return { headers: raw.slice(0, idx), body: raw.slice(idx + sepLen) };
}

/** 递归提取实体文本：multipart 下钻（深度限 5 防恶意嵌套），text/* 解码，其他跳过。 */
function extractPartText(headersBlock: string, body: string, depth: number): { mime: string; text: string } | null {
  const ct = parseContentType(headersBlock);
  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary || depth >= 5) return null;
    for (const child of splitMultipart(body, boundary)) {
      const found = extractPartText(child.headers, child.body, depth + 1);
      if (found) return found; // multipart/alternative 中 text/plain 约定在前，自然优先
    }
    return null;
  }
  if (!ct.type.startsWith("text/")) return null;
  const cte = readHeader(headersBlock, "content-transfer-encoding");
  const decoded = decodeCharset(decodeTransferEncoding(body, cte), ct.params.charset);
  const text = (ct.type === "text/html" ? htmlToText(decoded) : decoded).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { mime: ct.type, text };
}

/** 按 boundary 切分 multipart body，返回各子件的 {headers, body}（跳过 preamble/epilogue）。 */
function splitMultipart(body: string, boundary: string): Array<{ headers: string; body: string }> {
  const out: Array<{ headers: string; body: string }> = [];
  const sections = body.split(`--${boundary}`);
  for (let i = 1; i < sections.length; i++) {
    const seg = sections[i] ?? "";
    if (seg.startsWith("--")) break; // closing delimiter，后面是 epilogue
    let s = seg;
    if (s.startsWith("\r\n")) s = s.slice(2);
    else if (s.startsWith("\n")) s = s.slice(1);
    const pair = splitHeaderBody(s);
    out.push(pair);
  }
  return out;
}

function parseContentType(headersBlock: string): { type: string; params: Record<string, string> } {
  const raw = readHeader(headersBlock, "content-type");
  if (!raw) return { type: "text/plain", params: {} }; // RFC 5322 缺省即 text/plain
  const [rawType, ...rest] = raw.split(";");
  const type = rawType.trim().toLowerCase() || "text/plain";
  const params: Record<string, string> = {};
  for (const kv of rest) {
    const eq = kv.indexOf("=");
    if (eq < 0) continue;
    const k = kv.slice(0, eq).trim().toLowerCase();
    const v = kv.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (k) params[k] = v;
  }
  return { type, params };
}

/** 读单个头（先折叠续行再匹配，大小写不敏感）。 */
function readHeader(headersBlock: string, name: string): string {
  const unfolded = headersBlock.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  return unfolded.match(re)?.[1]?.trim() ?? "";
}

function decodeTransferEncoding(bodyLatin: string, cte: string): Buffer {
  const enc = cte.toLowerCase().trim();
  if (enc === "base64") {
    return Buffer.from(bodyLatin.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(bodyLatin);
  return Buffer.from(bodyLatin, "latin1");
}

/** quoted-printable 手工解码（软换行剔除 + =XX 十六进制还原字节）。 */
function decodeQuotedPrintable(body: string): Buffer {
  const noSoftBreaks = body.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const ch = noSoftBreaks[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoftBreaks.slice(i + 1, i + 3))) {
      out.push(parseInt(noSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(noSoftBreaks.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** 字符集解码：GBK/Big5 系走 iconv-lite（与 web-fetch-enhancer 同一约定），其余 TextDecoder。 */
function decodeCharset(buf: Buffer, charset?: string): string {
  const enc = (charset ?? "utf-8").toLowerCase().replace(/^"+|"+$/g, "");
  if (enc.includes("gb") || enc === "big5") {
    try {
      return iconv.decode(buf, enc.includes("big5") ? "big5" : "gbk");
    } catch {
      /* 落到 TextDecoder 兜底 */
    }
  }
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

/**
 * 常用命名 HTML 实体表（营销邮件正文的最低频集合；数字实体由通用规则兜底全量解码）。
 * shy 映射空串：soft hyphen 是隐形断字提示，解码后直接删除而非保留。
 */
const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±", middot: "·", bull: "•",
  cent: "¢", pound: "£", yen: "¥", euro: "€", sect: "§", para: "¶",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
  larr: "←", uarr: "↑", rarr: "→", darr: "↓", infin: "∞",
  iexcl: "¡", iquest: "¿", szlig: "ß", micro: "µ", dagger: "†", Dagger: "‡",
  permil: "‰", prime: "′", Prime: "″", oline: "‾", frasl: "⁄",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
};

/**
 * 解码 HTML 实体（数字十进制/十六进制全量 + 上表命名实体）。
 * 邮件 HTML 正文里 &#847;（组合字形连接符）、&shy;（软连字符）等隐形字符是
 * 营销邮件对抗过滤器的常见伎俩，必须解码后清除（见 stripInvisibleMailChars）。
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const mapped = NAMED_HTML_ENTITIES[body] ?? NAMED_HTML_ENTITIES[body.toLowerCase()];
    return mapped ?? whole;
  });
}

/**
 * 清除邮件文本中的隐形/零宽字符：软连字符、组合字形连接符（&#847;）、
 * 零宽空格系列、双向文本控制符、BOM、替换符。这些字符肉眼不可见但会污染
 * 展示文本（截图里整屏 &#847; &shy; 的乱码来源），也干扰关键词匹配。
 */
export function stripInvisibleMailChars(text: string): string {
  return text.replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\uFFF9-\uFFFB\uFFFD]/g, "");
}

/** 邮件短文本（主题/显示名）净化：解码实体 + 清除隐形字符 + 折叠空白。 */
export function sanitizeMailText(text: string): string {
  return stripInvisibleMailChars(decodeHtmlEntities(text ?? "")).replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  return stripInvisibleMailChars(
    decodeHtmlEntities(
      html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " "),
    ),
  );
}

/**
 * 提取邮件全文与 ICS 日历附件（票务→日程提取用；尽力而为，失败返回空）。
 * 与 extractMailTextSnippet 共用同一套手写 MIME 解析件，区别：
 *   - fullText 收全部 text/* 部件（plain 优先、HTML 去标签），拼接后截 12000 字符（规则正则用）；
 *   - icsTexts 收 text/calendar 部件或 .ics 附件（保真解码，不折叠空白——喂 RFC5545 解析器）。
 */
export function extractMailCalendarParts(
  source: Buffer | null | undefined,
): { fullText: string; icsTexts: string[] } {
  const empty = { fullText: "", icsTexts: [] as string[] };
  if (!source || source.length === 0) return empty;
  try {
    const raw = source.toString("latin1");
    const top = splitHeaderBody(raw);
    const texts: string[] = [];
    const icsTexts: string[] = [];
    const walk = (headersBlock: string, body: string, depth: number): void => {
      const ct = parseContentType(headersBlock);
      if (ct.type.startsWith("multipart/")) {
        const boundary = ct.params.boundary;
        if (!boundary || depth >= 5) return;
        for (const child of splitMultipart(body, boundary)) walk(child.headers, child.body, depth + 1);
        return;
      }
      if (!ct.type.startsWith("text/")) return;
      const cte = readHeader(headersBlock, "content-transfer-encoding");
      const decoded = decodeCharset(decodeTransferEncoding(body, cte), ct.params.charset);
      const disposition = readHeader(headersBlock, "content-disposition").toLowerCase();
      const filenameHint = `${ct.params.name ?? ""} ${/filename\s*=\s*"?([^";]+)"?/.exec(disposition)?.[1] ?? ""}`;
      if (ct.type === "text/calendar" || /\.ics\b/i.test(filenameHint.trim())) {
        icsTexts.push(decoded);
        return;
      }
      const text = (ct.type === "text/html" ? htmlToText(decoded) : decoded).replace(/[ \t]+/g, " ").trim();
      if (text) texts.push(text);
    };
    walk(top.headers, top.body, 0);
    return {
      fullText: texts.join("\n").slice(0, 12000),
      icsTexts,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------- //
// 生产默认客户端工厂（imapflow）
// ---------------------------------------------------------------------- //

export interface ImapflowClientConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

function formatAddressList(list?: Array<{ name?: string; address?: string }>): string {
  if (!list?.length) return "";
  return list
    .map((a) => (a.name ? `${sanitizeMailText(a.name)} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

/**
 * 生产默认 IMAP 客户端：imapflow 实现，每轮 poll 新建连接、用完即弃。
 * 动态 import：测试/未启用场景完全不加载 imapflow 模块。
 */
export async function createImapflowClient(cfg: ImapflowClientConfig): Promise<MailWatchClient> {
  const { ImapFlow } = await import("imapflow");
  // 143 端口走 STARTTLS（imapflow 自动升级），其余（993）显式 TLS
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port !== 143,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false, // imapflow 自带日志过啰嗦；统一走本服务 logger
    emitLogs: false,
  });
  // mailboxOpen 后记录 exists，fetchRecentMessages 直接用（避免依赖 client.mailbox 内部状态类型）
  let openedExists = 0;

  return {
    async connect() {
      await client.connect();
    },
    async logout() {
      try {
        await client.logout();
      } catch {
        // 连接可能已断（对端重置/超时）：直接关闭 socket，不向上抛
        try {
          client.close();
        } catch {
          /* 已断开，忽略 */
        }
      }
    },
    async mailboxOpen(mailbox) {
      const box = await client.mailboxOpen(mailbox);
      openedExists = box.exists;
      return { uidValidity: box.uidValidity, exists: box.exists };
    },
    async fetchRecentMessages(limit) {
      if (openedExists < 1) return [];
      // 按序列号取"最新 limit 封"窗口；source 截断 256KB 防大附件拖垮轮询
      const start = Math.max(1, openedExists - limit + 1);
      const out: MailWatchFetchedMail[] = [];
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        source: { maxLength: 262144 },
      })) {
        const env = msg.envelope;
        const date =
          msg.internalDate instanceof Date
            ? msg.internalDate.toISOString()
            : env?.date instanceof Date
              ? env.date.toISOString()
              : undefined;
        out.push({
          uid: msg.uid,
          from: formatAddressList(env?.from),
          to: formatAddressList(env?.to),
          // 主题/显示名同样可能带 HTML 实体与隐形字符（营销邮件干扰手段），统一净化
          subject: sanitizeMailText(env?.subject ?? ""),
          date,
          textSnippet: extractMailTextSnippet(msg.source),
          source: msg.source ?? undefined,
        });
      }
      return out.sort((a, b) => a.uid - b.uid);
    },
    async markSeen(uid) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
  };
}

// ---------------------------------------------------------------------- //
// 服务主体
// ---------------------------------------------------------------------- //

const STATE_VERSION = 1;
/** 已处理 UID 集合上限：只保留最近 N 个，防止几十年后文件膨胀（实际远用不到） */
const MAX_PERSISTED_UIDS = 2000;
/** 轮询失败退避：30s 起步指数翻倍，5min 封顶 */
const POLL_BACKOFF_BASE_MS = 30_000;
const POLL_BACKOFF_MAX_MS = 5 * 60_000;

interface MailWatchState {
  version: number;
  initialized: boolean;
  uidValidity: string;
  uids: number[];
}

function emptyState(uidValidity = ""): MailWatchState {
  return { version: STATE_VERSION, initialized: false, uidValidity, uids: [] };
}

export class MailWatchService {
  private readonly deps: MailWatchDeps;
  /** 配置（构造固化自 env；applyAutoAccount 可写 host/user/port/actorId/enabled） */
  private readonly cfg: MailWatchConfig;
  private readonly statePath: string;
  private readonly windowSize: number;

  private running = false;
  private polling = false;
  private reason: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private lastPollAt: string | null = null;
  private lastPollStartedMs = 0;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private retryDelaySec: number | null = null;
  private idleRounds = 0;
  private burstRounds = 0;
  private pendingWake = false;
  private newMessagesHandled = 0;
  private promotionalFiltered = 0;
  /**
   * 最近处理过的邮件环形缓冲（2026-10-10，供 SensorKernel 收编读取）：
   * `fetchNewSince(since)` 从这里取，不重连 IMAP。内核轮询内核水位，
   * 服务自身轮询照旧——两者共享同一份处理结果，零重复网络开销。
   */
  private readonly recentMails: Array<{ uid: number; at: number; mail: IncomingMail; importance: string }> = [];

  constructor(deps: MailWatchDeps = {}) {
    this.deps = deps;
    this.cfg = readMailWatchConfig(deps.env ?? process.env);
    // 数据路径与其他服务一致：统一数据目录（config/data-dir）
    this.statePath = deps.persistPath ?? join(getDataDir(), "mail-watch", "processed-uids.json");
    this.windowSize = deps.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  // ---------------- 生命周期 ----------------

  /**
   * 启动轮询。未启用或未配置时直接 no-op（不抛错），并在 status().reason 里如实说明——
   * 装配层可以无脑 start()，由 status() 判断真实状态。
   */
  start(): void {
    if (this.running) return; // 幂等：重复 start 忽略
    if (!this.cfg.enabled) {
      this.reason = "MAIL_WATCH_ENABLED=0：邮箱盯梢未启用";
      this.log("info", `未启动：${this.reason}`);
      return;
    }
    if (!this.isConfigured()) {
      this.reason = this.cfg.host && this.cfg.user
        ? "等待邮箱授权码：IMAP 需要授权码而非登录密码，请在设置页配置（MAIL_WATCH_PASS）"
        : "邮箱盯梢未配置：需要 MAIL_WATCH_HOST / MAIL_WATCH_USER / MAIL_WATCH_PASS";
      this.log("info", `未启动：${this.reason}`);
      return;
    }
    this.reason = null;
    this.running = true;
    this.log(
      "info",
      `邮箱盯梢已启动：${this.cfg.user}@${this.cfg.host}:${this.cfg.port}（${this.cfg.mailbox}，${this.cfg.pollSec}s 起，安静时最慢 ${this.cfg.idleMaxSec}s）`,
    );
    this.scheduleTick(0); // 启动即拉第一轮
  }

  /**
   * 外部唤醒：立即拉一轮（手动刷新 / 手机重连 / 内核提示有新数据）。
   * 退避省的是空转，不是该看的时刻——但 5s 内重复唤醒忽略，防连点把邮箱拉黑。
   */
  wake(reason = "manual"): void {
    if (!this.running) return;
    const now = Date.now();
    if (this.polling) {
      this.pendingWake = true;
      return;
    }
    if (now - this.lastPollStartedMs < MIN_WAKE_INTERVAL_MS) return;
    this.lastPollStartedMs = now; // 连点节流：这次唤醒已算一次拉取承诺
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("info", `外部唤醒（${reason}）：立即拉取`);
    this.scheduleTick(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    this.running = false;
    this.retryDelaySec = null;
    this.reason = "已手动停止";
    this.log("info", "邮箱盯梢已停止");
  }

  /** 配置是否齐备（host/user/pass）。 */
  isConfigured(): boolean {
    return Boolean(this.cfg.host && this.cfg.user && this.cfg.pass);
  }

  /**
   * 授权码提交（设置页）：配置后即刻尝试启动轮询。返回启动后状态供 UI 刷新。
   * 本进程内生效；持久化由客户端写 config.env（重启后 runtime 环境注入回来）。
   */
  applyPass(pass: string): MailWatchStatus {
    this.cfg.pass = pass.trim();
    if (!this.cfg.enabled) this.cfg.enabled = true;
    this.start();
    return this.status();
  }

  /**
   * 邮箱自动接入（P2 2026-10-01）：用户 env 未显式配 host/user 时，用注册表
   * 解析出的账号自动补全（host 按域映射、user=email、actorId=账号 id）。
   * 授权码（pass）服务端无从得知——缺时 start() 仍如实报 needs_pass，
   * 用户在设置页/env 填一次即全链点亮。已显式配置时本方法不覆盖（env 优先）。
   */
  applyAutoAccount(acct: {
    actorId: string;
    email: string;
    imapHost: string;
    imapPort: number;
  }): void {
    if (process.env.MAIL_WATCH_HOST?.trim() || process.env.MAIL_WATCH_USER?.trim()) return;
    this.cfg.host = acct.imapHost;
    this.cfg.port = acct.imapPort;
    this.cfg.user = acct.email;
    this.cfg.actorId = acct.actorId;
    // enabled 未显式开启时自动开启（自动接入的语义就是「登录即接入」）
    if (!this.cfg.enabled) this.cfg.enabled = true;
    this.log(
      "info",
      `邮箱自动接入：${acct.email} → ${acct.imapHost}（actor=${acct.actorId}）${this.cfg.pass ? "" : "；等待授权码（设置页 MAIL_WATCH_PASS）"}`,
    );
  }

  /** 当前快照（管理面/工具查询用；含诚实失败信息）。 */
  status(): MailWatchStatus {
    const state = this.loadState();
    return {
      enabled: this.cfg.enabled,
      configured: this.isConfigured(),
      running: this.running,
      polling: this.polling,
      reason: this.reason,
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      mailbox: this.cfg.mailbox,
      pollSec: this.cfg.pollSec,
      idleMaxSec: this.cfg.idleMaxSec,
      markSeen: this.cfg.markSeen,
      actorId: this.cfg.actorId,
      vipSenderCount: this.cfg.vipSenders.length,
      filterPromotional: this.cfg.filterPromotional,
      promotionalFiltered: this.promotionalFiltered,
      windowSize: this.windowSize,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      retryDelaySec: this.retryDelaySec,
      idleRounds: this.idleRounds,
      burstRounds: this.burstRounds,
      processedUidCount: state.uids.length,
      uidValidity: state.uidValidity || null,
      newMessagesHandled: this.newMessagesHandled,
    };
  }

  // ---------------- 轮询 ----------------

  /**
   * 单轮拉取（不抛错）。返回 { ok: true, handled } 或 { ok: false, error }；
   * 失败/恢复的记账（lastError / consecutiveFailures）就地维护——诚实失败：
   * 无论从轮询循环还是外部直接调用，status() 都能看到真实状态。
   */
  async pollOnce(): Promise<{ ok: true; handled: number } | { ok: false; error: string }> {
    this.lastPollStartedMs = Date.now();
    if (!this.deps.clientFactory) {
      const err = "clientFactory 未注入（未接生产 imapflow 工厂）";
      this.recordFailure(err);
      return { ok: false, error: err };
    }
    this.lastPollAt = new Date().toISOString();
    let client: MailWatchClient;
    try {
      client = await this.deps.clientFactory({
        host: this.cfg.host,
        port: this.cfg.port,
        user: this.cfg.user,
        pass: this.cfg.pass,
        mailbox: this.cfg.mailbox,
      });
    } catch (e) {
      const err = `创建 IMAP 客户端失败：${errorMessage(e)}`;
      this.recordFailure(err);
      return { ok: false, error: err };
    }
    try {
      await client.connect();
      const box = await client.mailboxOpen(this.cfg.mailbox);
      const uidValidity = String(box.uidValidity);
      let state = this.loadState();
      if (state.initialized && state.uidValidity && state.uidValidity !== uidValidity) {
        // UIDVALIDITY 变化 = 服务器重建了邮箱（旧 UID 全部作废）：旧记录不可再用于判重，
        // 重新以当前窗口为基线（不轰炸历史邮件）
        this.log("warn", `UIDVALIDITY 变化（${state.uidValidity} → ${uidValidity}）：旧已处理记录作废，重建基线`);
        state = emptyState();
      }

      const mails = await client.fetchRecentMessages(this.windowSize);
      const known = new Set(state.uids);
      const fresh = mails.filter((m) => !known.has(m.uid)).sort((a, b) => a.uid - b.uid);

      if (!state.initialized) {
        // 首次接入（或基线重建）：当前窗口整体记为已处理，只盯"之后到达"的新邮件，
        // 避免开启开关瞬间把最近 50 封历史邮件全部当成新消息轰炸用户
        this.saveState({
          version: STATE_VERSION,
          initialized: true,
          uidValidity,
          uids: mails.map((m) => m.uid).sort((a, b) => a - b).slice(-MAX_PERSISTED_UIDS),
        });
        this.noteSuccess();
        return { ok: true, handled: 0 };
      }

      let handled = 0;
      for (const mail of fresh) {
        await this.handleIncoming({
          actorId: this.cfg.actorId,
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          date: mail.date,
          textSnippet: mail.textSnippet,
          // 原文透传：票务桥解 MIME/ICS、营销过滤探 List-Unsubscribe 头都靠它
          // （此前漏传导致生产上票务桥永远拿不到 source、直接空返回）
          source: mail.source,
          uid: mail.uid,
          messageId: `mailwatch:${this.cfg.user}:${mail.uid}`,
        });
        known.add(mail.uid);
        handled += 1;
        if (this.cfg.markSeen) {
          try {
            await client.markSeen(mail.uid);
          } catch (e) {
            // 标已读失败不影响消息处理（消息已回调/落库）；下轮该邮件也不会重推（UID 已记录）
            this.log("warn", `标记已读失败（uid=${mail.uid}，忽略）：${errorMessage(e)}`);
          }
        }
      }
      this.saveState({
        version: STATE_VERSION,
        initialized: true,
        uidValidity,
        uids: Array.from(known).sort((a, b) => a - b).slice(-MAX_PERSISTED_UIDS),
      });
      this.noteSuccess();
      return { ok: true, handled };
    } catch (e) {
      const err = errorMessage(e);
      this.recordFailure(err);
      return { ok: false, error: err };
    } finally {
      // 每轮连接用完即弃：logout 失败（连接已断）吞掉，下轮新建连接
      try {
        await client.logout();
      } catch {
        /* 忽略 */
      }
    }
  }

  // ---------------- 消息处理 ----------------

  /**
   * 单封新邮件处理：分级 → onNewMessage 抛给装配层（ProactivityHub 接线点）→
   * 可选 ingest 进 message-hub。回调/落库异常均吞掉记日志（监控链路故障不能
   * 反过来打断轮询主循环）；返回分级结果供调用方与测试断言。
   *
   * 营销邮件（promotional）在此短路：不回调、不进消息中心——广告与用户无关，
   * 自动过滤不推送（UID 照常记入已处理集合，不会反复重判）。VIP 白名单发的
   * 营销邮件不受影响（classify 里 VIP 先于营销判定）。
   */
  async handleIncoming(mail: IncomingMail): Promise<MailWatchClassification> {
    const classification = classifyMailImportance(mail, this.cfg.vipSenders, {
      filterPromotional: this.cfg.filterPromotional,
    });
    this.newMessagesHandled += 1;

    if (classification.importance === "promotional") {
      this.promotionalFiltered += 1;
      this.log(
        "info",
        `营销邮件已过滤（${classification.reasons[0] ?? "promo"}，不推送不落库）：${extractEmailAddress(mail.from)}「${mail.subject}」`,
      );
      return classification;
    }

    if (this.deps.onNewMessage) {
      try {
        await this.deps.onNewMessage(mail, classification);
      } catch (e) {
        this.log("warn", `onNewMessage 回调失败（忽略）：${errorMessage(e)}`);
      }
    }
    if (this.deps.messageHub) {
      try {
        await this.ingestToHub(mail, classification);
      } catch (e) {
        this.log("warn", `邮件 ingest 进消息中心失败（忽略）：${errorMessage(e)}`);
      }
    }
    // 收编读取口：把处理结果留在环形缓冲，供 SensorKernel 的 MailSensor 拉取
    this.rememberRecent(mail, classification.importance);
    return classification;
  }

  /**
   * 只读取数口（2026-10-10 外部信源收编）：返回 `since` 以来**已处理**的邮件。
   * 不发起新的 IMAP 连接——直接从处理环形缓冲取；内核仅做形状转换。
   * 供 `MailSensor.collect()` 调用；未启用邮箱时返回空数组（不抛错）。
   */
  fetchNewSince(since: number): Array<{ uid: number; mail: IncomingMail; importance: string }> {
    return this.recentMails
      .filter((r) => r.at > since)
      .sort((a, b) => a.at - b.at)
      .map((r) => ({ uid: r.uid, mail: r.mail, importance: r.importance }));
  }

  /** 写入处理环形缓冲（容量封顶，防长期运行膨胀） */
  private rememberRecent(mail: IncomingMail, importance: string): void {
    const at = mail.date ? Date.parse(mail.date) : NaN;
    this.recentMails.push({
      uid: mail.uid ?? -1,
      at: Number.isFinite(at) ? at : Date.now(),
      mail,
      importance,
    });
    while (this.recentMails.length > 200) this.recentMails.shift();
  }

  /** 邮件 → message-hub：platform="email"，每个发件人地址一个会话（与 IM 联系人粒度一致）。 */
  private async ingestToHub(mail: IncomingMail, classification: MailWatchClassification): Promise<void> {
    const fromAddr = extractEmailAddress(mail.from) || mail.from || "unknown@unknown";
    const fromName = extractDisplayName(mail.from) || fromAddr;
    const text = [mail.subject?.trim(), mail.textSnippet?.trim()].filter(Boolean).join("\n") || "(空邮件)";
    // 判重键：有 uid 用 uid（稳定），否则用 from+subject+date 指纹兜底
    const externalId =
      mail.messageId ??
      `mailwatch:fp:${createHash("sha1").update(`${fromAddr}|${mail.subject ?? ""}|${mail.date ?? ""}`).digest("hex").slice(0, 16)}`;
    await this.deps.messageHub!.ingestInbound({
      actorId: mail.actorId,
      platform: "email",
      channelId: fromAddr,
      text: text.slice(0, 4000),
      participantId: fromAddr,
      participantName: fromName,
      title: `邮箱 · ${fromName}`,
      senderId: fromAddr,
      senderName: fromName,
      externalMessageId: externalId,
      meta: {
        source: "mail_watch",
        // hub 会用自己的规则写 meta.importance（high/normal 两档），这里保留邮件侧分级供提醒中枢用
        mailImportance: classification.importance,
        mailReasons: classification.reasons,
        mailDate: mail.date,
      },
    });
  }

  // ---------------- 内部：循环与落盘 ----------------

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.(); // 不阻止进程退出
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.polling = true;
    let result: Awaited<ReturnType<MailWatchService["pollOnce"]>>;
    try {
      result = await this.pollOnce();
      if (result.ok && result.handled > 0) {
        this.log("info", `本轮拉到 ${result.handled} 封新邮件`);
      }
    } catch (e) {
      // pollOnce 约定不抛错且自带失败记账；这里是防御性兜底
      this.recordFailure(errorMessage(e));
      result = { ok: false, error: errorMessage(e) };
    } finally {
      this.polling = false;
    }
    if (!this.running) return;

    // 自适应节奏的输入：有新邮件 → 快节奏跟进两轮（同批/补发）；空手而归 → 逐级拉长
    if (result.ok && result.handled > 0) {
      this.idleRounds = 0;
      this.burstRounds = BURST_ROUNDS;
    } else if (result.ok) {
      this.idleRounds += 1;
      if (this.burstRounds > 0) this.burstRounds -= 1;
    }

    // 唤醒请求在轮询期间到达：当前轮结束立刻接上
    if (this.pendingWake) {
      this.pendingWake = false;
      this.retryDelaySec = 0;
      this.scheduleTick(0);
      return;
    }

    // 失败退避：30s 起步指数翻倍、5min 封顶；连续失败计数在 status() 可见，绝不 crash
    let delayMs: number;
    if (this.consecutiveFailures > 0) {
      delayMs = Math.min(POLL_BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), POLL_BACKOFF_MAX_MS);
      this.log("warn", `轮询失败（连续第 ${this.consecutiveFailures} 次，${Math.round(delayMs / 1000)}s 后重试）：${this.lastError ?? ""}`);
    } else {
      delayMs = this.nextDelayMs();
    }
    this.retryDelaySec = Math.round(delayMs / 1000);
    this.scheduleTick(delayMs);
  }

  /** 自适应间隔：基础 → 空轮逐级翻倍（封顶 idleMaxSec）；新邮件后先 60s 快节奏跟进 */
  private nextDelayMs(): number {
    return adaptiveMailDelayMs(this.cfg.pollSec, this.idleRounds, this.cfg.idleMaxSec, this.burstRounds);
  }

  /** 失败记账（诚实失败：发生在哪记在哪，status() 直接可见）。 */
  private recordFailure(error: string): void {
    this.consecutiveFailures += 1;
    this.lastError = error;
  }

  /** 成功记账：更新最后成功时间并清零失败计数（退避窗口随之结束）。 */
  private noteSuccess(): void {
    this.lastSuccessAt = new Date().toISOString();
    this.consecutiveFailures = 0;
    this.lastError = null;
  }

  private loadState(): MailWatchState {
    const raw = readJson<Partial<MailWatchState>>(this.statePath, emptyState());
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.uids)) return emptyState();
    return {
      version: typeof raw.version === "number" ? raw.version : STATE_VERSION,
      initialized: raw.initialized === true,
      uidValidity: typeof raw.uidValidity === "string" ? raw.uidValidity : "",
      uids: raw.uids.filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
    };
  }

  /** 原子写（tmp + rename，persist-file 已兜底磁盘不可写场景）；落盘失败不影响内存态轮询。 */
  private saveState(state: MailWatchState): void {
    writeJson(this.statePath, state);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.deps.logger) {
      this.deps.logger(level, message);
      return;
    }
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[MailWatch] ${message}`);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
