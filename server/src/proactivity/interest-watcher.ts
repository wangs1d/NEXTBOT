// ProactivityHub —— 兴趣话题追踪（InterestWatcher）
//
// 对标「扣子」主动体验的核心：用户长期关注的话题（刘浩存/王者荣耀/某股票……），
// agent 在后台持续盯着，一有新动态就主动推给用户。
//
// 职责（与 ProactivityHub 分工）：
//  - 本模块：兴趣池管理（持久化 + 衰减）+ 后台轮询 + 命中判定（数据层）
//  - ProactivityHub.onInterestAlert：命中后直达车道模板直投（零 LLM）
//
// 实现路径（对齐扣子 Database + 定期触发）：
//  1. 采集：LLM 在对话中识别出用户的长期兴趣 → 调 interest.manage 工具入库
//     （工具动作 add/touch/remove/list，不靠 NER，靠模型判断"是否值得长期关注"）
//  2. 持久化：每 actor 兴趣池落盘 data/interest-watch.json（跨重启、跨会话）
//  3. 监控：后台 tick（20min，env INTEREST_WATCH_TICK_MS 可调）拉一次实时热搜
//     （复用 services/hot-rankings 的微博/百度/知乎/B站聚合），本地匹配全部兴趣
//  4. 推送：命中 + 指纹去重（同一条热点不重复推）+ 最小推送间隔（默认 2h）
//     → onHit 回调 → 装配层接 ProactivityHub.onInterestAlert
//  5. 衰减：30 天未在对话中提及 → 降权（不再推送）；60 天 → 彻底移除
//
// 频控是双层防线：本模块管"同兴趣"维度的冲重复制（指纹 + 间隔）；
// ProactivityHub 的 FrequencyGovernor 管"全局"维度（interest_alert 4h 冷却 +
// 每日预算 6 次）。两层都防刷屏。
import { randomUUID } from "node:crypto";

import { backgroundScheduler } from "../services/background-scheduler.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 兴趣实体类型（interest.manage 工具参数；对应「刘浩存=人物」这类归类） */
export type InterestType = "person" | "brand" | "work" | "stock" | "game" | "other";

/** 单条关注兴趣 */
export interface WatchInterest {
  id: string;
  actorId: string;
  /** 兴趣实体名（如「刘浩存」「王者荣耀」） */
  name: string;
  type: InterestType;
  /** 首次入库时刻（ms） */
  firstSeenAt: number;
  /** 最近一次在对话中被提及（ms），衰减依据 */
  lastSeenAt: number;
  /** 对话中提及次数 */
  mentionCount: number;
  /** 最近推送过的热点指纹（归一化 title），同指纹不重复推 */
  lastPushedFp: string | null;
  /** 最近一次推送时刻（ms） */
  lastPushedAt: number | null;
  /** false = 衰减降权（仍保留在池里，仅不参与轮询推送） */
  enabled: boolean;
}

/** 一条命中的热点 */
export interface InterestHit {
  title: string;
  /** 热搜来源平台（微博/百度/B站……） */
  platform: string;
  url?: string;
  /** 热度值/标签（如「爆」「318万」），无则空 */
  hot?: string;
}

export interface InterestWatcherDeps {
  /**
   * 抓取实时热搜（fetchHotRankings 的薄包装），返回按榜单顺序排列的热点。
   * 单次调用覆盖全部兴趣的匹配（每 tick 只拉一次，不做每兴趣一次）。
   */
  fetchHot?: (limit: number) => Promise<InterestHit[]>;
  /** 命中回调（装配层接 ProactivityHub.onInterestAlert） */
  onHit?: (actorId: string, interest: WatchInterest, hit: InterestHit) => void;
  /**
   * 语义匹配嵌入（2026-10-01，可选注入）：本地 bge-small-zh ONNX 引擎薄包装。
   * 注入且 INTEREST_SEMANTIC_MATCH 未关闭时，字面包含未命中的兴趣走
   * 余弦相似度兜底（阈值默认 0.45，实测标定）——「iPhone 17」对「苹果手机」这类
   * 换说法的热点也能命中。返回 null = 引擎不可用，纯字面匹配。
   */
  embed?: (texts: string[]) => Promise<number[][] | null>;
  /** 持久化文件路径（默认 data/interest-watch.json） */
  persistPath?: string;
  /** 同兴趣两次推送的最小间隔（默认 2h，防连续新热点刷屏） */
  minPushIntervalMs?: number;
  /** 测试注入：时钟源（默认 Date.now） */
  now?: () => number;
}

/** 兴趣池单用户上限 */
const MAX_INTERESTS_PER_ACTOR = 50;
/** 热搜抓取条数（覆盖 4 平台榜单头部） */
const HOT_FETCH_LIMIT = 50;
/** 降权线：距 lastSeenAt 超过 30 天 → enabled=false（不再推送） */
const DECAY_DISABLE_MS = 30 * 24 * 60 * 60 * 1000;
/** 移除线：距 lastSeenAt 超过 60 天 → 从池中彻底删除 */
const DECAY_REMOVE_MS = 60 * 24 * 60 * 60 * 1000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readTickIntervalMs(): number {
  const ms = readEnvInt("INTEREST_WATCH_TICK_MS", 20 * 60 * 1000);
  return Math.max(ms, 60_000); // 不小于 1 分钟
}

/** 语义匹配开关（默认开；INTEREST_SEMANTIC_MATCH=0 退回纯字面包含） */
function isSemanticMatchEnabled(): boolean {
  const raw = process.env.INTEREST_SEMANTIC_MATCH?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/**
 * 语义命中余弦阈值（默认 0.45，2026-10-01 实测标定：真实 bge-small-zh int8
 * 分布=无关负例 0.27-0.32 / 换说法正例 0.49-0.66 / 字面正例 0.79——0.45 恰在
 * 最弱正例（0.49）与最强负例（0.32）之间的空带里，两侧各留 ~0.13 边际）
 */
function semanticThreshold(): number {
  const raw = process.env.INTEREST_SEMANTIC_THRESHOLD;
  const v = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.45;
}

/** 余弦相似度（bge 输出未归一，须显式除模） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 指纹归一化：去符号 + 小写（中文人名/词条直接比较，等价于 title 词法包含） */
export function normalizeFp(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 兴趣名是否命中一条热点：归一化后 title 包含兴趣名（长度 >=2 才参与匹配） */
export function interestMatches(interest: WatchInterest, hit: { title: string }): boolean {
  const name = normalizeFp(interest.name);
  if (name.length < 2) return false;
  return normalizeFp(hit.title).includes(name);
}

/** 中文/英文类型标签 → InterestType（工具入参容错） */
export function normalizeInterestType(raw: unknown): InterestType {
  const v = String(raw ?? "").trim().toLowerCase();
  const direct: Record<string, InterestType> = {
    person: "person",
    brand: "brand",
    work: "work",
    stock: "stock",
    game: "game",
    other: "other",
  };
  if (direct[v]) return direct[v];
  if (v.includes("人")) return "person";
  if (v.includes("品") || v.includes("牌")) return "brand";
  if (v.includes("作") || v.includes("剧") || v.includes("影") || v.includes("书")) return "work";
  if (v.includes("股") || v.includes("票") || v.includes("基") || v.includes("货")) return "stock";
  if (v.includes("游") || v.includes("戏")) return "game";
  return "other";
}

type PersistedShape = { interests?: WatchInterest[] };

export class InterestWatcher {
  private readonly interests = new Map<string, WatchInterest>();
  private readonly fetchHot: InterestWatcherDeps["fetchHot"];
  private readonly embed: InterestWatcherDeps["embed"];
  private readonly persistPath: string;
  private readonly minPushIntervalMs: number;
  private readonly clock: () => number;
  /** 命中回调（装配层晚接线；构造时也可注入） */
  private onHit: InterestWatcherDeps["onHit"];
  /** 兴趣名向量缓存：`${interestId}:${normalizeFp(name)}` → 向量（跨轮复用） */
  private readonly nameVecCache = new Map<string, number[]>();
  private cancelTick: (() => void) | null = null;
  private started = false;

  constructor(deps: InterestWatcherDeps = {}) {
    this.fetchHot = deps.fetchHot;
    this.embed = deps.embed;
    this.persistPath = deps.persistPath ?? process.env.INTEREST_WATCH_FILE ?? "data/interest-watch.json";
    this.minPushIntervalMs = deps.minPushIntervalMs ?? readEnvInt("INTEREST_WATCH_MIN_INTERVAL_MS", 2 * 60 * 60 * 1000);
    this.clock = deps.now ?? Date.now;
    this.onHit = deps.onHit;
  }

  // ---- 生命周期 ----

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedShape;
      this.interests.clear();
      for (const item of data.interests ?? []) {
        if (item?.id && item?.actorId && typeof item.name === "string" && item.name.trim()) {
          this.interests.set(item.id, item);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(
      this.persistPath,
      JSON.stringify({ interests: Array.from(this.interests.values()) }, null, 2),
      "utf8",
    );
  }

  /** 设置命中回调（装配层晚接线；晚于构造是因为需要先有 ProactivityHub） */
  setOnHit(fn: InterestWatcherDeps["onHit"]): void {
    this.onHit = fn;
  }

  /**
   * 启动后台轮询。start 后立即异步执行一次首轮检查（不必等第一个 tick，上线即可捕捉当前热点）。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const intervalMs = readTickIntervalMs();
    this.cancelTick = backgroundScheduler.schedule({
      name: "interest-watcher.tick",
      intervalMs,
      run: async () => {
        await this.checkAll().catch((err) => {
          console.log(`[InterestWatcher] tick 失败（忽略）: ${err}`);
        });
      },
    });
    console.log(
      `[InterestWatcher] 已启动（tick=${Math.round(intervalMs / 60000)}min，同兴趣推送间隔=${Math.round(this.minPushIntervalMs / 60000)}min，池=${this.interests.size}）`,
    );
    // 首轮立即检查（fire-and-forget，让真实热点快速上线）
    void this.checkAll().catch((err) => {
      console.log(`[InterestWatcher] 首轮检查失败（忽略）: ${err}`);
    });
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.started = false;
  }

  // ---- 兴趣池管理（interest.manage 工具调用） ----

  /**
   * 新增兴趣（同名合并：更新 lastSeenAt/mentionCount，重新启用）。
   * @returns 当前用户兴趣列表（含新增项）
   */
  async addInterest(actorId: string, rawName: unknown, typeRaw?: unknown): Promise<WatchInterest[]> {
    const name = String(rawName ?? "").trim();
    if (name.length < 2) throw new Error("兴趣名至少 2 个字符");
    this.applyDecay(this.clock());
    const existing = Array.from(this.interests.values()).find(
      (i) => i.actorId === actorId && normalizeFp(i.name) === normalizeFp(name),
    );
    const nowMs = this.clock();
    if (existing) {
      existing.lastSeenAt = nowMs;
      existing.mentionCount += 1;
      existing.enabled = true;
      existing.type = normalizeInterestType(typeRaw ?? existing.type);
      this.interests.set(existing.id, existing);
    } else {
      const all = this.listInterests(actorId);
      if (all.length >= MAX_INTERESTS_PER_ACTOR) {
        throw new Error(`兴趣池已满（${MAX_INTERESTS_PER_ACTOR} 条），请先移除不关注的再添加`);
      }
      const item: WatchInterest = {
        id: randomUUID(),
        actorId,
        name,
        type: normalizeInterestType(typeRaw),
        firstSeenAt: nowMs,
        lastSeenAt: nowMs,
        mentionCount: 1,
        lastPushedFp: null,
        lastPushedAt: null,
        enabled: true,
      };
      this.interests.set(item.id, item);
    }
    await this.persist();
    return this.listInterests(actorId);
  }

  /** 对话中再次提及某兴趣（LLM 观察到用户又聊到这个 → 续命 + 计数） */
  async touchInterest(actorId: string, rawName: unknown): Promise<WatchInterest[]> {
    const name = String(rawName ?? "").trim();
    const found = Array.from(this.interests.values()).find(
      (i) => i.actorId === actorId && normalizeFp(i.name) === normalizeFp(name),
    );
    if (!found) return this.listInterests(actorId);
    found.lastSeenAt = this.clock();
    found.mentionCount += 1;
    found.enabled = true;
    this.interests.set(found.id, found);
    await this.persist();
    return this.listInterests(actorId);
  }

  /** 移除兴趣（支持 id 或名字） */
  async removeInterest(actorId: string, target: unknown): Promise<WatchInterest[]> {
    const raw = String(target ?? "").trim();
    if (!raw) throw new Error("需要提供要移除的兴趣名或 id");
    const id = this.findInterestId(actorId, raw);
    if (id) {
      this.interests.delete(id);
      await this.persist();
    }
    return this.listInterests(actorId);
  }

  /** 用户兴趣列表（enabled 在前，按 lastSeenAt 倒序） */
  listInterests(actorId: string): WatchInterest[] {
    return Array.from(this.interests.values())
      .filter((i) => i.actorId === actorId)
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.lastSeenAt - a.lastSeenAt);
  }

  /** 注入 prompt 的紧凑文本（【用户兴趣关注列表】块），无兴趣返回 null（零注入） */
  listForPrompt(actorId: string, limit = 10): string | null {
    const items = this.listInterests(actorId).filter((i) => i.enabled).slice(0, limit);
    if (items.length === 0) return null;
    const label: Record<InterestType, string> = {
      person: "人物",
      brand: "品牌",
      work: "作品",
      stock: "股票基金",
      game: "游戏",
      other: "其他",
    };
    return items.map((i) => `「${i.name}」${label[i.type]}`).join("、");
  }

  /** 测试/诊断：按 id 取单条 */
  getInterest(id: string): WatchInterest | null {
    return this.interests.get(id) ?? null;
  }

  // ---- 衰减 ----

  /**
   * 兴趣衰减（每次变更池时顺带执行）：
   *  - lastSeenAt 距今 > 60 天 → 彻底移除（自然呼吸）
   *  - > 30 天 → 降权（disabled，不再推送，但保留记录防误判重加）
   */
  applyDecay(nowMs: number): number {
    let removed = 0;
    for (const [id, item] of Array.from(this.interests.entries())) {
      const age = nowMs - item.lastSeenAt;
      if (age > DECAY_REMOVE_MS) {
        this.interests.delete(id);
        removed += 1;
      } else if (age > DECAY_DISABLE_MS && item.enabled) {
        item.enabled = false;
        this.interests.set(id, item);
      }
    }
    if (removed > 0) console.log(`[InterestWatcher] 衰减移除 ${removed} 条久未提及的兴趣`);
    return removed;
  }

  // ---- 后台轮询：热搜命中检测 ----

  /**
   * 一轮全量检查（单次拉热搜，匹配全部用户的全部启用兴趣）。
   * 匹配双层：字面包含（主，精确）→ 语义相似度（兜底，需注入 embed 引擎）。
   * 热搜拉取失败/为空时本轮静默跳过（不误推，下个 tick 重试）。
   */
  async checkAll(nowMs: number = this.clock()): Promise<number> {
    this.applyDecay(nowMs);
    const enabled = Array.from(this.interests.values()).filter(
      (i) => i.enabled && i.actorId,
    );
    if (enabled.length === 0) return 0;
    if (!this.fetchHot) return 0;

    let hits: InterestHit[];
    try {
      hits = await this.fetchHot(HOT_FETCH_LIMIT);
    } catch (err) {
      console.log(`[InterestWatcher] 热搜拉取失败（本轮跳过）: ${err}`);
      return 0;
    }
    if (hits.length === 0) {
      console.log("[InterestWatcher] 热搜为空（本轮跳过）");
      return 0;
    }

    // 语义层惰性初始化：有兴趣需要兜底时才嵌入一次本轮全部标题
    let titleVecs: number[][] | null = null;
    let titleVecsTried = false;
    const ensureTitleVecs = async (): Promise<number[][] | null> => {
      if (titleVecsTried) return titleVecs;
      titleVecsTried = true;
      if (!this.embed || !isSemanticMatchEnabled()) return null;
      try {
        titleVecs = await this.embed(hits.map((h) => h.title));
      } catch (err) {
        console.log(`[InterestWatcher] 语义嵌入失败（本轮退回字面匹配）: ${err}`);
        titleVecs = null;
      }
      return titleVecs;
    };

    let pushed = 0;
    for (const interest of enabled) {
      if (this.checkInterest(interest, hits, nowMs)) {
        pushed += 1;
        continue;
      }
      if (await this.checkInterestSemantic(interest, hits, ensureTitleVecs, nowMs)) pushed += 1;
    }
    return pushed;
  }

  /**
   * 单兴趣命中判定（字面包含）：
   *  - 在当轮热搜中找「rank 最靠前且 title 包含兴趣名」的一条
   *  - 指纹去重：与最近推送过的同指纹（同一条热点）→ 跳过
   *  - 间隔冷却：距上次推送 < minPushIntervalMs → 跳过（防新热点连推）
   *  - 通过 → onHit 回调 + 更新 lastPushedFp/lastPushedAt + 落盘
   *  - 未命中热搜 → 不动状态（隐私净：不因"暂时没上榜"而误记推送位）
   */
  checkInterest(
    interest: WatchInterest,
    hits: InterestHit[],
    nowMs: number = this.clock(),
  ): boolean {
    const fp = (h: { title: string }) => normalizeFp(h.title);
    const ownFp = normalizeFp(interest.name);
    if (ownFp.length < 2) return false;

    const chosen = hits.find((h) => fp(h).includes(ownFp));
    if (!chosen) return false;
    return this.commitHit(interest, chosen, nowMs);
  }

  /**
   * 语义兜底命中（2026-10-01）：字面未命中时按余弦相似度选最优标题。
   * 阈值默认 0.62（宁缺勿滥）；命中后走与字面命中完全相同的指纹/间隔闸与
   * 推送链路。本地 ONNX 推理零边际成本，无外部调用。
   */
  private async checkInterestSemantic(
    interest: WatchInterest,
    hits: InterestHit[],
    ensureTitleVecs: () => Promise<number[][] | null>,
    nowMs: number,
  ): Promise<boolean> {
    if (!this.embed || !isSemanticMatchEnabled()) return false;
    if (normalizeFp(interest.name).length < 2) return false;
    const vecKey = `${interest.id}:${normalizeFp(interest.name)}`;
    let nameVec = this.nameVecCache.get(vecKey);
    if (!nameVec) {
      try {
        const vecs = await this.embed?.([interest.name]);
        if (!vecs || vecs.length !== 1 || !Array.isArray(vecs[0])) return false;
        nameVec = vecs[0];
        this.nameVecCache.set(vecKey, nameVec);
        if (this.nameVecCache.size > 200) {
          // 缓存上限：淘汰最旧（兴趣改名/移除后的孤儿向量自然出局）
          const oldest = this.nameVecCache.keys().next().value;
          if (oldest !== undefined) this.nameVecCache.delete(oldest);
        }
      } catch {
        return false;
      }
    }
    const titleVecs = await ensureTitleVecs();
    if (!titleVecs || titleVecs.length !== hits.length) return false;

    const threshold = semanticThreshold();
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < hits.length; i++) {
      // 字面已能命中的标题不必重复评估（该兴趣若字面命中根本不会走到这）
      const score = cosineSimilarity(nameVec, titleVecs[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestScore < threshold) return false;
    const chosen = hits[bestIdx]!;
    console.log(
      `[InterestWatcher] 语义命中 interest=${interest.name} hit="${chosen.title.slice(0, 24)}" sim=${bestScore.toFixed(3)}`,
    );
    return this.commitHit(interest, chosen, nowMs);
  }

  /** 命中后的统一收口：指纹去重 + 间隔冷却 + 状态更新 + onHit + 落盘 */
  private commitHit(interest: WatchInterest, chosen: InterestHit, nowMs: number): boolean {
    const chosenFp = normalizeFp(chosen.title);
    if (interest.lastPushedFp === chosenFp) return false; // 同一条热点不重复推
    if (interest.lastPushedAt !== null && nowMs - interest.lastPushedAt < this.minPushIntervalMs) {
      return false; // 间隔内不连续推（哪怕换了新热点）
    }

    interest.lastPushedFp = chosenFp;
    interest.lastPushedAt = nowMs;
    this.interests.set(interest.id, interest);
    try {
      this.onHit?.(interest.actorId, { ...interest }, chosen);
    } catch (err) {
      console.log(`[InterestWatcher] onHit 回调异常（忽略）: ${err}`);
    }
    void this.persist().catch((err) => {
      console.log(`[InterestWatcher] 落盘失败（忽略）: ${err}`);
    });
    return true;
  }

  // ---- 内部 ----

  private findInterestId(actorId: string, target: string): string | null {
    // 先按 id 精确匹配，再按名字归一化匹配
    const byId = this.interests.get(target);
    if (byId && byId.actorId === actorId) return byId.id;
    const byName = Array.from(this.interests.values()).find(
      (i) => i.actorId === actorId && normalizeFp(i.name) === normalizeFp(target),
    );
    return byName?.id ?? null;
  }
}