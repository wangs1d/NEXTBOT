// Source Store —— 跨源统一采集库（"自己的数据库"，对齐 Muse「跨源汇聚到一个库」）。
//
// 背景（2026-10-10 定稿）：此前各外部信源（邮件/财务/ICS/购物…）各扫各的、
// 各存各的目录，数据散落 6 处 → 无法做跨源查询（"我这月钱花在哪""提到三亚的
// 所有来源"）。本模块把 **SensorKernel 分发出来的 Signal** 汇聚到一个库。
//
// 持久化形态（2026-10-10 二次改造，对齐 Muse「扫进自己的库、随时可查」）：
//  - 落盘 **按天分区**：`data/sensor-fabric/streams/<stream>/<YYYY-MM-DD>.ndjson`
//    （单日超 4MB 追加序号分片 `.1.ndjson` / `.2.ndjson`，不再"单代轮转覆盖"）。
//  - **保留 N 天**：`SENSOR_SOURCE_RETENTION_DAYS`（默认 30；0=永久保留）。
//    写入时每日惰性清理 + 公开 `pruneExpired()`（可被定时任务/诊断调用）。
//  - **启动分段加载**：`loadRecent()` 读最近 `SENSOR_SOURCE_LOAD_DAYS`（默认 7）天
//    的日分区，重建内存窗口与实体倒排 → 重启后历史仍可跨源查询（不再"重启即失忆"）。
//  - 内存窗口（2000 条 FIFO）只服务于按 stream 的**热查询**；跨源实体检索走索引。
//  - 实体索引满 `ENTITY_INDEX_MAX_KEYS` 时按 **LRU 淘汰最旧键**（不再"满则拒新"——
//    拒新会让索引老化，新实体进不来、旧实体永久占位）。
//
// 边界纪律：
//  - 外部服务**自己的业务状态**（IMAP 去重游标 processed-uids.json 等）**不搬**——
//    那是"服务的账本"；这里只汇聚"产出的、可供消费的信号"。
//  - 零 LLM：只做存储、分区与倒排，不做任何语义判断。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Signal, SignalStream } from "./sensors/types.js";

/** 单个分区文件落盘上限（超过则同日追加序号分片） */
const PARTITION_MAX_BYTES = 4 * 1024 * 1024;
/** 内存环形缓冲条数（按 stream 热查询窗口；跨源查询走索引） */
const MEMORY_WINDOW = 2000;
/** 单条信号并入索引的实体词上限（防超长正文把索引撑爆） */
/** 每信号实体上限（2026-10-11 由 12 提到 20：2 字滑窗后词元变多，避免长文本尾部被截断） */
const MAX_ENTITIES_PER_SIGNAL = 20;
/** 实体倒排索引键上限（满则 LRU 淘汰最旧键） */
const ENTITY_INDEX_MAX_KEYS = 5000;
/** 单个实体桶命中上限（保留最近 N 条） */
const ENTITY_BUCKET_MAX = 200;
/** 保留天数缺省（0=永久保留） */
const DEFAULT_RETENTION_DAYS = 30;
/** 启动加载天数缺省（0=不加载历史） */
const DEFAULT_LOAD_DAYS = 7;
/** 启动加载时单文件最多读的行数（尾部 N 行，防大文件拖慢启动） */
const MAX_LINES_PER_FILE_ON_LOAD = 2000;
/** 启动加载时跳过的超大文件阈值（异常增长的文件不解析） */
const MAX_FILE_BYTES_ON_LOAD = 32 * 1024 * 1024;
/** 一天毫秒数 */
const DAY_MS = 86_400_000;

/** 跨源实体索引里的一条命中 */
export type SourceHit = {
  stream: SignalStream;
  at: number;
  actorId?: string;
  /** 命中的实体词 */
  entity: string;
  /** 信号的自然语言描述（若有） */
  delta?: string;
  fingerprint: string;
  payload?: Record<string, unknown>;
};

export type SourceStoreOptions = {
  dataPath: string;
  /** 测试注入时钟 */
  nowFn?: () => number;
  /** 测试禁用落盘 */
  disablePersist?: boolean;
  /** 环境开关读取器（缺省读 process.env）。SENSOR_SOURCE_STORE=0 关。 */
  env?: Record<string, string | undefined>;
};

export class SourceStore {
  private readonly rootDir: string;
  /** 分区根目录：<dataPath>/sensor-fabric/streams */
  private readonly streamsDir: string;
  private readonly nowFn: () => number;
  private readonly disablePersist: boolean;
  private readonly env: Record<string, string | undefined>;
  /** 内存环形窗口（按到达顺序） */
  private readonly window: Signal[] = [];
  /** 实体词 → 命中的信号（倒排索引；Map 迭代序 = LRU 序，尾=最近访问） */
  private readonly entityIndex = new Map<string, SourceHit[]>();
  /** 因索引容量被淘汰的实体键计数 */
  private evicted = 0;
  /** 最近一次按天清理的日期键（每日至多一次，避免每写都扫目录） */
  private lastPruneDay = "";
  /** 累计被保留策略删除的分区文件数 */
  private prunedFiles = 0;
  /** 最近一次启动加载命中的信号条数 */
  private loadedCount = 0;

  constructor(opts: SourceStoreOptions) {
    this.rootDir = join(opts.dataPath, "sensor-fabric");
    this.streamsDir = join(this.rootDir, "streams");
    this.nowFn = opts.nowFn ?? Date.now;
    this.disablePersist = opts.disablePersist === true;
    this.env = opts.env ?? process.env;
  }

  /** 总开关（SENSOR_SOURCE_STORE=0 关；缺省开） */
  enabled(): boolean {
    return this.env.SENSOR_SOURCE_STORE !== "0";
  }

  /** 保留天数（SENSOR_SOURCE_RETENTION_DAYS；0 或负=永久保留） */
  retentionDays(): number {
    return this.numEnv("SENSOR_SOURCE_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  }

  /** 启动加载天数（SENSOR_SOURCE_LOAD_DAYS；0=不加载历史） */
  loadDays(): number {
    return this.numEnv("SENSOR_SOURCE_LOAD_DAYS", DEFAULT_LOAD_DAYS);
  }

  /**
   * 汇聚一条信号（SensorKernel.onSignal 桥接调用）。
   * 落盘按天分区；索引按实体词建倒排。同一指纹重复到达直接忽略（内核已去重，
   * 这里是二次保险 + 支持直接喂）。
   */
  feed(signal: Signal): void {
    if (!this.enabled()) return;
    this.ingest(signal, !this.disablePersist);
    if (!this.disablePersist) this.maybePrune();
  }

  /** 批量汇聚 */
  feedAll(signals: Signal[]): void {
    for (const s of signals) this.feed(s);
  }

  /**
   * 启动分段加载：读最近 N 天的日分区，重建内存窗口与实体索引。
   * 只读不写（不重复落盘），幂等可重入。返回加载条数。
   */
  loadRecent(opts: { days?: number } = {}): number {
    if (!this.enabled()) return 0;
    const days = opts.days ?? this.loadDays();
    if (days <= 0) return 0;
    const fromKey = dateKey(this.nowFn() - days * DAY_MS);
    const collected: Signal[] = [];
    try {
      if (existsSync(this.streamsDir)) {
        for (const entry of readdirSync(this.streamsDir)) {
          const full = join(this.streamsDir, entry);
          let st: ReturnType<typeof statSync>;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            // 按天分区目录：只取窗口内的日期文件
            for (const f of readdirSync(full)) {
              const m = /^(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.ndjson$/.exec(f);
              if (!m || m[1] < fromKey) continue;
              collected.push(...readSignalsFile(join(full, f)));
            }
          } else if (entry.endsWith(".ndjson")) {
            // 旧式扁平文件（迁移期，无日期）：整体读入，交由保留策略按 mtime 收口
            collected.push(...readSignalsFile(full));
          }
        }
      }
    } catch {
      /* 加载失败按空库处理（不阻塞启动） */
    }
    if (collected.length === 0) return 0;
    collected.sort((a, b) => a.at - b.at);
    for (const s of collected) this.ingest(s, false);
    this.loadedCount = collected.length;
    return collected.length;
  }

  /**
   * 保留期清理：删除超过保留天数的日分区文件（以及旧式扁平文件/旧轮转文件，
   * 按 mtime 判定）。返回删除文件数。`SENSOR_SOURCE_RETENTION_DAYS=0` 时不动。
   */
  pruneExpired(now = this.nowFn()): number {
    const days = this.retentionDays();
    if (days <= 0) return 0;
    const cutoffMs = now - days * DAY_MS;
    const cutoffKey = dateKey(cutoffMs);
    let removed = 0;
    try {
      if (!existsSync(this.streamsDir)) return 0;
      for (const entry of readdirSync(this.streamsDir)) {
        const full = join(this.streamsDir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          for (const f of readdirSync(full)) {
            const path = join(full, f);
            const m = /^(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.ndjson$/.exec(f);
            const expired = m ? m[1] < cutoffKey : fileMtimeMs(path) < cutoffMs;
            if (expired && this.tryRemove(path)) removed += 1;
          }
        } else if (fileMtimeMs(full) < cutoffMs) {
          // 旧式扁平文件 streams/<stream>.ndjson 或轮转 .1：按 mtime
          if (this.tryRemove(full)) removed += 1;
        }
      }
    } catch {
      /* 清理失败忽略 */
    }
    this.prunedFiles += removed;
    return removed;
  }

  /** 按 stream 取最近信号（内存窗口内，可叠加时间窗与 actor 过滤） */
  byStream(stream: SignalStream, opts: { since?: number; until?: number; actorId?: string; limit?: number } = {}): Signal[] {
    const since = opts.since ?? 0;
    const until = opts.until ?? Number.MAX_SAFE_INTEGER;
    const out = this.window.filter(
      (s) =>
        s.stream === stream &&
        s.at >= since &&
        s.at <= until &&
        (opts.actorId === undefined || s.actorId === opts.actorId),
    );
    return opts.limit !== undefined ? out.slice(-opts.limit) : out;
  }

  /**
   * 跨源实体检索（Muse「汇聚」的核心价值）：给定实体词（如"三亚"），
   * 一次返回**所有来源**里提到它的条目 —— 邮件/日历/购物/消息可拼成完整图景。
   * 走启动加载重建的常驻索引，重启后仍可查历史。
   */
  findByEntity(entity: string, opts: { since?: number; streams?: SignalStream[]; limit?: number } = {}): SourceHit[] {
    const key = entity.trim().toLowerCase();
    if (!key) return [];
    const since = opts.since ?? 0;
    const allow = opts.streams ? new Set(opts.streams) : null;
    const hits = (this.entityIndex.get(key) ?? []).filter((h) => h.at >= since && (!allow || allow.has(h.stream)));
    return opts.limit !== undefined ? hits.slice(-opts.limit) : hits;
  }

  /** 窗口内出现过的实体词（按出现次数降序；诊断/发现用） */
  topEntities(limit = 20): Array<{ entity: string; count: number }> {
    const counts = new Map<string, number>();
    for (const sig of this.window) {
      for (const e of extractEntities(sig)) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([entity, count]) => ({ entity, count }));
  }

  /** 库健康快照（/api/proactivity/sources 面板） */
  stats(): {
    enabled: boolean;
    windowSize: number;
    entityKeys: number;
    streams: Record<string, number>;
    evicted: number;
    loaded: number;
    prunedFiles: number;
    retentionDays: number;
    loadDays: number;
    /** @deprecated 保留旧字段名（语义=evicted），兼容既有消费方 */
    dropped: number;
  } {
    const streams: Record<string, number> = {};
    for (const s of this.window) streams[s.stream] = (streams[s.stream] ?? 0) + 1;
    return {
      enabled: this.enabled(),
      windowSize: this.window.length,
      entityKeys: this.entityIndex.size,
      streams,
      evicted: this.evicted,
      loaded: this.loadedCount,
      prunedFiles: this.prunedFiles,
      retentionDays: this.retentionDays(),
      loadDays: this.loadDays(),
      dropped: this.evicted,
    };
  }

  // ─── 内部 ───

  /** 并入窗口 + 索引（可选落盘）。加载路径传 persist=false。 */
  private ingest(signal: Signal, persist: boolean): void {
    this.window.push(signal);
    while (this.window.length > MEMORY_WINDOW) this.window.shift();
    this.indexSignal(signal);
    if (persist) this.appendPartition(signal);
  }

  /**
   * 实体倒排：Map 迭代序即 LRU 序。命中已有键 → delete+set 置为最近访问；
   * 新键且已达上限 → 淘汰最旧键（不再拒新，避免索引老化）。
   */
  private indexSignal(signal: Signal): void {
    for (const entity of extractEntities(signal)) {
      let bucket = this.entityIndex.get(entity);
      if (bucket) {
        this.entityIndex.delete(entity);
      } else {
        bucket = [];
        if (this.entityIndex.size >= ENTITY_INDEX_MAX_KEYS) {
          const oldest = this.entityIndex.keys().next().value;
          if (oldest !== undefined) {
            this.entityIndex.delete(oldest);
            this.evicted += 1;
          }
        }
      }
      bucket.push({
        stream: signal.stream,
        at: signal.at,
        ...(signal.actorId ? { actorId: signal.actorId } : {}),
        entity,
        ...(signal.delta ? { delta: signal.delta } : {}),
        fingerprint: signal.fingerprint,
        ...(signal.payload ? { payload: signal.payload } : {}),
      });
      if (bucket.length > ENTITY_BUCKET_MAX) bucket.shift();
      this.entityIndex.set(entity, bucket);
    }
  }

  /** 分区目录：<streamsDir>/<stream>/ */
  private partitionDir(stream: SignalStream): string {
    return join(this.streamsDir, stream);
  }

  /** 按天分区写入；单日超限则追加序号分片。 */
  private appendPartition(signal: Signal): void {
    try {
      const dir = this.partitionDir(signal.stream);
      mkdirSync(dir, { recursive: true });
      const key = dateKey(signal.at);
      let path = join(dir, `${key}.ndjson`);
      if (existsSync(path) && statSync(path).size > PARTITION_MAX_BYTES) {
        let seq = 1;
        let cand = join(dir, `${key}.${seq}.ndjson`);
        while (existsSync(cand) && statSync(cand).size > PARTITION_MAX_BYTES && seq < 1000) {
          seq += 1;
          cand = join(dir, `${key}.${seq}.ndjson`);
        }
        path = cand;
      }
      appendFileSync(path, `${JSON.stringify(signal)}\n`);
    } catch {
      /* 落盘失败不影响内存查询（库降级为内存态） */
    }
  }

  /** 每日至多一次的惰性保留清理 */
  private maybePrune(): void {
    const today = dateKey(this.nowFn());
    if (this.lastPruneDay === today) return;
    this.lastPruneDay = today;
    this.pruneExpired();
  }

  private tryRemove(path: string): boolean {
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private numEnv(key: string, def: number): number {
    const raw = this.env[key]?.trim();
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : def;
  }
}

/** 本地日期键 YYYY-MM-DD（按天分区文件名） */
export function dateKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 实体抽取（零 LLM）：把信号里"值得跨源关联"的词提出来。
 *  - 显式实体：payload.entities（传感器可直接给，最准）
 *  - 正文实体：payload.text（消息正文 / 邮件 textSnippet 摘要）里的词
 *  - 描述实体：delta 里的中文 2-4 字词 / 英文/数字 ≥3 字符词
 * 刻意保持保守（宁少勿滥），避免索引被噪声词撑爆。
 */
export function extractEntities(signal: Signal): string[] {
  const out = new Set<string>();
  const explicit = signal.payload?.entities;
  if (Array.isArray(explicit)) {
    for (const e of explicit) {
      if (typeof e === "string" && e.trim()) out.add(e.trim().toLowerCase());
    }
  }
  // 正文类字段（2026-10-14）：message 流的 payload.text（消息正文）、mail 流的
  // textSnippet 摘要——正文是实体主来源，tokenize 优先于 delta 模板词，避免长正文
  // 把「来自 X 的新消息」这类模板词元顶掉正文实体（20 上限内正文先占坑）。
  const body = signal.payload?.text;
  if (typeof body === "string" && body.trim()) {
    for (const t of tokenize(body)) out.add(t);
  }
  if (signal.delta) {
    for (const t of tokenize(signal.delta)) out.add(t);
  }
  return [...out].slice(0, MAX_ENTITIES_PER_SIGNAL);
}

/**
 * 中文串 / 拉丁-数字 3+ 词；去停用词。
 *
 * 2026-10-11 修（跨源拼图召回）：原来只取 2-4 字「贪婪整段」，于是
 * 「新邮件：三亚合同 review」里的中文段被切成「新邮件」「三亚合同」——
 * **「三亚」不是独立词元**，导致邮件的「三亚」和日历的「三亚出差」在倒排索引里
 * 永远碰不到面，Muse 式「一次查询命中所有来源」形同虚设。
 * 现改为：整段词元 + **2 字滑窗（CJK 检索惯例）**，短实体（三亚/携程/张总）必被召回。
 * 噪声由去停用词 + 每信号上限 + 索引 LRU 淘汰共同兜住。
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9]{2,}/g) ?? []) {
    const whole = raw.toLowerCase();
    if (!STOPWORDS.has(whole)) out.push(whole);
    if (raw.length >= 3 && /^[\u4e00-\u9fa5]+$/.test(raw)) {
      for (let i = 0; i + 2 <= raw.length; i++) {
        const bigram = raw.slice(i, i + 2).toLowerCase();
        if (!STOPWORDS.has(bigram)) out.push(bigram);
      }
    }
  }
  return [...new Set(out)];
}

const STOPWORDS = new Set([
  "用户",
  "当前",
  "状态",
  "已经",
  "现在",
  "新的",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
]);

/** 日期分片排序：先按日期，再按序号（无序号=0） */
function comparePartitionFiles(a: string, b: string): number {
  const pa = parsePartitionName(a);
  const pb = parsePartitionName(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.key !== pb.key) return pa.key < pb.key ? -1 : 1;
  return pa.seq - pb.seq;
}

function parsePartitionName(f: string): { key: string; seq: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/.exec(f);
  if (!m) return null;
  return { key: m[1], seq: m[2] ? Number.parseInt(m[2], 10) : 0 };
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** 读取一个分区文件（尾部 maxLines 行；容忍损坏行） */
function readSignalsFile(path: string, maxLines = MAX_LINES_PER_FILE_ON_LOAD): Signal[] {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES_ON_LOAD) return [];
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const tail = Number.isFinite(maxLines) ? lines.slice(-maxLines) : lines;
    const out: Signal[] = [];
    for (const l of tail) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l) as Signal);
      } catch {
        /* 忽略损坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 读回某 stream 的信号（诊断/回放；跨天分区 + 旧扁平文件一并读，不常驻内存）。
 * 按日期升序拼接，返回最后 `limit` 条。
 */
export function readPartition(dataPath: string, stream: SignalStream, limit = 200): Signal[] {
  const root = join(dataPath, "sensor-fabric", "streams");
  const dir = join(root, stream);
  const files: string[] = [];
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      files.push(
        ...readdirSync(dir)
          .filter((f) => f.endsWith(".ndjson"))
          .sort(comparePartitionFiles)
          .map((f) => join(dir, f)),
      );
    }
  } catch {
    /* 忽略 */
  }
  const flat = join(root, `${stream}.ndjson`);
  if (existsSync(flat)) files.push(flat);
  const all: Signal[] = [];
  for (const f of files) all.push(...readSignalsFile(f, Number.POSITIVE_INFINITY));
  return limit >= 0 ? all.slice(-limit) : all;
}

/** 统一分区目录（供装配层打印/健康面板展示） */
export function sourceStoreRoot(dataPath: string): string {
  return join(dataPath, "sensor-fabric", "streams");
}

/** 写一行索引快照（跨源索引可读化；诊断用，不参与查询） */
export function persistIndexSnapshot(store: SourceStore, dataPath: string): void {
  try {
    const path = join(dataPath, "sensor-fabric", "index.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store.topEntities(300), null, 0));
  } catch {
    /* 忽略 */
  }
}
