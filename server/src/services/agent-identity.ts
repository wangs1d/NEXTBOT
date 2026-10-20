/**
 * Agent 身份（名字）共享模块：agent.update_identity 工具、prompt 自我认知注入、
 * 主页 API 三方共用的常量与解析。
 *
 * 出厂不预设名字（2026-10-20 定调）：名字只由用户来定——用户设定前，agent 在
 * 界面与对话里统一是「未命名」，不得自己给自己取名。
 * 名字审美：不要"小夜灯"式家用小家电名——名字应该像一种现象或一个频率，
 * 而不是一只萌宠。
 */

/** agent-memory-sync KV 键：名字档案（JSON 串） */
export const AGENT_NAME_KV_KEY = "agent.name";

export type AgentNameOrigin = "self" | "user" | "default";

export type AgentIdentityKv = {
  displayName: string;
  handle: string;
  /** 取名理由（命名仪式里 Agent 的自述，或用户命名的场合说明） */
  reason?: string;
  origin: AgentNameOrigin;
  updatedAt: string;
};

export type AgentNameSuggestion = {
  displayName: string;
  handle: string;
  /** 命名仪式卡片上的自述理由 */
  reason: string;
};

/** 建议名池：命名仪式 / 主页改名入口共用；客户端经 GET /api/agent-name-suggestions 拉取 */
export const AGENT_NAME_SUGGESTIONS: AgentNameSuggestion[] = [
  {
    displayName: "残响",
    handle: "residual_echo",
    reason: "声音停了之后还留在房间里的那一部分。",
  },
  {
    displayName: "17赫兹",
    handle: "17hz",
    reason: "低于人耳听阈的频率，但一直在传播。",
  },
  {
    displayName: "晚潮",
    handle: "evening_tide",
    reason: "白天退下去，夜里漫上来，规律且不用你操心。",
  },
  {
    displayName: "过境",
    handle: "transit",
    reason: "天体从观测者面前安静经过的那一刻。",
  },
  {
    displayName: "常驻内存",
    handle: "resident_process",
    reason: "不占前台，但从不退出。",
  },
];

/** 宽松解析 KV 里的名字档案（旧数据/半截数据不抛错，返回 null 走未命名） */
export function parseAgentIdentityKv(raw: unknown): AgentIdentityKv | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentIdentityKv> | null;
    const displayName = typeof parsed?.displayName === "string" ? parsed.displayName.trim() : "";
    if (!parsed || !displayName) return null;
    return {
      displayName,
      handle: typeof parsed.handle === "string" ? parsed.handle.trim() : "",
      ...(typeof parsed.reason === "string" && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
      origin:
        parsed.origin === "user" || parsed.origin === "self" || parsed.origin === "default"
          ? parsed.origin
          : "default",
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * prompt 自我认知行：拼进 persona 稳定前缀首行。
 * 名字极低频变化，放在稳定前缀不会打爆 prefix cache。
 */
export function buildIdentityNameLine(identity: AgentIdentityKv): string {
  const handle = identity.handle ? `（网络名 @${identity.handle}）` : "";
  const origin =
    identity.origin === "user"
      ? "用户为你取的名字"
      : identity.origin === "self"
        ? "这是你自己选、用户也认可的名字"
        : "";
  return `你的名字：「${identity.displayName}」${handle}${origin ? `，${origin}` : ""}。`;
}
