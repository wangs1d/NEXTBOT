// 手机端对话式首启引导：账号级状态机 + 纯函数工具集（轻量、无装配依赖）。
//
// 2026-11-09 定稿：手机端用户注册时已登记称呼（账号 displayName），开场白
// 直接问候 + 问 agent 名字（不再问用户称呼）；名字落账号级权威源，桌面端
// 共享同一份数据。legacy awaiting_alias 阶段保留，兼容改版前已开跑的账号。
// 状态存 agent-memory-sync KV（账号级、幂等、重启不丢），吃现成的
// seedIfAbsent / setEntryAndWait，不新增表、不改 prefs 结构。
import { getMemoryComponents } from "../agentic-memory/index.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

export const ONBOARDING_STATE_KV_KEY = "onboarding.intro_state";

export type OnboardingStage = "awaiting_alias" | "awaiting_agent_name" | "done";

const VALID_STAGES: ReadonlySet<string> = new Set<OnboardingStage>([
  "awaiting_alias",
  "awaiting_agent_name",
  "done",
]);

type StoredState = { stage: OnboardingStage; at: string };

/** 读引导阶段；KV 缺失/损坏视为「从未开始」。 */
export function readOnboardingStage(
  sync: AgentMemorySyncService,
  actorId: string,
): OnboardingStage | null {
  try {
    const raw = sync.getSnapshot(actorId, [ONBOARDING_STATE_KV_KEY]).entries[
      ONBOARDING_STATE_KV_KEY
    ];
    if (typeof raw !== "string" || !raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return parsed?.stage && VALID_STAGES.has(parsed.stage)
      ? (parsed.stage as OnboardingStage)
      : null;
  } catch {
    return null;
  }
}

/** 写引导阶段（now 注入，禁 Date.now()/无参 new Date()）。 */
export async function writeOnboardingStage(
  sync: AgentMemorySyncService,
  actorId: string,
  stage: OnboardingStage,
  now: () => number,
): Promise<void> {
  const value: StoredState = { stage, at: new Date(now()).toISOString() };
  await sync.setEntryAndWait(actorId, ONBOARDING_STATE_KV_KEY, JSON.stringify(value));
}

/** 幂等开跑：仅当该账号从未写过状态才落 awaiting_alias，天然防多端重复发。 */
export async function seedOnboardingStage(
  sync: AgentMemorySyncService,
  actorId: string,
  stage: OnboardingStage,
  now: () => number,
): Promise<boolean> {
  const value: StoredState = { stage, at: new Date(now()).toISOString() };
  return sync.seedIfAbsent(actorId, ONBOARDING_STATE_KV_KEY, JSON.stringify(value));
}

/** 用户称呼（structured_facts「称呼」字段，与晨报/首启向导同源）。 */
export function userAliasOf(actorId: string): string | undefined {
  try {
    return (
      getMemoryComponents().factStore?.getFact(actorId, "称呼")?.value?.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * 开场白两泡文案（2026-11-09 定稿：确定性强模板，不走 LLM 生成）。
 * 第一泡：嗨 + 注册时登记的用户名称 + 管家定位（笑脸收尾）；
 * 第二泡：直接问 agent 名字（取名卡随第二泡下发，能力介绍整段删除）。
 */
export function buildIntroBubbles(userName?: string): [string, string] {
  const who = userName?.trim();
  const first = who
    ? `嗨，${who}，我是你的私人管家，以后生活中的事情交给我就好 😊`
    : "嗨，我是你的私人管家，以后生活中的事情交给我就好 😊";
  return [first, "你想叫我什么呢，之后你也可以修改。"];
}

const QUOTE_RE = /[「」『』"'`]/gu;
const TAIL_PARTICLE_RE =
  /(?:就行了|就好|就行|就好了|好了|可以了|即可|吧|呗|啦|嘛|呀|啊|哦|呢)$/u;
const NON_NAME_RE =
  /(?:帮我|提醒|几点|明天|今天|什么|怎么|吗|谢谢|不用|不了|起床|开会|上班|下班|吃饭|睡觉|天气|查一下|买|订|发|打|去|几点|号|点|周|月|日)/u;

function cleanName(raw: string, maxLen: number): string | null {
  let value = raw
    .replace(QUOTE_RE, "")
    .replace(/^[\s，,、：:]+|[，,。！!？?；;、\s]+$/gu, "")
    .trim();
  for (let i = 0; i < 3; i++) {
    const next = value.replace(TAIL_PARTICLE_RE, "").trim();
    if (next === value) break;
    value = next;
  }
  if (!value || value.length > maxLen) return null;
  if (NON_NAME_RE.test(value)) return null;
  return value;
}

const NAME_CHARS = "[^\\s，,。！!？?；;、：:（）()]+";
const ALIAS_RE = new RegExp(
  `(?:叫我|称呼我|喊我|我叫|我是|我的名字(?:叫|是)|名字(?:叫|是))\\s*(?:叫|是|为)?\\s*(${NAME_CHARS})`,
  "u",
);
const AGENT_NAME_RE = new RegExp(
  `(?:就叫你|叫你|喊你|你就叫|你叫|给你取名|给我取名|给你起名|给你取个名|你的名字(?:叫|是)|名字(?:叫|是))\\s*(?:叫|为|做|是)?\\s*(${NAME_CHARS})`,
  "u",
);

/** 从用户回复里抽「怎么称呼用户」；没有明确答案就返回 null（保持当前步）。 */
export function extractUserAlias(text: string): string | null {
  const trimmed = text.trim();
  const m = ALIAS_RE.exec(trimmed);
  if (m?.[1]) {
    const value = cleanName(m[1], 12);
    if (value) return value;
  }
  // 用户直接丢一个短名字过来（「阿哲」）也认；含疑问/任务词一律不认。
  if (trimmed.length <= 12 && !/[。！？!?；;，,、\n]/.test(trimmed)) {
    return cleanName(trimmed, 12);
  }
  return null;
}

/** 从用户回复里抽「给我取的名字」；只有明确命名句式或短名字才认。 */
export function extractAgentName(text: string): string | null {
  const trimmed = text.trim();
  const m = AGENT_NAME_RE.exec(trimmed);
  if (m?.[1]) {
    const value = cleanName(m[1], 24);
    if (value) return value;
  }
  if (trimmed.length <= 12 && !/[。！？!?；;，,、\n]/.test(trimmed)) {
    // 「叫我X」是明确的自我称呼句式（新流程下用户在等取名阶段报称呼很常见），
    // 绝不能当短名字兜底成 agent 名。
    if (ALIAS_RE.test(trimmed)) return null;
    return cleanName(trimmed, 24);
  }
  return null;
}

/** 是否在一句话里同时给了两个答案（明确命名句式才算，短名字兜底不算）。 */
export function explicitAgentName(text: string): string | null {
  const m = AGENT_NAME_RE.exec(text.trim());
  return m?.[1] ? cleanName(m[1], 24) : null;
}

/** 明确的自我称呼句式（「叫我X」才算；短字符串兜底不算，防误收任务句）。 */
export function explicitUserAlias(text: string): string | null {
  const m = ALIAS_RE.exec(text.trim());
  return m?.[1] ? cleanName(m[1], 12) : null;
}

/** 每轮主对话的引导意图（只给状态与意图，不教措辞、不写工具名）。 */
export function onboardingTurnHint(
  sync: AgentMemorySyncService,
  actorId: string,
): string | undefined {
  const stage = readOnboardingStage(sync, actorId);
  if (!stage || stage === "done") return undefined;
  if (stage === "awaiting_alias") {
    return [
      "【初次见面·引导中】你已经主动做过自我介绍并问了用户怎么称呼。",
      "用户这句还没给出称呼：先照常回应用户要办的事，别重新自我介绍，",
      "再顺带自然地补一句问称呼就好。",
    ].join("");
  }
  const alias = userAliasOf(actorId);
  return [
    "【初次见面·引导中】开场白已发出，正在等用户给你取名。",
    alias ? `用户名称是「${alias}」（注册时登记的称呼）。` : "",
    "取名卡会同时出现在回复下方，正文里顺口提一句就行，不必罗列候选名。",
    "先照常回应用户这句，不要自己给自己取名，也不要再介绍能力。",
  ].join("");
}

/** 供 prompt-context-builder 读取的运行时钩子（轻量接口，避免反向依赖装配层）。 */
export interface OnboardingHintRuntime {
  hintForTurn(actorId: string): string | undefined;
}

let runtime: OnboardingHintRuntime | null = null;

export function setOnboardingHintRuntime(value: OnboardingHintRuntime | null): void {
  runtime = value;
}

export function peekOnboardingHintRuntime(): OnboardingHintRuntime | null {
  return runtime;
}
