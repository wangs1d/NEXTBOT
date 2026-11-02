import type {
  ChatToolExecutionContext,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
} from "../../external-model/types.js";
import type { AgentAccessMode } from "../agent-access-mode.js";
import type { BrainCenter } from "../../brain/index.js";
import type { ClientLocationWire } from "../../types/client-location.js";
import type { KnownLocation, ToolContext, ToolMediaCard, ToolRegistry } from "../../tools/tool-registry.js";
import type { ToolCallGuard } from "../../services/tool-call-guard.js";
import { recordToolUsageForPromotion } from "../../tools/tool-search/tool-promotion.js";
import { recordPreloadExecution } from "../../tools/tool-search/preload-feedback.js";

export type ToolExecutionAccess = {
  agentAccessMode?: AgentAccessMode;
  desktopBridgeOnline?: boolean;
  phoneBridgeOnline?: boolean;
  /** 按需位置：位置类工具（weather.get_local 等）在缺少经纬度时可向客户端请求实时 GPS */
  requestLocation?: () => Promise<ClientLocationWire | null>;
  /** 最近已知位置（内存缓存 → 本地位置历史），带 ageMs；实时 GPS 拿不到时的兜底 */
  getLastKnownLocation?: () => KnownLocation | null;
  /** 中途推送媒体卡（购物登录/支付二维码等）：聊天主路径由 WS 层装配 */
  pushMediaCards?: (cards: ToolMediaCard[]) => void;
};

export type ToolExecutionBase = {
  actorId: string;
  sessionId: string;
  userId?: string;
  chatUserMessageId?: string;
  clientIp?: string;
  clientLocation?: ClientLocationWire;
  userText?: string;
  source: string;
  access?: ToolExecutionAccess;
};

export type ToolContextFactoryDeps = {
  toolRegistry: ToolRegistry;
  getBrainCenter: () => BrainCenter | null;
  /** 敏感工具（金额/不可逆）守卫：持久幂等回放 + 审计落盘（bootstrap 注入，缺省不启用） */
  toolCallGuard?: ToolCallGuard;
};

export type ToolContextCallbacks = {
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
  onAgentStatusLine?: (line: string) => void;
};

export class ToolContextFactory {
  constructor(private readonly deps: ToolContextFactoryDeps) {}

  create(base: ToolExecutionBase, callbacks: ToolContextCallbacks = {}): ChatToolExecutionContext {
    return {
      actorId: base.actorId,
      getCachedToolResult: (name, args) => this.deps.toolRegistry.getCachedResult(name, args),
      executeTool: (name, args, extras) => this.execute(name, args, base, extras?.signal),
      onToolExecuteStart: callbacks.onToolExecuteStart,
      onAgentStatusLine: callbacks.onAgentStatusLine,
      onToolExecuted: callbacks.onToolExecuted,
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    base: ToolExecutionBase,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    // 敏感工具幂等闸：TTL 内同 actor+工具+参数已成功 → 回放结果不重复执行
    // （防跨轮重试/重启恢复后的重复下单/重复转账）；guardNote 让模型如实转告用户
    const guard = this.deps.toolCallGuard;
    if (guard) {
      const replay = guard.checkReplay(base.actorId, name, args);
      if (replay) {
        console.log(`[ToolCallGuard] 幂等回放 tool=${name} actor=${base.actorId}（未重复执行）`);
        return {
          ok: true,
          result: {
            ...replay.result,
            idempotentReplay: true,
            guardNote: `同参数的「${name}」在 ${guard.ttlMinutes()} 分钟内已成功执行，本次为防重复操作的幂等回放，未再次执行。请如实告知用户。`,
          },
        };
      }
    }

    const brainCenter = this.deps.getBrainCenter();
    const brainSafety = brainCenter?.checkSafety(
      { tool: name, args },
      {
        actorId: base.actorId,
        sessionId: base.sessionId,
        ...(base.userText ? { userText: base.userText } : {}),
      },
    );
    if (brainSafety && !brainSafety.allowed) {
      guard?.record(base.actorId, name, args, false, { error: brainSafety.reason, blockedBy: "brain_center" });
      return {
        ok: false,
        result: {
          error: brainSafety.reason,
          severity: brainSafety.severity,
          blockedBy: "brain_center",
        },
      };
    }

    const bodyGateway = brainCenter?.getBodyGateway();
    if (bodyGateway?.hasRoute(name)) {
      const out = await bodyGateway.execute({
        tool: name,
        args,
        actorId: base.actorId,
        source: base.source,
      });
      guard?.record(base.actorId, name, args, out.ok, out.result);
      return out;
    }

    const out = await this.deps.toolRegistry.execute(name, args, this.toToolContext(base, signal));
    guard?.record(base.actorId, name, args, out.ok, out.result);
    // 晋升计数（2026-10-09 L4）：真实执行成功 → 近窗计数，凑满阈值常驻可见集
    recordToolUsageForPromotion(base.actorId, name, out.ok);
    // 预载负反馈（2026-10-10 L5 回流）：真实成功执行 = 预载通道的正证据，
    // 清零该工具的「预载未调」计数并解除冷却降权
    recordPreloadExecution(name, out.ok);
    return out;
  }

  private toToolContext(base: ToolExecutionBase, signal?: AbortSignal): ToolContext {
    return {
      sessionId: base.sessionId,
      userId: base.userId,
      chatUserMessageId: base.chatUserMessageId,
      clientIp: base.clientIp,
      clientLocation: base.clientLocation,
      agentAccessMode: base.access?.agentAccessMode,
      desktopBridgeOnline: base.access?.desktopBridgeOnline,
      phoneBridgeOnline: base.access?.phoneBridgeOnline,
      // 按需位置：透传 locationCoordinator 的 requestLocation，天气等位置类工具
      // 在缺少经纬度时才能向客户端下发 agent.location_request 请求实时 GPS。
      requestLocation: base.access?.requestLocation,
      getLastKnownLocation: base.access?.getLastKnownLocation,
      // 中途推卡：购物等长工具执行中把二维码等即时呈现给用户（chat.media_ready）
      pushMediaCards: base.access?.pushMediaCards,
      // 单次调用取消信号（工具循环超时即 abort）：子进程/HTTP 类 handler 可消费
      ...(signal ? { signal } : {}),
    };
  }
}
