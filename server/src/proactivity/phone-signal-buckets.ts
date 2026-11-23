// 手机状态 15 分钟桶落库（2026-11-23 主动触达 M1，需求文档 §7.2）
//
// 端上聚合、服务端只收桶（原始解锁流不出端）。这里管三件事：
//   1. 去重落盘——同一个桶心跳重发/重连补报不能记两次（按 actorId+bucket 幂等）；
//   2. 保留窗口——只留最近 keepDays 天，节律分析要的也就是这几周的分布；
//   3. 给诊断/夜间分析一个能读的口径（按天汇总，含夜间亮屏）。
//
// 为什么是 JSON 而不是 SQLite：单装机每天 96 桶 × 少量账号，写频 ≤ 4 次/小时，
// 与 proactivity 里其它台账（outcome-store、silence-log）同一套 persist-file 读写。
import { readJson, writeJson } from "./persist-file.js";

export type PhoneSignalBucket = {
  /** 本地 15 分钟对齐的桶起点 ms */
  bucket: number;
  unlocks: number;
  screenOnMin: number;
  inCallMin: number;
  charging: boolean;
  dnd: boolean;
  /**
   * 围栏命中的地点类别（§7.2 端上随桶一起报，§7.3 的 commute 维度靠它）。
   * "unknown" = 这一桶没有定位事实（权限关/室内无信号），与 "other"（在别处）
   * 必须区分开——把无信号当成"在外面"会把整晚判成离家。
   */
  placeKind: "home" | "work" | "other" | "unknown";
};

type StoredBucket = PhoneSignalBucket & { actorId: string };

interface BucketFileShape {
  version: 1;
  buckets: StoredBucket[];
}

const BUCKET_MS = 15 * 60 * 1000;

const PLACE_KINDS = new Set(["home", "work", "other"]);

function normalize(raw: unknown): PhoneSignalBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const bucket = Number(o.bucket);
  if (!Number.isFinite(bucket) || bucket <= 0) return null;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  // 一个桶只有 15 分钟，亮屏/通话时长不可能超过它——超过就是端上聚合算错了，
  // 按桶长截断，宁可低估也不让一帧坏数据污染整天的作息分布。
  const bucketMin = BUCKET_MS / 60_000;
  const place = typeof o.placeKind === "string" && PLACE_KINDS.has(o.placeKind) ? o.placeKind : "unknown";
  return {
    bucket: Math.floor(bucket / BUCKET_MS) * BUCKET_MS,
    unlocks: num(o.unlocks),
    screenOnMin: Math.min(bucketMin, num(o.screenOnMin)),
    inCallMin: Math.min(bucketMin, num(o.inCallMin)),
    // 端上两种写法都收：布尔（实时状态沿用）或分钟数（§7.2 桶口径 chargingMin/dndMin）
    charging: o.charging === true || num(o.chargingMin) > 0,
    dnd: o.dnd === true || num(o.dndMin) > 0,
    placeKind: place as PhoneSignalBucket["placeKind"],
  };
}

/** 本地小时（夜间亮屏判定用，不用 UTC） */
function localHour(ms: number): number {
  return new Date(ms).getHours();
}

export class PhoneSignalBucketStore {
  private buckets: StoredBucket[] = [];
  /** actorId|bucket → 数组下标无意义，用集合做幂等键即可 */
  private readonly seen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly keepDays = 30,
  ) {
    const raw = readJson<BucketFileShape>(path, { version: 1, buckets: [] });
    this.buckets = (raw.buckets ?? []).filter((b) => Number.isFinite(b?.bucket));
    for (const b of this.buckets) this.seen.add(`${b.actorId}|${b.bucket}`);
    this.prune(Date.now());
  }

  /**
   * 收录一批上报桶，返回新收录的条数。
   * 未来时刻直接丢（客户端时钟不可信，且未来的桶不可能有历史含义）。
   */
  append(actorId: string, incoming: unknown[], now = Date.now()): number {
    if (!actorId || !Array.isArray(incoming)) return 0;
    // 上界宽容一个桶长（端上时钟可能略超前），下界即保留窗口：
    // 早于窗口的桶收进来也会被 prune 掉，不如当场拒收，返回值才等于真实收录数。
    const oldest = now - this.keepDays * 24 * 60 * 60_000;
    let added = 0;
    for (const item of incoming) {
      const b = normalize(item);
      if (!b || b.bucket > now + BUCKET_MS || b.bucket < oldest) continue;
      const key = `${actorId}|${b.bucket}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.buckets.push({ ...b, actorId });
      added += 1;
    }
    if (added > 0) {
      this.prune(now);
      this.persist();
    }
    return added;
  }

  /** 某 actor 最近 n 个桶（新→旧） */
  recent(actorId?: string, limit = 96): StoredBucket[] {
    const out: StoredBucket[] = [];
    for (let i = this.buckets.length - 1; i >= 0 && out.length < limit; i--) {
      const b = this.buckets[i];
      if (actorId && b.actorId !== actorId) continue;
      out.push(b);
    }
    return out;
  }

  /**
   * 区间读取（旧→新）：节律引擎的 phone-usage-sensor 在夜间分析里按窗口拉一次。
   * 这是既有桶存储的一个只读视图——不新建库、不加轮询，采集节奏仍由端上的
   * 上报与服务器的夜间分析决定（PRD §7.3「不自带轮询」）。
   */
  list(actorId: string, from: Date, to: Date): PhoneSignalBucket[] {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    return this.buckets
      .filter((b) => b.actorId === actorId && b.bucket >= fromMs && b.bucket <= toMs)
      .sort((a, b) => a.bucket - b.bucket)
      .map(({ actorId: _drop, ...rest }) => rest);
  }

  /**
   * 按天汇总（诊断看板/夜间分析读这一份，不再翻原始桶）。
   * nightScreenOnMin = 22:00-07:00 的亮屏分钟——§7.3 入睡样本的候选口径。
   */
  dailySummary(actorId: string | undefined, days = 7, now = Date.now()): Array<{
    day: string;
    buckets: number;
    unlocks: number;
    screenOnMin: number;
    inCallMin: number;
    nightScreenOnMin: number;
    dndBuckets: number;
    chargingBuckets: number;
  }> {
    const fromMs = now - days * 24 * 60 * 60 * 1000;
    const rows = new Map<
      string,
      {
        day: string;
        buckets: number;
        unlocks: number;
        screenOnMin: number;
        inCallMin: number;
        nightScreenOnMin: number;
        dndBuckets: number;
        chargingBuckets: number;
      }
    >();
    for (const b of this.buckets) {
      if (b.bucket < fromMs || b.bucket > now) continue;
      if (actorId && b.actorId !== actorId) continue;
      const d = new Date(b.bucket);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
      const row =
        rows.get(day) ??
        {
          day,
          buckets: 0,
          unlocks: 0,
          screenOnMin: 0,
          inCallMin: 0,
          nightScreenOnMin: 0,
          dndBuckets: 0,
          chargingBuckets: 0,
        };
      row.buckets += 1;
      row.unlocks += b.unlocks;
      row.screenOnMin += b.screenOnMin;
      row.inCallMin += b.inCallMin;
      const h = localHour(b.bucket);
      if (h >= 22 || h < 7) row.nightScreenOnMin += b.screenOnMin;
      if (b.dnd) row.dndBuckets += 1;
      if (b.charging) row.chargingBuckets += 1;
      rows.set(day, row);
    }
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  size(): number {
    return this.buckets.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.keepDays * 24 * 60 * 60 * 1000;
    const kept = this.buckets.filter((b) => b.bucket >= cutoff);
    if (kept.length === this.buckets.length) return;
    this.buckets = kept;
    this.seen.clear();
    for (const b of this.buckets) this.seen.add(`${b.actorId}|${b.bucket}`);
  }

  private persist(): void {
    writeJson(this.path, { version: 1, buckets: this.buckets } satisfies BucketFileShape);
  }
}
