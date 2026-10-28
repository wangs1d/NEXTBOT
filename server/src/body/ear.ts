// Agent Body Center —— Ear 耳/听觉传感器
//
// 职责：对应人体的听觉器官，统一封装「入站音频到达」通道：
//   1. phone-bridge 入站音频流：标记入站音频到达事件
//   2. voice-message 入站音频：委托 voiceMessageService 接收音频
//
// 本模块不做语音转写（ASR 已从产品中移除）：入站音频只负责标记到达与取回，
// 需要理解音频内容的场景由 realtime 语音引擎（MiniMax 全双工）在云端处理。
//
// 设计原则（与 reflex-arc.ts / sensory-cortex.ts 一致）：
//   1. 子系统缺失时优雅降级（返回 ok=false + errorMessage），不抛异常
//   2. 所有 *Like 接口仅声明本模块实际用到的方法，结构兼容真实服务即可
//   3. async/await 风格，无 callback
//
// 与 brain/sensory-cortex.ts 的差异：
//   - SensoryCortex 是脑侧感知皮层，跨模态融合（看/说）
//   - Ear 是身体侧器官模块，仅负责听觉通道，挂到 BodyGateway

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyToolRegistry,
} from "./types.js";

// ---- 子系统最小化外观接口（结构兼容真实服务即可）----------------------

/**
 * PhoneBridge 入站音频流外观接口。
 * 真实实现为 PhoneBridgeCoordinator，此处仅声明 onInboundAudio 钩子（可选）。
 */
interface PhoneBridgeInboundLike {
  onInboundAudio?(
    handler: (audio: { data: Buffer; format: string }) => void,
  ): void;
}

/**
 * VoiceMessage 入站音频外观接口。
 * 真实实现为 VoiceMessageService，此处仅声明 receiveAudio 方法（可选）。
 */
interface VoiceMessageInboundLike {
  receiveAudio?(
    messageId: string,
  ): Promise<{ audio: { data: Buffer; format: string }; from?: string }>;
}

// ---- EarDeps ------------------------------------------------

/**
 * Ear 构造参数。
 *
 * - bodyBus：必填，身体内部消息总线，用于发布 body.ear.inbound_audio 信号
 * - phoneBridge：入站音频流（可选）
 * - voiceMessageService：入站语音消息（可选）
 */
export interface EarDeps {
  bodyBus: BodyBus;
  phoneBridge?: PhoneBridgeInboundLike;
  voiceMessageService?: VoiceMessageInboundLike;
}

// ---- Ear 主类 -----------------------------------------------

/**
 * 耳/听觉传感器：身体侧的听觉器官模块。
 *
 * 实现 BodyModuleLike 接口，挂到 BodyGateway 后由其路由调用。
 *
 * 工具列表：
 *   - phone_bridge.inbound_audio：标记入站音频到达事件
 *   - voice_message.inbound_audio：委托 voiceMessageService 接收音频
 *
 * 信号发布：
 *   - body.ear.inbound_audio：入站音频到达时发布，payload 含 source/format/timestamp
 *
 * 子系统缺失时优雅降级：
 *   - phoneBridge 缺失 → phone_bridge.inbound_audio 返回 ok=false + errorMessage
 *   - voiceMessageService 缺失 → voice_message.inbound_audio 返回 ok=false + errorMessage
 */
export class Ear implements BodyModuleLike {
  readonly name = "ear" as const;
  readonly label = "耳/听觉传感器";
  readonly tools = [
    "phone_bridge.inbound_audio",
    "voice_message.inbound_audio",
  ];

  private readonly bodyBus: BodyBus;

  private readonly phoneBridge: PhoneBridgeInboundLike | null;
  private readonly voiceMessageService: VoiceMessageInboundLike | null;

  private started = false;

  /** 最近一次入站音频时间（ISO timestamp，无活动时为 null） */
  private lastActivityAt: string | null = null;

  constructor(deps: EarDeps) {
    this.bodyBus = deps.bodyBus;
    this.phoneBridge = deps.phoneBridge ?? null;
    this.voiceMessageService = deps.voiceMessageService ?? null;
  }

  // ---- 生命周期 ---------------------------------------------------------

  /** 启动听觉皮层：当前无后台任务，仅置位并记日志。 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[Ear] 已启动，跳过重复 start");
      return;
    }
    console.log("[Ear] 正在启动...");
    this.started = true;
    console.log("[Ear] 启动完成");
  }

  /** 停止听觉皮层：仅置位，不主动中断底层服务。 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[Ear] 未启动，跳过 stop");
      return;
    }
    console.log("[Ear] 正在停止...");
    this.started = false;
    console.log("[Ear] 已停止");
  }

  // ---- 核心方法：act ----------------------------------------------------

  /**
   * 执行听觉相关动作。
   *
   * 工具分发：
   *  - phone_bridge.inbound_audio → 标记入站音频到达事件
   *  - voice_message.inbound_audio → 委托 voiceMessageService 接收音频
   *
   * 任一分支异常均被捕获，返回 ok=false + errorMessage，不抛出。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startTime = Date.now();
    const tool = action.tool ?? "";
    const args = action.args ?? {};

    try {
      switch (tool) {
        case "phone_bridge.inbound_audio":
          return await this.actPhoneBridgeInbound(args, action, startTime);
        case "voice_message.inbound_audio":
          return await this.actVoiceMessageInbound(args, action, startTime);
        default:
          return {
            ok: false,
            result: { error: `unknown_tool:${tool}` },
            errorMessage: `unknown_tool:${tool}`,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Ear] act 异常 tool=${tool} err=${errMsg}`);
      return {
        ok: false,
        result: { error: errMsg },
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * phone_bridge.inbound_audio：标记入站音频到达事件。
   *
   * phoneBridge 缺失或未暴露 onInboundAudio 时返回 ok=false + errorMessage。
   * 入站音频的实质性处理（落盘等）由调用方在收到信号后自行编排。
   */
  private async actPhoneBridgeInbound(
    args: Record<string, unknown>,
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (!this.phoneBridge || typeof this.phoneBridge.onInboundAudio !== "function") {
      return {
        ok: false,
        result: { error: "phone_bridge_not_available" },
        errorMessage: "phone_bridge_not_available",
        durationMs: Date.now() - startTime,
      };
    }

    // 标记入站音频到达事件（发布到 BodyBus，让其他模块可订阅 body.ear.inbound_audio）
    const now = new Date().toISOString();
    this.touchActivity();
    try {
      this.bodyBus.publish({
        kind: "body.ear.inbound_audio",
        payload: {
          source: "phone_bridge",
          format: (args.format as string) ?? "unknown",
          actorId: action.actorId,
          timestamp: now,
        },
        module: "ear",
        actorId: action.actorId,
        timestamp: now,
      });
    } catch (err) {
      console.log(`[Ear] bodyBus.publish 异常: ${err}`);
    }

    return {
      ok: true,
      result: {
        source: "phone_bridge",
        marked: true,
        timestamp: now,
      },
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * voice_message.inbound_audio：委托 voiceMessageService 接收音频。
   *
   * voiceMessageService 缺失或未暴露 receiveAudio 时返回 ok=false + errorMessage。
   * 成功时返回音频数据与来源。
   */
  private async actVoiceMessageInbound(
    args: Record<string, unknown>,
    action: BodyAction,
    startTime: number,
  ): Promise<BodyActionResult> {
    if (
      !this.voiceMessageService ||
      typeof this.voiceMessageService.receiveAudio !== "function"
    ) {
      return {
        ok: false,
        result: { error: "voice_message_service_not_available" },
        errorMessage: "voice_message_service_not_available",
        durationMs: Date.now() - startTime,
      };
    }

    const messageId = (args.messageId as string) ?? "";
    if (!messageId) {
      return {
        ok: false,
        result: { error: "missing_message_id" },
        errorMessage: "missing_message_id",
        durationMs: Date.now() - startTime,
      };
    }

    const received = await this.voiceMessageService.receiveAudio(messageId);
    this.touchActivity();

    const now = new Date().toISOString();
    try {
      this.bodyBus.publish({
        kind: "body.ear.inbound_audio",
        payload: {
          source: "voice_message",
          messageId,
          format: received.audio.format,
          from: received.from,
          actorId: action.actorId,
          timestamp: now,
        },
        module: "ear",
        actorId: action.actorId,
        timestamp: now,
      });
    } catch (err) {
      console.log(`[Ear] bodyBus.publish 异常: ${err}`);
    }

    return {
      ok: true,
      result: {
        source: "voice_message",
        messageId,
        audio: {
          format: received.audio.format,
          size: received.audio.data.length,
        },
        from: received.from,
        timestamp: now,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // ---- 核心方法：sense --------------------------------------------------

  /**
   * 感官查询。
   *
   * 支持的 query.kind：
   *  - "ear.status"：返回 { availableSources, lastAudioAt }
   * 其他 kind 返回 ok=false + errorMessage="unknown_query_kind"。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind ?? "";

    switch (kind) {
      case "ear.status": {
        return {
          ok: true,
          data: {
            availableSources: this.listAvailableSources(),
            lastAudioAt: this.lastActivityAt,
          },
          module: "ear",
        };
      }

      default:
        return {
          ok: false,
          data: { error: "unknown_query_kind" },
          module: "ear",
          errorMessage: `unknown_query_kind:${kind}`,
        };
    }
  }

  // ---- 核心方法：snapshot ----------------------------------------------

  /** 模块快照：返回当前在线状态、子系统列表与最近活动时间。 */
  snapshot(): BodyModuleSnapshot {
    return {
      name: "ear",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems: this.listAvailableSources(),
      lastActivityAt: this.lastActivityAt,
      metadata: {},
    };
  }

  // ---- 核心方法：registerTools -----------------------------------------

  /**
   * 把 phone_bridge.inbound_audio / voice_message.inbound_audio 工具挂到外部
   * ToolRegistry，handler 内部委托 this.act()。
   *
   * actorId 暂时无法获取（BodyToolRegistry 接口未传 context），保持 undefined。
   * 返回值：成功 { ok: true, ...result.result }；失败 { ok: false, error, ...result.result }。
   */
  registerTools(registry: BodyToolRegistry): void {
    for (const toolName of this.tools) {
      registry.register(toolName, async (input) => {
        const result = await this.act({
          tool: toolName,
          args: input,
          source: "body_module",
        });
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.errorMessage ??
              result.reason ??
              "body module action failed",
            ...result.result,
          };
        }
        return { ok: true, ...result.result };
      });
    }
  }

  // ---- 内部工具 ---------------------------------------------------------

  /** 列出当前可用的入站音频来源。 */
  private listAvailableSources(): string[] {
    const list: string[] = [];
    if (this.phoneBridge?.onInboundAudio) list.push("phone_bridge");
    if (this.voiceMessageService?.receiveAudio) list.push("voice_message");
    return list;
  }

  /** 更新最近一次活动时间为当前 ISO 时间戳。 */
  private touchActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }
}
