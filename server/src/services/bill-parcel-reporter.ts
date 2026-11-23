// 账单/快递主动汇报（P0，2026-11-19）——从 8505 行装配文件里抽出的可测模块。
//
// **为什么单独成文件**：这段逻辑（冷却 + 文案拼装 + 提案构造）此前内联在
// create-app-services.ts 的 onMatched 回调里，20+ 行深埋在巨型装配函数中，
// 无法单测——bill-parcel.test.ts 只覆盖到「分类 + 发信号」，从命中到提案这
// 最后一环一次都没被测过。抽成模块后生产装配只留一行调用，逻辑可用假时钟、
// 假 submit 直接驱动，端到端验证「快递到达 → 提案 → 投递/推送」真成立。
//
// 行为与原回调**逐字等价**：冷却窗口、来源标签、文案、evidence、detail 全部照搬，
// 仅把 `Date.now()` 与 `pipeline.submitProposal()` 改为可注入依赖（生产传真身）。
import type { ProactiveProposal } from "../proactivity/pipeline-types.js";
import type { BillParcelMatchedInfo } from "./bill-parcel-ingest-service.js";

/** 快递同类冷却：10min（快递公司常连发多条：已发货→在途→已到站） */
export const BILL_PARCEL_COOLDOWN_MS = 10 * 60 * 1000;
/** 账单同类冷却：6h（同一笔扣款常在短信+邮件+银行 App 三处各来一遍） */
export const BILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** 快递「晚点提醒我」的推迟间隔：2h（下班时段精确投递留给 M2 触点计划） */
export const PARCEL_REMIND_LATER_MS = 2 * 60 * 60 * 1000;
/** 账单「明天提醒」的推迟间隔：24h */
export const BILL_REMIND_TOMORROW_MS = 24 * 60 * 60 * 1000;

export type BillParcelReporterDeps = {
  /** 时钟（默认 Date.now）——测试注入以验证冷却，不改生产语义 */
  now?: () => number;
  /** 提案出口（生产 = pipeline.submitProposal） */
  submit: (proposal: ProactiveProposal) => void;
};

export class BillParcelReactiveReporter {
  /** 同一账号同类上次汇报时刻：key = actorId:category */
  private readonly cooldown = new Map<string, number>();
  private readonly now: () => number;
  private readonly submit: (proposal: ProactiveProposal) => void;

  constructor(deps: BillParcelReporterDeps) {
    this.now = deps.now ?? Date.now;
    this.submit = deps.submit;
  }

  /**
   * 汇报一条命中。冷却期内或无可报条目时静默返回。
   *
   * 优先级 bill > parcel：一条内容同时命中两类时（如「话费账单+包裹到驿站」），
   * 以账单为 primary 决定标题与重要度——金额比取件码更紧急；但 detail/evidence
   * 仍把两类字段都带上，不丢信息。
   */
  report(info: BillParcelMatchedInfo): void {
    const bill = info.entries.find((e) => e.category === "bill");
    const parcel = info.entries.find((e) => e.category === "parcel");
    const primary = bill ?? parcel;
    if (!primary) return;

    const actorId = info.actorId;
    const now = this.now();
    const fingerprint = primary.id;
    const isParcel = primary.category === "parcel";
    const cooldown = isParcel ? BILL_PARCEL_COOLDOWN_MS : BILL_COOLDOWN_MS;
    const cooldownKey = `${actorId}:${primary.category}`;
    const last = this.cooldown.get(cooldownKey);
    if (last != null && now - last < cooldown) return;
    this.cooldown.set(cooldownKey, now);

    const sourceLabel =
      info.source === "email" ? "邮件" : info.source === "sms" ? "短信" : "手机通知";
    const title = isParcel ? "收到快递通知" : "收到账单通知";
    const detailLines: string[] = [`来源: ${sourceLabel}`];
    if (parcel) {
      detailLines.push(
        parcel.trackingNo ? `运单号: ${parcel.trackingNo}` : "运单号: 未在原文给出",
      );
      if (parcel.pickupCode) detailLines.push(`取件码: ${parcel.pickupCode}`);
      if (parcel.carrier) detailLines.push(`承运商: ${parcel.carrier}`);
    }
    if (bill) {
      detailLines.push(`账单类型: ${bill.billType ?? "未分类"}`);
      detailLines.push(`金额: ${bill.amount != null ? `¥${bill.amount}` : "原文未给出"}`);
    }

    this.submit({
      proposalId: `bp_${fingerprint}`,
      actorId,
      kind: "action.bill_parcel",
      tier: "must",
      importance: isParcel ? "high" : "medium",
      dedupKey: `bill_parcel:${fingerprint}`,
      title,
      summary: primary.title,
      evidence: [
        "bill_parcel",
        `source:${info.source}`,
        `category:${primary.category}`,
        ...(parcel?.trackingNo ? [`tracking:${parcel.trackingNo}`] : []),
        ...(bill?.amount != null ? [`amount:${bill.amount}`] : []),
      ],
      directText: isParcel
        ? `刚收到一条快递通知——${parcel?.title ?? "包裹已到"}。` +
          (parcel?.pickupCode ? `取件码 ${parcel.pickupCode}。` : "") +
          `要我帮你记着，或者提醒你什么时候去取吗？`
        : `刚收到一条账单通知——${bill?.title ?? "账单已出"}。` +
          `要我帮你记进账本吗？`,
      createdAt: now,
      source: "bill_parcel",
      subject: isParcel ? "快递" : "账单",
      detail: Object.fromEntries(detailLines.map((l) => l.split(": "))),
      // 通知闭环（2026-11-23 M1）：两个按钮都背靠真接口——
      // 左键回写台账（已取件 / 已处理），右键走管道推迟重投。
      // 快递只在有取件码时给「已取件」（没码说明还在路上，取件无从谈起）。
      notifyOptions: isParcel
        ? parcel?.pickupCode
          ? [
              { action: "parcel_picked", label: "已取件", ref: parcel.id },
              { action: "snooze", label: "晚点提醒我", delayMs: PARCEL_REMIND_LATER_MS },
            ]
          : [{ action: "acknowledge", label: "知道了" }]
        : [
            { action: "bill_settled", label: "已处理", ref: primary.id },
            { action: "snooze", label: "明天提醒", delayMs: BILL_REMIND_TOMORROW_MS },
          ],
    });
  }

  /** 测试/诊断用：当前冷却表条目数 */
  get cooldownSize(): number {
    return this.cooldown.size;
  }
}
