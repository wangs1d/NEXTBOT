import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type WeatherPrefsRecord = {
  sessionId: string;
  latitude: number;
  longitude: number;
  /** 展示用，如「北京市」 */
  label?: string;
  /** IANA，如 Asia/Shanghai */
  timezone: string;
  /** 是否启用每日早间简报（由日程任务触发） */
  morningReminderEnabled: boolean;
  /** 已关联的 weather_brief 任务 id */
  weatherTaskId?: string;
  updatedAt: string;
};

type Persisted = {
  bySession?: Record<string, WeatherPrefsRecord>;
};

/**
 * 天气取数用的位置（2026-10-23）：显式偏好记录（{@link WeatherPrefsRecord}）
 * 与被动定位兜底（位置历史的最新定位）归一成同一个形状喂给 WeatherService。
 */
export type WeatherLocation = {
  latitude: number;
  longitude: number;
  timezone?: string;
  label?: string;
};

export class WeatherPrefsService {
  private readonly bySession = new Map<string, WeatherPrefsRecord>();

  private get persistPath(): string {
    return process.env.WEATHER_PREFS_FILE ?? join(getDataDir(), "weather-prefs.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as Persisted;
      this.bySession.clear();
      for (const [k, v] of Object.entries(data.bySession ?? {})) {
        if (v?.sessionId && Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) {
          this.bySession.set(k, v);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const bySession: Record<string, WeatherPrefsRecord> = {};
    for (const [k, v] of this.bySession) {
      bySession[k] = v;
    }
    await writeFile(this.persistPath, JSON.stringify({ bySession }, null, 2), "utf8");
  }

  get(sessionId: string): WeatherPrefsRecord | undefined {
    return this.bySession.get(sessionId);
  }

  async upsert(
    input: Omit<WeatherPrefsRecord, "updatedAt"> & { updatedAt?: string },
  ): Promise<WeatherPrefsRecord> {
    const now = new Date().toISOString();
    const rec: WeatherPrefsRecord = {
      ...input,
      timezone: input.timezone?.trim() || "Asia/Shanghai",
      morningReminderEnabled: Boolean(input.morningReminderEnabled),
      updatedAt: input.updatedAt ?? now,
    };
    this.bySession.set(rec.sessionId, rec);
    await this.persist();
    return rec;
  }
}
