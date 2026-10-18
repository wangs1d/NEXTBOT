/**
 * 方案 A：统一预订编排服务。
 *
 * 所有预订类域（网约车 / 家政 / 餐厅 / 未来的旅行票务）共用同一编排：
 *
 *   search    → 路由到域内 Provider（可指定 key），返回 options + 可用性说明
 *   book      → 两阶段确认（ask_first）：
 *                 阶段一 confirm=false：重新报价定位 option → 单笔/单日限额校验 →
 *                   生成 token + 复述摘要；LLM 必须先让用户确认
 *                 阶段二 confirm=true+token：执行 provider.book → 本地订单落库 →
 *                   写入承诺板（deadline=服务时间）→ 审计
 *   getStatus → 本地订单 → provider.getStatus；completed 时同步承诺板 fulfill
 *   cancel    → 两阶段确认；成功后同步承诺板 cancel
 *   reschedule→ 改期（家政）；同步订单与承诺板 deadline
 *
 * 支付边界：Agent 只下单不代付。Provider 返回 paymentUrl 时原样透出，
 * 由用户手动完成支付（「下单到支付页面」模式）。
 *
 * 安全护栏（不依赖访问模式，沙箱下也可用）：
 *   1. 两阶段确认 token（BOOKING_CONFIRMATION_TTL_MS 默认 5 分钟）
 *   2. 单笔上限 BOOKING_MAX_AMOUNT_CNY（默认 1000）
 *   3. 单日累计上限 BOOKING_DAILY_BUDGET_CNY（默认 500；0=不限）
 *   4. Provider availability 门禁（缺 key/企业资质直接拒绝）
 *   5. 审计日志（AuditService）
 * 自主任务通道另有 AgentTaskSafety 高危拦截（book 工具名在
 * isHighRiskFinancialTool 名单中，require_approval）。
 */

import { randomBytes } from "node:crypto";
import { resolveActorId } from "../../agent/actor-id.js";
import type { CommitmentBoard } from "../../agentic-memory/commitment-board.js";
import type { AuditService } from "../audit-service.js";
import type { ToolContext } from "../../tools/tool-registry.js";

import type {
  BookingDomain,
  BookingDraft,
  BookingProvider,
  BookingProviderContext,
  BookingOrderStatus,
} from "./booking-provider.js";
import { newBookingOrderId, BookingOrderStore, localDateKey, type StoredBookingOrder } from "./booking-order-store.js";
import { BookingConfirmationStore, type BookingPendingConfirmation } from "./booking-confirmation.js";
import { getBookingConfig, type BookingConfig } from "./booking-config.js";
import type { ScheduleBookingBridge } from "../schedule-booking-bridge.js";

export type BookingServiceResult =
  | { ok: true; summary: string } & Record<string, unknown>
  | { ok: false; error: string; retryable?: boolean };

const DOMAIN_LABELS: Record<BookingDomain, string> = {
  ride: "网约车",
  home_service: "家政/本地生活",
  restaurant: "餐厅预订",
  travel: "旅行票务",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface BookingServiceDeps {
  providers: BookingProvider[];
  store?: BookingOrderStore;
  /** 承诺板可延后注入（bootstrap 中晚于服务构造） */
  board?: CommitmentBoard | null;
  audit?: AuditService | null;
  /** 日程联动桥可延后注入（bootstrap 中晚于冲突服务构造） */
  scheduleBridge?: ScheduleBookingBridge | null;
  config?: Partial<BookingConfig>;
  now?: () => Date;
}

export class BookingService {
  private readonly providers: BookingProvider[];
  private readonly store: BookingOrderStore;
  private board: CommitmentBoard | null;
  private readonly audit: AuditService | null;
  private bridge: ScheduleBookingBridge | null;
  private readonly config: BookingConfig;
  private readonly now: () => Date;
  private readonly confirmations: BookingConfirmationStore;
  /** 同一 actor 的下单执行锁（promise 链）：阶段二限额复查与订单落库之间不留并发窗口 */
  private readonly bookLocks = new Map<string, Promise<unknown>>();

  constructor(deps: BookingServiceDeps) {
    this.providers = deps.providers;
    this.store = deps.store ?? new BookingOrderStore(null);
    this.board = deps.board ?? null;
    this.audit = deps.audit ?? null;
    this.bridge = deps.scheduleBridge ?? null;
    this.config = { ...getBookingConfig(), ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.confirmations = new BookingConfirmationStore({
      ttlMs: this.config.confirmationTtlMs,
      now: () => this.now().getTime(),
    });
  }

  /** bootstrap 中承诺板构造完成后注入（见 create-app-services.ts）。 */
  setCommitmentBoard(board: CommitmentBoard | null): void {
    this.board = board;
  }

  /** bootstrap 中日程冲突服务构造完成后注入（见 create-app-services.ts）。 */
  setScheduleBridge(bridge: ScheduleBookingBridge | null): void {
    this.bridge = bridge;
  }

  dispose(): void {
    this.confirmations.dispose();
  }

  // ------------------------------------------------------------------ //
  // Provider 路由
  // ------------------------------------------------------------------ //

  providersForDomain(domain: BookingDomain): BookingProvider[] {
    return this.providers.filter((p) => p.domain === domain);
  }

  private resolveProvider(domain: BookingDomain, providerKey?: string):
    | { ok: true; provider: BookingProvider }
    | { ok: false; error: string; retryable?: boolean } {
    const candidates = this.providersForDomain(domain);
    if (candidates.length === 0) {
      return {
        ok: false,
        error: `「${DOMAIN_LABELS[domain]}」暂无可用预订 Provider（BOOKING_MODE=${this.config.mode}；live 模式需配置对应平台 API key）`,
        retryable: false,
      };
    }
    let provider: BookingProvider | undefined;
    if (providerKey) {
      provider = candidates.find((p) => p.key === providerKey);
      if (!provider) {
        return {
          ok: false,
          error: `未找到 provider「${providerKey}」。可选：${candidates.map((p) => `${p.key}（${p.label}）`).join("、")}`,
          retryable: true,
        };
      }
    } else {
      provider = candidates.find((p) => p.availability().ok) ?? candidates[0];
    }
    const avail = provider.availability();
    if (!avail.ok) {
      return { ok: false, error: `${provider.label} 不可用：${avail.reason ?? "未知原因"}`, retryable: false };
    }
    return { ok: true, provider };
  }

  private providerContext(ctx: ToolContext): BookingProviderContext {
    return { actorId: resolveActorId(ctx), location: ctx.clientLocation ?? null, toolContext: ctx };
  }

  // ------------------------------------------------------------------ //
  // search
  // ------------------------------------------------------------------ //

  async search(
    ctx: ToolContext,
    domain: BookingDomain,
    query: {
      city?: string;
      scheduleAt?: string | null;
      params: Record<string, unknown>;
    },
    providerKey?: string,
  ): Promise<BookingServiceResult> {
    const resolved = this.resolveProvider(domain, providerKey);
    if (!resolved.ok) return resolved;
    const { provider } = resolved;

    const result = await provider.search(
      {
        domain,
        city: query.city,
        location: ctx.clientLocation ?? null,
        scheduleAt: query.scheduleAt ?? null,
        params: query.params,
      },
      this.providerContext(ctx),
    );
    if (!result.ok) return result;

    const availabilityNotes = this.providersForDomain(domain)
      .filter((p) => p.key !== provider.key && !p.availability().ok)
      .map((p) => `${p.label} 不可用：${p.availability().reason ?? "未知"}`);

    return {
      ok: true,
      summary: `「${DOMAIN_LABELS[domain]}」${provider.label} 返回 ${result.options.length} 个选项`,
      provider: provider.key,
      providerLabel: provider.label,
      options: result.options,
      note: result.note,
      otherProviderNotes: availabilityNotes.length > 0 ? availabilityNotes : undefined,
    };
  }

  // ------------------------------------------------------------------ //
  // book（两阶段确认）
  // ------------------------------------------------------------------ //

  async book(
    ctx: ToolContext,
    domain: BookingDomain,
    input: {
      provider?: string;
      optionId: string;
      params: Record<string, unknown>;
      city?: string;
      scheduleAt?: string | null;
      confirm: boolean;
      confirmationToken?: string;
    },
  ): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    if (input.confirm) {
      // 阶段二确认凭证两条路（2026-10-18）：
      //   a) 模型回抄 confirmationToken（原有路径，token 仍在上下文时最精确）；
      //   b) 缺 token → 服务端消费同 actor+action+domain 的最新待确认记录
      //      （optionId 可匹配时优先）。工具循环会把已完成工具结果折叠成摘要，
      //      阶段一 mint 的 token 字符串多轮后会从模型上下文消失，回抄必然断链；
      //      用户在会话内明确同意 + confirm=true 即确认语义，凭证校验由
      //      BookingConfirmationStore 确定性承担（actor/domain/action + TTL + 一次性）。
      const token = input.confirmationToken?.trim() ?? "";
      const consumed = token
        ? this.confirmations.consume(token, { actorId, action: "book", domain })
        : this.confirmations.consumeLatest({ actorId, action: "book", domain }, input.optionId);
      if (!consumed.ok) return consumed;
      return this.executeBookStage2(ctx, consumed.pending);
    }
    return this.executeBookStage1(ctx, domain, input);
  }

  private async executeBookStage1(
    ctx: ToolContext,
    domain: BookingDomain,
    input: {
      provider?: string;
      optionId: string;
      params: Record<string, unknown>;
      city?: string;
      scheduleAt?: string | null;
    },
  ): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    const resolved = this.resolveProvider(domain, input.provider);
    if (!resolved.ok) return resolved;
    const { provider } = resolved;

    // 重新报价定位 option（报价可能过期，以本次结果为准）
    const searchResult = await provider.search(
      {
        domain,
        city: input.city,
        location: ctx.clientLocation ?? null,
        scheduleAt: input.scheduleAt ?? null,
        params: input.params,
      },
      this.providerContext(ctx),
    );
    if (!searchResult.ok) return searchResult;
    const option = searchResult.options.find((o) => o.id === input.optionId);
    if (!option) {
      return {
        ok: false,
        error: `未找到 optionId「${input.optionId}」。当前可选：${searchResult.options.map((o) => `${o.id}=${o.title}`).join("；")}`,
        retryable: true,
      };
    }

    // 限额校验：单笔 + 单日累计
    const amount = option.amountCny;
    if (amount != null && amount > this.config.maxAmountCny) {
      await this.recordAudit(ctx, "book_blocked_amount", domain, {
        provider: provider.key,
        optionId: option.id,
        amount,
        limit: this.config.maxAmountCny,
      });
      return {
        ok: false,
        error: `金额 ¥${amount} 超过单笔上限 ¥${this.config.maxAmountCny}，已拒绝。可调整 BOOKING_MAX_AMOUNT_CNY。`,
        retryable: false,
      };
    }
    if (amount != null && this.config.dailyBudgetCny > 0) {
      const spentToday = await this.store.sumAmountOnDate(actorId, localDateKey(this.now()));
      if (spentToday + amount > this.config.dailyBudgetCny) {
        await this.recordAudit(ctx, "book_blocked_daily", domain, {
          provider: provider.key,
          optionId: option.id,
          amount,
          spentToday,
          limit: this.config.dailyBudgetCny,
        });
        return {
          ok: false,
          error: `今日已预订 ¥${spentToday}，本次 ¥${amount} 将超过单日上限 ¥${this.config.dailyBudgetCny}，已拒绝。可调整 BOOKING_DAILY_BUDGET_CNY。`,
          retryable: false,
        };
      }
    }

    // 组装草稿：把报价时确定的坐标等关键 extra 并入下单参数
    const draftParams: Record<string, unknown> = { ...input.params };
    for (const key of ["origin", "destination"]) {
      if (isRecord(option.extra) && typeof option.extra[key] === "string") {
        draftParams[key] = option.extra[key];
      }
    }
    const scheduleAt = option.scheduleAt ?? input.scheduleAt ?? null;
    // 日程冲突预检（程序层）：有冲突时在摘要中提示，由 LLM 向用户转述并让用户决定
    let conflictInfo: Record<string, unknown> | null = null;
    if (this.bridge && scheduleAt) {
      try {
        const precheck = this.bridge.precheckBookConflict(
          { actorId, scheduleAt },
          option.durationMinutes,
          ctx.clientLocation?.timezone?.trim() || "Asia/Shanghai",
        );
        if (precheck.conflict) conflictInfo = precheck.toolResult;
      } catch {
        // 冲突预检失败不阻断预订链路
      }
    }
    const summaryParts = [
      `即将预订「${DOMAIN_LABELS[domain]}」`,
      option.title,
      option.description ?? "",
      amount != null ? `金额：¥${amount}` : "金额：以平台为准",
      scheduleAt ? `服务时间：${scheduleAt}` : "",
      conflictInfo ? "⚠️ 该时间与已有日程冲突" : "",
      option.simulated ? "⚠️ 模拟模式：不会真实下单" : "",
    ].filter(Boolean);
    const summary = summaryParts.join("，");

    const draft: BookingDraft = {
      domain,
      provider: provider.key,
      optionId: option.id,
      title: option.title,
      amountCny: amount,
      scheduleAt,
      durationMinutes: option.durationMinutes ?? null,
      summary,
      params: draftParams,
    };
    const pending = this.confirmations.mint({
      actorId,
      domain,
      provider: provider.key,
      action: "book",
      draft,
      summary,
      amountCny: amount,
    });

    await this.recordAudit(ctx, "book_stage1", domain, {
      provider: provider.key,
      optionId: option.id,
      amount,
      token: pending.token,
    });

    return {
      ok: true,
      summary,
      needsConfirmation: true,
      confirmationToken: pending.token,
      expiresInMs: this.config.confirmationTtlMs,
      provider: provider.key,
      providerLabel: provider.label,
      optionId: option.id,
      amountCny: amount,
      scheduleAt,
      simulated: option.simulated === true,
      ...(conflictInfo
        ? {
            scheduleConflict: conflictInfo,
            hint:
              "该预订时间与用户已有日程冲突：请先向用户逐条转述 scheduleConflict.conflicts 并询问是否仍要预订；用户明确坚持后再走阶段二确认。",
          }
        : {
            hint: "请向用户复述上述摘要（模拟模式必须说明是模拟），得到明确同意后，再调用一次本工具并把 confirm 传 true 完成预订（confirmationToken 可省略，系统会自动匹配本次待确认记录）",
          }),
    };
  }

  private async executeBookStage2(ctx: ToolContext, pending: BookingPendingConfirmation): Promise<BookingServiceResult> {
    const draft = pending.draft;
    if (!draft) return { ok: false, error: "确认记录缺少订单草稿" };
    const actorId = resolveActorId(ctx);

    // 同一 actor 的下单执行串行化：保证限额复查读到之前刚落库的订单
    return this.runExclusive(actorId, async () => {
      const resolved = this.resolveProvider(draft.domain, draft.provider);
      if (!resolved.ok) return resolved;
      const { provider } = resolved;

      // 阶段二复查限额：阶段一 mint 之后用户可能又确认了其他订单，
      // 仅靠阶段一校验会被多笔待确认 token 击穿单日累计
      const amount = draft.amountCny;
      if (amount != null && amount > this.config.maxAmountCny) {
        await this.recordAudit(ctx, "book_blocked_amount_stage2", draft.domain, {
          provider: provider.key,
          optionId: draft.optionId,
          amount,
          limit: this.config.maxAmountCny,
        });
        return { ok: false, error: `金额 ¥${amount} 超过单笔上限 ¥${this.config.maxAmountCny}，已拒绝。`, retryable: false };
      }
      if (amount != null && this.config.dailyBudgetCny > 0) {
        const spentToday = await this.store.sumAmountOnDate(actorId, localDateKey(this.now()));
        if (spentToday + amount > this.config.dailyBudgetCny) {
          await this.recordAudit(ctx, "book_blocked_daily_stage2", draft.domain, {
            provider: provider.key,
            optionId: draft.optionId,
            amount,
            spentToday,
            limit: this.config.dailyBudgetCny,
          });
          return {
            ok: false,
            error: `今日已预订 ¥${spentToday}，本次 ¥${amount} 将超过单日上限 ¥${this.config.dailyBudgetCny}，已拒绝。可调整 BOOKING_DAILY_BUDGET_CNY。`,
            retryable: false,
          };
        }
      }

      let bookResult;
      try {
        bookResult = await provider.book(draft, this.providerContext(ctx));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `预订执行失败：${message}`, retryable: true };
      }
      if (!bookResult.ok) {
        // 瞬时失败归还 token：用户可直接重试阶段二（token 过期后需重新走阶段一）；
        // 不可重试失败（如企业资质未配置）烧掉 token，避免残留僵尸确认
        if (bookResult.retryable) this.confirmations.restore(pending);
        await this.recordAudit(ctx, "book_failed", draft.domain, {
          provider: provider.key,
          optionId: draft.optionId,
          error: bookResult.error,
        });
        return bookResult;
      }

      const nowIso = this.now().toISOString();
      const simulated = this.config.mode === "mock";
      const orderId = newBookingOrderId(this.now());
      const order: StoredBookingOrder = {
        orderId,
        actorId,
        domain: draft.domain,
        provider: provider.key,
        providerOrderId: bookResult.providerOrderId ?? null,
        title: draft.title,
        amountCny: draft.amountCny,
        status: bookResult.status ?? "confirmed",
        scheduleAt: draft.scheduleAt ?? null,
        deadline: draft.scheduleAt ?? null,
        params: draft.params,
        paymentUrl: bookResult.paymentUrl ?? null,
        commitmentId: null,
        simulated,
        createdAt: nowIso,
        updatedAt: nowIso,
        dateKey: localDateKey(this.now()),
      };

      // 写入承诺板跟踪状态（失败不阻断下单结果）
      let commitmentId: string | null = null;
      if (this.board) {
        try {
          const created = this.board.create({
            actorId,
            text: `【${DOMAIN_LABELS[draft.domain]}】${draft.title}${draft.amountCny != null ? `（¥${draft.amountCny}）` : ""} 已下单${simulated ? "（模拟）" : ""}`,
            committedBy: "agent",
            deadline: draft.scheduleAt ?? null,
            source: "manual",
            notes: `bookingOrderId=${orderId}; provider=${provider.key}; providerOrderId=${bookResult.providerOrderId ?? "-"}`,
          });
          if (created && !("error" in created)) commitmentId = created.id;
        } catch {
          // 承诺板异常不影响预订主链路
        }
      }
      order.commitmentId = commitmentId;

      // 落库失败不回滚平台订单（假失败会诱导用户重复下单，比缺失本地记录更危险），
      // 如实返回部分成功并由调用方转告用户
      let persistenceError: string | null = null;
      try {
        await this.store.create(order);
      } catch (err) {
        persistenceError = err instanceof Error ? err.message : String(err);
        console.warn(`[Booking] 订单落库失败（平台订单已创建）：orderId=${orderId}，${persistenceError}`);
      }

      await this.recordAudit(ctx, "book_stage2", draft.domain, {
        provider: provider.key,
        orderId,
        providerOrderId: bookResult.providerOrderId,
        amount: draft.amountCny,
        simulated,
        persistenceFailed: persistenceError != null,
      });

      // 日程联动：下单成功自动建日程（失败不阻断下单结果，仅透出告警）
      let scheduleWarning: string | null = null;
      let scheduleTaskId: string | null = null;
      if (this.bridge) {
        try {
          const task = await this.bridge.onBooked(order, {
            timezone: ctx.clientLocation?.timezone?.trim() || "Asia/Shanghai",
            durationMinutes: draft.durationMinutes,
          });
          if (task) scheduleTaskId = task.taskId;
        } catch (err) {
          scheduleWarning = err instanceof Error ? err.message : String(err);
          console.warn(`[Booking] 预订联动建日程失败（不影响下单）：orderId=${orderId}，${scheduleWarning}`);
        }
      }

      const summaryParts = [
        `已提交${DOMAIN_LABELS[draft.domain]}预订${simulated ? "（模拟模式，未真实下单）" : ""}`,
        draft.title,
        draft.amountCny != null ? `金额 ¥${draft.amountCny}` : "",
        scheduleTaskId ? "已自动加入日程" : "",
        bookResult.paymentUrl ? "支付链接已返回，请在支付页面手动完成支付" : "",
      ].filter(Boolean);

      return {
        ok: true,
        summary: summaryParts.join("，"),
        orderId,
        provider: provider.key,
        providerOrderId: bookResult.providerOrderId ?? null,
        status: order.status,
        amountCny: draft.amountCny,
        scheduleAt: order.scheduleAt,
        paymentUrl: order.paymentUrl,
        simulated,
        commitmentId,
        tracking: bookResult.tracking,
        ...(scheduleTaskId ? { scheduleTaskId } : {}),
        ...(scheduleWarning
          ? { scheduleWarning: `预订已成功，但自动创建日程失败：${scheduleWarning}` }
          : {}),
        ...(persistenceError
          ? { persistenceWarning: `订单已在平台创建，但本地记录落库失败：${persistenceError}。请知悉该订单可能不会出现在本地订单列表中。` }
          : {}),
        note:
          bookResult.message ??
          (order.paymentUrl
            ? "Agent 不代付：请打开支付链接手动完成支付"
            : simulated
              ? "模拟模式：结果为沙盒数据，必须如实告知用户"
              : undefined),
      };
    });
  }

  /** 同一 actor 的写操作互斥执行（promise 链，前序失败不阻塞后序）。 */
  private runExclusive<T>(actorId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.bookLocks.get(actorId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.bookLocks.set(actorId, next.catch(() => {}));
    return next;
  }

  // ------------------------------------------------------------------ //
  // getStatus / listOrders
  // ------------------------------------------------------------------ //

  async getStatus(ctx: ToolContext, domain: BookingDomain, orderId?: string): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    if (!orderId) {
      const orders = await this.store.listByActor(actorId, { domain, includeFinished: true, limit: 10 });
      return {
        ok: true,
        summary: `最近 ${orders.length} 笔${DOMAIN_LABELS[domain]}订单`,
        orders: orders.map(summarizeOrder),
      };
    }
    const order = await this.store.get(orderId);
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `订单 ${orderId} 不存在` };
    }
    if (order.domain !== domain) {
      return { ok: false, error: `订单 ${orderId} 属于「${DOMAIN_LABELS[order.domain]}」，不是「${DOMAIN_LABELS[domain]}」` };
    }

    // 模拟订单：providerOrderId 在进程内存中（重启后无法回查），直接返回本地快照
    const resolved = this.resolveProvider(domain, order.provider);
    if (resolved.ok && order.providerOrderId) {
      try {
        const statusResult = await resolved.provider.getStatus(
          { provider: order.provider, providerOrderId: order.providerOrderId },
          this.providerContext(ctx),
        );
        if (statusResult.ok && statusResult.status && statusResult.status !== order.status) {
          await this.applyStatusTransition(order, statusResult.status, statusResult.message);
          order.status = statusResult.status;
        }
        if (statusResult.ok) {
          return {
            ok: true,
            summary: `订单 ${orderId}：${order.status}${statusResult.message ? `（${statusResult.message}）` : ""}`,
            order: summarizeOrder(order),
            tracking: statusResult.tracking,
            simulated: order.simulated,
          };
        }
        // provider 查询失败：降级返回本地快照（标注）
        return {
          ok: true,
          summary: `订单 ${orderId}：${order.status}（Provider 查询失败，展示本地快照：${statusResult.error}）`,
          order: summarizeOrder(order),
          simulated: order.simulated,
          degraded: true,
        };
      } catch {
        // 回退本地快照
      }
    }
    return {
      ok: true,
      summary: `订单 ${orderId}：${order.status}（本地快照）`,
      order: summarizeOrder(order),
      simulated: order.simulated,
    };
  }

  /** 状态迁移时同步本地订单与承诺板。 */
  private async applyStatusTransition(order: StoredBookingOrder, next: BookingOrderStatus, message?: string): Promise<void> {
    await this.store.update(order.orderId, { status: next });
    if (this.board && order.commitmentId) {
      try {
        if (next === "completed") {
          this.board.fulfill(order.commitmentId);
        } else if (next === "cancelled" || next === "failed") {
          this.board.cancel(order.commitmentId, message ?? `预订状态变为 ${next}`);
        }
      } catch {
        // 承诺板异常不影响主链路
      }
    }
  }

  // ------------------------------------------------------------------ //
  // cancel（两阶段确认）
  // ------------------------------------------------------------------ //

  async cancel(
    ctx: ToolContext,
    domain: BookingDomain,
    orderId: string,
    confirm: boolean,
    confirmationToken?: string,
    reason?: string,
  ): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    const order = await this.store.get(orderId);
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `订单 ${orderId} 不存在` };
    }
    if (order.domain !== domain) {
      return { ok: false, error: `订单 ${orderId} 不属于「${DOMAIN_LABELS[domain]}」` };
    }
    if (order.status === "cancelled") {
      return { ok: false, error: "订单已是取消状态" };
    }
    if (order.status === "completed") {
      return { ok: false, error: "订单已完成，无法取消" };
    }

    if (confirm) {
      const consumed = this.confirmations.consume(confirmationToken ?? "", {
        actorId,
        action: "cancel",
        domain,
      });
      if (!consumed.ok) return consumed;
      return this.executeCancelStage2(ctx, order, reason);
    }

    // 阶段一
    const summary = `即将取消「${DOMAIN_LABELS[domain]}」订单：${order.title}${order.amountCny != null ? `（¥${order.amountCny}）` : ""}${order.simulated ? "（模拟）" : ""}`;
    const pending = this.confirmations.mint({
      actorId,
      domain,
      provider: order.provider,
      action: "cancel",
      orderId: order.orderId,
      summary,
      amountCny: order.amountCny,
    });
    await this.recordAudit(ctx, "cancel_stage1", domain, { orderId, token: pending.token });
    return {
      ok: true,
      summary,
      needsConfirmation: true,
      confirmationToken: pending.token,
      expiresInMs: this.config.confirmationTtlMs,
      hint: "请向用户复述待取消订单摘要，得到明确同意后，带 confirm=true + confirmationToken 再调用完成取消",
    };
  }

  private async executeCancelStage2(ctx: ToolContext, order: StoredBookingOrder, reason?: string): Promise<BookingServiceResult> {
    const resolved = this.resolveProvider(order.domain, order.provider);
    if (!resolved.ok) return resolved;

    if (order.providerOrderId) {
      try {
        const cancelResult = await resolved.provider.cancel(
          { provider: order.provider, providerOrderId: order.providerOrderId },
          reason,
          this.providerContext(ctx),
        );
        if (!cancelResult.ok) {
          await this.recordAudit(ctx, "cancel_failed", order.domain, { orderId: order.orderId, error: cancelResult.error });
          return cancelResult;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `取消执行失败：${message}`, retryable: true };
      }
    }

    await this.store.update(order.orderId, { status: "cancelled" });
    if (this.board && order.commitmentId) {
      try {
        this.board.cancel(order.commitmentId, reason ?? "用户主动取消预订");
      } catch {
        // 承诺板异常不影响主链路
      }
    }
    // 日程反向同步：取消预订 → 取消关联日程（失败不阻断）
    let scheduleSyncWarning: string | null = null;
    if (this.bridge) {
      try {
        await this.bridge.onCancelled(order);
      } catch (err) {
        scheduleSyncWarning = err instanceof Error ? err.message : String(err);
        console.warn(`[Booking] 取消联动日程失败：orderId=${order.orderId}，${scheduleSyncWarning}`);
      }
    }
    await this.recordAudit(ctx, "cancel_stage2", order.domain, {
      orderId: order.orderId,
      providerOrderId: order.providerOrderId,
      reason,
    });

    return {
      ok: true,
      summary: `已取消${DOMAIN_LABELS[order.domain]}订单 ${order.orderId}（${order.title}）`,
      orderId: order.orderId,
      status: "cancelled",
      simulated: order.simulated,
      ...(scheduleSyncWarning
        ? { scheduleWarning: `订单已取消，但关联日程取消失败：${scheduleSyncWarning}，可让用户手动删除该日程` }
        : {}),
    };
  }

  // ------------------------------------------------------------------ //
  // requestRefund（已支付/已出票订单退改工单：Agent 立单+导航，不代办真实退改）
  // ------------------------------------------------------------------ //

  /**
   * travel 域已出票订单的退票/改签：真实退改只能在原下单平台办理且涉及
   * 资金退回，Agent 不代办最终提交。本方法只做两件事：
   *   1. 两阶段确认后在本地订单上创建退改工单（params.refundTickets，可断点续办）
   *   2. 返回平台导航指引：经用户批准后由 agent_browser 打开原平台订单页，
   *      退改入口的「最终提交」必须由用户本人点击
   */
  async requestRefund(
    ctx: ToolContext,
    domain: BookingDomain,
    orderId: string,
    input: {
      kind: "refund" | "change";
      reason?: string;
      confirm: boolean;
      confirmationToken?: string;
    },
  ): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    const order = await this.store.get(orderId);
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `订单 ${orderId} 不存在` };
    }
    if (order.domain !== domain) {
      return { ok: false, error: `订单 ${orderId} 不属于「${DOMAIN_LABELS[domain]}」` };
    }
    if (order.status === "cancelled") {
      return { ok: false, error: "订单已取消，无需退改" };
    }
    if (order.status === "pending_payment") {
      return {
        ok: false,
        error: "订单尚未支付，直接取消即可（cancel），无需退改工单",
        retryable: false,
      };
    }
    if (order.status === "completed") {
      return {
        ok: false,
        error: "订单已完成（行程/入住已结束），退改时效一般已过；如需办理请直接联系商家或平台客服",
        retryable: false,
      };
    }

    if (input.confirm) {
      const consumed = this.confirmations.consume(input.confirmationToken ?? "", {
        actorId,
        action: "refund",
        domain,
      });
      if (!consumed.ok) return consumed;
      return this.executeRefundStage2(ctx, order, input.kind, input.reason);
    }

    const summary =
      `即将为「${DOMAIN_LABELS[domain]}」订单「${order.title}」创建${input.kind === "refund" ? "退票" : "改签"}工单。` +
      "真实退改将在原下单平台办理（Agent 只立单并提供页面导航，退改费用与时效以平台规则为准，最终提交须用户本人确认）";
    const pending = this.confirmations.mint({
      actorId,
      domain,
      provider: order.provider,
      action: "refund",
      orderId: order.orderId,
      summary,
      amountCny: order.amountCny,
    });
    await this.recordAudit(ctx, "refund_stage1", domain, { orderId, kind: input.kind, token: pending.token });
    return {
      ok: true,
      summary,
      needsConfirmation: true,
      confirmationToken: pending.token,
      expiresInMs: this.config.confirmationTtlMs,
      hint: "请向用户复述工单摘要（含「真实退改在原平台办理、费用以平台规则为准」），用户明确同意后带 confirm=true + confirmationToken 再调用完成立单",
    };
  }

  private async executeRefundStage2(
    ctx: ToolContext,
    order: StoredBookingOrder,
    kind: "refund" | "change",
    reason?: string,
  ): Promise<BookingServiceResult> {
    const ticketId = `rft_${this.now().getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
    const ticket = {
      ticketId,
      kind,
      reason: reason ?? null,
      status: "pending_user",
      createdAt: this.now().toISOString(),
    };
    const existing = Array.isArray(order.params.refundTickets) ? order.params.refundTickets : [];
    await this.store.update(order.orderId, {
      params: { ...order.params, refundTickets: [...existing, ticket] },
    });
    await this.recordAudit(ctx, "refund_ticket_created", order.domain, {
      orderId: order.orderId,
      providerOrderId: order.providerOrderId,
      ticketId,
      kind,
      reason,
    });

    return {
      ok: true,
      summary: `退改工单已创建（${ticketId}，${kind === "refund" ? "退票" : "改签"}）。真实退改须在原下单平台办理，Agent 不代办最终提交`,
      orderId: order.orderId,
      ticketId,
      kind,
      navigation: {
        platformHint:
          "经用户批准后，用 agent_browser.open 打开原下单平台的「我的订单」页（如携程 my.ctrip.com、12306 订单页、酒店平台订单页），" +
          "定位该订单进入退改签入口；页面上的「提交退票/改签」最终确认必须由用户本人点击，Agent 不得代点",
        cashierUrl: typeof order.params.cashierUrl === "string" ? order.params.cashierUrl : null,
      },
      note: "退改手续费与时效以平台规则为准，请如实转告用户；工单已随订单保存，可断点续办",
    };
  }

  // ------------------------------------------------------------------ //
  // reschedule（家政等改期；单次调用，需用户明确给出新时间）
  // ------------------------------------------------------------------ //

  async reschedule(
    ctx: ToolContext,
    domain: BookingDomain,
    orderId: string,
    scheduleAt: string,
  ): Promise<BookingServiceResult> {
    const actorId = resolveActorId(ctx);
    const ts = Date.parse(scheduleAt);
    if (!Number.isFinite(ts)) {
      return { ok: false, error: `scheduleAt 不是合法 ISO 时间：${scheduleAt}`, retryable: true };
    }
    const order = await this.store.get(orderId);
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `订单 ${orderId} 不存在` };
    }
    if (order.domain !== domain) {
      return { ok: false, error: `订单 ${orderId} 不属于「${DOMAIN_LABELS[domain]}」` };
    }
    if (order.status === "cancelled" || order.status === "completed") {
      return { ok: false, error: `订单已${order.status === "cancelled" ? "取消" : "完成"}，无法改期` };
    }

    const resolved = this.resolveProvider(domain, order.provider);
    if (!resolved.ok) return resolved;
    if (order.providerOrderId) {
      try {
        const result = resolved.provider.reschedule
          ? await resolved.provider.reschedule(
              { provider: order.provider, providerOrderId: order.providerOrderId },
              scheduleAt,
              this.providerContext(ctx),
            )
          : { ok: false as const, error: `provider「${order.provider}」不支持改期` };
        if (!result.ok) return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `改期执行失败：${message}`, retryable: true };
      }
    }

    await this.store.update(order.orderId, { scheduleAt, deadline: scheduleAt });
    if (this.board && order.commitmentId) {
      try {
        this.board.update(order.commitmentId, { deadline: scheduleAt });
      } catch {
        // 承诺板异常不影响主链路
      }
    }
    // 日程反向同步：改期预订 → 更新关联日程时间（失败不阻断）
    let scheduleSyncWarning: string | null = null;
    if (this.bridge) {
      try {
        const updatedOrder = { ...order, scheduleAt, deadline: scheduleAt };
        await this.bridge.onRescheduled(updatedOrder, scheduleAt);
      } catch (err) {
        scheduleSyncWarning = err instanceof Error ? err.message : String(err);
        console.warn(`[Booking] 改期联动日程失败：orderId=${orderId}，${scheduleSyncWarning}`);
      }
    }
    await this.recordAudit(ctx, "reschedule", domain, { orderId, scheduleAt });

    return {
      ok: true,
      summary: `订单 ${orderId} 已改期至 ${scheduleAt}`,
      orderId,
      scheduleAt,
      simulated: order.simulated,
      ...(scheduleSyncWarning
        ? { scheduleWarning: `订单已改期，但关联日程改期失败：${scheduleSyncWarning}，可让用户手动调整该日程` }
        : {}),
    };
  }

  // ------------------------------------------------------------------ //
  // 审计
  // ------------------------------------------------------------------ //

  private async recordAudit(
    ctx: ToolContext,
    action: string,
    domain: BookingDomain,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record({
        ts: this.now().toISOString(),
        category: "booking",
        action,
        domain,
        actorId: resolveActorId(ctx),
        sessionId: ctx.sessionId,
        ...extra,
      });
    } catch {
      // 审计失败静默（与 shopping-order 一致）
    }
  }
}

/** 订单摘要（返回给 LLM / 前端的裁剪视图）。 */
function summarizeOrder(order: StoredBookingOrder): Record<string, unknown> {
  return {
    orderId: order.orderId,
    domain: order.domain,
    provider: order.provider,
    title: order.title,
    amountCny: order.amountCny,
    status: order.status,
    scheduleAt: order.scheduleAt,
    paymentUrl: order.paymentUrl,
    simulated: order.simulated,
    createdAt: order.createdAt,
  };
}
