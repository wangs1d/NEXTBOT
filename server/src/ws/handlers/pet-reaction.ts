/**
 * 处理 `pet.reaction` — 桌宠即兴台词（纯 LLM 生成，无本地词库）。
 *
 * 客户端（桌宠 overlay / 悬浮组件）在交互或事件发生时上报上下文，
 * 服务端用一次性 LLM 调用（ephemeral，不进对话线程、不污染前缀缓存）
 * 生成一句台词，以 `pet.reaction.ack` 返回：
 *   { ok: true, trigger, text, mood?, energy? }
 * 失败/未配置 LLM 时 ack { ok:false }，客户端静默降级（不显示台词）。
 *
 * 零配置门禁：chat 未装配或未启用 → 直接 ok:false 返回，绝不 throw。
 */

/** ExternalChatProvider 的结构化最小接口（与 desktop-scene-handlers 的约定一致）。 */
export type PetReactionChatLike = {
  isEnabled(): boolean;
  streamCompletion(
    sessionId: string,
    userTurn: { text: string; clientMessageId?: string },
    onDelta: (delta: string) => void,
    tools?: unknown,
    streamOpts?: {
      ephemeralTurn?: boolean;
      systemPromptOverride?: string;
      maxOutputTokens?: number;
      disableThinking?: boolean;
    },
  ): Promise<string>;
};

export interface PetReactionHandlerContext {
  /** 只需要 send 能力（connection.ts 的 socket 结构兼容） */
  socket: { send: (data: string) => void };
  boundActorId: string;
}

export interface PetReactionHandlerDeps {
  chat: PetReactionChatLike | null;
}

const ACK_TYPE = "pet.reaction.ack";
const MIN_INTERVAL_MS = 1500;
const GENERATION_TIMEOUT_MS = 8000;
const actorLastHandledAt = new Map<string, number>();
const actorInFlight = new Set<string>();

type PetTrigger =
  | "drag_start"
  | "drag_release"
  | "rotate_start"
  | "rotate_release"
  | "spin"
  | "shake"
  | "tap"
  | "vertical_bounce"
  | "long_idle"
  | "offwork_card"
  | "health_reminder"
  | "focus_start"
  | "focus_done"
  | (string & {});

function buildSystemPrompt(trigger: PetTrigger): string {
  const base =
    "你是用户电脑上的 AI 桌宠，也是用户私人 Agent 的人格载体。根据给到的实时上下文即兴说一句话。" +
    "要求：只输出台词本身；中文口语化；有性格但不油腻；不解释、不加引号、不加旁白。";
  if (trigger === "offwork_card") {
    return (
      base +
      "这是下班打卡场景：根据用户今天的专注数据写一句有趣、暖一点或调侃一点的打卡评语，" +
      "长度不超过 28 个字，最多一个 emoji；数据平淡时也要说得可爱，不许编造数据里没有的成绩。"
    );
  }
  if (trigger === "health_reminder") {
    return (
      base +
      "这是健康提醒场景（久坐/喝水/护眼）：说一句关心但不啰嗦的短句，不超过 20 个字，最多一个 emoji。"
    );
  }
  if (trigger === "focus_start" || trigger === "focus_done") {
    return (
      base +
      "这是专注计时场景：开始或结束一轮番茄钟时说一句打气的短句，不超过 20 个字，最多一个 emoji。"
    );
  }
  return base + "长度不超过 22 个字，最多一个 emoji。";
}

function buildUserText(payload: Record<string, unknown>): string {
  const ctx: Record<string, unknown> = {
    trigger: payload.trigger ?? "unknown",
    hour: payload.hour,
    mood: payload.mood,
    intensity: payload.intensity,
    totalMagnitude: payload.totalMagnitude,
    silenceMs: payload.silenceMs,
    region: payload.region,
  };
  if (payload.healthKind) ctx.healthKind = payload.healthKind;
  if (payload.stats && typeof payload.stats === "object") {
    const s = payload.stats as Record<string, unknown>;
    ctx.stats = {
      focusMinutes: s.focusMinutes,
      sessions: s.sessions,
      streakDays: s.streakDays,
      offworkTime: s.offworkTime,
    };
  }
  // 剔除 undefined 字段，保持 prompt 干净
  for (const k of Object.keys(ctx)) {
    if (ctx[k] === undefined) delete ctx[k];
  }
  return JSON.stringify(ctx);
}

async function generateLine(
  chat: PetReactionChatLike,
  actorId: string,
  trigger: PetTrigger,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!chat.isEnabled()) return null;
  try {
    const text = await Promise.race([
      chat.streamCompletion(
        `pet-reaction:${actorId}`,
        {
          text: buildUserText(payload),
          clientMessageId: `pet-reaction-${Date.now()}`,
        },
        () => {},
        undefined,
        {
          ephemeralTurn: true,
          systemPromptOverride: buildSystemPrompt(trigger),
          maxOutputTokens: 64,
          disableThinking: true,
        },
      ),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), GENERATION_TIMEOUT_MS),
      ),
    ]);
    const line = String(text ?? "").trim().replace(/^["'「『]|["'」』]$/g, "");
    if (!line || line.length > 60) return null;
    return line;
  } catch (error) {
    console.error(
      "[PetReaction] line generation failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * 处理 pet.reaction 事件。节流 + 单飞（同一 actor 未完成时丢弃新请求），
 * 生成失败/超时一律 ok:false 返回，客户端降级为不显示台词。
 */
export async function handlePetReactionEvent(
  ctx: PetReactionHandlerContext,
  payload: unknown,
  deps: PetReactionHandlerDeps,
): Promise<void> {
  const { socket, boundActorId } = ctx;
  const sendAck = (payloadAck: Record<string, unknown>): void => {
    try {
      socket.send(JSON.stringify({ type: ACK_TYPE, payload: payloadAck }));
    } catch {
      /* 连接已断开时静默 */
    }
  };

  if (!boundActorId) {
    sendAck({ ok: false, reason: "session_required" });
    return;
  }
  const pl = (payload ?? {}) as Record<string, unknown>;
  const trigger = String(pl.trigger ?? "unknown").trim() as PetTrigger;
  // 客户端关联 ID：多组件并发请求时用于匹配 ack（原样透传）
  const requestId = typeof pl.requestId === "string" ? pl.requestId : undefined;

  // 节流：同一 actor 两次台词请求至少间隔 MIN_INTERVAL_MS
  const now = Date.now();
  const last = actorLastHandledAt.get(boundActorId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    sendAck({ ok: false, reason: "throttled", trigger });
    return;
  }
  // 单飞：上一句还没生成完就不再叠加
  if (actorInFlight.has(boundActorId)) {
    sendAck({ ok: false, reason: "busy", trigger });
    return;
  }

  const chat = deps.chat;
  if (!chat) {
    sendAck({ ok: false, reason: "chat_unavailable", trigger });
    return;
  }

  actorLastHandledAt.set(boundActorId, now);
  actorInFlight.add(boundActorId);
  try {
    const text = await generateLine(chat, boundActorId, trigger, pl);
    if (text) {
      sendAck({ ok: true, trigger, text, mood: "happy", energy: 0.7, requestId });
    } else {
      sendAck({ ok: false, reason: "generation_failed", trigger, requestId });
    }
  } finally {
    actorInFlight.delete(boundActorId);
    // 防泄漏：actor 记录上限
    if (actorLastHandledAt.size > 512) {
      const oldest = actorLastHandledAt.keys().next().value;
      if (oldest !== undefined) actorLastHandledAt.delete(oldest);
    }
  }
}
