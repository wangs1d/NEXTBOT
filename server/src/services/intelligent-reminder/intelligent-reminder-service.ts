import { randomUUID } from "crypto";
import { readJson, writeJson } from "../../proactivity/persist-file.js";
import type {
  ReminderConfig,
  ReminderInstance,
  ReminderLevel,
  ReminderStatus,
  ReminderEscalationRule,
  UserResponseHistory,
  PopupReminderConfig,
  PhoneCallConfig,
} from "./types.js";

export interface IntelligentReminderDeps {
  onPopupReminder: (instance: ReminderInstance) => Promise<void>;
  onPhoneCallReminder: (instance: ReminderInstance) => Promise<void>;
  getUserResponseHistory?: (userId: string) => Promise<UserResponseHistory | null>;
  updateUserResponseHistory?: (
    userId: string,
    level: ReminderLevel,
    responseTimeMs: number,
    responded: boolean,
  ) => Promise<void>;
  /**
   * 提醒实例持久化文件路径。缺省 = 纯内存（单测保持轻量）。
   * 背景：此前 activeReminders 全在内存，服务重启后未确认的提醒静默蒸发。
   */
  persistPath?: string;
}

const ACTIVE_STATUSES: ReminderStatus[] = ["pending", "active", "escalated", "delivered"];

export class IntelligentReminderService {
  private activeReminders = new Map<string, ReminderInstance>();
  private deps: IntelligentReminderDeps;

  constructor(deps: IntelligentReminderDeps) {
    this.deps = deps;
  }

  async createReminder(
    config: ReminderConfig & {
      popupConfig?: PopupReminderConfig;
      phoneConfig?: PhoneCallConfig;
    },
  ): Promise<ReminderInstance> {
    const userId = typeof config.metadata?.userId === "string" ? config.metadata.userId : null;
    const initialLevel =
      config.autoSelectInitialLevel && userId
        ? await this.getRecommendedLevel(userId, config.priority)
        : config.initialLevel;

    // 升级链已斩断（2026-11-05 定调）：popup 不再自动升级到 phone_call；
    // 电话触达仅保留为显式 initialLevel（agent 或调用方直接指定）。
    // escalationRules 一律置空并覆盖传入值，防止旧数据/旧调用复活升级链。
    const instance: ReminderInstance = {
      config: {
        ...config,
        initialLevel,
        escalationRules: [],
      },
      currentLevel: initialLevel,
      status: "pending",
      createdAt: new Date(),
      escalationCount: 0,
      escalationHistory: [],
      popupConfig: config.popupConfig,
      phoneConfig: config.phoneConfig,
    };

    this.activeReminders.set(config.id, instance);
    this.persist();
    return instance;
  }

  async triggerReminder(reminderId: string): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || instance.status !== "pending") {
      return null;
    }

    instance.status = "active";
    instance.startedAt = new Date();

    await this.executeCurrentLevel(instance);

    this.persist();

    return instance;
  }

  private async executeCurrentLevel(instance: ReminderInstance): Promise<void> {
    switch (instance.currentLevel) {
      case "popup":
        await this.deps.onPopupReminder(instance);
        break;
      case "phone_call":
        await this.deps.onPhoneCallReminder(instance);
        break;
    }
  }

  async acknowledgeReminder(
    reminderId: string,
    userId: string,
  ): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || !["active", "escalated", "delivered"].includes(instance.status)) {
      return null;
    }

    const responseTimeMs =
      instance.startedAt?.getTime()
        ? Date.now() - instance.startedAt.getTime()
        : 0;

    instance.status = "acknowledged";
    instance.acknowledgedAt = new Date();
    this.persist();

    if (this.deps.updateUserResponseHistory) {
      await this.deps.updateUserResponseHistory(
        userId,
        instance.currentLevel,
        responseTimeMs,
        true,
      );
    }

    return instance;
  }

  async markDelivered(reminderId: string): Promise<ReminderInstance | null> {
    const instance = this.activeReminders.get(reminderId);
    if (!instance) {
      return null;
    }

    instance.status = "delivered";
    instance.deliveredAt = new Date();
    this.persist();
    return instance;
  }

  cancelReminder(reminderId: string): boolean {
    const instance = this.activeReminders.get(reminderId);
    if (!instance || !["pending", "active", "escalated"].includes(instance.status)) {
      return false;
    }

    instance.status = "cancelled";
    this.persist();
    return true;
  }

  getReminder(reminderId: string): ReminderInstance | undefined {
    return this.activeReminders.get(reminderId);
  }

  getActiveReminders(): ReminderInstance[] {
    return Array.from(this.activeReminders.values()).filter((r) =>
      ["pending", "active", "escalated", "delivered"].includes(r.status),
    );
  }

  async getRecommendedLevel(
    userId: string,
    priority: ReminderConfig["priority"],
  ): Promise<ReminderLevel> {
    if (!this.deps.getUserResponseHistory) {
      return "popup";
    }

    const history = await this.deps.getUserResponseHistory(userId);
    if (!history) {
      return "popup";
    }

    // 仅当用户明确偏好电话且优先级为 urgent 时，才推荐 phone_call
    const prefersPhone = history.preferredLevel === "phone_call";
    if (prefersPhone && priority === "urgent") {
      return "phone_call";
    }

    // 默认始终使用弹窗方式
    return "popup";
  }

  cleanup(): void {
    this.activeReminders.clear();
    this.persist();
  }

  /** 把活跃实例（含升级状态）落盘。写失败静默（内存态仍可用，与 persist-file 约定一致）。 */
  private persist(): void {
    if (!this.deps.persistPath) return;
    const instances = [...this.activeReminders.values()].filter((r) =>
      ACTIVE_STATUSES.includes(r.status),
    );
    writeJson(this.deps.persistPath, {
      version: 1,
      savedAt: new Date().toISOString(),
      instances: instances.map(serializeInstance),
    });
  }

  /**
   * 重启恢复：回填活跃实例。升级链已斩断（2026-11-05 定调）——恢复时不重排
   * 任何升级计时，旧落盘数据里的 escalationRules 一并置空，杜绝升级链复活。
   * 返回恢复的实例数。
   */
  async load(): Promise<number> {
    if (!this.deps.persistPath) return 0;
    const raw = readJson<{ version?: number; instances?: Array<Record<string, unknown>> }>(
      this.deps.persistPath,
      {},
    );
    const restored: ReminderInstance[] = [];
    for (const item of raw.instances ?? []) {
      try {
        const inst = reviveInstance(item);
        if (ACTIVE_STATUSES.includes(inst.status) && !this.activeReminders.has(inst.config.id)) {
          inst.config.escalationRules = [];
          this.activeReminders.set(inst.config.id, inst);
          restored.push(inst);
        }
      } catch {
        /* 单条损坏跳过，不影响其余恢复 */
      }
    }

    this.persist();
    return restored.length;
  }
}

// ─── 持久化序列化：Date ↔ ISO 字符串（JSON.stringify 天然把 Date 变 ISO，恢复时定点复活）───

function serializeInstance(instance: ReminderInstance): Record<string, unknown> {
  return JSON.parse(JSON.stringify(instance)) as Record<string, unknown>;
}

function reviveInstance(raw: Record<string, unknown>): ReminderInstance {
  const toDate = (v: unknown): Date | undefined => {
    const d = typeof v === "string" ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  const config = raw.config as Record<string, unknown> | undefined;
  if (!config || typeof raw.status !== "string" || typeof config.id !== "string") {
    throw new Error("malformed reminder instance");
  }
  const history = Array.isArray(raw.escalationHistory) ? raw.escalationHistory : [];
  return {
    config: {
      ...(config as unknown as ReminderConfig),
      scheduledAt: toDate(config.scheduledAt) ?? new Date(),
    },
    currentLevel: raw.currentLevel as ReminderLevel,
    status: raw.status as ReminderStatus,
    createdAt: toDate(raw.createdAt) ?? new Date(),
    startedAt: toDate(raw.startedAt),
    deliveredAt: toDate(raw.deliveredAt),
    acknowledgedAt: toDate(raw.acknowledgedAt),
    escalationCount: typeof raw.escalationCount === "number" ? raw.escalationCount : 0,
    escalationHistory: history.map((h) => {
      const entry = h as { fromLevel: ReminderLevel; toLevel: ReminderLevel; triggeredAt: unknown; reason?: string };
      return {
        fromLevel: entry.fromLevel,
        toLevel: entry.toLevel,
        triggeredAt: toDate(entry.triggeredAt) ?? new Date(),
        reason: entry.reason ?? "",
      };
    }),
    popupConfig: raw.popupConfig as PopupReminderConfig | undefined,
    phoneConfig: raw.phoneConfig as PhoneCallConfig | undefined,
  };
}
