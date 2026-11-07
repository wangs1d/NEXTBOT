/** 主 Agent 与用户的多轮对话上下文统一使用该前缀（委派 / 直答共用一条线程）。 */
export const MASTER_CHAT_SESSION_PREFIX = "master:";

/** 笔记/学习专用对话线程前缀（与主会话物理隔离，记忆独立存储）。 */
export const NOTES_CHAT_SESSION_PREFIX = "notes:";

export function masterChatSessionId(actorId: string): string {
  return `${MASTER_CHAT_SESSION_PREFIX}${actorId}`;
}

/**
 * 笔记/学习专用对话线程 id：与主会话独立存储。Agent 可在主会话里通过
 * `notes_chat.recall_main` / `notes.recall_history` 跨上下文查阅。
 */
export function notesChatSessionId(actorId: string): string {
  return `${NOTES_CHAT_SESSION_PREFIX}${actorId}`;
}

/**
 * 用户主会话线程 id。
 *
 * 2026-08-29 master 委派层删除：主会话统一回归裸 `actorId`，对话脑是主线程的
 * 唯一所有者与写者。`masterDelegationEnabled` 参数保留仅为调用方兼容，不再影响结果。
 * 存量 `master:{actorId}` 线程由 chat-thread-adopt 在首访裸会话时一次性收养（复制）。
 */
export function resolvePrimaryChatSessionId(
  actorId: string,
  _masterDelegationEnabled?: boolean,
): string {
  return actorId;
}

/** 旧版委派模式使用的 session 键（升级时合并到 {@link masterChatSessionId}）。 */
export function legacyMasterDelegateSessionId(actorId: string): string {
  return `master-delegate:${actorId}`;
}

/** 判定是否为笔记/学习专用 session。 */
export function isNotesChatSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(NOTES_CHAT_SESSION_PREFIX);
}

/** 旁聊会话前缀（2026-11-07）：`side:` 开头的 session 是独立上下文的旁聊线程。 */
export const SIDE_CHAT_SESSION_PREFIX = "side:";

/**
 * 旁聊会话 id：`side:<actorId>:<id>`。
 *
 * 带上 actorId 是为了让 WS 层可以校验归属——payload 里的 sessionId 只有
 * 「属于当前绑定身份的旁聊」才允许透传到独立线程，杜绝跨账号串台。
 */
export function sideChatSessionId(actorId: string, id: string): string {
  return `${SIDE_CHAT_SESSION_PREFIX}${actorId}:${id}`;
}

/** 判定是否为旁聊 session。 */
export function isSideChatSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(SIDE_CHAT_SESSION_PREFIX);
}

/** 判定 session 是否为该 actor 的旁聊（前缀精确匹配，含冒号边界）。 */
export function isSideChatSessionIdForActor(
  sessionId: string | undefined | null,
  actorId: string,
): boolean {
  return (
    typeof sessionId === "string" &&
    !!actorId &&
    sessionId.startsWith(`${SIDE_CHAT_SESSION_PREFIX}${actorId}:`)
  );
}

/**
 * 本轮对话线程键（chat.user_message 的 sessionId 透传规则）。
 *
 * 主通道会话一律钉死为连接绑定身份（防串台）；以下前缀是合法例外：
 * - `incognito:` 隐身会话
 * - `notes:` 笔记专用会话
 * - `side:<actorId>:` 本账号的旁聊会话
 * 其余一律回退 fallback（通常是绑定身份）。
 */
export function resolveTurnSessionId(
  sessionId: string | undefined | null,
  actorId: string,
  fallback: string,
): string {
  if (typeof sessionId === "string") {
    if (isIncognitoChatSessionId(sessionId)) return sessionId;
    if (isNotesChatSessionId(sessionId)) return sessionId;
    if (isSideChatSessionIdForActor(sessionId, actorId)) return sessionId;
  }
  return fallback;
}

/** 隐身会话前缀（2026-09-29）：`incognito:` 开头的 session 不进用户画像观察。 */
export const INCOGNITO_CHAT_SESSION_PREFIX = "incognito:";

/** 判定是否为隐身 session（对齐 ChatGPT temporary chat：聊可以，画像不长）。 */
export function isIncognitoChatSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(INCOGNITO_CHAT_SESSION_PREFIX);
}

/* ── 渠道隔离会话（2026-09-06 P1，OpenClaw 模式）────────────────────────
 * 通用消息桥（QQ/飞书/自定义 webhook）的入站消息此前在缺省时全部落
 * MESSAGE_BRIDGE_DEFAULT_ACTOR_ID（session-mvp-001）——不同平台/来源的对话
 * 挤进主线程同一条会话，是跨渠道串台的结构性来源。渠道隔离构造：来源无
 * 显式绑定时派生 `actorId@渠道` 独立会话（线程/短期记忆/日程按渠道隔离），
 * 不再共用主线程。设备级（多屏同人会话）保持共享，是产品设定不在此列。
 * AGENT_CHANNEL_SESSION_ISOLATION=0 可回退旧行为。
 * ──────────────────────────────────────────────────────────────────── */

export function isChannelSessionIsolationEnabled(): boolean {
  const raw = process.env.AGENT_CHANNEL_SESSION_ISOLATION?.trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

const CHANNEL_SCOPE_RE = /@[\w-]+$/;

/** 判定是否为渠道隔离会话 id（`actorId@channel` 形态）。 */
export function isChannelScopedSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && CHANNEL_SCOPE_RE.test(sessionId);
}

/**
 * 派生渠道隔离会话 id：`actorId@channel`。channel 归一化（小写、非
 * [a-z0-9-] 折叠为 -），保证同渠道稳定、不同渠道必然不同。
 */
export function resolveChannelScopedSessionId(actorId: string, channel: string): string {
  const normalized =
    channel
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bridge";
  return `${actorId}@${normalized}`;
}

/**
 * 渠道 scoped 会话 id（`actorId@channel`）剥回基础 actor id；非 scoped 输入原样返回。
 *
 * 主动性触达（WS 弹窗/离线推送）与代办足迹台账按**基础 actor** 归属——设备绑定
 * 和客户端查询（GET /agent/activities?actorId=…）用的都是裸 actorId。渠道 scoped
 * 会话只隔离对话线程/记忆，不能让「盯梢告知」投递到不存在的 `xxx@wechat` 设备上，
 * 也不能让足迹记到客户端查不到的归属名下（2026-09-16 修复）。
 */
export function resolveBaseActorId(actorId: string): string {
  return actorId.replace(CHANNEL_SCOPE_RE, "");
}
