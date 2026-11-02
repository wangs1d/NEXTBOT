/**
 * 旅游收藏库（服务端，按 actor 分区）
 *
 * 与客户端本地收藏（travel_favorites.dart，key 为「type:name」）同键格式。
 * 客户端收藏变更时经 POST /travel/favorites 全量同步本 actor 那一格，服务端持久化
 * 到 data/travel-favorites/<actorKey>.json（actorKey 与行程库同一净化规则）；
 * travel.plan-itinerary 排序时按调用者 actorId 取收藏键加权（C5）。
 */
import { getDataDir } from "../../config/data-dir.js";
import { sanitizeActorKey } from "../../agentic-memory/actor-key.js";
import fs from "fs";
import path from "path";

class TravelFavoritesStore {
  private dir: string;
  /** actorKey → 该 actor 的收藏键集合（惰性按 actor 读盘） */
  private byActor = new Map<string, Set<string>>();
  private loaded = new Set<string>();

  constructor() {
    // 测试可用 TRAVEL_FAVORITES_DIR 覆盖存储目录（默认 data/travel-favorites）
    this.dir = path.resolve(
      process.env.TRAVEL_FAVORITES_DIR || path.join(getDataDir(), "travel-favorites"),
    );
  }

  private actorKey(actorId: string): string {
    return sanitizeActorKey(actorId) || "_unassigned";
  }

  private fileOf(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private ensureLoaded(actorId: string): Set<string> {
    const key = this.actorKey(actorId);
    if (this.loaded.has(key)) return this.byActor.get(key)!;
    this.loaded.add(key);
    const set = new Set<string>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileOf(key), "utf-8")) as unknown;
      if (Array.isArray(raw)) for (const k of raw) if (k != null) set.add(String(k));
    } catch {
      // 不存在/损坏 → 该 actor 空收藏
    }
    this.byActor.set(key, set);
    return set;
  }

  private persist(actorId: string): void {
    const key = this.actorKey(actorId);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.fileOf(key), JSON.stringify([...(this.byActor.get(key) ?? [])]), "utf-8");
    } catch (err) {
      console.error("[TravelFavoritesStore] persist failed:", err);
    }
  }

  list(actorId: string): string[] {
    return [...this.ensureLoaded(actorId)];
  }

  /** 全量替换本 actor 那一格（客户端同步用），返回替换后的 keys */
  replaceAll(actorId: string, keys: string[]): string[] {
    this.loaded.add(this.actorKey(actorId));
    this.byActor.set(
      this.actorKey(actorId),
      new Set(keys.filter((k) => typeof k === "string" && k.trim())),
    );
    this.persist(actorId);
    return this.list(actorId);
  }

  /** 本 actor 的收藏键集合（「type:name」原样，供排序加权精确匹配） */
  favoriteKeys(actorId: string | undefined): Set<string> {
    if (!actorId) return new Set();
    return new Set(this.ensureLoaded(actorId));
  }
}

export const travelFavoritesStore = new TravelFavoritesStore();
