// 账单/快递汇总台账 —— 「自动识别并汇总」的落点（2026-11-13）。
//
// 病根：邮件与短信此前各扫各的、各存各的，识别结果只留在各自的内存环形缓冲里，
// 既不能跨源合并（"这个月话费扣了多少 + 快递单号在哪儿"），也不能在重启后追问。
// 本台账把两条链路识别出的条目**汇到一处**，提供：
//   - list()    —— 条目明细（可按类别/来源/时间/用户过滤）
//   - summary() —— 区间汇总（账单金额合计 + 分类分组、快递件数 + 承运商分组 + 待取件）
//
// 存储选 JSON 而非 SQLite：条目量级是「每月几十条」，无并发写压力，
// 读写模式与仓库既有 persist-file.ts 一致（tmp 原子替换），可读性/可调试性更好。
import { join } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import type { BillParcelCategory } from "./bill-parcel-classifier.js";

/** 来源 */
export type BillParcelSource = "sms" | "email" | "notification" | "other";

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
  /** 已处理时刻 ms（通知栏「已取件 / 已处理」写入；缺省 = 仍待办） */
  resolvedAt?: number | null;
  /**
   * 人工纠正后的类目（§9 月报卡「类目可改」，2026-11-24）。
   * 与 billType 同值时表示"这条是纠正过的样本"——classifierCorrections() 据此
   * 把它当作分类器训练数据回灌，下一次同类文本直接按纠正后的类目识别。
   */
  correctedBillType?: string | null;
  /** 纠正时刻 ms（缺省 = 从未被人工纠正） */
  correctedAt?: number | null;
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
};

/** 区间内金额最大的一笔（月报「最大单笔」用；只带呈现所需字段） */
export type BillParcelLargest = {
  id: string;
  title: string;
  amount: number;
  billType: string | null;
  occurredAt: number;
};

/** 区间汇总 */
export type BillParcelSummary = {
  window: { days: number; from: number; to: number };
  bills: {
    count: number;
    /** 金额合计（仅统计有金额的条目） */
    totalAmount: number;
    /** 有金额的条目数（合计的分母，避免"0 元账单"稀释平均） */
    amountCount: number;
    byType: Array<{ type: string; count: number; amount: number }>;
    /** 区间内金额最大的一笔（§9 月报「最大单笔」；无带金额条目时 null） */
    largest: BillParcelLargest | null;
  };
  parcels: {
    count: number;
    /** 待取件（有取件码即视为待取） */
    awaitingPickup: number;
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
    for (const category of input.category === undefined ? [] : [input.category]) {
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
      if (this.entries.some((e) => e.id === id)) continue;
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
      };
      this.entries.push(entry);
      added.push(entry);
    }
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
        if (query.category && e.category !== query.category) return false;
        if (query.source && e.source !== query.source) return false;
        if (query.actorId && e.actorId !== query.actorId) return false;
        if (query.since != null && e.occurredAt < query.since) return false;
        if (e.occurredAt >= until) return false;
        return true;
      })
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, Math.max(1, limit));
  }

  /**
   * 标记一条为已处理（2026-11-23 通知闭环 M1：通知栏「已取件 / 已处理」按钮的落点）。
   * 归属不符或条目不存在返回 null；已处理过的幂等返回原条目（不改时间）。
   */
  resolve(id: string, actorId: string, at?: number): BillParcelEntry | null {
    this.load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.actorId !== actorId) return null;
    if (entry.resolvedAt) return entry;
    entry.resolvedAt = at ?? this.nowFn();
    this.persist();
    return entry;
  }

  /** 按 id 取一条（执行器回执文案用；归属由调用方核对） */
  get(id: string): BillParcelEntry | undefined {
    this.load();
    return this.entries.find((e) => e.id === id);
  }

  /**
   * 人工改类目（§9 月报卡「类目可改」）。与 resolve() 同一条纪律：归属不符或
   * 条目不存在返回 null；改成同一个值幂等（不刷新 correctedAt，避免重复投训练样本）。
   *
   * 纠正除了改写 billType，还打 correctedBillType/correctedAt 标记——
   * classifierCorrections() 据此把这条当作分类器训练样本回灌规则表。
   */
  setBillType(id: string, actorId: string, billType: string, at?: number): BillParcelEntry | null {
    this.load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.actorId !== actorId || entry.category !== "bill") return null;
    const next = billType.trim();
    if (!next) return null;
    if (entry.billType === next && entry.correctedBillType === next) return entry;
    entry.billType = next;
    entry.correctedBillType = next;
    entry.correctedAt = at ?? this.nowFn();
    this.persist();
    return entry;
  }

  /**
   * 已有人工纠正的分类器训练样本（新→旧，默认最多 50 条）。
   * 只在内存里派生，不落新文件——纠正本身已经写在台账条目上了。
   */
  corrections(actorId?: string, limit = 50): Array<{ text: string; billType: string; at: number }> {
    this.load();
    return this.entries
      .filter(
        (e) =>
          e.category === "bill" &&
          !!e.correctedBillType &&
          (!actorId || e.actorId === actorId),
      )
      .sort((a, b) => (b.correctedAt ?? 0) - (a.correctedAt ?? 0))
      .slice(0, Math.max(1, limit))
      .map((e) => ({
        // 只用原文摘要：entry.title 是识别器生成的「账单·话费 ¥12.34」，
        // 拿生成物当训练文本等于让分类器学自己的措辞。
        text: e.excerpt,
        billType: e.correctedBillType as string,
        at: e.correctedAt ?? e.occurredAt,
      }));
  }

  /**
   * 区间汇总。
   *
   * 窗口两种给法（**同一套聚合代码**，这是 §9 验收「月报合计 = 明细合计，误差 0」
   * 成立的前提——月报不许另写一份 sum 逻辑）：
   *   - `days`：滚动窗口（默认 30 天，动态页旧口径不变）；
   *   - `from` / `to`：绝对区间 ms（to 含），月报按自然月切窗口走这条。
   */
  summary(opts: { actorId?: string; days?: number; from?: number; to?: number } = {}): BillParcelSummary {
    this.load();
    const days = Math.max(1, opts.days ?? 30);
    const now = this.nowFn();
    const to = Number.isFinite(opts.to) ? (opts.to as number) : now;
    const from = Number.isFinite(opts.from)
      ? (opts.from as number)
      : to - days * 24 * 60 * 60 * 1000;
    const scoped = this.entries.filter(
      (e) => (!opts.actorId || e.actorId === opts.actorId) && e.occurredAt >= from && e.occurredAt <= to,
    );

    const bills = scoped.filter((e) => e.category === "bill");
    const parcels = scoped.filter((e) => e.category === "parcel");

    const typeMap = new Map<string, { count: number; amount: number }>();
    let totalAmount = 0;
    let amountCount = 0;
    let largest: BillParcelLargest | null = null;
    for (const b of bills) {
      const type = b.billType ?? "其他";
      const cur = typeMap.get(type) ?? { count: 0, amount: 0 };
      cur.count += 1;
      if (b.amount != null) {
        cur.amount += b.amount;
        totalAmount += b.amount;
        amountCount += 1;
        if (!largest || b.amount > largest.amount) {
          largest = {
            id: b.id,
            title: b.title,
            amount: b.amount,
            billType: b.billType,
            occurredAt: b.occurredAt,
          };
        }
      }
      typeMap.set(type, cur);
    }

    const carrierMap = new Map<string, number>();
    let awaitingPickup = 0;
    for (const p of parcels) {
      const carrier = p.carrier ?? "未知";
      carrierMap.set(carrier, (carrierMap.get(carrier) ?? 0) + 1);
      if (p.pickupCode && !p.resolvedAt) awaitingPickup += 1;
    }

    const pickupEntries = parcels
      .filter((p) => p.pickupCode && !p.resolvedAt)
      .sort((a, b) => b.occurredAt - a.occurredAt);

    return {
      window: {
        days: Number.isFinite(opts.from)
          ? Math.max(1, Math.round((to - from) / (24 * 60 * 60 * 1000)))
          : days,
        from,
        to,
      },
      bills: {
        count: bills.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        amountCount,
        largest,
        byType: [...typeMap.entries()]
          .map(([type, v]) => ({ type, count: v.count, amount: Math.round(v.amount * 100) / 100 }))
          .sort((a, b) => b.amount - a.amount || b.count - a.count),
      },
      parcels: {
        count: parcels.length,
        awaitingPickup,
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
        .sort((a, b) => b.occurredAt - a.occurredAt)
        .slice(0, 20),
    };
  }

  /** 条目总数（诊断） */
  size(): number {
    this.load();
    return this.entries.length;
  }

  /** 台账里出现过的 actor（月度边界要逐个发小结，§9） */
  actorIds(): string[] {
    this.load();
    return [...new Set(this.entries.map((e) => e.actorId).filter(Boolean))];
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
