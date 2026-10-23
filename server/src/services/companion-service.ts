import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type CompanionProfile = {
  sessionId: string;
  preferredTone: "warm" | "balanced" | "formal" | "humor";
  greetingEnabled: boolean;
  dailyGreetingHourLocal: number;
  timezone: string;
  likes: string[];
  dislikes: string[];
  updatedAt: string;
};

export type PriceWatch = {
  id: string;
  sessionId: string;
  item: string;
  currentPrice: number;
  targetPrice: number;
  currency: string;
  createdAt: string;
};

type PersistedCompanionState = {
  profiles?: CompanionProfile[];
  priceWatches?: PriceWatch[];
};

const DEFAULT_PROFILE: Omit<CompanionProfile, "sessionId" | "updatedAt"> = {
  preferredTone: "warm",
  greetingEnabled: true,
  dailyGreetingHourLocal: 9,
  timezone: "Asia/Shanghai",
  likes: [],
  dislikes: [],
};

export class CompanionService {
  private readonly bySession = new Map<string, CompanionProfile>();
  private readonly priceWatches = new Map<string, PriceWatch[]>();

  private get persistPath(): string {
    return process.env.COMPANION_STATE_FILE ?? join(getDataDir(), "companion-state.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedCompanionState;
      this.bySession.clear();
      this.priceWatches.clear();
      for (const profile of data.profiles ?? []) {
        if (profile?.sessionId) this.bySession.set(profile.sessionId, profile);
      }
      for (const watch of data.priceWatches ?? []) {
        if (!watch?.sessionId) continue;
        const list = this.priceWatches.get(watch.sessionId) ?? [];
        list.push(watch);
        this.priceWatches.set(watch.sessionId, list);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.persistPath), { recursive: true });
    const profiles = Array.from(this.bySession.values());
    const priceWatches = Array.from(this.priceWatches.values()).flat();
    await writeFile(this.persistPath, JSON.stringify({ profiles, priceWatches }, null, 2), "utf8");
  }

  getProfile(sessionId: string): CompanionProfile {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    return {
      sessionId,
      ...DEFAULT_PROFILE,
      updatedAt: new Date().toISOString(),
    };
  }

  async upsertProfile(
    sessionId: string,
    patch: Partial<Omit<CompanionProfile, "sessionId" | "updatedAt">>,
  ): Promise<CompanionProfile> {
    const next: CompanionProfile = {
      ...this.getProfile(sessionId),
      ...patch,
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    this.bySession.set(sessionId, next);
    await this.persist();
    return next;
  }

  getGreetingMessage(sessionId: string, now = new Date()): string {
    const profile = this.getProfile(sessionId);
    const hour = now.getHours();
    const dayPart = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const base = `${dayPart}.`;
    if (profile.preferredTone === "formal") {
      return `${base} I prepared your key tasks and reminders for today.`;
    }
    if (profile.preferredTone === "humor") {
      return `${base} Your life co-pilot is online, ready to save you time and money today.`;
    }
    if (profile.preferredTone === "balanced") {
      return `${base} Here is your focused plan for today.`;
    }
    return `${base} I am here with your plan, reminders, and shopping watchlist.`;
  }

  async addPriceWatch(watch: PriceWatch): Promise<void> {
    const list = this.priceWatches.get(watch.sessionId) ?? [];
    list.push(watch);
    this.priceWatches.set(watch.sessionId, list);
    await this.persist();
  }

  listPriceWatches(sessionId: string): PriceWatch[] {
    return [...(this.priceWatches.get(sessionId) ?? [])];
  }
}

