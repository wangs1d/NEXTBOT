// 成稿（IntelComposer）—— 升级路径：判断的草稿过不了事实校验（缺稿/编造/跨天
// 失真）时才运行，此时才把面板里的详情加载进来，带人格重写这句话。
//
// 输出是可直接投递的一到两句话；模型不可用时抛错，调用方保留条目按退避重试。
import type { ExternalChatProvider } from "../../external-model/types.js";
import type {
  IntelComposeInput,
  IntelComposeResult,
  IntelComposer,
} from "./intel-types.js";
import { formatDistance, formatRelativeClock } from "./intel-time.js";

export type IntelComposerDeps = {
  chat: () => ExternalChatProvider | null;
  /** 人格·静态（agent/SOUL.md）：说出口的话与主对话同一副嗓子 */
  personaPrompt?: (actorId: string) => string | null;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DETAIL_IN_PROMPT_MAX = 2000;

/** 成稿纪律：稳定前缀，不随时间变化（保护前缀缓存） */
const COMPOSE_RULES = [
  "",
  "现在把已判定「值得开口」的事说给用户听。只输出 JSON 数组，不要解释。每个元素：",
  `{"id":"消息id","message":"对用户说的话","needsConfirm":false,"memoryCandidate":""}`,
  "",
  "要求：",
  "- message 像朋友顺口说一句，一到两句，60 字以内；带关键数字与时间；直奔主题。",
  "- 不要『系统检测到』『温馨提示』，不要类别前缀或标签，不要编造详情里没有的信息。",
  "- 详情与摘要冲突时以详情为准；详情里没有的细节宁可不提。",
  "- needsConfirm：只有用户必须回一句才算闭环（要做决定、要确认完成）才为 true，其余 false。",
  "- memoryCandidate：只有日后仍需记得、需要继续跟进的事（答应别人的期限、待办）才写一句可长期记住的事实；否则留空。",
].join("\n");

function localIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

function buildSystemPrompt(persona: string | null): string {
  return persona?.trim() ? `${persona.trim()}\n${COMPOSE_RULES}` : COMPOSE_RULES.trimStart();
}

export function buildComposeUserPrompt(input: IntelComposeInput): string {
  const lines: string[] = [];
  lines.push(`现在：${localIso(input.now)}（${input.timezone}）`);
  lines.push(`用户在场：${input.presence}；正在对话：${input.inConversation ? "是" : "否"}`);
  if (input.styleBrief?.trim()) lines.push(`用户画像：${input.styleBrief.trim()}`);
  if (input.recentSpoken.length > 0) {
    lines.push(
      `最近主动说过（别重复同样的说法）：\n${input.recentSpoken
        .map((s) => `- ${formatRelativeClock(s.at, input.now)}｜${s.message}`)
        .join("\n")}`,
    );
  }
  lines.push("");
  lines.push(`要说的事（${input.items.length} 条，详情已加载）：`);
  input.items.forEach((it, i) => {
    lines.push(`${i + 1}. id=${it.id}`);
    lines.push(`   来源=${it.source}${it.from ? `；来自=${it.from}` : ""}；收到=${formatRelativeClock(it.at, input.now)}（${formatDistance(it.at, input.now)}）`);
    lines.push(`   摘要=${it.brief}`);
    const detail = it.detail.replace(/\n{3,}/g, "\n\n").slice(0, DETAIL_IN_PROMPT_MAX).trim();
    if (detail) lines.push(`   详情=${detail}`);
  });
  return lines.join("\n");
}

/** 解析成稿：容忍围栏与 {messages:[]}/{results:[]} 包装；缺 message 的条目丢弃（调用方重试该条） */
export function parseComposeOutput(raw: string, ids: Set<string>): IntelComposeResult[] {
  const text = String(raw ?? "").replace(/```(?:json)?/gi, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  let rows: unknown = null;
  if (start >= 0 && end > start) {
    try {
      rows = JSON.parse(text.slice(start, end + 1));
    } catch {
      rows = null;
    }
  }
  if (!Array.isArray(rows)) {
    try {
      const obj = JSON.parse(text) as { messages?: unknown; results?: unknown };
      rows = Array.isArray(obj.messages) ? obj.messages : Array.isArray(obj.results) ? obj.results : null;
    } catch {
      rows = null;
    }
  }
  if (!Array.isArray(rows)) return [];

  const out: IntelComposeResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!ids.has(id) || out.some((r) => r.id === id)) continue;
    const message = typeof o.message === "string" ? o.message.replace(/\s+/g, " ").trim() : "";
    if (!message) continue;
    const memory =
      typeof o.memoryCandidate === "string" ? o.memoryCandidate.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    out.push({
      id,
      message: message.slice(0, 300),
      ...(o.needsConfirm === true ? { needsConfirm: true } : {}),
      ...(memory ? { memoryCandidate: memory } : {}),
    });
  }
  return out;
}

export function createIntelComposer(deps: IntelComposerDeps): IntelComposer {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (input: IntelComposeInput) => {
    const chat = deps.chat();
    if (!chat) throw new Error("主聊天模型未启用，成稿暂缓");
    const ids = new Set(input.items.map((it) => it.id));
    let full = "";
    const call = chat.streamCompletion(
      `intel_compose:${input.actorId}:${input.now.toString(36)}`,
      { text: buildComposeUserPrompt(input) },
      (delta: string) => {
        full += delta;
      },
      undefined,
      {
        ephemeralTurn: true,
        disableThinking: true,
        maxThreadMessages: 0,
        systemPromptOverride: buildSystemPrompt(deps.personaPrompt?.(input.actorId) ?? null),
        auditStage: "intel_compose",
      },
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`成稿超时（${timeoutMs}ms）`)), timeoutMs).unref?.(),
    );
    const raw = await Promise.race([call, timeout]);
    const composed = parseComposeOutput(raw || full, ids);
    if (composed.length === 0) throw new Error("成稿结果为空或格式不合法");
    return composed;
  };
}
