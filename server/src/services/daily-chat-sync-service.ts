import type { DailyDigestService } from "./daily-digest-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export type ChatSyncRecord = {
  actorId: string;
  day: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    messageId: string;
    timestamp: string;
  }>;
  clientTimestamp: string;
  serverReceivedAt: string;
};

export type ChatSyncConfig = {
  enabled: boolean;
  maxMessagesPerSync: number;
  retentionDays: number;
  autoSyncIntervalMs: number;
};

const DEFAULT_CONFIG: ChatSyncConfig = {
  enabled: true,
  maxMessagesPerSync: 500,
  retentionDays: 30,
  autoSyncIntervalMs: 5 * 60_000,
};

class DailyChatSyncService {
  private readonly config: ChatSyncConfig;
  private readonly pendingSyncs = new Map<string, ChatSyncRecord>();
  private dailyDigest: DailyDigestService | null = null;
  /** 兼容保留：KV recap 写入已下线（2026-10-23 recap 污染收口），依赖注入不再消费 */
  private memorySync: AgentMemorySyncService | null = null;

  constructor(config?: Partial<ChatSyncConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    dailyDigest: DailyDigestService | null,
    memorySync: AgentMemorySyncService | null,
  ): void {
    this.dailyDigest = dailyDigest;
    this.memorySync = memorySync;
  }

  receiveClientChatSync(record: ChatSyncRecord): {
    success: boolean;
    messageCount: number;
    processed: boolean;
  } {
    if (!this.config.enabled) {
      return { success: false, messageCount: 0, processed: false };
    }

    const key = `${record.actorId}::${record.day}`;
    
    const existing = this.pendingSyncs.get(key);
    if (existing && existing.messages.length >= record.messages.length) {
      return { 
        success: true, 
        messageCount: existing.messages.length, 
        processed: false 
      };
    }

    record.serverReceivedAt = new Date().toISOString();
    this.pendingSyncs.set(key, record);

    console.log(
      `[DailyChatSync] Received sync for ${record.actorId}, day=${record.day}, messages=${record.messages.length}`,
    );

    this.processSyncToMemorySystems(record).catch((err) => {
      console.error(`[DailyChatSync] Process failed for ${key}:`, err);
    });

    return {
      success: true,
      messageCount: record.messages.length,
      processed: true,
    };
  }

  async processSyncToMemorySystems(record: ChatSyncRecord): Promise<void> {
    try {
      await this.updateDailyDigest(record);
      // KV session_recap 逐字对话写入已移除（2026-10-23 recap 污染收口）：
      // 这里曾把客户端历史转成 `[HH:MM] [客户端同步] Agent: …` 整批塞进 KV
      // session_recap —— 只有钟点没有日期的逐字对话，正是「锚点只在今天 /
      // 新对话复述旧对话」的污染源之一。逐字对话属 turn-wal/journal；
      // 跨设备记忆走 dailyDigest.observeTurn 与统一抽取，不走 KV 流水。

      console.log(
        `[DailyChatSync] ✅ Successfully synced ${record.messages.length} messages for ${record.actorId}`,
      );
    } catch (err) {
      console.error(`[DailyChatSync] Sync processing error for ${record.actorId}:`, err);
      throw err;
    }
  }

  private async updateDailyDigest(record: ChatSyncRecord): Promise<void> {
    if (!this.dailyDigest) return;

    const method = this.dailyDigest as unknown as Record<string, (...args: unknown[]) => void>;
    
    for (const msg of record.messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const userText = msg.role === "user" ? msg.text : "";
        const assistantText = msg.role === "assistant" ? msg.text : "";
        
        if (typeof method.observeTurn === "function") {
          method.observeTurn(record.actorId, userText, assistantText);
        }
      }
    }
  }


  getSyncStatus(actorId?: string): {
    totalPendingSyncs: number;
    totalMessages: number;
    actorStats?: Array<{
      actorId: string;
      day: string;
      messageCount: number;
      receivedAt: string;
    }>;
  } {
    let totalMessages = 0;
    const actorStats: Array<{
      actorId: string;
      day: string;
      messageCount: number;
      receivedAt: string;
    }> = [];

    for (const [key, record] of this.pendingSyncs.entries()) {
      totalMessages += record.messages.length;
      actorStats.push({
        actorId: record.actorId,
        day: record.day,
        messageCount: record.messages.length,
        receivedAt: record.serverReceivedAt,
      });
    }

    if (actorId) {
      const filtered = actorStats.filter((s) => s.actorId === actorId);
      return {
        totalPendingSyncs: filtered.length,
        totalMessages: filtered.reduce((sum, s) => sum + s.messageCount, 0),
        actorStats: filtered,
      };
    }

    return {
      totalPendingSyncs: this.pendingSyncs.size,
      totalMessages,
      actorStats,
    };
  }

  cleanupOldRecords(): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    let removed = 0;

    for (const [key, record] of this.pendingSyncs.entries()) {
      const recordDate = new Date(record.serverReceivedAt);
      if (recordDate < cutoffDate) {
        this.pendingSyncs.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[DailyChatSync] Cleaned up ${removed} old sync records`);
    }

    return removed;
  }
}

let singleton: DailyChatSyncService | null = null;

export function getDailyChatSyncService(): DailyChatSyncService {
  if (!singleton) singleton = new DailyChatSyncService();
  return singleton;
}

export function initDailyChatSyncService(
  config?: Partial<ChatSyncConfig>,
): DailyChatSyncService | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new DailyChatSyncService(config);
  return singleton;
}
