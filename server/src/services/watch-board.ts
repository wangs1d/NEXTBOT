/**
 * 统一盯梢门面（WatchBoard，2026-10-23）—— 用户说「帮我盯着 X」的唯一入口。
 *
 * 定位：**门面，不是第二套存储**。盯梢语义按对象类型路由到既有执行器，
 * 各执行器保留自己的评估机制与投递链路，本模块只做统一登记 / 统一视图 /
 * 统一生命周期：
 *
 *   kind = "topic" → WatchTaskStore（消息关键词命中，事件驱动，WatchTaskWatcher 消费）
 *   kind = "price" → ShoppingCompareService.addWatch（周期复查，到价 onPriceAlert 推送）
 *
 * 对齐 Muse / Coze 的 watch 模式：watch.create(target, condition) 一句话建档，
 * 命中后由既有主动管道投递。后续新增盯梢类型（航班价/人物动态/回购提醒）
 * 在此加 kind 分支，不动工具层与对话层。
 */
import type { WatchTaskStore } from "../proactivity/branches/watch-tasks.js";

export type WatchKind = "topic" | "price";

export type UnifiedWatchStatus = "active" | "paused";

export interface UnifiedWatch {
  /** 全局唯一：`topic:<id>` / `price:<id>`，供 pause/resume/close 路由 */
  watchId: string;
  kind: WatchKind;
  actorId: string;
  /** 人话描述：topic=盯梢 label；price=监控关键词 query */
  target: string;
  status: UnifiedWatchStatus;
  createdAt: number;
  /** 类型特定详情（topic: keywords；price: platform/targetPrice） */
  detail: Record<string, unknown>;
}

/** WatchTaskStore 的最小结构面（避免重类型耦合） */
export interface TopicWatchStoreLike {
  create(actorId: string, label: string, keywords: string[]): {
    id: string;
    label: string;
    keywords: string[];
    active: boolean;
    createdAt: number;
  };
  list(actorId?: string): Array<{
    id: string;
    actorId: string;
    label: string;
    keywords: string[];
    active: boolean;
    createdAt: number;
  }>;
  setActive(actorId: string, id: string, active: boolean): boolean;
  remove(actorId: string, id: string): boolean;
}

/** ShoppingCompareService 降价监控的最小结构面 */
export interface PriceWatchServiceLike {
  addWatch(
    actorId: string,
    query: string,
    platform: string,
    targetPrice: number,
  ): Promise<Array<{ id: string; query: string; platform: string; targetPrice: number; enabled: boolean; createdAt: number }>>;
  listWatches(actorId: string): Array<{
    id: string;
    query: string;
    platform: string;
    targetPrice: number;
    enabled: boolean;
    createdAt: number;
  }>;
  /** 按监控关键词移除（服务端签名如此） */
  removeWatch(actorId: string, target: string): Promise<unknown>;
}

export interface WatchBoardDeps {
  topic?: TopicWatchStoreLike | null;
  price?: PriceWatchServiceLike | null;
  /** price 类缺省平台（未指定且服务支持时使用） */
  defaultPlatform?: string;
  now?: () => number;
}

export type WatchCreateInput = {
  kind: WatchKind;
  /** 人话目标：topic=盯什么（label）；price=监控什么商品（query） */
  target: string;
  /** topic 必填：2-8 字关键词（创建时 LLM 从原话提炼，运行期零 LLM 匹配） */
  keywords?: string[];
  /** price 必填：平台（缺省用 deps.defaultPlatform） */
  platform?: string;
  /** price 必填：降价目标（CNY） */
  targetPrice?: number;
};

const WATCH_ID_PREFIX = {
  topic: "topic:",
  price: "price:",
} as const;

export class WatchBoard {
  constructor(private readonly deps: WatchBoardDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 创建盯梢。按 kind 路由到执行器，返回统一视图记录。 */
  async create(actorId: string, input: WatchCreateInput): Promise<UnifiedWatch> {
    const target = String(input.target ?? "").trim();
    if (target.length < 2) throw new Error("target 至少 2 个字符（用一句人话描述盯什么）");

    if (input.kind === "topic") {
      const store = this.deps.topic;
      if (!store) throw new Error("盯梢任务存储未装配");
      const keywords = (input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
      if (keywords.length === 0) {
        throw new Error("topic 盯梢必须给 keywords：从用户原话提炼 2-6 个会出现在相关消息里的关键词");
      }
      const t = store.create(actorId, target, keywords);
      return {
        watchId: `${WATCH_ID_PREFIX.topic}${t.id}`,
        kind: "topic",
        actorId,
        target: t.label,
        status: t.active ? "active" : "paused",
        createdAt: t.createdAt,
        detail: { keywords: t.keywords },
      };
    }

    // kind === "price"
    const price = this.deps.price;
    if (!price) throw new Error("降价监控服务未装配");
    const targetPrice = Number(input.targetPrice);
    if (!(targetPrice > 0)) throw new Error("targetPrice 必须为正数（CNY），用户没给目标价时先问一句");
    const platform = String(input.platform ?? this.deps.defaultPlatform ?? "").trim();
    if (!platform) throw new Error("price 盯梢必须指定 platform（如 taobao/jd）");
    const rows = await price.addWatch(actorId, target, platform, targetPrice);
    const row = rows.find((w) => w.query === target) ?? rows[rows.length - 1];
    if (!row) throw new Error("监控创建失败（服务无返回）");
    return {
      watchId: `${WATCH_ID_PREFIX.price}${row.id}`,
      kind: "price",
      actorId,
      target: row.query,
      status: row.enabled ? "active" : "paused",
      createdAt: row.createdAt ?? this.now(),
      detail: { platform: row.platform, targetPrice: row.targetPrice },
    };
  }

  /** 统一视图：topic + price 两源合并，创建时间倒序。单源故障降级为空，不抛错。 */
  async list(actorId: string): Promise<UnifiedWatch[]> {
    const out: UnifiedWatch[] = [];
    try {
      for (const t of this.deps.topic?.list(actorId) ?? []) {
        out.push({
          watchId: `${WATCH_ID_PREFIX.topic}${t.id}`,
          kind: "topic",
          actorId: t.actorId,
          target: t.label,
          status: t.active ? "active" : "paused",
          createdAt: t.createdAt,
          detail: { keywords: t.keywords },
        });
      }
    } catch {
      /* topic 源故障降级 */
    }
    try {
      for (const w of this.deps.price?.listWatches(actorId) ?? []) {
        out.push({
          watchId: `${WATCH_ID_PREFIX.price}${w.id}`,
          kind: "price",
          actorId,
          target: w.query,
          status: w.enabled ? "active" : "paused",
          createdAt: w.createdAt,
          detail: { platform: w.platform, targetPrice: w.targetPrice },
        });
      }
    } catch {
      /* price 源故障降级 */
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 暂停 / 恢复（按 watchId 前缀路由；target 不变的暂停语义两边都支持） */
  async setStatus(actorId: string, watchId: string, active: boolean): Promise<boolean> {
    const { kind, rawId } = parseWatchId(watchId);
    if (kind === "topic") {
      return this.deps.topic?.setActive(actorId, rawId, active) ?? false;
    }
    // PriceWatch 只有 enabled 开关，服务未暴露 toggle → 用移除重建模拟代价太高，
    // 如实报告不支持（模型会转告用户用 close 后重建）。
    void actorId;
    void rawId;
    return false;
  }

  /** 关闭盯梢：topic → remove；price → removeWatch（按监控关键词）。 */
  async close(actorId: string, watchId: string): Promise<boolean> {
    const { kind, rawId } = parseWatchId(watchId);
    if (kind === "topic") {
      return this.deps.topic?.remove(actorId, rawId) ?? false;
    }
    const price = this.deps.price;
    if (!price) return false;
    const row = price.listWatches(actorId).find((w) => w.id === rawId);
    if (!row) return false;
    await price.removeWatch(actorId, row.query);
    return true;
  }
}

function parseWatchId(watchId: string): { kind: WatchKind; rawId: string } {
  const id = String(watchId ?? "").trim();
  if (id.startsWith(WATCH_ID_PREFIX.topic)) return { kind: "topic", rawId: id.slice(WATCH_ID_PREFIX.topic.length) };
  if (id.startsWith(WATCH_ID_PREFIX.price)) return { kind: "price", rawId: id.slice(WATCH_ID_PREFIX.price.length) };
  throw new Error(`watchId 格式不合法（应为 topic:<id> 或 price:<id>）：${watchId.slice(0, 40)}`);
}
