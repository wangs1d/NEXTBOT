import type { ReminderInstance, PhoneCallConfig } from "./types.js";
import type { VirtualPhoneService } from "../virtual-phone-service.js";
import type { VoiceDialogueService } from "../voice-dialogue/voice-dialogue-service.js";
import type { DialogueContext } from "../voice-dialogue/types.js";
import { ServerEventType } from "../../protocol.js";

export interface PhoneCallHandlerDeps {
  virtualPhoneService: VirtualPhoneService;
  voiceDialogueService: VoiceDialogueService;
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export class PhoneCallHandler {
  private deps: PhoneCallHandlerDeps;
  private activeCalls = new Map<string, {
    callId: string;
    isActive: boolean;
    retryCount: number;
    disconnectCommands: string[];
    dialogueContext: DialogueContext;
  }>();

  constructor(deps: PhoneCallHandlerDeps) {
    this.deps = deps;
  }

  async handle(instance: ReminderInstance): Promise<void> {
    const config = instance.phoneConfig ?? {};
    const userId = instance.config.metadata?.userId as string | undefined;
    const actorId = instance.config.metadata?.actorId as string | undefined;

    if (!userId) {
      this.deps.logger?.error("Phone call reminder missing userId in metadata");
      return;
    }

    const disconnectCommands = config.disconnectCommand ?? ["退下", "知道了", "收到", "挂断"];
    // 不重试：定时提醒只打一次，失败就发通知让用户看消息
    const maxRetries = 0;

    let retryCount = 0;
    let callSuccessful = false;

    while (!callSuccessful && retryCount <= maxRetries) {
      try {
        callSuccessful = await this.executePhoneCall(
          instance,
          userId,
          actorId,
          config,
          disconnectCommands,
        );
      } catch (error) {
        this.deps.logger?.error(`Phone call attempt ${retryCount + 1} failed: ${error}`);
      }

      if (callSuccessful) break;
      if (retryCount >= maxRetries) break;
      retryCount++;
      this.deps.logger?.info(`Retrying phone call... Attempt ${retryCount + 1}/${maxRetries}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (!callSuccessful) {
      this.deps.logger?.error(`All phone call attempts failed for reminder: ${instance.config.id}`);
      await this.sendCallFailedNotification(userId, instance);
    }
  }

  private async executePhoneCall(
    instance: ReminderInstance,
    userId: string,
    actorId: string | undefined,
    config: PhoneCallConfig,
    disconnectCommands: string[],
  ): Promise<boolean> {
    await this.sendIncomingCallNotification(userId, instance);

    let callResult;
    if (actorId) {
      /** 前摇引导语：振铃阶段让用户知道这是提醒来电 */
      const preGreeting = this.buildPreGreeting(instance);
      const fullTranscript = `${preGreeting}\n\n${instance.config.message}`;

      callResult = await this.deps.virtualPhoneService.callUserWithRinging({
        fromActorId: actorId,
        toUserId: userId,
        transcript: fullTranscript,
        ringStyle: "reminder",
        ringPhase: {
          enableRingingPhase: true,
          ringDurationMs: config.ringDurationMs ?? 8_000,
        },
      });
    } else {
      return false;
    }

    if (!callResult.ok || !callResult.callId) {
      return false;
    }

    const dialogueContext: DialogueContext = {
      sessionId: instance.config.id,
      userId,
      conversationHistory: [
        {
          role: "system",
          content: `你是一个提醒助手。当前任务：向用户传达提醒信息"${instance.config.message}"。用户可能会回应，你需要确认他们已理解。当用户说"退下"、"知道了"、"收到"等确认词语时，礼貌地结束对话。`,
        },
      ],
      metadata: {
        reminderId: instance.config.id,
        reminderTitle: instance.config.title,
      },
    };

    const callState = {
      callId: callResult.callId,
      isActive: true,
      retryCount: 0,
      disconnectCommands,
      dialogueContext,
    };

    this.activeCalls.set(instance.config.id, callState);

    try {
      await this.runInteractiveDialogueLoop(instance, userId, callResult.callId, config, disconnectCommands, dialogueContext);
      return true;
    } catch (error) {
      this.deps.logger?.error(`Error during interactive dialogue: ${error}`);
      this.activeCalls.delete(instance.config.id);
      return false;
    }
  }

  private async runInteractiveDialogueLoop(
    instance: ReminderInstance,
    userId: string,
    callId: string,
    config: PhoneCallConfig,
    disconnectCommands: string[],
    context: DialogueContext,
  ): Promise<void> {
    const callState = this.activeCalls.get(instance.config.id);
    if (!callState || !callState.isActive) return;

    const maxDurationMs = (config.maxRingDurationSec ?? 300) * 1000;
    const startTime = Date.now();
    let userAcknowledged = false;

    // 通话内后续回应统一经 VirtualPhoneService.pushVoiceReply 推送
    // （TTS 合成 + agent.phone.voice_reply WS 事件）；接通首帧正文已由
    // callUserWithRinging 随 call_connecting 下发，此处不再重复播报。
    try {
      // Realtime 语音模式：通话对话由 duplex realtime 引擎按 callId 上下文接管
      // （提醒正文已在接通首帧播报），本循环让位，只等通话结束走统一收尾。
      if (this.deps.virtualPhoneService.isRealtimeVoice?.()) {
        this.deps.logger?.info(`Call ${callId}: realtime voice engine owns the dialogue, waiting for call end`);
        await this.deps.virtualPhoneService.waitForCallEnd(callId, maxDurationMs);
      } else {
        while (callState.isActive && !userAcknowledged) {
          const remainingMs = maxDurationMs - (Date.now() - startTime);
          if (remainingMs <= 0) {
            this.deps.logger?.info(`Call timeout after ${maxDurationMs / 1000}s`);
            break;
          }

          // 等待用户在通话中的真实回复（客户端经 phone.call_reply 上行，打字输入）；
          // 超时/挂断返回 null
          const input = await this.deps.virtualPhoneService.waitForCallReply(callId, remainingMs);
          if (!input) break;
        const userText = input.text.trim();
        if (!userText) continue;

        this.deps.logger?.info(`User input received on call ${callId}: "${userText}"`);

        const shouldDisconnect = disconnectCommands.some((cmd) =>
          userText.toLowerCase().includes(cmd.toLowerCase()),
        );

        if (shouldDisconnect) {
          userAcknowledged = true;
          this.deps.logger?.info(`User acknowledged with: "${userText}"`);
          await this.pushVoiceReply(callId, userId, "好的，提醒已送达。再见！");
          // 给客户端留出播报告别语的缓冲，再走挂断清理
          await new Promise((resolve) => setTimeout(resolve, 800));
        } else {
          context.conversationHistory.push({ role: "user", content: userText });

          let assistantText = "";
          try {
            assistantText = await this.deps.voiceDialogueService.chatCompletion(
              context.conversationHistory,
              {
                temperature: 0.7,
                systemPrompt:
                  "你是提醒助手，简短回应用户，并引导他们说'退下'或'收到'来结束通话。",
              },
            );
          } catch (error) {
            this.deps.logger?.error(`Error in LLM dialogue: ${error}`);
            assistantText = `我听到了您说"${userText}"。请回复"退下"结束通话。`;
          }

          assistantText = assistantText.trim();
          if (assistantText) {
            context.conversationHistory.push({ role: "assistant", content: assistantText });
            await this.pushVoiceReply(callId, userId, assistantText);
            this.deps.logger?.info(`Assistant voice reply: "${assistantText}"`);
          }
        }
        }
      }
    } finally {
      callState.isActive = false;
      this.activeCalls.delete(instance.config.id);
      // 会话收尾（清理会话+落通话记录，不推 ended——本循环随后自带带语义 reason 的 ended 推送）。
      // 必须把会话从服务端会话表移除，否则并发忙线护栏会把该用户锁到 TTL 超时。
      this.deps.virtualPhoneService.closeCall(callId, userAcknowledged ? "acknowledged" : "timeout");
    }

    if (userAcknowledged) {
      await this.sendCallCompletedNotification(userId, instance);
    }
    // 通话收尾：推 ended 状态让客户端关闭通话 UI（手机端全屏通话页 / 桌面 Win32 通话窗）
    await this.sendCallEndedStatus(userId, callId, userAcknowledged ? "acknowledged" : "timeout");
  }

  private async sendCallEndedStatus(
    userId: string,
    callId: string,
    reason: "acknowledged" | "timeout",
  ): Promise<void> {
    if (!callId) return;
    try {
      await this.deps.sendToClient(userId, {
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          direction: "agent_to_user",
          status: "ended",
          reason,
        },
      });
    } catch (error) {
      this.deps.logger?.error(`Failed to send call ended status for ${callId}: ${error}`);
    }
  }

  private async pushVoiceReply(callId: string, userId: string, text: string): Promise<void> {
    try {
      const result = await this.deps.virtualPhoneService.pushVoiceReply(callId, userId, text);
      if (!result.pushed) {
        this.deps.logger?.info(`Voice reply not delivered (user offline): call ${callId}`);
      }
    } catch (error) {
      this.deps.logger?.error(`Failed to push voice reply for call ${callId}: ${error}`);
    }
  }

  /**
   * 构建前摇引导语（精简版）。
   */
  private buildPreGreeting(instance: ReminderInstance): string {
    return "";  // 不加额外引导语，直接播提醒正文
  }

  private formatTimeLabel(): string {
    const hour = new Date().getHours();
    if (hour < 6) return "深夜";
    if (hour < 9) return "早上";
    if (hour < 12) return "上午";
    if (hour < 14) return "中午";
    if (hour < 18) return "下午";
    if (hour < 22) return "晚上";
    return "夜间";
  }

  private async sendIncomingCallNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "incoming_reminder_call",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: instance.config.message,
      priority: instance.config.priority,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  private async sendCallFailedNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "reminder_call_failed",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: "无法接通电话，请查看消息内容",
      originalMessage: instance.config.message,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  private async sendCallCompletedNotification(
    userId: string,
    instance: ReminderInstance,
  ): Promise<void> {
    const payload = {
      type: "reminder_call_completed",
      reminderId: instance.config.id,
      timestamp: new Date().toISOString(),
    };

    await this.deps.sendToClient(userId, payload);
  }

  forceEndCall(reminderId: string): boolean {
    const callState = this.activeCalls.get(reminderId);
    if (!callState || !callState.isActive) {
      return false;
    }

    callState.isActive = false;
    this.activeCalls.delete(reminderId);
    this.deps.virtualPhoneService.cancelCallReplyWaiters(callState.callId);
    this.deps.logger?.info(`Force ended call: ${reminderId}`);
    return true;
  }

  getActiveCallCount(): number {
    return Array.from(this.activeCalls.values()).filter((c) => c.isActive).length;
  }

  cleanup(): void {
    for (const [id, state] of this.activeCalls) {
      state.isActive = false;
      this.deps.virtualPhoneService.cancelCallReplyWaiters(state.callId);
    }
    this.activeCalls.clear();
  }
}
