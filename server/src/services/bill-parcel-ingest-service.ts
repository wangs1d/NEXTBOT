// 账单/快递汇入服务 —— 邮件与短信两条链路的**共同收口**（2026-11-13）。
//
// 此前两条链路各走各的：邮件在 MailWatchService 里分类完就停在环形缓冲，
// 短信在 MessageHub onInbound 里连分类都没有。本服务把「识别 → 落台账 → 发信号」
// 三步收在一处，两条链路都调它，保证语义一致、去重一致、汇总口径一致。
//
// 零 LLM：全部走 classifyBillParcel 的确定性规则。
import {
  classifyBillParcel,
  looksLikeGroupChat,
  looksLikeMarketing,
  shouldReportBillParcel,
  summarizeBillParcel,
  type BillParcelCategory,
  type BillParcelMatch,
} from "./bill-parcel-classifier.js";
import type {
  BillParcelEntry,
  BillParcelLedger,
  BillParcelSource,
} from "./bill-parcel-ledger.js";
import type {
  BlockedReason,
  DynamicsSettingsStore,
  SourceRuleId,
} from "./dynamics-settings-store.js";
import type { Signal } from "../proactivity/sensors/types.js";

export type BillParcelIngestInput = {
  actorId: string;
  source: BillParcelSource;
  /** 标题（邮件 subject；短信一般为空） */
  title?: string;
  /** 正文 */
  text: string;
  /** 发生时刻 ms（缺省取当前时间） */
  at?: number;
  /** 稳定来源 id（邮件 messageId / 短信 externalMessageId）——用于跨渠道去重 */
  externalId?: string;
};

export type BillParcelIngestResult = {
  /** 是否识别出账单/快递 */
  matched: boolean;
  /** 是否为纯验证码（用户明确这类不进汇总） */
  otpOnly: boolean;
  /** 是否被入口规则拦截（拦截后不落台账、不发信号） */
  blockedReason?: BlockedReason;
  match: BillParcelMatch;
  /** 实际新增的台账条目（重复内容为空） */
  entries: BillParcelEntry[];
};

export type BillParcelIngestDeps = {
  ledger: BillParcelLedger;
  /** 来源规则与拦截计数（未接时保持旧行为：只按验证码降级） */
  settings?: DynamicsSettingsStore;
  /** 信号出口（SensorKernel feeder 闭包；为空则只落台账） */
  emit?: (signal: Omit<Signal, "stream">) => void;
  /**
   * 时钟（默认 Date.now）。
   *
   * 必须与台账的时钟同源：台账的汇总窗口按自己的 now 算，而条目时刻若来自
   * 另一个时钟，窗口两端就会错位——条目可能被判在"未来"而被汇总直接过滤掉，
   * 表现为"明明识别到了，汇总却是空的"。
   */
  now?: () => number;
  /**
   * 命中回调（主动汇报接线点）。
   *
   * 只在**新增**台账条目时触发（重复内容不再打扰）——这是天然的第一道去重。
   * 回调抛错不影响识别与落库（识别链路不能因为汇报失败而断）。
   */
  onMatched?: (info: {
    actorId: string;
    source: BillParcelSource;
    match: BillParcelMatch;
    entries: BillParcelEntry[];
  }) => void;
};

/** 上限：单条内容截断长度（与 SourceStore 实体索引上限对齐） */
const EXCERPT_LIMIT = 500;

export class BillParcelIngestService {
  constructor(private readonly deps: BillParcelIngestDeps) {}

  /**
   * 汇入一条内容。返回识别结果与新增台账条目。
   *
   * 无论是否命中都会返回结果——调用方需要知道「这条是不是验证码」以便决定
   * 是否另行提示（验证码虽不进汇总，但可检索）。
   */
  ingest(input: BillParcelIngestInput): BillParcelIngestResult {
    const at = input.at ?? (this.deps.now ?? Date.now)();
    const haystack = `${input.title ? `${input.title}\n` : ""}${input.text}`;
    const settings = this.deps.settings;

    // 群聊通知：默认不进入动态页（来源规则可开）。
    if (
      input.source === "notification" &&
      looksLikeGroupChat(haystack) &&
      settings &&
      !settings.allows("groupChat")
    ) {
      settings.recordBlocked("groupChat", input.source, at);
      return {
        matched: false,
        otpOnly: false,
        blockedReason: "groupChat",
        match: emptyMatch(),
        entries: [],
      };
    }

    const match = classifyBillParcel({
      title: input.title,
      text: input.text,
    });

    // 营销推广：命中明确的促销动作词时直接不进动态页（只在拦截计数里回一条）。
    // 带「优惠券」的正常支付回执仍保留：有金额且无「退订/促销/秒杀」等强促销词。
    if (settings && looksLikeMarketing(haystack)) {
      const strongPromo = /(退订|拒收|促销|大促|秒杀|抢购|领券|限时活动)/.test(haystack);
      const valuable = match.amount != null && match.categories.length > 0 && !strongPromo;
      if (!valuable && !settings.allows("ecommerceMarketing")) {
        settings.recordBlocked("marketing", input.source, at);
        return {
          matched: false,
          otpOnly: false,
          blockedReason: "marketing",
          match,
          entries: [],
        };
      }
    }

    if (!shouldReportBillParcel(match)) {
      if (match.isOtpOnly && settings) {
        settings.recordBlocked("otp", input.source, at);
      }
      return { matched: false, otpOnly: match.isOtpOnly, match, entries: [] };
    }

    // 来源规则（银行短信 / 快递通知）——关闭后入口层直接丢弃。
    const ruleId = sourceRuleFor(match);
    if (settings && ruleId && !settings.allows(ruleId)) {
      settings.recordBlocked("sourceRule", input.source, at);
      return { matched: false, otpOnly: false, blockedReason: "sourceRule", match, entries: [] };
    }

    const excerpt = haystack.slice(0, EXCERPT_LIMIT);
    const title = summarizeBillParcel(match, excerpt.replace(/\s+/g, " ").trim());

    const entries: BillParcelEntry[] = [];
    for (const category of match.categories) {
      const added = this.deps.ledger.add({
        category,
        source: input.source,
        actorId: input.actorId,
        title,
        amount: match.amount,
        billType: category === "bill" ? match.billType : null,
        trackingNo: match.trackingNo,
        pickupCode: match.pickupCode,
        carrier: match.carrier,
        occurredAt: at,
        excerpt,
        // externalId 只作为去重键的**兜底**（单号/取件码优先），
        // 这样同一单快递在短信与邮件里各出现一次时仍只入一条
        externalId: input.externalId,
      });
      entries.push(...added);
    }

    if (entries.length === 0 && settings && match.categories.includes("parcel")) {
      // 物流轨迹重复更新：同单号多次推送只保留一条，计入「重复物流」拦截计数
      settings.recordBlocked("duplicateParcel", input.source, at);
    }

    if (entries.length > 0 && this.deps.emit) {
      for (const entry of entries) {
        this.deps.emit({
          actorId: entry.actorId,
          at: entry.occurredAt,
          // 指纹带上条目 id：同一 externalId 只发一次信号
          fingerprint: `bill_parcel:${entry.id}`,
          // 账单与快递都是用户明确要求汇报的 → high
          salience: "high",
          delta: entry.title,
          payload: {
            category: entry.category,
            source: entry.source,
            title: entry.title,
            amount: entry.amount,
            billType: entry.billType,
            trackingNo: entry.trackingNo,
            pickupCode: entry.pickupCode,
            carrier: entry.carrier,
            // 正文进实体索引：SourceStore 按 payload.text 建倒排，
            // 「提到某单号的全部来源」靠这条命中
            text: entry.excerpt,
            entities: entityHints(entry),
          },
        });
      }
    }

    // 主动汇报接线点：只在有**新增**条目时回调（重复内容不再打扰）。
    // 回调异常不影响识别与落库——识别链路不能因为汇报失败而断。
    if (entries.length > 0 && this.deps.onMatched) {
      try {
        this.deps.onMatched({
          actorId: input.actorId,
          source: input.source,
          match,
          entries,
        });
      } catch {
        /* 汇报失败忽略 */
      }
    }

    return { matched: true, otpOnly: false, match, entries };
  }
}

/** 命中的来源规则（账单类只对银行/还款生效，避免把生活缴费也归到银行短信） */
function sourceRuleFor(match: BillParcelMatch): SourceRuleId | null {
  if (match.categories.includes("parcel")) return "parcelNotice";
  if (match.categories.includes("bill")) {
    if (match.billType === "银行卡" || match.billType === "还款扣款") return "bankSms";
  }
  return null;
}

function emptyMatch(): BillParcelMatch {
  return {
    categories: [],
    labels: [],
    isOtpOnly: false,
    amount: null,
    billType: null,
    trackingNo: null,
    pickupCode: null,
    carrier: null,
  };
}

/** 跨源实体候选：单号/取件码/承运商/账单子类——高置信、可被"某单号"检索命中 */
function entityHints(entry: BillParcelEntry): string[] {
  const hints: string[] = [];
  if (entry.trackingNo) hints.push(entry.trackingNo);
  if (entry.pickupCode) hints.push(entry.pickupCode);
  if (entry.carrier) hints.push(entry.carrier);
  if (entry.billType) hints.push(entry.billType);
  return hints.filter(Boolean);
}

/** 类别优先级（供调用方排序用：账单金额通常比快递更紧急） */
export const BILL_PARCEL_PRIORITY: readonly BillParcelCategory[] = ["bill", "parcel"];
