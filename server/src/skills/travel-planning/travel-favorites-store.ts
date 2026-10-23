/**
 * 旅游收藏库（服务端，单例）
 *
 * 与客户端本地收藏（travel_favorites.dart，key 为「type:name」）同键格式。
 * 客户端收藏变更时经 PUT /travel/favorites 全量同步，服务端持久化到
 * data/travel-favorites.json；travel.plan-itinerary 排序时对命中收藏键
 * （type:name）的 POI 加权（C5：用户收藏的地点在后续规划中优先排入）。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from "fs";
import path from "path";

class TravelFavoritesStore {
  private file: string;
  /** key = 「type:name」 */
  private keys = new Set<string>();
  private loaded = false;

  constructor() {
    this.file = path.resolve(
      process.env.TRAVEL_FAVORITES_FILE ||
        path.join(getDataDir(), "travel-favorites.json"),
    );
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as unknown;
      if (Array.isArray(raw)) {
        for (const k of raw) if (k != null) this.keys.add(String(k));
      }
    } catch {
      // 不存在/损坏 → 空收藏
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.keys]), "utf-8");
    } catch (err) {
      console.error("[TravelFavoritesStore] persist failed:", err);
    }
  }

  list(): string[] {
    this.ensureLoaded();
    return [...this.keys];
  }

  /** 全量替换（客户端同步用），返回替换后的 keys */
  replaceAll(keys: string[]): string[] {
    this.keys = new Set(keys.filter((k) => typeof k === "string" && k.trim()));
    this.persist();
    return this.list();
  }

  /** 收藏键集合（「type:name」原样，供排序加权精确匹配——餐厅与景点同名互不污染） */
  favoriteKeys(): Set<string> {
    this.ensureLoaded();
    return new Set(this.keys);
  }
}

export const travelFavoritesStore = new TravelFavoritesStore();
