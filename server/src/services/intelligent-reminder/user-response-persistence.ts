import { getDataDir } from "../../config/data-dir.js";
import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import type {
  ReminderLevel,
  UserResponseHistory,
  ReminderInstance,
} from "../intelligent-reminder/types.js";

export interface ReminderResponseRecord {
  id: string;
  userId: string;
  reminderId: string;
  reminderTitle: string;
  level: ReminderLevel;
  priority: string;
  triggeredAt: string;
  respondedAt?: string;
  responseTimeMs: number;
  responded: boolean;
  escalationCount: number;
  finalLevel: ReminderLevel;
  userFeedback?: "positive" | "negative" | "neutral";
  metadata?: Record<string, unknown>;
}

export interface UserResponseAnalytics {
  userId: string;
  totalReminders: number;
  totalResponses: number;
  responseRate: number;
  averageResponseTimeMs: number;
  ignoreRate: number;
  escalationRate: number;
  preferredLevel: ReminderLevel;
  levelDistribution: Record<ReminderLevel, {
    count: number;
    responses: number;
    avgResponseTimeMs: number;
  }>;
  hourlyResponsePattern: Record<number, number>;
  lastResponseAt?: string;
  createdAt: string;
  updatedAt: string;
}

type PersistedData = {
  responses: ReminderResponseRecord[];
  analytics: Record<string, UserResponseAnalytics>;
};

export class UserResponsePersistenceService {
  private data: PersistedData = {
    responses: [],
    analytics: {},
  };
  private persistChain: Promise<void> = Promise.resolve();

  private get persistPath(): string {
    return (
      process.env.REMINDER_RESPONSES_FILE ??
      join(getDataDir(), "reminder-responses.json")
    );
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      this.data = JSON.parse(raw) as PersistedData;
      console.log(
        `[UserResponsePersistence] Loaded ${this.data.responses.length} records, ${Object.keys(this.data.analytics).length} users`,
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        console.log("[UserResponsePersistence] No existing data file, starting fresh");
        return;
      }
      throw err;
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.persistNow());
  }

  private async persistNow(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(this.data, null, 2), "utf8");
  }

  async recordResponse(params: {
    userId: string;
    instance: ReminderInstance;
    responded: boolean;
    responseTimeMs: number;
    feedback?: "positive" | "negative" | "neutral";
  }): Promise<ReminderResponseRecord> {
    const record: ReminderResponseRecord = {
      id: randomUUID(),
      userId: params.userId,
      reminderId: params.instance.config.id,
      reminderTitle: params.instance.config.title,
      level: params.instance.currentLevel,
      priority: params.instance.config.priority,
      triggeredAt: params.instance.startedAt?.toISOString() ?? new Date().toISOString(),
      respondedAt: params.responded ? new Date().toISOString() : undefined,
      responseTimeMs: params.responseTimeMs,
      responded: params.responded,
      escalationCount: params.instance.escalationCount,
      finalLevel: params.instance.currentLevel,
      userFeedback: params.feedback,
    };

    this.data.responses.push(record);

    await this.updateUserAnalytics(params.userId, record);
    this.schedulePersist();

    return record;
  }

  private async updateUserAnalytics(
    userId: string,
    record: ReminderResponseRecord,
  ): Promise<void> {
    let analytics = this.data.analytics[userId];

    if (!analytics) {
      analytics = this.createDefaultAnalytics(userId);
      this.data.analytics[userId] = analytics;
    }

    analytics.totalReminders += 1;

    if (record.responded) {
      analytics.totalResponses += 1;
      analytics.lastResponseAt = record.respondedAt;
    }

    analytics.responseRate =
      analytics.totalReminders > 0
        ? analytics.totalResponses / analytics.totalReminders
        : 0;

    if (record.responseTimeMs > 0) {
      const totalTime =
        analytics.averageResponseTimeMs * (analytics.totalResponses - 1) +
        record.responseTimeMs;
      analytics.averageResponseTimeMs =
        analytics.totalResponses > 0 ? totalTime / analytics.totalResponses : 0;
    }

    if (!record.responded && record.escalationCount === 0) {
      analytics.ignoreRate =
        analytics.totalReminders > 0
          ? (analytics.ignoreRate * (analytics.totalReminders - 1) + 1) /
            analytics.totalReminders
          : 0;
    }

    if (record.escalationCount > 0) {
      analytics.escalationRate =
        analytics.totalReminders > 0
          ? (analytics.escalationRate * (analytics.totalReminders - 1) + 1) /
            analytics.totalReminders
          : 0;
    }

    const levelStats = analytics.levelDistribution[record.level];
    levelStats.count += 1;
    if (record.responded) {
      levelStats.responses += 1;
      const avgTime =
        levelStats.avgResponseTimeMs * (levelStats.responses - 1) +
        record.responseTimeMs;
      levelStats.avgResponseTimeMs = avgTime / levelStats.responses;
    }

    const hour = new Date(record.triggeredAt).getHours();
    analytics.hourlyResponsePattern[hour] =
      (analytics.hourlyResponsePattern[hour] ?? 0) + 1;

    analytics.preferredLevel = this.calculatePreferredLevel(analytics);
    analytics.updatedAt = new Date().toISOString();
  }

  private createDefaultAnalytics(userId: string): UserResponseAnalytics {
    return {
      userId,
      totalReminders: 0,
      totalResponses: 0,
      responseRate: 0,
      averageResponseTimeMs: 0,
      ignoreRate: 0,
      escalationRate: 0,
      preferredLevel: "popup",
      levelDistribution: {
        popup: { count: 0, responses: 0, avgResponseTimeMs: 0 },
        tts_alarm: { count: 0, responses: 0, avgResponseTimeMs: 0 },
        phone_call: { count: 0, responses: 0, avgResponseTimeMs: 0 },
      },
      hourlyResponsePattern: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private calculatePreferredLevel(analytics: UserResponseAnalytics): ReminderLevel {
    if (analytics.ignoreRate > 0.5 || analytics.escalationRate > 0.7) {
      return "phone_call";
    }

    if (
      analytics.ignoreRate > 0.3 ||
      analytics.escalationRate > 0.4 ||
      analytics.averageResponseTimeMs > 300_000
    ) {
      return "tts_alarm";
    }

    const levels: ReminderLevel[] = ["popup", "tts_alarm", "phone_call"];
    let bestLevel: ReminderLevel = "popup";
    let bestScore = -1;

    for (const level of levels) {
      const stats = analytics.levelDistribution[level];
      if (stats.count < 3) continue;

      const responseRate = stats.count > 0 ? stats.responses / stats.count : 0;
      const speedScore = Math.max(0, 1 - stats.avgResponseTimeMs / 300_000);
      const score = responseRate * 0.6 + speedScore * 0.4;

      if (score > bestScore) {
        bestScore = score;
        bestLevel = level;
      }
    }

    return bestLevel;
  }

  async getUserHistory(userId: string): Promise<UserResponseHistory | null> {
    const analytics = this.data.analytics[userId];
    if (!analytics) return null;

    return {
      userId: analytics.userId,
      totalReminders: analytics.totalReminders,
      respondedCount: analytics.totalResponses,
      averageResponseTimeMs: analytics.averageResponseTimeMs,
      preferredLevel: analytics.preferredLevel,
      ignoredCount: Math.round(analytics.ignoreRate * analytics.totalReminders),
      lastResponseAt: analytics.lastResponseAt
        ? new Date(analytics.lastResponseAt)
        : undefined,
      levelStats: {
        popup: {
          shown: analytics.levelDistribution.popup.count,
          responded: analytics.levelDistribution.popup.responses,
          avgResponseTimeMs: analytics.levelDistribution.popup.avgResponseTimeMs,
        },
        tts_alarm: {
          shown: analytics.levelDistribution.tts_alarm.count,
          responded: analytics.levelDistribution.tts_alarm.responses,
          avgResponseTimeMs: analytics.levelDistribution.tts_alarm.avgResponseTimeMs,
        },
        phone_call: {
          shown: analytics.levelDistribution.phone_call.count,
          responded: analytics.levelDistribution.phone_call.responses,
          avgResponseTimeMs: analytics.levelDistribution.phone_call.avgResponseTimeMs,
        },
      },
    };
  }

  async getUserAnalytics(userId: string): Promise<UserResponseAnalytics | null> {
    return this.data.analytics[userId] ?? null;
  }

  getRecentResponses(
    userId: string,
    limit: number = 50,
  ): ReminderResponseRecord[] {
    return this.data.responses
      .filter((r) => r.userId === userId)
      .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime())
      .slice(0, limit);
  }

  getResponseStats(timeRange?: { start: Date; end: Date }): {
    total: number;
    responded: number;
    ignored: number;
    escalated: number;
    averageResponseTimeMs: number;
  } {
    let filtered = this.data.responses;

    if (timeRange) {
      filtered = filtered.filter((r) => {
        const date = new Date(r.triggeredAt);
        return date >= timeRange.start && date <= timeRange.end;
      });
    }

    const total = filtered.length;
    const responded = filtered.filter((r) => r.responded).length;
    const ignored = filtered.filter((r) => !r.responded && r.escalationCount === 0).length;
    const escalated = filtered.filter((r) => r.escalationCount > 0).length;

    const respondedRecords = filtered.filter((r) => r.responded && r.responseTimeMs > 0);
    const averageResponseTimeMs =
      respondedRecords.length > 0
        ? respondedRecords.reduce((sum, r) => sum + r.responseTimeMs, 0) /
          respondedRecords.length
        : 0;

    return { total, responded, ignored, escalated, averageResponseTimeMs };
  }

  cleanup(): void {
    this.data = { responses: [], analytics: {} };
  }
}
