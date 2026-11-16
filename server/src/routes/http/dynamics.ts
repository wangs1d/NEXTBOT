// 「动态」tab 聚合路由（手机端统一入口页数据源）
//
// GET /api/dynamics?userId=&sessionId=&days=30&limit=8
//
// 一次请求聚合 Agent 主动性产出，客户端免多次往返：
//   bills   账单汇总 + 最近条目（bill-parcel-ledger；主动记账）
//   parcels 快递汇总 + 待取件列表（同台账；快递聚合，待取件排前）
//   alerts  未决提醒 + 主动动作足迹（attentionStore + activityStore）
//   mail    邮件流最近要事（跨源采集库 mail 流；low 信号不进动态页）
//
// 各数据源均为可选注入：缺哪个该区块为空数组/零值，接口恒 ok:true——
// 客户端按区块渲染空态，不做整体失败。days 同时约束账单汇总窗口。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { looksLikeOtpText } from "../../services/mail-watch-service.js";
import type { BillParcelLedger, BillParcelEntry } from "../../services/bill-parcel-ledger.js";
import type { AttentionStore, AttentionRecord } from "../../proactivity/attention-store.js";
import type { AgentActivityStore } from "../../proactivity/activity-store.js";
import type { SourceStore } from "../../proactivity/source-store.js";

export interface DynamicsRouteDeps {
  billParcelLedger?: BillParcelLedger | null;
  attentionStore?: AttentionStore | null;
  activityStore?: AgentActivityStore | null;
  /** 跨源采集库（mail 流要事；未注入时 mail 区块为空） */
  sourceStore?: SourceStore | null;
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
      // 待取件（有取件码）排前；列表整体新→旧
      const parcels = ledger.list({ category: "parcel", actorId, limit: 50 });
      const seen = new Set<string>();
      parcelEntries = [...parcels.filter((e) => e.pickupCode), ...parcels].filter((e) => {
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
            recent: summary.recent.filter((e) => e.category === "bill").slice(0, limit),
          }
        : { count: 0, totalAmount: 0, amountCount: 0, byType: [], recent: [] },
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
    };
  });
}
