/**
 * 用户画像聚合器（User Profile Aggregator）
 *
 * 目标：让 agent 真正"越来越了解用户"。
 *
 * 设计（主流方案：LLM 决策 + 代码确定性写入，对齐 mem0 / 扣子记忆变量思路）：
 *   1. 每轮抽取（LLM，异步旁路）：每轮对话后，把【当前画像 + 本轮对话】交给轻量 LLM，
 *      输出结构化操作 JSON（ADD/UPDATE/DELETE + 目标 section + 定位关键词）。
 *      LLM 只负责"记什么、放哪、改哪条"，不直接改写画像文件。
 *   2. 确定性落位（纯代码）：applyProfileOps 按 op 精确操作对应 section 的行；
 *      写盘后重读文件 verifyProfileOps 校验每条操作真实生效、落在正确 section，
 *      校验失败打日志（不静默）。
 *   3. 持久化轮次队列：每轮对话追加到 pending-turns.json（重启不丢），
 *      深度合成消费该队列；替代旧的内存环形缓冲（12 轮滑出即永久丢失，
 *      是"王铭川没进画像"的根源）。
 *   4. 深度合成（LLM，低频）：每 N 轮或巩固钩子触发，输入 = 现有画像 +
 *      规则引擎信号 + 未消费的持久化轮次，输出完整画像 markdown 重写文件。
 *
 * 安全约束：
 *   - LLM 失败静默降级（画像保持旧版，不影响主链路）；
 *   - 同一 actor 的画像读写经串行链，抽取/合成不会并发覆盖；
 *   - 画像文件保持既定 markdown 结构（基本信息/兴趣与习惯/沟通偏好/备注），
 *     UserPersonalizationService.getPromptSlice 的消费格式不变。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../config/model-routing.js";
import { UserProfileStore } from "../services/user-personalization/user-profile-store.js";
import {
  parseFieldLine,
  profileFieldOfLabel,
  projectProfileMarkdown,
  reconcileProfileFactsFromStores,
  type ProfileAuthorityDeps,
  type ProfileAuthorityReport,
} from "../services/user-personalization/profile-fact-authority.js";
import { touchProfileLines, rebuildProfileMeta, listStaleLines } from "./profile-lines-meta.js";

/** 规则画像的最小接口（OnlineLearningCortex 子集，避免硬依赖） */
export interface OnlineLearningLike {
  getProfile(actorId: string): {
    preferences: Array<{ key: string; value: string; stability: number }>;
    habits: Array<{ key: string; value: string; stability: number }>;
    taboos: Array<{ key: string; value: string; stability: number }>;
    topics: string[];
    totalObservations: number;
  };
}

export interface ProfileAggregatorConfig {
  enabled: boolean;
  /** 每轮 LLM 抽取开关 */
  extractEnabled: boolean;
  /** 抽取 token 闸：仅高信号/个人陈述轮跑抽取（寒暄轮靠深度合成兜底） */
  extractPrescreen: boolean;
  /** 画像行陈旧判定阈值（天）：超过该天数未被对话证实的行进合成裁决 */
  staleLineDays: number;
  /** 每轮抽取使用的模型 */
  extractModel: string;
  /** 每 N 轮触发一次 LLM 深度合成 */
  synthesisTurnThreshold: number;
  /** 距上次合成超过该毫秒数才允许再次合成 */
  minSynthesisIntervalMs: number;
  model: string;
  maxTokens: number;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

export function loadProfileAggregatorConfig(): ProfileAggregatorConfig {
  // 抽取/合成默认走 MINI 档（默认跟随主模型，MODEL_MINI env 可统一切小模型）
  const miniModel = getModelForTask(TaskTier.MINI) || resolvePrimaryLlmClientConfig()?.model || "gpt-4.1-mini";
  const primaryModel = miniModel;
  return {
    enabled: envFlag(process.env.MEMORY_PROFILE_AGGREGATOR_ENABLED, true),
    extractEnabled: envFlag(process.env.MEMORY_PROFILE_EXTRACT_ENABLED, true),
    extractPrescreen: envFlag(process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN, true),
    staleLineDays: parseIntEnv(process.env.MEMORY_PROFILE_STALE_DAYS, 90),
    extractModel: process.env.MEMORY_PROFILE_EXTRACT_MODEL?.trim() || primaryModel,
    synthesisTurnThreshold: parseIntEnv(process.env.MEMORY_PROFILE_SYNTHESIS_TURNS, 12),
    minSynthesisIntervalMs: parseFloatEnv(process.env.MEMORY_PROFILE_SYNTHESIS_INTERVAL_MS, 30 * 60 * 1000),
    model: process.env.MEMORY_PROFILE_SYNTHESIS_MODEL?.trim() || primaryModel,
    maxTokens: parseIntEnv(process.env.MEMORY_PROFILE_SYNTHESIS_MAX_TOKENS, 1200),
  };
}

/* ──────────────────────────────────────────────────────────────
 * 结构化画像操作（LLM 输出契约 + 确定性应用）
 * ────────────────────────────────────────────────────────────── */

export type ProfileSectionKey = "basic" | "interest" | "communication" | "note";

export interface ProfileOp {
  op: "ADD" | "UPDATE" | "DELETE";
  section: ProfileSectionKey;
  /** ADD/UPDATE 的新内容（一行，不带 "- " 前缀） */
  line?: string;
  /** UPDATE/DELETE 定位旧条目的关键词 */
  match?: string;
}

/** 已应用操作的校验凭据 */
export interface AppliedOp {
  op: ProfileOp;
  /** 应用后该行必须存在于目标 section */
  expectLine?: string;
  /** 应用后该关键词必须不存在于目标 section */
  expectMatchGone?: string;
}

/** 画像 md 的 section 标题（与 UserProfileStore 默认模板一致） */
const SECTION_HEADINGS: Record<ProfileSectionKey, string> = {
  basic: "## 基本信息",
  interest: "## 兴趣与习惯",
  communication: "## 沟通偏好",
  note: "## 备注",
};

const VALID_SECTIONS = new Set<string>(Object.keys(SECTION_HEADINGS));
const VALID_OPS = new Set<string>(["ADD", "UPDATE", "DELETE"]);

/** 返回 section 内容行的下标区间 [start, end)；section 不存在返回 null */
function sectionBounds(lines: string[], section: ProfileSectionKey): { start: number; end: number } | null {
  const heading = SECTION_HEADINGS[section];
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx < 0) return null;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return { start: headingIdx + 1, end };
}

/** section 不存在时，在文档末尾补一个空 section */
function ensureSection(lines: string[], section: ProfileSectionKey): string[] {
  if (sectionBounds(lines, section)) return lines;
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
  next.push("", SECTION_HEADINGS[section], "");
  return next;
}

/** 在 section 末尾（下一个 ## 或文件尾前）插入一行 */
function insertLineToSection(lines: string[], section: ProfileSectionKey, line: string): string[] {
  const bounds = sectionBounds(lines, section)!;
  let insertIdx = bounds.end;
  // 回退到该 section 最后一条内容之后（跳过尾部空行）
  while (insertIdx > bounds.start && lines[insertIdx - 1].trim() === "") insertIdx--;
  const next = [...lines];
  next.splice(insertIdx, 0, `- ${line}`);
  return next;
}

/**
 * 确定性应用画像操作（纯代码，不经 LLM）。
 * - ADD：section 内无相同行才追加（幂等）；
 * - UPDATE：section 内首个含 match 的行替换为 line；match 缺省时按 line 的"字段："前缀定位；找不到则退化为 ADD；
 * - DELETE：移除 section 内所有含 match 的行。
 */
export function applyProfileOps(
  profile: string,
  ops: ProfileOp[],
): { profile: string; applied: AppliedOp[] } {
  let lines = profile.split("\n");
  const applied: AppliedOp[] = [];

  for (const op of ops) {
    const cleanLine = (op.line ?? "").trim();
    const cleanMatch = (op.match ?? "").trim();

    if (op.op === "ADD") {
      if (!cleanLine) continue;
      lines = ensureSection(lines, op.section);
      const bounds = sectionBounds(lines, op.section)!;
      const exists = lines.slice(bounds.start, bounds.end).some((l) => l.trim() === `- ${cleanLine}`);
      if (!exists) {
        lines = insertLineToSection(lines, op.section, cleanLine);
      }
      applied.push({ op, expectLine: cleanLine });
      continue;
    }

    if (op.op === "UPDATE") {
      if (!cleanLine) continue;
      lines = ensureSection(lines, op.section);
      const bounds = sectionBounds(lines, op.section)!;
      // 定位词：显式 match 优先，否则用新行的"字段："前缀
      const locator = cleanMatch || cleanLine.split(/[：:]/)[0].trim();
      let hit = -1;
      if (locator) {
        for (let i = bounds.start; i < bounds.end; i++) {
          if (lines[i].includes(locator)) {
            hit = i;
            break;
          }
        }
      }
      if (hit >= 0) {
        lines = [...lines];
        lines[hit] = `- ${cleanLine}`;
      } else {
        lines = insertLineToSection(lines, op.section, cleanLine);
      }
      applied.push({ op, expectLine: cleanLine });
      continue;
    }

    // DELETE
    if (!cleanMatch) continue;
    const bounds = sectionBounds(lines, op.section);
    if (!bounds) continue;
    const kept: string[] = [];
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
      if (i >= bounds.start && i < bounds.end && lines[i].includes(cleanMatch)) {
        removed = true;
        continue;
      }
      kept.push(lines[i]);
    }
    if (removed) {
      lines = kept;
      applied.push({ op, expectMatchGone: cleanMatch });
    }
  }

  return { profile: lines.join("\n"), applied };
}

/**
 * 写后校验：对每条已应用操作，确认其真实生效且落在正确 section。
 * 返回未通过校验的操作列表（空数组 = 全部通过）。
 */
export function verifyProfileOps(profile: string, applied: AppliedOp[]): AppliedOp[] {
  const lines = profile.split("\n");
  const failures: AppliedOp[] = [];
  for (const a of applied) {
    const bounds = sectionBounds(lines, a.op.section);
    const scope = bounds ? lines.slice(bounds.start, bounds.end) : [];
    if (a.expectLine !== undefined) {
      const present = scope.some((l) => l.trim() === `- ${a.expectLine}` || l.trim() === a.expectLine);
      if (!present) failures.push(a);
    }
    if (a.expectMatchGone !== undefined) {
      if (scope.some((l) => l.includes(a.expectMatchGone!))) failures.push(a);
    }
  }
  return failures;
}

/** 容错解析 LLM 抽取输出为操作列表（去围栏 + 严格字段校验，非法项丢弃） */
export function parseExtractOps(output: string): ProfileOp[] {
  let text = output.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const ops = (parsed as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) return [];
  const result: ProfileOp[] = [];
  for (const raw of ops.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.op !== "string" || !VALID_OPS.has(o.op)) continue;
    if (typeof o.section !== "string" || !VALID_SECTIONS.has(o.section)) continue;
    const line = typeof o.line === "string" ? o.line.trim().slice(0, 120) : "";
    const match = typeof o.match === "string" ? o.match.trim().slice(0, 60) : "";
    if (o.op !== "DELETE" && !line) continue;
    if (o.op === "DELETE" && !match) continue;
    result.push({ op: o.op as ProfileOp["op"], section: o.section as ProfileSectionKey, line, match });
  }
  return result;
}

function buildExtractMessages(
  currentProfile: string,
  userText: string,
  assistantText: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = [
    "你是用户画像增量维护器。阅读【当前画像】与【本轮对话】，只输出需要写入画像的结构化操作（JSON）。",
    "",
    "规则：",
    "1. 只提取用户明确表达、对未来对话仍有价值的稳定信息（姓名/称呼、所在地、职业、长期偏好、禁忌、长期事实）；寒暄、一次性任务细节、当下情绪不提取。",
    "2. 疑问不是事实：用户问「我叫什么」不得抽取任何姓名；只有用户陈述（如「我叫X」「X 记住没有」「以后叫我X」）才算姓名信息。",
    "3. section 取值：basic（基本信息：称呼/所在地/职业）、interest（兴趣与习惯）、communication（沟通偏好）、note（备注：重要但不宜归类）。",
    "4. op 取值：ADD（画像中不存在该事实）、UPDATE（已有同类条目需修正，match 填旧条目定位关键词）、DELETE（旧条目已被否定或过时，match 填定位关键词）。",
    "5. line 是一行短句（不超过 40 字），格式「字段：值」或自然短句，不带「- 」前缀、不带 markdown。",
    "6. 与现有画像语义重复的信息不要再次输出；拿不准就不输出。",
    "7. 无值得记录的信息时输出 {\"ops\":[]}。",
    "8. 只输出 JSON，不要任何解释。",
    "9. 只有「用户:」的话是事实来源：助手回复里的猜测、调侃、求证（如「到底哪位是正主」「可能是X吧」）不是用户事实，严禁据此 ADD/UPDATE 任何画像条目。",
    "10. 亲密关系是单值字段：老婆/媳妇/正主/未婚妻/对象等（含「未来老婆」等变体）视为同一字段。用户明确给出人名时，必须先 DELETE 画像中该字段下其他不同人名的条目，再写入新值；同一字段禁止并存两个人名，禁止输出「候选/备选/待确认」式的暧昧条目。",
    "11. 用户纠正旧信息时必须输出 DELETE（match=旧条目定位词）：只 ADD 新值不删旧值视为错误。",
  ].join("\n");
  const user = [
    "【当前画像】",
    currentProfile || "（空）",
    "",
    "【本轮对话】",
    `用户: ${userText.slice(0, 500)}`,
    `助手: ${assistantText.slice(0, 300)}`,
    "",
    "请输出 JSON：",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/* ──────────────────────────────────────────────────────────────
 * 深度合成（低频整理）
 * ────────────────────────────────────────────────────────────── */

/** 规则画像 → 供 LLM 的文本块（只取 stability 较高的稳定条目） */
function formatOnlineLearningForPrompt(profile: ReturnType<OnlineLearningLike["getProfile"]>): string {
  const parts: string[] = [];
  const fmt = (list: Array<{ key: string; value: string; stability: number }>, label: string) => {
    const stable = list.filter((e) => e.stability >= 0.35).slice(0, 8);
    if (stable.length > 0) {
      parts.push(`${label}: ${stable.map((e) => `${e.key}=${e.value}(${(e.stability * 100).toFixed(0)}%)`).join("；")}`);
    }
  };
  fmt(profile.preferences, "偏好");
  fmt(profile.habits, "习惯");
  fmt(profile.taboos, "禁忌");
  if (profile.topics.length > 0) {
    parts.push(`近期关注话题: ${profile.topics.slice(0, 8).join("、")}`);
  }
  parts.push(`累计观察轮数: ${profile.totalObservations}`);
  return parts.join("\n");
}

function buildSynthesisMessages(
  currentProfile: string,
  onlineLearningBlock: string,
  recentTurns: string,
  extra?: { factBlock?: string; understandingBlock?: string; staleText?: string },
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = [
    "你是用户画像维护器。根据「现有画像」「规则引擎提取的画像信号」「最近对话轮」，输出更新后的完整用户画像 markdown。",
    "",
    "要求：",
    "1. 保持 markdown 结构：# 用户画像 标题 + ## 基本信息 / ## 兴趣与习惯 / ## 沟通偏好 / ## 备注 四个 section；",
    "2. 只在有足够置信度时写入新信息（用户明确表达过，或多次出现）；冲突时以最新信息为准（人会改变）；",
    "3. 删除已被新信息取代的旧条目和过期的「（待了解）」占位符；",
    "4. 从对话中提炼隐性偏好：语气偏好、专业领域深度、决策风格、常用语言、活跃时段；",
    "5. 每条信息一行，以「- 」开头，精炼不啰嗦；不要编造对话中没有的依据；",
    "6. 控制总尺寸（画像注入 prompt 有长度预算，超长会被整块丢弃）：全文不超过 1500 字；每个 section 至多 8 条；同类条目合并成一条；「备注」只保留长期有效的重要事项，过期的、临时性的、重复的条目直接删除；",
    "7. 亲密关系单值：老婆/对象/正主/未婚妻等（含「未来老婆」等变体）视为同一字段，以用户最新明确表述为准，删除旧表述与「候选/备选/关系未确认」式暧昧条目；助手的调侃、求证永远不是依据；",
    "8. 画像开头保留一行引用块：`> 本文件由 Agent 在与你的对话中持续更新。最后更新：{ISO时间}`；",
    "9. 直接输出 markdown 全文，不要任何解释或代码围栏。",
    "10. 跨库一致性：若提供了【结构化事实库当前值】/【理解档案当前要点】，它们是其他记忆库的权威快照——画像与它们矛盾时，以「最近对话轮」为最高权威统一口径，画像与快照必须改到一致；无矛盾证据时不要凭空改写快照内容。",
    "11. 陈旧裁决：若提供了【陈旧行候选】，逐条判断——近期对话或事实库/理解档案能证实的保留；已明显过时（换了工作/搬了家/关系变化）的删除或改写为现状；拿不准的保留原样。不要为了删而删。",
  ].join("\n");
  const user = [
    "【现有画像】",
    currentProfile || "（空，首次生成）",
    "",
    "【规则引擎画像信号】",
    onlineLearningBlock || "（无）",
    "",
    "【最近对话轮（供提炼隐性偏好）】",
    recentTurns || "（无）",
    "",
    ...(extra?.factBlock ? [extra.factBlock, ""] : []),
    ...(extra?.understandingBlock ? [extra.understandingBlock, ""] : []),
    ...(extra?.staleText
      ? ["【陈旧行候选（长期未被对话证实，逐条裁决：保留/删除/改写为现状）】", extra.staleText, ""]
      : []),
    "请输出更新后的完整画像 markdown：",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 容错提取 LLM 输出中的 markdown 正文（去围栏） */
function cleanProfileMarkdownOutput(output: string): string {
  let text = output.trim();
  text = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "");
  // 必须看起来像画像（含二级标题），否则视为无效输出
  if (!/^#\s*用户画像/m.test(text) || !/##\s/.test(text)) return "";
  return text.trim();
}

/** 轮次队列持久化上限 / 单次合成消费上限 */
const PENDING_TURNS_CAP = 200;
const PENDING_TURNS_PER_SYNTHESIS = 40;

export class UserProfileAggregator {
  private readonly store = new UserProfileStore();
  private readonly config: ProfileAggregatorConfig;
  private readonly client: OpenAI | null;
  private onlineLearning: OnlineLearningLike | null = null;

  /** actorId → 未消费轮次队列（内存缓存，落盘到 pending-turns.json，重启不丢；合成触发判据） */
  private readonly pendingTurns = new Map<string, string[]>();
  private readonly pendingLoaded = new Set<string>();
  /** actorId → 上次深度合成时间戳 */
  private readonly lastSynthesisAt = new Map<string, number>();
  /** in-flight 深度合成去重 */
  private readonly synthesizing = new Set<string>();
  /** actorId → 画像写操作串行链（抽取/合成/队列落盘互不并发覆盖） */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(config?: Partial<ProfileAggregatorConfig>, apiKey?: string) {
    this.config = { ...loadProfileAggregatorConfig(), ...config };
    const llm = resolvePrimaryLlmClientConfig();
    const key = apiKey?.trim() || llm?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
    this.client = key
      ? new OpenAI(
          llm?.baseURL?.trim()
            ? { apiKey: key, baseURL: llm.baseURL.trim(), maxRetries: 1 }
            : { apiKey: key, maxRetries: 1 },
        )
      : null;
  }

  /** 是否具备 LLM 能力（无 key 时 observeTurn 只排队不落画像） */
  get canSynthesize(): boolean {
    return this.client !== null;
  }

  /** 是否实际承担画像事实写入（有 LLM key 且抽取开关开启） */
  get canExtract(): boolean {
    return this.client !== null && this.config.enabled && this.config.extractEnabled;
  }

  /** 注入规则画像源（OnlineLearningCortex） */
  registerOnlineLearning(svc: OnlineLearningLike | null): void {
    this.onlineLearning = svc;
  }

  /**
   * 每轮 finalizeTurn 收尾时调用（2026-09-29 从 brain-center 阶段3.6.1 迁入：
   * 原位传 cognitive.response 恒空串，画像只见用户半边；finalizeTurn 拿真实全文）。
   * - 轮次进入持久化队列（深度合成的输入 + 合成触发判据，重启不丢）；
   * - 条件触发 LLM 抽取（token 闸预筛，ADD/UPDATE/DELETE 精确落位，不阻塞调用方）；
   * - 队列条数达阈值时异步触发 LLM 深度合成。
   */
  observeTurn(
    actorId: string,
    userText: string,
    assistantText: string,
    opts?: { highSignal?: boolean },
  ): void {
    if (!this.config.enabled) return;
    const user = (userText ?? "").trim();
    const assistant = (assistantText ?? "").trim();
    if (!user && !assistant) return;

    // 1. 持久化轮次队列
    const block = `用户: ${user.slice(0, 200)}\n助手: ${assistant.slice(0, 200)}`;
    void this.appendPendingTurn(actorId, block)
      .then(() => this.maybeSynthesizeByPendingCount(actorId))
      .catch(() => {
        /* 队列落盘失败静默，内存仍有 */
      });

    // 2. 条件 LLM 抽取 → 结构化操作确定性写入画像。
    //    token 闸：高信号轮或个人陈述预筛命中才跑 MINI 抽取，寒暄轮跳过；
    //    漏掉的由深度合成兜底（轮次已在队列，零丢失）。
    if (user && this.shouldExtractNow(user, opts?.highSignal === true)) {
      void this.extractAndApply(actorId, user, assistant).catch(() => {
        /* 抽取失败静默，深度合成兜底 */
      });
    }
  }

  /**
   * 个人陈述信号（宽匹配：假阳性=多跑一次 MINI 抽取，假阴性=深度合成兜底）。
   * 二组为改口/迁移类（2026-09-29 纠错腿盲区：「现在在泉州开咖啡店/以后长住」
   * 无「住在/搬家/换工作」字样，被闸误跳过导致画像不更新）。
   */
  private static readonly EXTRACT_HINT_RE =
    /我叫|我的(名字|小名|生日|猫|狗|爱好|工作|职业|公司|学校|专业|老婆|老公|男朋友|女朋友|女儿|儿子|家人|爸妈)|我是(一名|做|搞|学)|住在|在.{0,10}上班|喜欢|讨厌|害怕|最近在(学|练|看|读|准备|找)|养了|要考|结婚|订婚|分手|搬家|换工作|辞职|入职|毕业|记错|搞错|其实|直接一?点|绕弯子|现在(在|不|是)|以后(就|在)|长住|定居|转行|改行|搬(到|去|家)|转让|不干了|改(成|开|做)|换成/;

  /** 抽取 token 闸（MEMORY_PROFILE_EXTRACT_PRESCREEN=0 关闭预筛，恢复每轮抽取） */
  private shouldExtractNow(userText: string, highSignal: boolean): boolean {
    if (!this.config.extractPrescreen) return true;
    if (highSignal) return true;
    return UserProfileAggregator.EXTRACT_HINT_RE.test(userText);
  }

  /**
   * 跨库一致性快照块（P1-2）：事实库当前值 + 理解档案要点，进合成 prompt 交
   * LLM 与画像统一裁决。库未装配/为空时返回空串（零注入）。
   * 返回第三项恒为 "stale" 占位——陈旧行须在合成串行链内按最新画像全文计算。
   */
  private async buildCrossStoreBlocks(
    actorId: string,
  ): Promise<[factBlock: string, understandingBlock: string, staleMarker: string]> {
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      const components = getMemoryComponents();
      const facts = components.factStore?.getActiveFacts?.(actorId) ?? [];
      const understandings =
        components.understandingStore?.getActiveUnderstandings?.(actorId) ?? [];
      const factText = facts
        .slice(0, 20)
        .map((f) => `- ${f.field}: ${f.value}`)
        .join("\n");
      const understandingText = understandings
        .slice(0, 10)
        .map((n) => `- [${n.kind}] ${n.topic}: ${n.note}`)
        .join("\n");
      return [factText, understandingText, "stale"];
    } catch {
      return ["", "", ""];
    }
  }

  /**
   * 档案字段权威投影（2026-10-09 单一权威源）：
   * 把「基本信息」里的档案字段行（称呼/职业/居住地…）重渲染为结构化事实库
   * 的当前值——同一字段只保留一行、清掉别名行（如「用户称呼」）与行内历史注解。
   * 记忆系统未装配/无权威值时原样返回（零注入）。
   */
  private async projectProfileFields(actorId: string, md: string): Promise<string> {
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      const facts = getMemoryComponents().factStore?.getActiveFacts?.(actorId) ?? [];
      if (facts.length === 0) return md;
      return projectProfileMarkdown(md, facts);
    } catch {
      return md;
    }
  }

  /**
   * 把 LLM 抽取到的档案字段值回灌权威库（structured_facts）——本聚合器是
   * 权威库的**馈入方**而非并列写入方，避免画像与事实库各记一个值。
   * 只回收 basic section 里「字段：值」形态的短断言（问句/长句不回收）。
   */
  private async feedBasicFieldsToCanonicalStore(
    actorId: string,
    ops: readonly ProfileOp[],
  ): Promise<void> {
    const candidates: Array<{ field: string; value: string }> = [];
    for (const op of ops) {
      if (op.section !== "basic" || op.op === "DELETE") continue;
      const parsed = op.line ? parseFieldLine(op.line) : null;
      if (!parsed) continue;
      const field = profileFieldOfLabel(parsed.label);
      if (!field) continue;
      // 去掉行内注解（「王哥；也曾使用"王king"」→「王哥」）
      const value = parsed.value.split(/[；;]/)[0]!.trim();
      if (!value || value.length > 40 || /[？?]$/.test(value) || /待了解|未知/.test(value)) continue;
      candidates.push({ field, value });
    }
    if (candidates.length === 0) return;
    try {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      const store = getMemoryComponents().factStore;
      if (!store) return;
      for (const c of candidates) {
        store.applyFact({
          actorId,
          field: c.field,
          value: c.value,
          sourceRef: "profile-aggregator",
        });
      }
    } catch {
      /* 记忆系统未装配 → 忽略（画像照常写） */
    }
  }

  /**
   * 一次性收敛（启动 / 写钩子 / 手动脚本用）：把该 actor 画像的档案字段行重渲染
   * 为权威投影，并（可选）清掉 KV 槽位里的档案字段副本。幂等——无变化不写盘。
   */
  async reconcileProfileFieldAuthority(
    actorId: string,
    memorySync?: ProfileAuthorityDeps["memorySync"],
  ): Promise<ProfileAuthorityReport> {
    return this.runSerialized(actorId, async () => {
      const { getMemoryComponents } = await import("../agentic-memory/index.js");
      return reconcileProfileFactsFromStores(actorId, {
        profileStore: this.store,
        factStore: getMemoryComponents().factStore,
        memorySync: memorySync ?? null,
      });
    });
  }

  /**
   * 持久化队列条数达标即触发深度合成（2026-09-29 换锚：原内存计数器随 tsx watch
   * 重启清零，阈值永远凑不齐；队列文件本就每轮落盘，判据读它重启不丢）。
   * 间隔/在途去重由 synthesizeDeepProfile 内部闸承担；未放行时队列继续累积
   * （上限 200），后续每轮重试直至合成。
   */
  private async maybeSynthesizeByPendingCount(actorId: string): Promise<void> {
    try {
      const pending = await this.ensurePendingLoaded(actorId);
      if (pending.length >= this.config.synthesisTurnThreshold) {
        await this.synthesizeDeepProfile(actorId);
      }
    } catch {
      /* 静默 */
    }
  }

  /** 深度合成外部触发口（MemoryManager 巩固完成后调用） */
  triggerSynthesis(actorId: string): void {
    if (!this.config.enabled) return;
    void this.synthesizeDeepProfile(actorId).catch(() => {
      /* 静默 */
    });
  }

  /** 同一 actor 的画像相关写操作串行执行 */
  private runSerialized<T>(actorId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(actorId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      actorId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /* ── 持久化轮次队列 ── */

  private pendingPath(actorId: string): string {
    return join(dirname(this.store.profilePath(actorId)), "pending-turns.json");
  }

  private async ensurePendingLoaded(actorId: string): Promise<string[]> {
    if (this.pendingLoaded.has(actorId)) return this.pendingTurns.get(actorId) ?? [];
    let list: string[] = [];
    try {
      const raw = await readFile(this.pendingPath(actorId), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* 文件不存在/损坏 → 空队列 */
    }
    this.pendingTurns.set(actorId, list);
    this.pendingLoaded.add(actorId);
    return list;
  }

  private async appendPendingTurn(actorId: string, block: string): Promise<void> {
    await this.runSerialized(actorId, async () => {
      const list = await this.ensurePendingLoaded(actorId);
      list.push(block);
      if (list.length > PENDING_TURNS_CAP) list.splice(0, list.length - PENDING_TURNS_CAP);
      const path = this.pendingPath(actorId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(list, null, 0), "utf8");
    });
  }

  /* ── 每轮 LLM 抽取：决策 → 确定性落位 → 写后校验 ── */

  async extractAndApply(actorId: string, userText: string, assistantText: string): Promise<boolean> {
    if (!this.config.enabled || !this.config.extractEnabled || !this.client) return false;
    const client = this.client;
    return this.runSerialized(actorId, async () => {
      const currentProfile = await this.store.read(actorId);
      const messages = buildExtractMessages(currentProfile, userText, assistantText);
      const response = await client.chat.completions.create({
        model: this.config.extractModel,
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages,
        ...bypassChatRequestExtras(),
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
        recordLlmUsageByChars({
          stage: "user_profile_extract",
          inputChars: JSON.stringify(messages).length,
          outputChars: content.length,
          model: this.config.extractModel,
          // P1-3（2026-09-29）：非流式调用天然带 usage——真值进审计/预算闸，
          // 不再按字符估算虚高 ~1.8 倍记账
          ...(response.usage ? {
            apiPromptTokens: response.usage.prompt_tokens,
            apiCompletionTokens: response.usage.completion_tokens,
          } : {}),
        });
      }
      if (!content) return false;

      const ops = parseExtractOps(content);
      if (ops.length === 0) return true;

      const { profile: next, applied } = applyProfileOps(currentProfile, ops);
      if (applied.length === 0) return true;
      // 单一权威源闭环：LLM 抽到的档案字段先回灌结构化事实库（唯一写入者），
      // 再把画像的档案字段行投影为权威值（去别名重复行 / 清行内历史注解）。
      await this.feedBasicFieldsToCanonicalStore(actorId, applied.map((a) => a.op));
      const projected = await this.projectProfileFields(actorId, next);
      await this.store.write(actorId, projected);

      // 写后校验：重读文件，确认每条操作真实生效且落在正确 section。
      // 基本信息里的档案字段行由权威投影接管（会被重渲染），不计为失败。
      const written = await this.store.read(actorId);
      const failures = verifyProfileOps(written, applied).filter((a) => {
        if (a.op.section !== "basic" || a.expectLine === undefined) return true;
        const parsed = parseFieldLine(a.expectLine);
        return !(parsed && profileFieldOfLabel(parsed.label));
      });
      if (failures.length > 0) {
        console.warn(
          `[ProfileAggregator] 画像写入校验未通过: ${actorId} (${failures.length}/${applied.length} 条未落位)`,
        );
      } else {
        console.log(`[ProfileAggregator] LLM 抽取更新画像: ${actorId} (${applied.length} 条操作，校验通过)`);
      }
      // 新鲜度 sidecar：同步画像全文 + 证实本次落位的行（P1-1）
      try {
        await touchProfileLines(
          actorId,
          written,
          applied.map((a) => a.expectLine ?? "").filter(Boolean),
        );
      } catch (metaErr) {
        console.warn(`[ProfileAggregator] 行元数据同步失败（忽略）: ${metaErr instanceof Error ? metaErr.message : metaErr}`);
      }
      return failures.length === 0;
    });
  }

  /**
   * LLM 深度画像合成：现有画像 + 规则增量 + 未消费轮次队列 + 跨库一致性快照 +
   * 陈旧行裁决清单 → 更新后的画像 markdown。
   * in-flight 去重 + 最小间隔控制；失败静默保持旧画像（轮次不清空，下次再消费）。
   */
  async synthesizeDeepProfile(actorId: string): Promise<boolean> {
    if (!this.config.enabled || !this.client) return false;
    if (this.synthesizing.has(actorId)) return false;

    const last = this.lastSynthesisAt.get(actorId) ?? 0;
    if (Date.now() - last < this.config.minSynthesisIntervalMs) return false;

    // 跨库一致性快照（P1-2）+ 陈旧行候选（P1-1）：都在合成 prompt 里交 LLM 统一裁决
    const [factBlock, understandingBlock, staleBlock] = await this.buildCrossStoreBlocks(actorId);

    this.synthesizing.add(actorId);
    try {
      return await this.runSerialized(actorId, async () => {
        const currentProfile = await this.store.read(actorId);
        const onlineBlock = this.onlineLearning
          ? formatOnlineLearningForPrompt(this.onlineLearning.getProfile(actorId))
          : "";
        const pending = await this.ensurePendingLoaded(actorId);
        const recentTurns = pending.slice(-PENDING_TURNS_PER_SYNTHESIS).join("\n\n");
        // 陈旧行要在拿到画像全文后按当前内容过滤（loadMeta 在串行链外读的，行集合可能有变）
        const staleLines = staleBlock ? await listStaleLines(actorId, currentProfile, this.config.staleLineDays * 86_400_000) : [];
        const staleText = staleLines.length > 0
          ? staleLines.map((m) => `- 「${m.line}」（${m.section}，最近证实 ${m.lastConfirmedAt.slice(0, 10)}，证实 ${m.seenCount} 次）`).join("\n")
          : "";

        const messages = buildSynthesisMessages(
          currentProfile,
          onlineBlock,
          recentTurns,
          { factBlock, understandingBlock, staleText },
        );
        const response = await this.client!.chat.completions.create({
          model: this.config.model,
          temperature: 0.2,
          max_tokens: this.config.maxTokens,
          messages,
          ...bypassChatRequestExtras(),
        });
        const content = response.choices[0]?.message?.content?.trim();
        if (content) {
          const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
          recordLlmUsageByChars({
            stage: "user_profile_aggregate",
            inputChars: JSON.stringify(messages).length,
            outputChars: content.length,
            model: this.config.model,
            // P1-3（2026-09-29）：同 extract——非流式 usage 真值进审计
            ...(response.usage ? {
              apiPromptTokens: response.usage.prompt_tokens,
              apiCompletionTokens: response.usage.completion_tokens,
            } : {}),
          });
        }
        if (!content) return false;

        const cleaned = cleanProfileMarkdownOutput(content);
        if (!cleaned) {
          console.warn("[ProfileAggregator] LLM 输出不符合画像格式，保持旧画像");
          return false;
        }
        // 单一权威源：整文重写同样受权威投影约束，档案字段行以事实库为准
        const projected = await this.projectProfileFields(actorId, cleaned);

        await this.store.write(actorId, projected);
        this.lastSynthesisAt.set(actorId, Date.now());
        // 新鲜度 sidecar 随整文重写重建（保留原有行的历史，新行从现在起算）
        try {
          await rebuildProfileMeta(actorId, projected);
        } catch (metaErr) {
          console.warn(`[ProfileAggregator] 行元数据重建失败（忽略）: ${metaErr instanceof Error ? metaErr.message : metaErr}`);
        }
        // 消费轮次队列（已在序列化链内，直接落盘避免嵌套死锁）
        this.pendingTurns.set(actorId, []);
        try {
          await writeFile(this.pendingPath(actorId), "[]", "utf8");
        } catch {
          /* 静默 */
        }
        console.log(`[ProfileAggregator] 深度画像合成完成: ${actorId} (${cleaned.length} chars)`);
        return true;
      });
    } catch (err) {
      console.warn(
        `[ProfileAggregator] LLM 深度画像合成失败（保持旧画像）: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    } finally {
      this.synthesizing.delete(actorId);
    }
  }

  /** 诊断：当前累积状态 */
  getStats(actorId: string): {
    turnsSinceSynthesis: number;
    bufferedTurns: number;
    lastSynthesisAt: string | null;
    canSynthesize: boolean;
  } {
    const buffered = (this.pendingTurns.get(actorId) ?? []).length;
    return {
      turnsSinceSynthesis: buffered,
      bufferedTurns: buffered,
      lastSynthesisAt: this.lastSynthesisAt.has(actorId)
        ? new Date(this.lastSynthesisAt.get(actorId)!).toISOString()
        : null,
      canSynthesize: this.canSynthesize,
    };
  }
}

/** 工厂：始终返回实例（无 key 时 observeTurn 只排队不落画像） */
export function createUserProfileAggregator(): UserProfileAggregator {
  return new UserProfileAggregator();
}
