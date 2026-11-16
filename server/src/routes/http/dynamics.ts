// 「动态」tab 聚合路由（手机端统一入口页数据源）
//
// GET /api/dynamics?userId=&sessionId=&days=30&limit=8
//
// 一次请求聚合 Agent 主动性产出，客户端免多次往返：
//   bills         账单汇总 + 最近条目（bill-parcel-ledger；主动记账）
//   parcels       快递汇总 + 待取件列表（同台账；已取件单独计数）
//   alerts        未决提醒 + 主动动作足迹（attentionStore + activityStore）
//   mail          邮件流最近要事（跨源采集库 mail 流；low 信号不进动态页）
//   subscriptions 订阅与续费扫描（只读台账；不登录第三方）
//   blockedThisWeek 入口拦截计数（电商营销/验证码/重复物流/群聊）
//   sources       邮件监听真实状态（通知使用权由客户端本机读取）
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
import { scanSubscriptions } from "../../services/bill-subscription-scan.js";
import type {
  DynamicsSettingsStore,
  SourceRuleAction,
  SourceRuleId,
} from "../../services/dynamics-settings-store.js";

export interface DynamicsRouteDeps {
  billParcelLedger?: BillParcelLedger | null;
  attentionStore?: AttentionStore | null;
  activityStore?: AgentActivityStore | null;
  /** 跨源采集库（mail 流要事；未注入时 mail 区块为空） */
  sourceStore?: SourceStore | null;
  /** 来源规则 + 拦截计数（未注入时返回默认规则、零计数） */
  settings?: DynamicsSettingsStore | null;
  /** 邮件监听真实状态（GET /api/dynamics/sources 用） */
  mailWatchStatus?: (actorId: string) => unknown;
  /** 时钟（测试注入） */
  now?: () => number;
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
  const now = deps.now ?? Date.now;

  /** 主聚合（首页 / 各列表页共用；动作后客户端重拉一次即可） */
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
    const settings = deps.settings;

    // —— 账单 / 快递（同一台账，summary 内已按窗口聚合）——
    const ledger = deps.billParcelLedger;
    const summary = ledger ? ledger.summary({ actorId, days }) : null;
    let parcelEntries: BillParcelEntry[] = [];
    if (ledger) {
      // 待取件排前；列表整体新→旧；已取件仍保留（详情可撤销）
      const parcels = ledger.list({ category: "parcel", actorId, limit: 80 });
      const seen = new Set<string>();
      parcelEntries = [
        ...parcels.filter((e) => e.pickupCode && e.pickedUpAt == null),
        ...parcels,
      ]
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .slice(0, Math.max(limit, 20));
    }

    // —— 订阅与续费：只读台账，不登录第三方 ——
    const billEntries = ledger
      ? ledger.list({
          category: "bill",
          actorId,
          since: now() - 90 * 24 * 60 * 60 * 1000,
          limit: 300,
        })
      : [];
    const subscriptions = scanSubscriptions(billEntries, {
      now: now(),
      reminders: settings?.allSubscriptionReminders() ?? {},
      filter: (item) => !settings?.isSubscriptionDismissed(item.id),
    });

    // —— 提醒 / 足迹 ——
    const pending: AttentionRecord[] = deps.attentionStore?.listOpen(actorId).slice(0, limit) ?? [];
    const activity = deps.activityStore?.list(actorId, limit) ?? [];

    // —— 邮件要事：low 信号不进动态页 ——
    const mailSignals = deps.sourceStore?.byStream("mail", { actorId, limit: limit * 3 }) ?? [];

    return {
      ok: true,
      generatedAt: now(),
      bills: summary
        ? {
            count: summary.bills.count,
            totalAmount: summary.bills.totalAmount,
            amountCount: summary.bills.amountCount,
            reimbursedCount: summary.bills.reimbursedCount,
            wrongCount: summary.bills.wrongCount,
            duplicateIds: summary.bills.duplicateIds,
            byType: summary.bills.byType,
            recent: summary.recent.filter((e) => e.category === "bill").slice(0, Math.max(limit, 20)),
          }
        : {
            count: 0,
            totalAmount: 0,
            amountCount: 0,
            reimbursedCount: 0,
            wrongCount: 0,
            duplicateIds: [],
            byType: [],
            recent: [],
          },
      parcels: {
        count: summary?.parcels.count ?? 0,
        awaitingPickup: summary?.parcels.awaitingPickup ?? 0,
        pickedUp: summary?.parcels.pickedUp ?? 0,
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
      subscriptions,
      blockedThisWeek:
        settings?.blockedThisWeek(now()) ?? {
          total: 0,
          byReason: { marketing: 0, otp: 0, duplicateParcel: 0, sourceRule: 0, groupChat: 0 },
          since: 0,
        },
      sources: {
        mail: deps.mailWatchStatus?.(actorId) ?? null,
        serverTime: now(),
      },
    };
  });

  /** 消息设置页数据：来源规则 + 拦截计数 + 邮件真实状态 */
  app.get("/api/dynamics/sources", async (request) => {
    const query = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    return {
      ok: true,
      rules: deps.settings?.rules() ?? [],
      blockedThisWeek: deps.settings?.blockedThisWeek(now()) ?? null,
      mail: deps.mailWatchStatus?.(actorId) ?? null,
      serverTime: now(),
    };
  });

  /** 来源规则开关（enter / block，入口层立即生效） */
  app.put("/api/dynamics/sources/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { action?: string };
    if (!deps.settings) {
      return reply.code(503).send({ ok: false, error: "settings not wired" });
    }
    if (!isSourceRuleId(id)) {
      return reply.code(400).send({ ok: false, error: "unknown rule id" });
    }
    const action: SourceRuleAction = body.action === "block" ? "block" : "enter";
    return { ok: true, rules: deps.settings.setRule(id, action) };
  });

  /** 快递取件 / 撤销取件 */
  app.post("/api/dynamics/parcels/:id/pickup", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { pickedUp?: boolean };
    const entry = deps.billParcelLedger?.setPickedUp(id, body.pickedUp !== false, now());
    if (!entry) return reply.code(404).send({ ok: false, error: "parcel not found" });
    return { ok: true, item: entry };
  });

  /** 账单复核：reimbursed / wrong / clear */
  app.post("/api/dynamics/bills/:id/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: string };
    const status =
      body.status === "reimbursed" || body.status === "wrong"
        ? body.status
        : body.status === "clear"
          ? null
          : undefined;
    if (status === undefined) {
      return reply.code(400).send({ ok: false, error: "status must be reimbursed|wrong|clear" });
    }
    const entry = deps.billParcelLedger?.setBillStatus(id, status);
    if (!entry) return reply.code(404).send({ ok: false, error: "bill not found" });
    return { ok: true, item: entry };
  });

  /** 稍后提醒（until=null 取消） */
  app.post("/api/dynamics/entries/:id/snooze", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { until?: number | null };
    const until = typeof body.until === "number" && Number.isFinite(body.until) ? body.until : null;
    const entry = deps.billParcelLedger?.snooze(id, until);
    if (!entry) return reply.code(404).send({ ok: false, error: "entry not found" });
    return { ok: true, item: entry };
  });

  /** 归档 / 取消归档 */
  app.post("/api/dynamics/entries/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { archived?: boolean };
    const entry = deps.billParcelLedger?.setArchived(id, body.archived !== false);
    if (!entry) return reply.code(404).send({ ok: false, error: "entry not found" });
    return { ok: true, item: entry };
  });

  /** 置顶 / 取消置顶 */
  app.post("/api/dynamics/entries/:id/pin", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { pinned?: boolean };
    const entry = deps.billParcelLedger?.setPinned(id, body.pinned !== false);
    if (!entry) return reply.code(404).send({ ok: false, error: "entry not found" });
    return { ok: true, item: entry };
  });

  /** 忽略一条订阅建议（不删账单，只不再提示） */
  app.post("/api/dynamics/subscriptions/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.settings) {
      return reply.code(503).send({ ok: false, error: "settings not wired" });
    }
    deps.settings.dismissSubscription(id);
    return { ok: true };
  });

  /** 续费前提醒（真实写入设置；按订阅 id） */
  app.post("/api/dynamics/subscriptions/:id/remind", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.settings) {
      return reply.code(503).send({ ok: false, error: "settings not wired" });
    }
    const body = (request.body ?? {}) as { at?: number };
    const at = typeof body.at === "number" && Number.isFinite(body.at) ? body.at : undefined;
    deps.settings.remindSubscription(id, at);
    return { ok: true, remindAt: deps.settings.subscriptionReminder(id) };
  });
}

const SOURCE_RULE_IDS: ReadonlySet<string> = new Set([
  "bankSms",
  "ecommerceMarketing",
  "parcelNotice",
  "groupChat",
]);

function isSourceRuleId(id: string): id is SourceRuleId {
  return SOURCE_RULE_IDS.has(id);
}
