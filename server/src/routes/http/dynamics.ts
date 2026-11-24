// 「动态」tab 聚合路由（手机端统一入口页数据源）
//
// GET /api/dynamics?userId=&sessionId=&days=30&limit=8
//
// 一次请求聚合 Agent 主动性产出，客户端免多次往返：
//   bills   账单汇总 + 最近条目（bill-parcel-ledger；主动记账）
//   monthly 「{月份}小结」月报（PRD §9 钱的月报；客户端顶部账单汇总卡 + 明细页）
//   parcels 快递汇总 + 待取件列表（同台账；快递聚合，待取件排前）
//   alerts  未决提醒 + 主动动作足迹（attentionStore + activityStore）
//   mail    邮件流最近要事（跨源采集库 mail 流；low 信号不进动态页）
//
// 各数据源均为可选注入：缺哪个该区块为空数组/零值，接口恒 ok:true——
// 客户端按区块渲染空态，不做整体失败。days 同时约束账单汇总窗口。
//
// POST /api/dynamics/bills/category 改一条账单的类目（§9「类目可改」）：回写台账
// 并打纠正标记，之后识别器把它当训练样本用（见 bill-parcel-classifier 学习层）。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { listBillTypes } from "../../services/bill-parcel-classifier.js";
import { looksLikeOtpText } from "../../services/mail-watch-service.js";
import type { BillParcelLedger, BillParcelEntry } from "../../services/bill-parcel-ledger.js";
import { buildMonthlyBillSummary } from "../../services/monthly-bill-summary.js";
import type { MonthlyBillSummaryDeps } from "../../services/monthly-bill-summary.js";
import type { AttentionStore, AttentionRecord } from "../../proactivity/attention-store.js";
import type { AgentActivityStore } from "../../proactivity/activity-store.js";
import type { SourceStore } from "../../proactivity/source-store.js";

export interface DynamicsRouteDeps {
  billParcelLedger?: BillParcelLedger | null;
  attentionStore?: AttentionStore | null;
  activityStore?: AgentActivityStore | null;
  /** 跨源采集库（mail 流要事；未注入时 mail 区块为空） */
  sourceStore?: SourceStore | null;
  /** 订阅盘点（月报卡订阅/续费段数据源；未注入时该段为空） */
  subscriptionAudit?: MonthlyBillSummaryDeps["subscriptionAudit"];
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 验证码信号兜底过滤（2026-11-14 用户定稿：动态页不允许验证码进入）。
 * 源头（MailWatchService）已整封丢弃验证码，这里再拦两层：
 *   ① 历史落库的验证码信号（salience=medium 的旧 normal 件）在启动清理前仍可能
 *      停留在内存窗口；
 *   ② 任何上游改动都不该让验证码重新出现在动态页。
 * 判据：payload.importance==="otp" 或 标题/正文像验证码。
 */
function isOtpSignal(s: Record<string, unknown>): boolean {
  const payload = (s.payload ?? {}) as Record<string, unknown>;
  if (payload.importance === "otp") return true;
  const title = String(s.delta ?? "").replace(/^新邮件：/, "");
  return looksLikeOtpText(title) || looksLikeOtpText(String(payload.text ?? ""));
}

/** 邮件信号裁剪成动态页要事的轻量形状 */
function pickMailSignal(s: Record<string, unknown>): {
  at: number;
  salience: string;
  title: string;
  text: string;
} {
  const payload = (s.payload ?? {}) as Record<string, unknown>;
  return {
    at: Number(s.at ?? 0),
    salience: String(s.salience ?? "normal"),
    title: String(s.delta ?? "").replace(/^新邮件：/, ""),
    text: String(payload.text ?? "").slice(0, 160),
  };
}

export function registerDynamicsRoutes(app: FastifyInstance, deps: DynamicsRouteDeps): void {
  app.get("/api/dynamics", async (request) => {
    const query = request.query as {
      userId?: string;
      sessionId?: string;
      days?: string;
      limit?: string;
    };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    const days = clampInt(query.days, 30, 1, 90);
    const limit = clampInt(query.limit, 8, 1, 50);

    // —— 账单 / 快递（同一台账，summary 内已按窗口聚合）——
    const ledger = deps.billParcelLedger;
    const summary = ledger ? ledger.summary({ actorId, days }) : null;
    let parcelEntries: BillParcelEntry[] = [];
    if (ledger) {
      // 待取件（有取件码且未确认取走）排前；列表整体新→旧。
      // 已取件的条目（resolvedAt，2026-11-23 通知闭环）仍留在列表里作历史，排在后面。
      const parcels = ledger.list({ category: "parcel", actorId, limit: 50 });
      const seen = new Set<string>();
      parcelEntries = [...parcels.filter((e) => e.pickupCode && !e.resolvedAt), ...parcels].filter((e) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      }).slice(0, limit);
    }

    // —— 提醒 / 足迹 ——
    const pending: AttentionRecord[] = deps.attentionStore?.listOpen(actorId).slice(0, limit) ?? [];
    const activity = deps.activityStore?.list(actorId, limit) ?? [];

    // —— 邮件要事：low 信号不进动态页 ——
    const mailSignals = deps.sourceStore?.byStream("mail", { actorId, limit: limit * 3 }) ?? [];

    return {
      ok: true,
      generatedAt: Date.now(),
      bills: summary
        ? {
            count: summary.bills.count,
            totalAmount: summary.bills.totalAmount,
            amountCount: summary.bills.amountCount,
            byType: summary.bills.byType,
            largest: summary.bills.largest,
            recent: summary.recent.filter((e) => e.category === "bill").slice(0, limit),
          }
        : { count: 0, totalAmount: 0, amountCount: 0, byType: [], largest: null, recent: [] },
      // §9 钱的月报：客户端顶部「账单月结」汇总卡 + 月报明细页的数据源。
      // 台账缺失时给 null 而不是零值——客户端据此退回窗口合计口径，不显示一排 0。
      monthly: ledger
        ? await buildMonthlyBillSummary(
            { ledger, subscriptionAudit: deps.subscriptionAudit ?? null },
            actorId,
          )
        : null,
      parcels: {
        count: summary?.parcels.count ?? 0,
        awaitingPickup: summary?.parcels.awaitingPickup ?? 0,
        byCarrier: summary?.parcels.byCarrier ?? [],
        latestPickup: summary?.parcels.latestPickup ?? null,
        recent: parcelEntries,
      },
      alerts: {
        pending,
        activity,
        unreadActivity: deps.activityStore?.unreadCount(actorId) ?? 0,
      },
      mail: {
        recent: mailSignals
          .filter((s) => (s as Record<string, unknown>).salience !== "low")
          .filter((s) => !isOtpSignal(s as Record<string, unknown>))
          .slice(0, limit)
          .map((s) => pickMailSignal(s as Record<string, unknown>)),
      },
      // 改类目的候选项（与识别规则同源，见 listBillTypes）
      billTypes: listBillTypes(),
    };
  });

  /**
   * 改一条账单的类目（§9「类目可改，改动作为分类器的反馈」）。
   *
   * 落点是台账条目本身（bill-parcel-ledger.json 的 billType + correctedBillType
   * 标记）——不新建表、不新建文件；识别器下一次 ingest 就把这条当训练样本读走。
   */
  app.post<{ Body: { userId?: string; sessionId?: string; id?: string; billType?: string } }>(
    "/api/dynamics/bills/category",
    async (request, reply) => {
      const ledger = deps.billParcelLedger;
      if (!ledger) return reply.code(503).send({ ok: false, error: "账单台账未启用" });
      const b = request.body;
      const billType = String(b?.billType ?? "").trim();
      if (!b?.id || !billType) {
        return reply.code(400).send({ ok: false, error: "id / billType 必填" });
      }
      if (billType.length > 24) {
        return reply.code(400).send({ ok: false, error: "billType 过长（≤24 字）" });
      }
      const actorId = resolveActorId({ userId: b.userId, sessionId: b.sessionId ?? "" });
      const entry: BillParcelEntry | null = ledger.setBillType(b.id, actorId, billType);
      if (!entry) return reply.code(404).send({ ok: false, error: "账单不存在或不属于该用户" });
      return { ok: true, entry };
    },
  );
}
