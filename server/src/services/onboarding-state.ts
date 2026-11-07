// 手机端对话式首启引导：账号级状态机 + 纯函数工具集（轻量、无装配依赖）。
//
// 2026-11-07 定稿：手机端用户注册/登录后 agent 主动开口（自我介绍 + 问称呼），
// 再问用户怎么称呼自己；两个答案都落账号级权威源，桌面端共享同一份数据。
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

/** 能力材料：每项都带「具体替用户做什么」，是事实材料不是措辞模板。 */
export const CAPABILITY_MATERIAL_LINES: readonly string[] = [
  "定提醒、管日程：早上把当天安排整理成晨报，晚上睡前把明天要做的事捋成备忘",
  "盯要紧事：用户说一句「帮我盯着」就一直留意，有变化第一时间告诉用户",
  "查天气、搜资料、比价下单：一次办齐",
  "旅行规划：行程、车次、地图一口气安排好",
  "打电话、发消息、收邮件：直接替用户跑腿",
  "闲着的时候陪用户聊天",
];

/** LLM 失败/kill switch/熔断时的回退正文（两段 = 两个绿泡）。 */
export const INTRO_FALLBACK =
  "嗨，我是你的贴身助手，今天正式上岗。\n" +
  "定提醒、管日程是最基本的，早上把当天安排整理成晨报给你，晚上睡前再把明天要做的事捋成备忘，" +
  "你说一句「帮我盯着」，我就一直留意那件事、有变化马上告诉你，" +
  "查天气、搜资料、比价下单、规划旅行行程和车次地图我也能一次办齐，" +
  "打电话、发消息、收邮件照样能替你跑，平时想闲聊我也在，" +
  "先认识一下——平时怎么称呼你？";

/** 主动开口的任务材料（场景语义留在 user 轮，人格与纪律由 SpeechHub 单点装配）。 */
export function buildIntroTaskPrompt(): string {
  return [
    "任务材料：这是你与这位用户的第一次见面，需要你主动开口（不是回复消息）。",
    "能力材料（要覆盖，别照抄）：",
    ...CAPABILITY_MATERIAL_LINES.map((line) => `- ${line}`),
    "结构要求：只输出两段，中间用一个换行隔开。",
    "第一段：单独一句问候，说自己上岗了。",
    "第二段：用一段话说清上面这些能力具体能替用户做什么，然后问用户平时怎么称呼。",
    "第二段内部只用逗号和顿号，不要出现句号、分号、感叹号、问号或换行，末尾用唯一一个问号收尾。",
    "不要编号、不要列表符号、不要引号、不要解释结构。",
  ].join("\n");
}

/** 取第一段的第一句（问候独占一泡，多说的部分丢掉，避免问候泡被撑长）。 */
function firstSentenceOnly(text: string): string {
  const m = text.match(/^[\s\S]*?[。！？!?]/u);
  return (m?.[0] ?? text).trim();
}

/**
 * 第二泡规范化：合并成单句，去掉所有句末标点（分泡器只在句末切泡），
 * 末尾补上唯一的问号，并保证「问称呼」这个意图存在。
 */
function normalizeSecondBubble(text: string): string {
  let out = text
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/[。！!；;？?]/g, "，")
    .replace(/[「」『』"']/g, "")
    .trim();
  out = out.replace(/^[，,、\s]+|[，,、\s]+$/gu, "");
  out = out.replace(/[，,、]+$/gu, "");
  if (!/怎么称呼|称呼你|怎么叫|叫什么|叫你什么/.test(out)) {
    out = `${out}，先认识一下——平时怎么称呼你`;
  }
  return `${out}？`;
}

/** 把主动开口正文拆成两泡：问候一泡，能力介绍 + 问称呼一泡。 */
export function splitIntroIntoBubbles(raw: string): string[] {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    return [firstSentenceOnly(lines[0]!), normalizeSecondBubble(lines.slice(1).join(""))];
  }
  const text = lines[0] ?? "";
  const m = text.match(/^([\s\S]*?[。！？!?])([\s\S]*)$/u);
  if (m?.[1] && m[2]?.trim()) {
    return [firstSentenceOnly(m[1]), normalizeSecondBubble(m[2])];
  }
  return [text.trim()].filter(Boolean);
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
    return cleanName(trimmed, 24);
  }
  return null;
}

/** 是否在一句话里同时给了两个答案（明确命名句式才算，短名字兜底不算）。 */
export function explicitAgentName(text: string): string | null {
  const m = AGENT_NAME_RE.exec(text.trim());
  return m?.[1] ? cleanName(m[1], 24) : null;
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
    "【初次见面·引导中】用户刚告诉你称呼",
    alias ? `是「${alias}」` : "",
    "，接下来该问用户想怎么称呼你（给你取个名字）。",
    "先照常回应用户这句，别重复问称呼，不要自己给自己取名，也不要再介绍能力。",
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
