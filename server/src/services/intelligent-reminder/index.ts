import { IntelligentReminderService } from "./intelligent-reminder-service.js";
import { PopupReminderHandler } from "./popup-reminder-handler.js";
import { PhoneCallHandler } from "./phone-call-handler.js";
import { UserResponsePersistenceService } from "./user-response-persistence.js";
import type {
  ReminderInstance,
  ReminderLevel,
} from "./types.js";
import type { VirtualPhoneService } from "../virtual-phone-service.js";
import type { VoiceCapabilityService } from "../voice-capability-service.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";
import type { PhoneBridgeCoordinator } from "../phone-bridge-coordinator.js";

export interface IntelligentReminderSystemDeps {
  virtualPhoneService: VirtualPhoneService;
  phoneBridgeCoordinator?: PhoneBridgeCoordinator;
  voiceDialogueService: VoiceDialogueService;
  /** Agent 底层语音能力中枢（用于电话级微信兜底的 TTS 音频合成） */
  voiceCapabilityService?: VoiceCapabilityService;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  /**
   * 设备在场感知（2026-09-18 设备分级触达）：按连接登记的 deviceClass 报告
   * 电脑端/移动端各自是否在线。缺省 = 视为始终在线（行为同旧版）。
   */
  getDevicePresence?: (userId: string) => { desktopOnline: boolean; mobileOnline: boolean };
  /**
   * 离线必达：手机系统级推送（管道 MobilePushService，App 被杀也能收到）。
   * 用户全部设备离线时，升级链每级先经离线通道送达，不再"假装弹窗成功"。
   */
  offlinePush?: (input: {
    actorId: string;
    title: string;
    body: string;
    importance: string;
    kind: string;
    deliveryId: string;
  }) => Promise<{ ok: boolean; provider?: string; reason?: string }>;
  /**
   * 离线末级兜底：真实短信（阿里云 SMS）。仅 urgent/high 且推送失败时触发，
   * 收件人从 REMINDER_SMS_TO / 用户绑定手机号解析（装配层负责）。
   */
  offlineSms?: (userId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 提醒实例持久化文件路径（透传 IntelligentReminderService；缺省不持久化） */
  statePath?: string;
  /**
   * 可选：微信主动推送回调。
   * 当用户无 WebSocket 连接时（仅使用微信），提醒将通过此通道推送。
   *
   * @param userId - 目标用户 ID
   * @param level - 提醒级别
   * @param title - 提醒标题
   * @param message - 提醒正文
   * @param options.ttsAudio - 可选的 TTS 音频数据（用于语音推送）
   */
  sendWechatProactive?: (
    userId: string,
    level: ReminderLevel,
    title: string,
    message: string,
    options?: { ttsAudio?: { format: string; base64: string } | null },
  ) => Promise<boolean>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  onContactOutcome?: (params: {
    userId: string;
    channel: ReminderLevel;
    responded: boolean;
    responseTimeMs?: number;
    feedback?: "positive" | "negative" | "neutral";
    quietHours?: boolean;
  }) => void;
}

export function createIntelligentReminderSystem(deps: IntelligentReminderSystemDeps) {
  const userResponsePersistence = new UserResponsePersistenceService();

  /**
   * 离线必达闸门（2026-09-18 设备分级触达）：
   * 用户电脑端+移动端全部离线时，WS 弹窗/TTS/模拟来电都是"推给了空气"——
   * 旧实现 trySend 返回 false 但不抛错，升级链照常走完，用户永远收不到。
   * 现在各级 handler 先过这道闸：全离线 → 手机系统级推送 → 短信（urgent/high）→ 微信，
   * 任一成功即止；返回 true 表示已走离线通道（handler 不再执行 WS 路径）。
   */
  const deliverOfflineAnywhere = async (
    userId: string,
    instance: ReminderInstance,
    level: ReminderLevel,
  ): Promise<boolean> => {
    const presence = deps.getDevicePresence?.(userId);
    if (!presence || presence.desktopOnline || presence.mobileOnline) {
      return false; // 有任一端在线 → 走原 WS 链路
    }
    const title = instance.config.title;
    const message = instance.config.message;
    const importance =
      instance.config.priority === "urgent" ? "critical" : instance.config.priority === "high" ? "high" : "normal";
    deps.logger?.info?.(
      `[reminder] 用户全部设备离线，改走离线必达通道: ${instance.config.id} level=${level}`,
    );

    // 1) 手机系统级推送（App 被杀也能收到系统通知——离线场景的主力通道）
    if (deps.offlinePush) {
      try {
        const pushed = await deps.offlinePush({
          actorId: userId,
          title,
          body: message,
          importance,
          kind: "intelligent_reminder",
          deliveryId: `reminder:${instance.config.id}:${level}`,
        });
        if (pushed.ok) {
          deps.logger?.info?.(`[reminder] 离线提醒已经系统级推送送达: ${instance.config.id}`);
          return true;
        }
        deps.logger?.error?.(`[reminder] 离线推送失败: ${pushed.reason ?? "unknown"}`);
      } catch (err) {
        deps.logger?.error?.(`[reminder] 离线推送异常: ${String(err)}`);
      }
    }

    // 2) 真实短信末级兜底（只给 urgent/high，避免低优提醒骚扰手机收件箱）
    if (deps.offlineSms && (instance.config.priority === "urgent" || instance.config.priority === "high")) {
      try {
        const smsText = `【管家提醒】${title}：${message}`.slice(0, 60);
        const sent = await deps.offlineSms(userId, smsText);
        if (sent.ok) {
          deps.logger?.info?.(`[reminder] 离线提醒已经短信兜底送达: ${instance.config.id}`);
          return true;
        }
        deps.logger?.error?.(`[reminder] 短信兜底失败: ${sent.reason ?? "unknown"}`);
      } catch (err) {
        deps.logger?.error?.(`[reminder] 短信兜底异常: ${String(err)}`);
      }
    }

    // 3) 微信兜底（装配层注入时才可用；与原各级 handler 内的兜底共用同一回调）
    if (deps.sendWechatProactive) {
      try {
        if (await deps.sendWechatProactive(userId, level, title, message)) {
          deps.logger?.info?.(`[reminder] 离线提醒已经微信兜底送达: ${instance.config.id}`);
          return true;
        }
      } catch (err) {
        deps.logger?.error?.(`[reminder] 微信兜底异常: ${String(err)}`);
      }
    }

    deps.logger?.error?.(
      `[reminder] 离线必达全部失败（推送/短信/微信均不可用），提醒未能送达: ${instance.config.id}（站内信只承载平台消息，不承载提醒）`,
    );
    return true; // 仍视为已处理（避免 handler 再走注定失败的 WS 路径）
  };

  /** 离线送达也计入触达统计（responded=false）：保持响应偏好学习数据连续，
   * 否则"人在外面（全设备离线）"的场景会从统计里消失，升级节奏随之失真。 */
  const recordOfflineDelivery = (
    userId: string,
    instance: ReminderInstance,
    channel: ReminderLevel,
  ): void => {
    void userResponsePersistence
      .recordResponse({ userId, instance, responded: false, responseTimeMs: 0 })
      .catch(() => {});
    deps.onContactOutcome?.({
      userId,
      channel,
      responded: false,
      quietHours: isQuietHours(),
    });
  };

  const popupHandler = new PopupReminderHandler({
    sendToClient: deps.sendToClient,
    logger: deps.logger,
  });

  const phoneHandler = new PhoneCallHandler({
    virtualPhoneService: deps.virtualPhoneService,
    voiceDialogueService: deps.voiceDialogueService,
    sendToClient: deps.sendToClient,
    logger: deps.logger,
  });

  const reminderService = new IntelligentReminderService(
    {
      onPopupReminder: async (instance) => {
        const userId = instance.config.metadata?.userId as string ?? "unknown";
        // 全设备离线 → 不再假装弹窗，直达推送/短信/微信离线通道
        if (await deliverOfflineAnywhere(userId, instance, "popup")) {
          recordOfflineDelivery(userId, instance, "popup");
          return;
        }
        // 若用户真实手机在线，同步触发物理响铃
        if (deps.phoneBridgeCoordinator?.hasExecutor(userId)) {
          deps.phoneBridgeCoordinator
            .invoke(userId, "ring", {
              reason: `日程提醒：${instance.config.title}`,
              durationSec: 15,
              vibrate: true,
            })
            .catch((err) => deps.logger?.error?.(`[reminder] phone.ring 失败: ${String(err)}`));
        }
        try {
          await popupHandler.handle(instance);
        } catch (wsErr) {
          // WS 推送失败时，尝试微信主动推送
          if (deps.sendWechatProactive) {
            const sent = await deps.sendWechatProactive(userId, "popup", instance.config.title, instance.config.message);
            if (sent) {
              deps.logger?.info?.(`[reminder] popup 已通过微信主动推送: ${instance.config.title}`);
            } else {
              deps.logger?.error?.(`[reminder] popup WS 和微信推送均失败: ${instance.config.title}`);
            }
          }
        }
        await userResponsePersistence.recordResponse({
          userId,
          instance,
          responded: false,
          responseTimeMs: 0,
        });
        deps.onContactOutcome?.({
          userId,
          channel: "popup",
          responded: false,
          quietHours: isQuietHours(),
        });
      },
      onPhoneCallReminder: async (instance) => {
        const userId = instance.config.metadata?.userId as string ?? "unknown";
        // 全设备离线 → 模拟来电必然无人接听，直达推送/短信/微信离线通道
        if (await deliverOfflineAnywhere(userId, instance, "phone_call")) {
          recordOfflineDelivery(userId, instance, "phone_call");
          return;
        }
        try {
          await phoneHandler.handle(instance);
        } catch (wsErr) {
          // WS 推送失败时，尝试微信语音来电模拟
          if (deps.sendWechatProactive && deps.voiceCapabilityService) {
            // 生成前摇引导语 + 正文 的 TTS 音频
            let ttsAudio = null;
            try {
              const preGreeting = buildPreGreetingForWechat(instance);
              const fullText = `${preGreeting}\n\n${instance.config.message}`;
              const ttsResult = await deps.voiceCapabilityService.synthesize(fullText);
              if (ttsResult.ok) {
                ttsAudio = { format: ttsResult.format, base64: ttsResult.base64 };
              }
            } catch (_) { /* TTS 生成失败 */ }

            const sent = await deps.sendWechatProactive(userId, "phone_call", instance.config.title, instance.config.message, { ttsAudio });
            if (sent) {
              deps.logger?.info?.(`[reminder] phone_call 已通过微信语音推送模拟来电: ${instance.config.title}`);
            } else {
              deps.logger?.error?.(`[reminder] phone_call WS 和微信推送均失败: ${instance.config.title}`);
            }
          }
        }
        await userResponsePersistence.recordResponse({
          userId,
          instance,
          responded: false,
          responseTimeMs: 0,
        });
        deps.onContactOutcome?.({
          userId,
          channel: "phone_call",
          responded: false,
          quietHours: isQuietHours(),
        });
      },
      getUserResponseHistory: async (userId) => {
        return userResponsePersistence.getUserHistory(userId);
      },
      updateUserResponseHistory: async (
        userId: string,
        level: ReminderLevel,
        responseTimeMs: number,
        responded: boolean,
      ) => {
        const record = await userResponsePersistence.recordResponse({
          userId,
          instance: {} as any,
          responded,
          responseTimeMs,
        });
        return;
      },
      persistPath: deps.statePath,
    },
  );


  return {
    reminderService,
    popupHandler,
    phoneHandler,
    userResponsePersistence,
  };
}

function isQuietHours(now = new Date()): boolean {
  const hour = now.getHours();
  return hour >= 23 || hour < 8;
}

function getLevelLabel(level: ReminderLevel): string {
  switch (level) {
    case "popup":
      return "弹窗文字";
    case "phone_call":
      return "电话呼叫";
    default:
      return level;
  }
}

/**
 * 为微信端生成电话来电的前摇引导语（TTS 语音内容）。
 * 模拟真实电话的"接通感"，让用户知道这是 Agent 的语音提醒。
 */
function buildPreGreetingForWechat(instance: { config: { title?: string; priority?: string } }): string {
  const title = instance.config.title ?? "提醒";
  const priority = instance.config.priority ?? "normal";

  const hour = new Date().getHours();
  const timeLabel = hour < 6 ? "深夜" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 22 ? "晚上" : "夜间";

  const priorityHint =
    priority === "urgent"
      ? "紧急"
      : priority === "high"
        ? "重要"
        : "";

  return `叮铃铃——您好，我是您的 Agent。${timeLabel}有一条${priorityHint}${title}提醒，请听好。`;
}
