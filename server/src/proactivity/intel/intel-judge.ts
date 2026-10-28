// 情报判断（IntelJudge）—— 一次调用回答「现在说 / 到点说 / 不必说」并写好那句话。
//
// 输入是面板的目录行（一行摘要 + 时间 + 来源），不是正文；需要正文才能写准时
// 才让模型标 needDetail，再带详情判一次。取舍规则放在系统提示词里逐字节稳定，
// 前缀缓存可复用；语气只靠用户消息末尾的风格卡，不进系统提示词。
//
// 没有关键词表、没有每日配额：频率由判断本身与用户回执调控；模型不可用时
// 不产生结论，调用方把条目留在面板等恢复。
import type { ExternalChatProvider } from "../../external-model/types.js";
import type {
  IntelDirectoryLine,
  IntelJudge,
  IntelJudgeInput,
  IntelJudgeResult,
} from "./intel-types.js";
import { formatDistance, formatRelativeClock } from "./intel-time.js";

export type IntelJudgeDeps = {
  /** 主聊天模型（晚绑定：运行期取；null/未启用 = 判断不可用） */
  chat: () => ExternalChatProvider | null;
  timeoutMs?: number;
  /** 单次最多要求看详情的条数（防止把面板全量拉进上下文） */
  maxNeedDetail?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NEED_DETAIL = 2;

const SYSTEM_RULES = [
  "你在替用户的私人助理做情报取舍，并顺手写成开口要说的话。面板每行是一条聚合消息的摘要（来源｜时间｜摘要）。",
  "你决定这一条「现在说 / 到点说 / 不必说」，并对要说的事写一句草稿；拿不准就 never。",
  "只输出 JSON 数组，不要任何解释。每个元素：",
  `{"id":"消息id","verdict":"now|later|never","reason":"一句话内部理由","draft":"对用户说的话（now/later 必填）","needsConfirm":false,"memoryCandidate":"","dueAt":"ISO8601（later 必填）","expiresAt":"ISO8601（可选）","needDetail":false}`,
  "",
  "取舍原则：",
  "- 信息存在不等于值得打扰。拿不准就 never。",
  "- 只有用户需要行动或做决定、错过会后悔或不可逆的事才值得说：临近的行程变动、会议变更或冲突、今天必须处理的截止、账户或支付异常、用户正在等的结果。",
  "- 验证码等一次性口令、常规到账/扣款/订阅续费、营销推送、社交闲聊、随时可以自己查的资讯：never。",
  "- 用户最近忽略或静音过的类型，更克制；同一件事没有新变化就不再说。",
  "- later 必须给 dueAt，贴着这件事「说才有用」的时刻；expiresAt 写过了就没意义的时刻。",
  "- 摘要不足以判断、或不足以把草稿写准时，才把 needDetail 设为 true（最多 2 条）；能凭摘要决定的不要看详情。",
  "- 若条目带「详情」，以详情为准做最终决定和草稿。",
  "",
  "草稿要求：",
  "- 像朋友顺口说一句，一到两句，60 字以内；带关键数字与时间；直奔主题。",
  "- 不要『系统检测到』『温馨提示』，不要类别前缀或标签，不要编造摘要与详情里没有的信息。",
  "- later 的草稿尽量写绝对日期时间（如 10月29日 18:35），避免次日投递时『明天』失真。",
  "- needsConfirm 只在用户必须回一句才算闭环（要做决定、要确认完成）时为 true。",
  "- memoryCandidate 只写日后仍需记得、需要继续跟进的承诺/待办；否则留空。",
].join("\n");

function localIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
  );
}

function lineOf(line: IntelDirectoryLine, now: number): string {
  const from = line.from ? `｜${line.from}` : "";
  const state =
    line.state === "held" && line.dueAt !== undefined ? `｜约定 ${formatRelativeClock(line.dueAt, now)}` : "";
  const detail = line.detail ? `\n  详情=${line.detail.replace(/\s+/g, " ").slice(0, 1500)}` : "";
  return `- id=${line.id}｜${line.source}${from}｜${formatRelativeClock(line.at, now)}${state}｜${line.brief}${detail}`;
}

export function buildJudgeUserPrompt(input: IntelJudgeInput): string {
  const lines: string[] = [];
  lines.push(`现在：${localIso(input.now)}（${input.timezone}）`);
  lines.push(`用户在场：${input.presence}；正在对话：${input.inConversation ? "是" : "否"}`);
  if (input.styleBrief?.trim()) lines.push(`用户画像：${input.styleBrief.trim()}`);
  const spoken = input.feedback.recentSpoken;
  lines.push(
    spoken.length
      ? `最近主动说过：\n${spoken
          .map((s) => `- ${formatRelativeClock(s.at, input.now)}（${formatDistance(s.at, input.now)}）｜${s.message}`)
          .join("\n")}`
      : "最近主动说过：无",
  );
  const outcomes = input.feedback.recentOutcomes;
  lines.push(
    outcomes.length
      ? `最近投递回执：\n${outcomes
          .map((o) => `- ${formatRelativeClock(o.at, input.now)}｜${o.kind}｜${o.outcome}`)
          .join("\n")}`
      : "最近投递回执：无",
  );
  lines.push("");
  lines.push(`面板目录（${input.lines.length} 条）：`);
  for (const line of input.lines) lines.push(lineOf(line, input.now));
  const voice = input.voiceCard?.trim();
  if (voice) {
    lines.push("");
    lines.push(`说话风格（只影响 draft，不影响取舍）：${voice}`);
  }
  lines.push("");
  lines.push(
    "提醒：只输出 JSON 数组；needDetail 只给真正需要的条目标 true，其余省略或 false。",
  );
  return lines.join("\n");
}

/** 解析模型输出：容忍代码围栏与 {judgments:[...]} 包装；非法条目直接丢弃（留待重试） */
export function parseJudgeOutput(
  raw: string,
  ids: Set<string>,
  now: number,
  maxNeedDetail = DEFAULT_MAX_NEED_DETAIL,
): IntelJudgeResult[] {
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
      const obj = JSON.parse(text) as { judgments?: unknown };
      rows = Array.isArray(obj.judgments) ? obj.judgments : null;
    } catch {
      rows = null;
    }
  }
  if (!Array.isArray(rows)) return [];

  const out: IntelJudgeResult[] = [];
  let needDetailUsed = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!ids.has(id)) continue;
    if (out.some((r) => r.id === id)) continue;
    const verdict = o.verdict;
    if (verdict !== "now" && verdict !== "later" && verdict !== "never") continue;
    const dueParsed = typeof o.dueAt === "string" ? Date.parse(o.dueAt) : NaN;
    const expiresParsed = typeof o.expiresAt === "string" ? Date.parse(o.expiresAt) : NaN;
    const wantDetail =
      o.needDetail === true && verdict !== "never" && needDetailUsed < maxNeedDetail;
    if (wantDetail) needDetailUsed += 1;
    const draft =
      verdict === "never"
        ? ""
        : typeof o.draft === "string"
          ? o.draft.replace(/\s+/g, " ").trim().slice(0, 300)
          : "";
    const memory =
      verdict === "never" || typeof o.memoryCandidate !== "string"
        ? ""
        : o.memoryCandidate.replace(/\s+/g, " ").trim().slice(0, 200);
    out.push({
      id,
      verdict,
      reason: typeof o.reason === "string" ? o.reason.trim().slice(0, 300) : "",
      ...(draft ? { draft } : {}),
      ...(verdict !== "never" && o.needsConfirm === true ? { needsConfirm: true } : {}),
      ...(memory ? { memoryCandidate: memory } : {}),
      // later 缺合法时刻时按「现在」处理：判断为值得说，不让解析问题把事拖没
      ...(verdict === "later" ? { dueAt: Number.isFinite(dueParsed) ? Math.max(dueParsed, now) : now } : {}),
      ...(Number.isFinite(expiresParsed) ? { expiresAt: expiresParsed } : {}),
      ...(wantDetail ? { needDetail: true } : {}),
    });
  }
  return out;
}

export function createIntelJudge(deps: IntelJudgeDeps): IntelJudge {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxNeedDetail = deps.maxNeedDetail ?? DEFAULT_MAX_NEED_DETAIL;
  return async (input: IntelJudgeInput) => {
    const chat = deps.chat();
    if (!chat) throw new Error("主聊天模型未启用，判断暂缓");
    const ids = new Set(input.lines.map((line) => line.id));
    let full = "";
    const call = chat.streamCompletion(
      `intel_judge:${input.lines[0]?.id.split(":")[0] ?? "default"}:${input.now.toString(36)}`,
      { text: buildJudgeUserPrompt(input) },
      (delta: string) => {
        full += delta;
      },
      undefined,
      {
        ephemeralTurn: true,
        disableThinking: true,
        maxThreadMessages: 0,
        systemPromptOverride: SYSTEM_RULES,
        auditStage: "intel_judge",
      },
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`判断超时（${timeoutMs}ms）`)), timeoutMs).unref?.(),
    );
    const raw = await Promise.race([call, timeout]);
    const judgments = parseJudgeOutput(raw || full, ids, input.now, maxNeedDetail);
    if (judgments.length === 0) throw new Error("判断结果为空或格式不合法");
    return judgments;
  };
}
