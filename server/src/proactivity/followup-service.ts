/**
 * 承诺跟进（PRD §3.5，2026-11-25 落地）。
 *
 * 「它记得我」最直接的体感：用户提过的未来事件（面试/考试/看病/出差/搬家/聚会/
 * 家人生日），**事后**接上一句。与日程的分工是 §3.5 划死的——日程是「提醒你去做」，
 * 跟进是「事后问一句」，同一件事可以两者都有，所以这里完全不碰 schedule-task-service。
 *
 * 四条口径：
 *  1. **不自己排程**：跟进事件落 `commitments(kind='follow_up')`（services/followup-store.ts，
 *     复用表与状态机，不新开库），`followAt` 只当「最早可发时刻」用——提交时带
 *     `deliverAfter=followAt`，落在哪个触点、几点说，全交给 §3.4 的触点计划与管道既有
 *     30s flush。本模块没有任何 timer / 轮询（PRD §1.3 硬约束）。
 *  2. **唯一开口通道**：`ProactivePipeline.submitProposal`，`kind='commitment'`、
 *     `tier='social'`（计入社交日预算，§3.10），因此自动受频控、在场判定、静默日志管辖。
 *  3. **陈述句，不追回复**：「今天面试辛苦了，结果出来想聊随时说。」而不是「面试怎么样？」
 *     ——问句会把「它记得我」变成「它在考核我」（§11-19 无隐性要求原则）。
 *  4. **private 上锁屏不泄露**：健康/感情/法律/财务纠纷类，通知正文（WS 的 text、
 *     手机推送的 body、动作意图的 body 三处同源的 `directText`）只出
 *     「{管家名}：有句话想跟你说」，全文只留在 `summary`（点开进 App 才看得见）与落库行里。
 *
 * 限制：同一事件最多跟进 1 次（行 id 由事件指纹派生 + `reminder_sent_at` 提交闸）；
 * 用户点「别跟进这个」→ 该类别 30 天内不再抽、不再提（复用既有负反馈抑制表
 * `ProactivitySuppressionStore`，kind='follow_up'、keyword=类别，TTL 在这里判——
 * 抑制表本身没有过期语义，到期不再命中即可，不需要谁来清理它）。
 */
import type { UnifiedFollowUp } from "../agentic-memory/unified-extractor.js";
import { CHAT_REPLY_ROLE } from "./notification-actions.js";
import { followUpIdFor, getFollowUp, insertFollowUp, listFollowUps, listFollowUpsByCategory, markFollowUpSubmitted, settleFollowUp } from "../services/followup-store.js";
import type { FollowUpRecord, FollowUpSensitivity } from "../services/followup-store.js";
import type { ProactiveProposal, ProposalNotifyOption } from "./pipeline-types.js";

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** 同类抑制的落库口径（抑制表按 kind+关键词匹配，跟进用独立的 kind 命名空间） */
export const FOLLOWUP_SUPPRESS_KIND = "follow_up";
/** 「别跟进这个」的抑制时长（§3.5：同类事件 30 天内不再跟进） */
export const FOLLOWUP_SUPPRESS_MS = 30 * DAY_MS;
/** private 事件在锁屏/通知正文上的唯一可见内容（§3.5） */
export const PRIVATE_LOCK_SCREEN_HINT = "有句话想跟你说";
/** 超过这个时长才需要 firedAt 抗僵尸清理（ProposalStore 的挂起上限是 48h） */
const PENDING_MAX_AGE_MS = 48 * 60 * 60_000;
/** 抽出来后多久还没开口就作废（三条天前的面试不该第四条被问起） */
export const FOLLOWUP_TTL_MS = 36 * 60 * 60_000;
/** 事件时刻早于「现在」多久就不算未来事件（补一句三天前的面试毫无意义） */
export const STALE_EVENT_MS = 3 * 60 * 60_000;

export type FollowUpCategory =
  | "interview"
  | "exam"
  | "medical"
  | "travel"
  | "move"
  | "party"
  | "birthday"
  | "legal"
  | "money"
  | "other";

/**
 * 确定性判私（§3.5「健康、感情、法律、财务纠纷」）：模型漏判 private 不能让内容
 * 上锁屏，所以这是一道兜底闸而不是提示。宁可多判 private（用户点开就能看到，只是
 * 少一次锁屏预览），也不漏判。
 */
const PRIVATE_EVENT_RE =
  /医院|看病|就诊|复诊|复查|体检|检查|报告|手术|化疗|药|胃镜|肠镜|化验|彩超|核磁|挂号|门诊|确诊|病情|怀孕|流产|精神|心理|抑郁|分手|离婚|恋|感情|暗恋|表白|相亲|官司|起诉|仲裁|律师|报警|维权|欠款|借|债|赔|催款|逾期|扣款/;

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  "interview",
  "exam",
  "medical",
  "travel",
  "move",
  "party",
  "birthday",
  "legal",
  "money",
  "other",
]);

/** 类别归一：模型的 category 缺失/越界/就是 other 时按关键词回落到类别（抑制按类匹配，类别不能空） */
export function categorizeFollowUp(event: string, raw?: string): FollowUpCategory {
  const c = (raw ?? "").trim().toLowerCase();
  // "other" 视为「没分类」：抽取侧的白名单会把越界值统一洗成 other，
  // 若就此打住，复诊/搬家这类事件都会掉进 other 桶（抑制面放大、话术变含糊）。
  if (c && c !== "other" && KNOWN_CATEGORIES.has(c)) return c as FollowUpCategory;
  const t = event ?? "";
  if (/面试|试镜|终面|复试/.test(t)) return "interview";
  if (/考试|测验|答辩|考级|考证|模考|笔试|口试/.test(t)) return "exam";
  if (/医院|看病|就诊|复诊|复查|体检|手术|检查|核磁|化验|胃镜|肠镜|门诊|挂号/.test(t)) return "medical";
  if (/出差|高铁|飞机|航班|旅行|游玩|自驾/.test(t)) return "travel";
  if (/搬家|退租|租房|交房|签约|看房/.test(t)) return "move";
  if (/聚会|饭局|聚餐|生日局|婚礼|满月|唱 K|唱K/.test(t)) return "party";
  if (/生日|纪念日|周年/.test(t)) return "birthday";
  if (/开庭|起诉|仲裁|律师|维权|报警/.test(t)) return "legal";
  if (/退款|理赔|欠款|催款|逾期|账单|还款/.test(t)) return "money";
  return "other";
}

/** 敏感度判定：模型给 private 或命中判私正则（体检/复诊…）都算 private */
export function classifySensitivity(event: string, raw?: string): FollowUpSensitivity {
  if (raw === "private") return "private";
  return PRIVATE_EVENT_RE.test(event ?? "") ? "private" : "normal";
}

/** 本地零点（时段计算全按用户墙钟，UTC 会把「今天下班」算到昨天） */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 冷启动默认时刻（与触点计划的默认钟同口径：下班 18:30 / 明日预览 22:00） */
const DEFAULT_LEAVE_WORK_MINUTE = 18 * 60 + 30;
const DEFAULT_PREVIEW_MINUTE = 22 * 60;
/** 只在这两类触点里落点（§3.5「当天下班或明日预览」） */
const FOLLOWUP_SLOT_KINDS: readonly string[] = ["leave_work", "tomorrow_preview"];

export type FollowUpSlotTime = { kind: string; windowStart: number };

/**
 * `followAt` = `eventAt` 之后第一个合适的触点起点。
 *
 * 时刻来源优先问触点计划（`slotTimes`，bootstrap 接 `TouchpointPlanner.planOf`），
 * 拿不到就按冷启动默认钟自己排——两条路都只是给提案一个 `deliverAfter`，
 * 真正「排进哪个槽、几点合并说」仍是计划层在 submitProposal 里决定，这里不越权。
 */
export function computeFollowAt(input: {
  eventAt: number;
  now: number;
  slotTimes?: (atMs: number) => FollowUpSlotTime[];
}): number {
  const floor = Math.max(input.eventAt, input.now - MINUTE_MS);
  const collected: number[] = [];
  // 只看事件当天与之后三天：三天后还没找到落点说明这一刻根本不该跟进
  for (let offset = 0; offset <= 3; offset += 1) {
    const dayStart = startOfDay(input.eventAt) + offset * DAY_MS;
    if (dayStart > floor + 4 * DAY_MS) break;
    const slots = input.slotTimes?.(dayStart + 12 * 60 * MINUTE_MS) ?? null;
    const usable = (slots ?? [])
      .filter((s) => FOLLOWUP_SLOT_KINDS.includes(s.kind) && Number.isFinite(s.windowStart))
      .map((s) => s.windowStart);
    if (usable.length === 0) {
      // 无计划（未装配 / 该日没排触点）：按默认钟给出「当天下班 → 当天预览 → 次天下班」
      usable.push(dayStart + DEFAULT_LEAVE_WORK_MINUTE * MINUTE_MS);
      usable.push(dayStart + DEFAULT_PREVIEW_MINUTE * MINUTE_MS);
    }
    for (const at of usable.sort((a, b) => a - b)) {
      if (at > floor) collected.push(at);
    }
  }
  if (collected.length === 0) return floor + 30 * MINUTE_MS;
  return collected.sort((a, b) => a - b)[0]!;
}

/** 「今天/昨天/前天」前缀：跟进的话必须带锚点，用户才知道说的是哪件事 */
export function dayLabel(fromEventAt: number, atFollowTime: number): string {
  const days = Math.round((startOfDay(atFollowTime) - startOfDay(fromEventAt)) / DAY_MS);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  return "那天";
}

/**
 * 各类别的收尾话术（{d} = 今天/昨天/前天）。
 *
 * 全部写成陈述句、且句子本身就把「回不回」的主动权交出去（"不用回我""想说的时候我在"）——
 * 问句会形成隐性要求，这是 §3.5 表达要求里点名的反面例子。
 */
const CATEGORY_COPY: Record<FollowUpCategory, string> = {
  interview: "{d}面试辛苦了，结果出来想聊随时说。",
  exam: "{d}考完了，题难不难不用专门讲，想吐槽的时候我在。",
  medical: "{d}看诊辛苦了，医生怎么说不用急着说，想说的时候我在。",
  travel: "{d}那趟出门辛苦了，安顿好了再聊，不急。",
  move: "{d}搬家最累，收拾完了早点歇，不用回我。",
  party: "{d}聚得开心就好，细节不用讲。",
  birthday: "{d}是你的生日，祝你这一年顺一点，不用回。",
  legal: "{d}那件事办完了，进展如何不用专门说，需要我时我在。",
  money: "{d}那笔钱的事有着落了，细节不用讲，要商量随时说。",
  other: "{d}那件事告一段落了，想聊随时说，不想聊也没关系。",
};

/** 跟进全文（点开看到的那句；private 也用它，锁屏那一面由 lockScreenBody 遮住） */
export function followUpText(rec: Pick<FollowUpRecord, "event" | "category" | "eventAt" | "followAt">): string {
  const d = dayLabel(rec.eventAt, rec.followAt);
  const tpl = CATEGORY_COPY[rec.category as FollowUpCategory] ?? CATEGORY_COPY.other;
  return tpl.replace("{d}", d);
}

/** 通知正文 / 锁屏预览：normal 出全文，private 只出「{管家名}：有句话想跟你说」 */
export function lockScreenBody(rec: { sensitivity: FollowUpSensitivity }, butlerName: string, fullText: string): string {
  if (rec.sensitivity !== "private") return fullText;
  const name = (butlerName ?? "").trim();
  return name ? `${name}：${PRIVATE_LOCK_SCREEN_HINT}` : PRIVATE_LOCK_SCREEN_HINT;
}

/** 通知抬头（华为通道强制非空）：private 只挂管家名，绝不带事件词 */
export function lockScreenTitle(rec: { sensitivity: FollowUpSensitivity }, butlerName: string, event: string): string {
  const name = (butlerName ?? "").trim();
  if (rec.sensitivity === "private") return name || "有句话想跟你说";
  return event ? `${event}` : name || "跟进一句";
}

/** ISO（含本地时区偏移）：与 unified-extractor 的换算口径一致 */
function parseEventAt(raw: string | undefined, fallbackDay: number): number | null {
  const t = (raw ?? "").trim().replace(" ", "T");
  if (!t) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T12:00` : t;
  const ms = Date.parse(normalized.length === 16 ? `${normalized}:00` : normalized);
  if (!Number.isFinite(ms)) return null;
  void fallbackDay;
  return ms;
}

export type FollowUpDeps = {
  /** 唯一开口通道（ProactivePipeline.submitProposal 的薄包装，晚绑定） */
  submit: (proposal: ProactiveProposal) => unknown;
  /** 频率档闸门（§3.10「只在有事时」不跟进） */
  governor?: { tierAllows(actorId: string, feature: "followup" | "ask_you"): boolean };
  /** 负反馈抑制表（既有）：记「别跟进这个」，30 天窗口在这里判 */
  suppression?: {
    add(actorId: string, kind: string, keywords?: unknown, note?: unknown): unknown;
    list(actorId: string): Array<{ kind: string; keywords: string[]; createdAt: string }>;
  };
  /** 触点计划的读侧（bootstrap 接 planOf）：followAt 用真实 slot 时刻 */
  slotTimes?: (actorId: string, atMs: number) => FollowUpSlotTime[];
  /** 管家名（锁屏抬头/正文）；未命名返回空串 */
  butlerName?: (actorId: string) => string | null;
  /** SQLite 路径（测试隔离；缺省走 agentic-memory 主库的 commitments 表） */
  dbPath?: string;
  nowFn?: () => number;
  log?: (msg: string) => void;
  /** 总开关（env PROACTIVITY_FOLLOWUP_ENABLED=0 一键关） */
  enabled?: () => boolean;
};

export type FollowUpIngestResult = {
  id: string;
  submitted: boolean;
  reason:
    | "submitted"
    | "disabled"
    | "no_actor"
    | "no_anchor"
    | "stale_event"
    | "suppressed_category"
    | "already_followed"
    | "quiet_tier"
    | "submit_failed";
  record?: FollowUpRecord;
  proposal?: ProactiveProposal;
};

export class FollowUpService {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: FollowUpDeps) {
    this.now = deps.nowFn ?? Date.now;
    this.log = deps.log ?? ((msg) => console.log(msg));
  }

  private get enabled(): boolean {
    return this.deps.enabled?.() !== false;
  }

  /** 某类事件此刻是否处于 30 天抑制期（「别跟进这个」之后） */
  isCategorySuppressed(actorId: string, category: string, at = this.now()): boolean {
    const list = this.deps.suppression?.list(actorId) ?? [];
    return list.some((e) => {
      if (e.kind !== FOLLOWUP_SUPPRESS_KIND) return false;
      if (!e.keywords.includes(category)) return false;
      const since = Date.parse(e.createdAt);
      // 时间戳读不出来就按仍在抑制处理：用户明确表过态，宁可少说也不失信
      if (!Number.isFinite(since)) return true;
      return at - since < FOLLOWUP_SUPPRESS_MS;
    });
  }

  /**
   * 统一抽取产物 → 跟进事件（对话归档 / 夜间批 / 高信号轮共用这一个入口）。
   * 全程零 LLM、零定时器；任何异常都不抛给记忆主链路。
   */
  ingestFromExtraction(input: {
    actorId: string;
    sourceRef: string;
    followUps: UnifiedFollowUp[] | undefined;
    now?: number;
  }): FollowUpIngestResult[] {
    const list = input.followUps ?? [];
    if (list.length === 0) return [];
    const now = input.now ?? this.now();
    const out: FollowUpIngestResult[] = [];
    for (const raw of list) {
      try {
        out.push(this.ingestOne(input.actorId, input.sourceRef, raw, now));
      } catch (err) {
        this.log(`[FollowUp] 单条落库失败（忽略）actor=${input.actorId}: ${err}`);
        out.push({ id: "", submitted: false, reason: "submit_failed" });
      }
    }
    return out;
  }

  private ingestOne(
    actorId: string,
    sourceRef: string,
    raw: UnifiedFollowUp,
    now: number,
  ): FollowUpIngestResult {
    if (!this.enabled) return { id: "", submitted: false, reason: "disabled" };
    const event = (raw?.event ?? "").trim();
    if (!actorId?.trim() || event.length < 2) {
      return { id: "", submitted: false, reason: "no_actor" };
    }
    const eventAt = parseEventAt(raw.eventAt, now);
    if (eventAt === null) {
      // 无锚点不跟进：「改天去看看牙」没有对的时刻，硬排会变成随机打扰
      return { id: "", submitted: false, reason: "no_anchor" };
    }
    if (eventAt < now - STALE_EVENT_MS) {
      return { id: "", submitted: false, reason: "stale_event" };
    }
    const category = categorizeFollowUp(event, raw.category);
    const sensitivity = classifySensitivity(event, raw.sensitivity);
    const followAt = computeFollowAt({
      eventAt,
      now,
      ...(this.deps.slotTimes
        ? { slotTimes: (atMs: number) => this.deps.slotTimes!(actorId, atMs) }
        : {}),
    });
    const id = followUpIdFor({ actorId, category, eventAt });

    const existing = getFollowUp(this.deps.dbPath, id);
    if (existing?.submittedAt !== undefined) {
      // 同一事件最多跟进 1 次：说过第二遍也不补发
      return { id, submitted: false, reason: "already_followed", record: existing };
    }
    if (this.isCategorySuppressed(actorId, category, now)) {
      return { id, submitted: false, reason: "suppressed_category" };
    }

    const rec: FollowUpRecord = {
      id,
      actorId,
      event,
      eventAt,
      followAt,
      sensitivity,
      sourceRef: sourceRef || "conversation",
      category,
      status: "active",
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.6,
    };
    insertFollowUp(this.deps.dbPath, rec);

    const quiet = this.deps.governor?.tierAllows(actorId, "followup") === false;
    if (quiet) {
      // 「只在有事时」档：事件照记（用户哪天问起来它还知道），但不开口
      return { id, submitted: false, reason: "quiet_tier", record: rec };
    }

    const proposal = this.buildProposal(rec, now);
    try {
      this.deps.submit(proposal);
    } catch (err) {
      this.log(`[FollowUp] 提案提交失败 actor=${actorId} id=${id}: ${err}`);
      return { id, submitted: false, reason: "submit_failed", record: rec };
    }
    markFollowUpSubmitted(this.deps.dbPath, id, now);
    this.log(
      `[FollowUp] 已排跟进 actor=${actorId} 事件="${event}" 类别=${category} 敏感度=${sensitivity} ` +
        `开口于 ${new Date(followAt).toLocaleString("zh-CN")}（提案 deliverAfter，落点由触点计划决定）`,
    );
    return { id, submitted: true, reason: "submitted", record: rec, proposal };
  }

  /**
   * 组一条跟进提案（无副作用，测试与 ingestOne 共用）。
   *
   * `directText` 是投递链上唯一被渲染成通知正文的字段（WS payload.text、
   * 推送 body、动作意图 body 三处都取它），所以 private 的遮罩只写在这里就够了；
   * 全文放 `summary`——点开进 App 看得见，不进锁屏。
   */
  buildProposal(rec: FollowUpRecord, at = this.now()): ProactiveProposal {
    const name = (this.deps.butlerName?.(rec.actorId) ?? "").trim();
    const full = followUpText(rec);
    const body = lockScreenBody({ sensitivity: rec.sensitivity }, name, full);
    const notifyOptions: ProposalNotifyOption[] = [
      // §3.5 每条跟进两枚按钮：回复（通知栏内联输入，走 §4.3 chat.reply）
      // 与「别跟进这个」。回复角色是封闭联合类型之外的字符串（见 CHAT_REPLY_ROLE 注释），
      // 不声明就只能落到默认的「知道了/稍后再说」，那条就没有回话入口了。
      { action: CHAT_REPLY_ROLE as ProposalNotifyOption["action"], label: "回复" },
      // 「别跟进这个」带 ref=跟进 id：optionToAction 把它透给执行器，才能精确
      // 结掉这件事并按类别抑制 30 天（见 decline）
      { action: "dismiss", label: "别跟进这个", ref: rec.id },
    ];
    const farFuture = rec.followAt - at > PENDING_MAX_AGE_MS - 8 * 60 * 60_000;
    return {
      proposalId: `p_${rec.followAt.toString(36)}_fu`,
      actorId: rec.actorId,
      // 承诺跟进（§3.5）：触点计划里 commitment 的偏好落点就是下班/明日预览
      kind: "commitment",
      // social 层：跟进是主动社交行为，计入社交日预算（§3.10），不占用户点名事项的必达额度
      tier: "social",
      // private 不弹窗（popup 会把整条内容摊在锁屏上），normal 也只是低打扰的一句话
      importance: "low",
      // dedupKey 锁事件本身：待发区同键合并 + 已投递 24h 指纹，双保险防重发
      dedupKey: `commitment:followup:${rec.id}`,
      title: lockScreenTitle({ sensitivity: rec.sensitivity }, name, rec.event),
      summary: full,
      directText: body,
      evidence: [
        "follow_up",
        `id=${rec.id}`,
        `event=${rec.event}`,
        `category=${rec.category}`,
        `sensitivity=${rec.sensitivity}`,
        `eventAt=${new Date(rec.eventAt).toISOString()}`,
        `followAt=${new Date(rec.followAt).toISOString()}`,
        `source=${rec.sourceRef}`,
      ],
      createdAt: at,
      // 到点才说：时刻来自 followAt（事件之后的第一个下班/明日预览触点）
      deliverAfter: rec.followAt,
      // 保质期：拖过 36 小时的「事后问一句」已经变成「它记错了日子」
      expiresAt: rec.followAt + FOLLOWUP_TTL_MS,
      // 超出待发区 48h 僵尸上限的远期事件带 firedAt 豁免清理（近路的不带，
      // 否则会被计划层当成补推消息跳过排槽）
      ...(farFuture ? { firedAt: rec.followAt } : {}),
      source: "follow_up",
      subject: rec.category,
      notifyOptions,
    };
  }

  /**
   * 「别跟进这个」：这件事结掉 + 同类事件 30 天内不再提（§3.5 限制）。
   *
   * 通知按钮执行器与对话侧（用户直接说「别跟进这个」）共用这一个入口。
   * ref 可以是跟进 id，也可以是类别名（对话里用户说的是「面试这类」）。
   */
  decline(
    actorId: string,
    ref: string,
  ): { ok: boolean; message: string; category: string; cancelled: number } {
    const raw = (ref ?? "").trim();
    if (!actorId || !raw) {
      return { ok: false, message: "不知道你说的是哪件事，回聊天里跟我提一句", category: "", cancelled: 0 };
    }
    const byId = raw.startsWith("fu_") ? getFollowUp(this.deps.dbPath, raw) : null;
    const category = byId?.category ?? categorizeFollowUp(raw, raw);
    const now = this.now();
    let cancelled = 0;
    const targets = byId
      ? [byId]
      : listFollowUpsByCategory(this.deps.dbPath, actorId, category).filter((r) => r.status === "active");
    for (const rec of targets) {
      if (settleFollowUp(this.deps.dbPath, rec.id, "cancelled", now)) cancelled += 1;
    }
    try {
      void this.deps.suppression?.add(actorId, FOLLOWUP_SUPPRESS_KIND, [category], "别跟进这个");
    } catch (err) {
      this.log(`[FollowUp] 抑制登记失败（事件已取消，类别抑制下次再试）: ${err}`);
    }
    this.log(
      `[FollowUp] 用户拒跟进 actor=${actorId} 类别=${category} 取消=${cancelled} 条，同类 ${Math.round(
        FOLLOWUP_SUPPRESS_MS / DAY_MS,
      )} 天内不再提`,
    );
    return {
      ok: true,
      message: `好，${categoryLabel(category)}这类事 ${Math.round(FOLLOWUP_SUPPRESS_MS / DAY_MS)} 天内我不再提了`,
      category,
      cancelled,
    };
  }

  /** 该 actor 的跟进台账（诊断/点开详情用） */
  snapshot(actorId: string, opts?: { status?: "active" | "fulfilled" | "cancelled" | "any" }): {
    pending: Array<{ id: string; event: string; category: string; followAt: number; sensitivity: FollowUpSensitivity; submitted: boolean }>;
    suppressedCategories: string[];
  } {
    const rows = listFollowUps(this.deps.dbPath, actorId, { status: opts?.status ?? "active" });
    const cats = new Set<string>();
    for (const c of ["interview", "exam", "medical", "travel", "move", "party", "birthday", "legal", "money", "other"] as const) {
      if (this.isCategorySuppressed(actorId, c)) cats.add(c);
    }
    return {
      pending: rows.map((r) => ({
        id: r.id,
        event: r.event,
        category: r.category,
        followAt: r.followAt,
        sensitivity: r.sensitivity,
        submitted: r.submittedAt !== undefined,
      })),
      suppressedCategories: [...cats],
    };
  }

  /** 已取消/已跟进的行收口（供执行器与 outcome 回灌复用） */
  settle(id: string, outcome: "fulfilled" | "cancelled", at = this.now()): boolean {
    return settleFollowUp(this.deps.dbPath, id, outcome, at);
  }
}

function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    interview: "面试",
    exam: "考试",
    medical: "看病",
    travel: "出门办事",
    move: "搬家",
    party: "聚会",
    birthday: "生日",
    legal: "官司",
    money: "钱的事",
    other: "这件",
  };
  return map[category] ?? category;
}

/** 总开关（默认开）：PROACTIVITY_FOLLOWUP_ENABLED=0 整条链关停 */
export function isFollowUpFeatureEnabled(): boolean {
  const raw = process.env.PROACTIVITY_FOLLOWUP_ENABLED?.trim();
  return raw !== "0" && raw !== "false";
}

/**
 * 装配层句柄（同 getAgenticMemoryRuntime 的惯例）：
 * 通知按钮执行器与 HTTP 路由从这里取实例，不必让 bootstrap 把参数一路透传下去。
 */
let followUpServiceInstance: FollowUpService | null = null;

export function setFollowUpService(svc: FollowUpService | null): void {
  followUpServiceInstance = svc;
}

export function getFollowUpService(): FollowUpService | null {
  return followUpServiceInstance;
}
