/**
 * 预订层统一两阶段确认（ask_first 分支）。
 *
 * 与 shopping-order 的 PendingConfirmation 同构，但抽成独立可测组件：
 *   阶段一（confirm=false）：mint() 生成 token（TTL 默认 5 分钟），
 *     返回待确认摘要；LLM 必须先向用户复述摘要
 *   阶段二（confirm=true + token）：consume() 校验 token / TTL / actor /
 *     action / domain 一致后放行执行；一次性消费
 *
 * token 过期自动清理（60s 定时 + 消费时惰性删除）。
 */

import { randomUUID } from "node:crypto";

import type { BookingDomain, BookingDraft } from "./booking-provider.js";

export interface BookingPendingConfirmation {
  token: string;
  actorId: string;
  domain: BookingDomain;
  provider: string;
  /** 确认的动作：book（下单）/ cancel（取消）/ refund（退改工单） */
  action: "book" | "cancel" | "refund";
  /** book：订单草稿；cancel/refund：待处理的本地 orderId */
  draft: BookingDraft | null;
  orderId: string | null;
  /** 复述给用户的摘要 */
  summary: string;
  amountCny: number | null;
  expiresAt: number;
}

export interface BookingConfirmationStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export type ConsumeResult =
  | { ok: true; pending: BookingPendingConfirmation }
  | { ok: false; error: string; retryable?: boolean };

export class BookingConfirmationStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pendings = new Map<string, BookingPendingConfirmation>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(opts: BookingConfirmationStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 阶段一：生成待确认记录。 */
  mint(input: {
    actorId: string;
    domain: BookingDomain;
    provider: string;
    action: "book" | "cancel" | "refund";
    draft?: BookingDraft | null;
    orderId?: string | null;
    summary: string;
    amountCny: number | null;
  }): BookingPendingConfirmation {
    this.startCleanup();
    const pending: BookingPendingConfirmation = {
      token: randomUUID(),
      actorId: input.actorId,
      domain: input.domain,
      provider: input.provider,
      action: input.action,
      draft: input.draft ?? null,
      orderId: input.orderId ?? null,
      summary: input.summary,
      amountCny: input.amountCny,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pendings.set(pending.token, pending);
    return pending;
  }

  /** 阶段二：校验并一次性消费 token。 */
  consume(
    token: string,
    expect: { actorId: string; action: "book" | "cancel" | "refund"; domain: BookingDomain },
  ): ConsumeResult {
    if (!token) return { ok: false, error: "缺少 confirmationToken（来自阶段一）" };
    const pending = this.pendings.get(token);
    if (!pending) {
      return { ok: false, error: "确认 token 无效或已被使用，请重新发起（confirm=false）", retryable: true };
    }
    if (this.now() > pending.expiresAt) {
      this.pendings.delete(token);
      return { ok: false, error: "确认已过期，请重新发起（confirm=false）", retryable: true };
    }
    if (pending.actorId !== expect.actorId) {
      return { ok: false, error: "确认 token 与当前用户不匹配" };
    }
    if (pending.action !== expect.action || pending.domain !== expect.domain) {
      return { ok: false, error: `确认 token 与当前操作不匹配（token 属于 ${pending.domain} ${pending.action}）` };
    }
    this.pendings.delete(token);
    return { ok: true, pending };
  }

  /**
   * 阶段二缺 token 时的服务端兜底：消费同 actor + action + domain 下未过期的
   * 最新一条待确认记录（optionId 可匹配时优先）。
   *
   * 为什么存在（2026-10-18 live e2e 实证）：工具循环会把已完成工具结果折叠成
   * 摘要行（replan/digest 历史），阶段一 mint 的 token 字符串会从模型工作上下文
   * 消失——要求 LLM 回抄不透明 token 让两阶段确认在多轮会话里必然断链。聊天
   * 通道里用户明确说「确认下单」+ 模型 confirm=true 即确认语义，凭证由本层
   * 确定性校验（actor/domain/action 一致 + TTL + 一次性消费）承担，token 回抄
   * 降级为可选路径。安全语义不变：找不到任何待确认记录仍 fail-closed 拒绝。
   */
  consumeLatest(
    expect: { actorId: string; action: "book" | "cancel" | "refund"; domain: BookingDomain },
    preferredOptionId?: string,
  ): ConsumeResult {
    const nowMs = this.now();
    let best: BookingPendingConfirmation | null = null; // 最近 mint 的合格 pending
    let exact: BookingPendingConfirmation | null = null; // 最近 mint 且 optionId 精确匹配
    for (const pending of this.pendings.values()) {
      if (nowMs > pending.expiresAt) continue; // 过期条目留给定时清理，不在此删（避免迭代中变更）
      if (pending.actorId !== expect.actorId) continue;
      if (pending.action !== expect.action || pending.domain !== expect.domain) continue;
      best = pending; // Map 迭代序 = mint 序，后写入者覆盖 → 最新
      if (preferredOptionId && pending.draft?.optionId === preferredOptionId) {
        exact = pending;
      }
    }
    const chosen = exact ?? best;
    if (!chosen) {
      return {
        ok: false,
        error: "当前没有待确认的订单（确认摘要已过期或从未生成）。请先带 confirm=false 重新生成确认摘要，用户同意后再 confirm=true 下单。",
        retryable: true,
      };
    }
    this.pendings.delete(chosen.token);
    return { ok: true, pending: chosen };
  }

  /** 失败归还：把未执行成功的待确认记录放回（保留原 TTL；已过期则丢弃）。 */
  restore(pending: BookingPendingConfirmation): void {
    if (this.now() > pending.expiresAt) return;
    this.pendings.set(pending.token, pending);
  }

  /** 存量统计（测试/调试）。 */
  get size(): number {
    return this.pendings.size;
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const nowMs = this.now();
      for (const [token, pending] of this.pendings) {
        if (nowMs > pending.expiresAt) this.pendings.delete(token);
      }
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pendings.clear();
  }
}
