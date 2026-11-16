// 账单/快递汇总台账 —— 「自动识别并汇总」的落点（2026-11-13）。
//
// 病根：邮件与短信此前各扫各的、各存各的，识别结果只留在各自的内存环形缓冲里，
// 既不能跨源合并（"这个月话费扣了多少 + 快递单号在哪儿"），也不能在重启后追问。
// 本台账把两条链路识别出的条目**汇到一处**，提供：
//   - list()    —— 条目明细（可按类别/来源/时间/用户过滤）
//   - summary() —— 区间汇总（账单金额合计 + 分类分组、快递件数 + 承运商分组 + 待取件）
//
// 2026-11-16 动态 tab 改版：条目增加可操作状态（已取件 / 已报销 / 记错了 /
// 稍后提醒 / 归档 / 置顶），汇总口径随之修正——
//   · 已取件不再计入待取，也不再进首页待取数；
//   · 记错了从金额合计与分类占比中扣除，但条目仍保留在列表（金额删除线）；
//   · 归档不进任何列表与汇总，但数据保留可追溯。
//
// 存储选 JSON 而非 SQLite：条目量级是「每月几十条」，无并发写压力，
// 读写模式与仓库既有 persist-file.ts 一致（tmp 原子替换），可读性/可调试性更好。
import { join } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import type { BillParcelCategory } from "./bill-parcel-classifier.js";

/** 来源 */
export type BillParcelSource = "sms" | "email" | "notification" | "other";

/** 账单复核状态：已报销 / 记错了（记错了不计入合计） */
export type BillStatus = "reimbursed" | "wrong";

/** 台账条目 */
export type BillParcelEntry = {
  /** 去重指纹（同一条不重复入库） */
  id: string;
  /** 类别（一条可同属 bill + parcel，但拆成两条 entry 便于按类汇总） */
  category: BillParcelCategory;
  source: BillParcelSource;
  actorId: string;
  /** 一行摘要 */
  title: string;
  /** 金额（元） */
  amount: number | null;
  /** 账单子类（话费/还款/银行卡…） */
  billType: string | null;
  /** 快递单号 */
  trackingNo: string | null;
  /** 取件码 */
  pickupCode: string | null;
  /** 承运商 */
  carrier: string | null;
  /** 发生时刻 ms */
  occurredAt: number;
  /** 原文摘要（供人工核对与检索） */
  excerpt: string;
  /** 快递已取件时刻（null / 缺省 = 未取件） */
  pickedUpAt?: number | null;
  /** 账单复核状态（null / 缺省 = 未复核） */
  billStatus?: BillStatus | null;
  /** 稍后提醒到点时间（ms；null = 无） */
  snoozeUntil?: number | null;
  /** 置顶（首页队列/列表排前） */
  pinned?: boolean;
  /** 归档时刻（有值即不进列表与汇总） */
  archivedAt?: number | null;
};

/** 台账查询参数 */
export type BillParcelListQuery = {
  category?: BillParcelCategory;
  source?: BillParcelSource;
  actorId?: string;
  /** 起始时刻（含）ms */
  since?: number;
  /** 结束时刻（不含）ms */
  until?: number;
  limit?: number;
  /** 是否包含已归档（默认 false） */
  includeArchived?: boolean;
};

/** 区间汇总 */
export type BillParcelSummary = {
  window: { days: number; from: number; to: number };
  bills: {
    /** 条目数（含记错了，不含归档） */
    count: number;
    /** 金额合计（剔除「记错了」与无金额条目） */
    totalAmount: number;
    /** 有金额且未记错了的条目数（合计的分母，避免"0 元账单"稀释平均） */
    amountCount: number;
    /** 已报销笔数 */
    reimbursedCount: number;
    /** 记错了笔数（已从合计扣除） */
    wrongCount: number;
    byType: Array<{ type: string; count: number; amount: number }>;
    /** 同商户/同类型 + 同金额 + 48 小时内 ≥2 笔（仅提示，不自动删） */
    duplicateIds: string[];
  };
  parcels: {
    /** 条目数（含已取件，不含归档） */
    count: number;
    /** 待取件（有取件码且未标记已取） */
    awaitingPickup: number;
    /** 已取件数 */
    pickedUp: number;
    byCarrier: Array<{ carrier: string; count: number }>;
    /** 最近一条待取件（去哪儿取、码是多少） */
    latestPickup: { title: string; pickupCode: string | null; occurredAt: number } | null;
  };
  /** 最近的条目（新→旧），供工具直接呈现 */
  recent: BillParcelEntry[];
};

export type BillParcelLedgerOptions = {
  /** 台账文件目录（通常为 getDataDir()） */
  dataPath: string;
  /** 测试注入时钟 */
  now?: () => number;
  /** 条目上限（默认 500） */
  maxEntries?: number;
  /** 保留天数（默认 90） */
  retentionDays?: number;
};

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_RETENTION_DAYS = 90;
/** 疑似重复：同商户/类型 + 同金额 + 48 小时窗口 */
const DUPLICATE_WINDOW_MS = 48 * 60 * 60 * 1000;

type PersistedShape = {
  version: 1;
  entries: BillParcelEntry[];
};

export class BillParcelLedger {
  private readonly filePath: string;
  private readonly nowFn: () => number;
  private readonly maxEntries: number;
  private readonly retentionDays: number;
  private entries: BillParcelEntry[] = [];
  private loaded = false;

  constructor(private readonly opts: BillParcelLedgerOptions) {
    this.filePath = join(opts.dataPath, "bill-parcel-ledger.json");
    this.nowFn = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /** 读盘（幂等，可重复调用） */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson<PersistedShape>(this.filePath, { version: 1, entries: [] });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    this.entries = entries.filter((e) => this.isValidEntry(e));
    this.prune();
  }

  /**
   * 写入一条（按类别拆条：一条内容同时是账单+快递时落两条）。
   * 返回实际新增的条目；全部重复时返回空数组。
   */
  add(
    input: Omit<BillParcelEntry, "id" | "occurredAt"> & {
      occurredAt?: number;
      id?: string;
      externalId?: string;
    },
  ): BillParcelEntry[] {
    this.load();
    const occurredAt = input.occurredAt ?? this.nowFn();
    const added: BillParcelEntry[] = [];
    const category = input.category;
    const id =
      input.id ??
      makeEntryId(
        {
          actorId: input.actorId,
          source: input.source,
          title: input.title,
          trackingNo: input.trackingNo,
          pickupCode: input.pickupCode,
          amount: input.amount,
          externalId: input.externalId ?? null,
        },
        category,
        occurredAt,
      );
    if (this.entries.some((e) => e.id === id)) return added;
    const entry: BillParcelEntry = {
      id,
      category,
      source: input.source,
      actorId: input.actorId,
      title: input.title,
      amount: input.amount,
      billType: input.billType,
      trackingNo: input.trackingNo,
      pickupCode: input.pickupCode,
      carrier: input.carrier,
      occurredAt,
      excerpt: input.excerpt,
      pickedUpAt: input.pickedUpAt ?? null,
      billStatus: input.billStatus ?? null,
      snoozeUntil: input.snoozeUntil ?? null,
      pinned: input.pinned ?? false,
      archivedAt: input.archivedAt ?? null,
    };
    this.entries.push(entry);
    added.push(entry);
    if (added.length > 0) {
      this.prune();
      this.persist();
    }
    return added;
  }

  /** 明细查询（新→旧） */
  list(query: BillParcelListQuery = {}): BillParcelEntry[] {
    this.load();
    const until = query.until ?? Number.POSITIVE_INFINITY;
    const limit = query.limit ?? 50;
    return this.entries
      .filter((e) => {
        if (!query.includeArchived && e.archivedAt != null) return false;
        if (query.category && e.category !== query.category) return false;
        if (query.source && e.source !== query.source) return false;
        if (query.actorId && e.actorId !== query.actorId) return false;
        if (query.since != null && e.occurredAt < query.since) return false;
        if (e.occurredAt >= until) return false;
        return true;
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.occurredAt - a.occurredAt)
      .slice(0, Math.max(1, limit));
  }

  /** 按 id 取一条（含归档；找不到返回 null） */
  get(id: string): BillParcelEntry | null {
    this.load();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /** 标记快递已取件 / 撤销（pickedUp=false 时清空时刻） */
  setPickedUp(id: string, pickedUp: boolean, at?: number): BillParcelEntry | null {
    return this.mutate(id, (e) => {
      if (e.category !== "parcel") return false;
      e.pickedUpAt = pickedUp ? at ?? this.nowFn() : null;
      return true;
    });
  }

  /** 账单复核：reimbursed / wrong / clear(null) */
  setBillStatus(id: string, status: BillStatus | null): BillParcelEntry | null {
    return this.mutate(id, (e) => {
      if (e.category !== "bill") return false;
      e.billStatus = status;
      return true;
    });
  }

  /** 稍后提醒（until=null 清除） */
  snooze(id: string, until: number | null): BillParcelEntry | null {
    return this.mutate(id, (e) => {
      e.snoozeUntil = until;
      return true;
    });
  }

  /** 归档 / 取消归档 */
  setArchived(id: string, archived: boolean): BillParcelEntry | null {
    return this.mutate(id, (e) => {
      e.archivedAt = archived ? this.nowFn() : null;
      return true;
    });
  }

  /** 置顶 / 取消置顶 */
  setPinned(id: string, pinned: boolean): BillParcelEntry | null {
    return this.mutate(id, (e) => {
      e.pinned = pinned;
      return true;
    });
  }

  /** 区间汇总 */
  summary(opts: { actorId?: string; days?: number } = {}): BillParcelSummary {
    this.load();
    const days = Math.max(1, opts.days ?? 30);
    const now = this.nowFn();
    const from = now - days * 24 * 60 * 60 * 1000;
    const scoped = this.entries.filter(
      (e) =>
        (!opts.actorId || e.actorId === opts.actorId) &&
        e.archivedAt == null &&
        e.occurredAt >= from &&
        e.occurredAt <= now,
    );

    const bills = scoped.filter((e) => e.category === "bill");
    const parcels = scoped.filter((e) => e.category === "parcel");

    const typeMap = new Map<string, { count: number; amount: number }>();
    let totalAmount = 0;
    let amountCount = 0;
    let reimbursedCount = 0;
    let wrongCount = 0;
    for (const b of bills) {
      if (b.billStatus === "reimbursed") reimbursedCount += 1;
      if (b.billStatus === "wrong") {
        wrongCount += 1;
        continue;
      }
      const type = b.billType ?? "其他";
      const cur = typeMap.get(type) ?? { count: 0, amount: 0 };
      cur.count += 1;
      if (b.amount != null) {
        cur.amount += b.amount;
        totalAmount += b.amount;
        amountCount += 1;
      }
      typeMap.set(type, cur);
    }

    const carrierMap = new Map<string, number>();
    let awaitingPickup = 0;
    let pickedUp = 0;
    for (const p of parcels) {
      const carrier = p.carrier ?? "未知";
      carrierMap.set(carrier, (carrierMap.get(carrier) ?? 0) + 1);
      if (p.pickedUpAt != null) pickedUp += 1;
      else if (p.pickupCode) awaitingPickup += 1;
    }

    const pickupEntries = parcels
      .filter((p) => p.pickupCode && p.pickedUpAt == null)
      .sort((a, b) => b.occurredAt - a.occurredAt);

    return {
      window: { days, from, to: now },
      bills: {
        count: bills.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        amountCount,
        reimbursedCount,
        wrongCount,
        byType: [...typeMap.entries()]
          .map(([type, v]) => ({ type, count: v.count, amount: Math.round(v.amount * 100) / 100 }))
          .sort((a, b) => b.amount - a.amount || b.count - a.count),
        duplicateIds: this.findDuplicateBills(bills).map((b) => b.id),
      },
      parcels: {
        count: parcels.length,
        awaitingPickup,
        pickedUp,
        byCarrier: [...carrierMap.entries()]
          .map(([carrier, count]) => ({ carrier, count }))
          .sort((a, b) => b.count - a.count),
        latestPickup: pickupEntries[0]
          ? {
              title: pickupEntries[0].title,
              pickupCode: pickupEntries[0].pickupCode,
              occurredAt: pickupEntries[0].occurredAt,
            }
          : null,
      },
      recent: scoped
        .slice()
        .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.occurredAt - a.occurredAt)
        .slice(0, 20),
    };
  }

  /** 条目总数（诊断） */
  size(): number {
    this.load();
    return this.entries.length;
  }

  /**
   * 疑似重复：同金额 + 同类型（或同标题）+ 48 小时内 ≥2 笔。
   * 只标记较新的一笔（重复项），不改金额、不自动删除。
   */
  private findDuplicateBills(bills: BillParcelEntry[]): BillParcelEntry[] {
    const out: BillParcelEntry[] = [];
    for (const b of bills) {
      if (b.amount == null || b.billStatus === "wrong") continue;
      const same = bills.some(
        (o) =>
          o.id !== b.id &&
          o.amount === b.amount &&
          o.billStatus !== "wrong" &&
          (o.billType ?? "") === (b.billType ?? "") &&
          Math.abs(o.occurredAt - b.occurredAt) <= DUPLICATE_WINDOW_MS,
      );
      if (same) out.push(b);
    }
    return out;
  }

  private mutate(id: string, fn: (entry: BillParcelEntry) => boolean): BillParcelEntry | null {
    this.load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    if (!fn(entry)) return null;
    this.persist();
    return entry;
  }

  private isValidEntry(e: unknown): e is BillParcelEntry {
    if (!e || typeof e !== "object") return false;
    const o = e as Partial<BillParcelEntry>;
    return (
      (o.category === "bill" || o.category === "parcel") &&
      typeof o.id === "string" &&
      typeof o.occurredAt === "number" &&
      Number.isFinite(o.occurredAt)
    );
  }

  /** 过期清理 + 容量封顶 */
  private prune(): void {
    const cutoff = this.nowFn() - this.retentionDays * 24 * 60 * 60 * 1000;
    this.entries = this.entries.filter((e) => e.occurredAt >= cutoff);
    if (this.entries.length > this.maxEntries) {
      // 保留最新 maxEntries 条
      this.entries = this.entries
        .slice()
        .sort((a, b) => b.occurredAt - a.occurredAt)
        .slice(0, this.maxEntries)
        .sort((a, b) => a.occurredAt - b.occurredAt);
    }
  }

  private persist(): void {
    writeJson(this.filePath, { version: 1, entries: this.entries } satisfies PersistedShape);
  }
}

/**
 * 条目指纹：同一条内容不重复入库。
 *
 * 稳定业务键优先级（**从高到低**）：
 *   1. 快递单号 —— 跨渠道一致（短信与邮件转述同一单快递时只应记一次）
 *   2. 取件码   —— 同上
 *   3. 来源 id  —— 同一封信/同一条短信被重复抓取时去重
 *   4. 组合指纹 —— 来源+归属+标题+日期+金额；去掉秒级时间以容忍重复轮询
 */
export function makeEntryId(
  input: {
    actorId: string;
    source: string;
    title: string;
    trackingNo?: string | null;
    pickupCode?: string | null;
    amount?: number | null;
    externalId?: string | null;
  },
  category: BillParcelCategory,
  occurredAt: number,
): string {
  const stableKey =
    input.trackingNo?.trim() ||
    input.pickupCode?.trim() ||
    input.externalId?.trim() ||
    `${input.source}|${input.actorId}|${input.title}|${dayKey(occurredAt)}|${input.amount ?? ""}`;
  return `${category}:${hashShort(stableKey)}`;
}

/** 本地日期键（YYYY-MM-DD，按运行环境的本地时区） */
export function dayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 轻量稳定哈希（FNV-1a 32bit，够做去重指纹，不追求密码学强度） */
function hashShort(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
