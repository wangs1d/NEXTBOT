/**
 * 用户画像聚合器（User Profile Aggregator）
 *
 * 目标：让 agent 真正"越来越了解用户"。
 *
 * 设计（主流方案：LLM 决策 + 代码确定性写入，对齐 mem0 / 扣子记忆变量思路）：
 *   1. 对话内抽取（LLM）：每轮把【当前画像 + 本轮对话】交给 LLM，输出结构化操作
 *      JSON（ADD/UPDATE/DELETE + 目标 section + 定位关键词）。默认由统一抽取
 *      一次调用捎带 profileOps（每轮仅 1 次 LLM）；统一抽取关闭时才单独发一次。
 *      LLM 只负责"记什么、放哪、改哪条"，不直接改写画像文件。
 *   2. 确定性落位（纯代码）：applyProfileOps 按 op 精确操作对应 section 的行；
 *      写盘后重读文件 verifyProfileOps 校验每条操作真实生效、落在正确 section，
 *      校验失败打日志（不静默）。
 *
 * 明确不做的事（2026-10-21 架构收敛）：
 *   - 不维护 pending-turns 轮次队列；
 *   - 不在后台做 LLM 整文重写/深度合成——画像只由对话内的结构化事实 upsert 驱动，
 *     后台（夜间 dreaming）只做确定性整理，零 LLM。
 *
 * 安全约束：
 *   - LLM 失败静默降级（画像保持旧版，不影响主链路）；
 *   - 同一 actor 的画像读写经串行链，不会并发覆盖；
 *   - 画像文件保持既定 markdown 结构（基本信息/兴趣与习惯/沟通偏好/备注），
 *     UserPersonalizationService.getPromptSlice 的消费格式不变。
 */

import { readFile } from "node:fs/promises";

import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../config/model-routing.js";
import {
  UserProfileStore,
  isNoisyProfileLine,
  sanitizeProfileMarkdown,
} from "../services/user-personalization/user-profile-store.js";
import {
  parseFieldLine,
  profileFieldOfLabel,
  projectProfileMarkdown,
  reconcileProfileFactsFromStores,
  type ProfileAuthorityDeps,
  type ProfileAuthorityReport,
} from "../services/user-personalization/profile-fact-authority.js";
import { touchProfileLines } from "./profile-lines-meta.js";
import { isMemoryUnifiedExtractEnabled, isProfileExtractHint } from "../agentic-memory/unified-extractor.js";

export interface ProfileAggregatorConfig {
  enabled: boolean;
  /** 每轮 LLM 抽取开关 */
  extractEnabled: boolean;
  /** 抽取 token 闸：仅高信号/个人陈述轮跑抽取（统一抽取关闭时的回退路径） */
  extractPrescreen: boolean;
  /** 每轮抽取使用的模型 */
  extractModel: string;
}

function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

export function loadProfileAggregatorConfig(): ProfileAggregatorConfig {
  // 抽取默认走 MINI 档（默认跟随主模型，MODEL_MINI env 可统一切小模型）
  const miniModel = getModelForTask(TaskTier.MINI) || resolvePrimaryLlmClientConfig()?.model || "gpt-4.1-mini";
  return {
    enabled: envFlag(process.env.MEMORY_PROFILE_AGGREGATOR_ENABLED, true),
    extractEnabled: envFlag(process.env.MEMORY_PROFILE_EXTRACT_ENABLED, true),
    extractPrescreen: envFlag(process.env.MEMORY_PROFILE_EXTRACT_PRESCREEN, true),
    extractModel: process.env.MEMORY_PROFILE_EXTRACT_MODEL?.trim() || miniModel,
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
 * 写入门槛（2026-10-20）：ADD/UPDATE 的 line 先过确定性净噪器（isNoisyProfileLine），
 * 疑问句 / meta 观察 / 临时行程 / 行为频率 / 不确定推断 / 无权威字段（如「常用语言」）
 * 一律丢弃不进盘，落进 skipped（仅观测，不影响 applied 语义）。
 */
export function applyProfileOps(
  profile: string,
  ops: ProfileOp[],
): { profile: string; applied: AppliedOp[]; skipped: string[] } {
  let lines = profile.split("\n");
  const applied: AppliedOp[] = [];
  const skipped: string[] = [];

  for (const op of ops) {
    const cleanLine = (op.line ?? "").trim();
    const cleanMatch = (op.match ?? "").trim();

    if (op.op === "ADD") {
      if (!cleanLine) continue;
      if (isNoisyProfileLine(cleanLine, op.section)) {
        skipped.push(cleanLine);
        continue;
      }
      lines = ensureSection(lines, op.section);
      const bounds = sectionBounds(lines, op.section)!;
      // basic 段字段行按 label 维度去重/升级（2026-10-22）：同一字段只留一行，
      // 值相同 = 幂等跳过插入；值不同 = 原位替换（与权威投影「一字段一行」不变式一致）。
      // 其余 section 维持纯追加（如兴趣多条并存）。
      let handledByLabelDedup = false;
      if (op.section === "basic") {
        const parsed = parseFieldLine(cleanLine);
        if (parsed) {
          const labelPattern = new RegExp(`^[-*+]\\s*${parsed.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[：:]`);
          for (let i = bounds.start; i < bounds.end; i++) {
            if (!labelPattern.test(lines[i]!)) continue;
            handledByLabelDedup = true;
            const existing = lines[i]!.replace(/^[-*+]\s*/, "").trim();
            if (existing !== cleanLine) {
              const next = [...lines];
              next[i] = `- ${cleanLine}`;
              lines = next;
            }
            break;
          }
        }
      }
      if (!handledByLabelDedup) {
        const exists = lines.slice(bounds.start, bounds.end).some((l) => l.trim() === `- ${cleanLine}`);
        if (!exists) {
          lines = insertLineToSection(lines, op.section, cleanLine);
        }
      }
      applied.push({ op, expectLine: cleanLine });
      continue;
    }

    if (op.op === "UPDATE") {
      if (!cleanLine) continue;
      if (isNoisyProfileLine(cleanLine, op.section)) {
        skipped.push(cleanLine);
        continue;
      }
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

  return { profile: lines.join("\n"), applied, skipped };
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
    "12. 身份类字段（职业/公司/学历）只在用户明确自述时写入（如「我是做…的」「我是产品经理」）；从上下文、助手推断、工具调用或行为表现得出的身份一律不写。",
    "13. 禁止写入：疑问句（「我多少事？」「你能记住我多少事？」）；助手（Agent）自身的行为或对用户的观察（如「会主动询问宠物相关信息」「会主动让助手帮忙记事情」）；临时安排与行程（出差/旅行/周末计划、「近期在忙的事」）；行为频率与变化的描述（如「旅游目的频繁切换」「经常更换…」）；不确定推断（可能/大概/也许/似乎）。",
    "14. 主语必须明确：每条要能回答「谁的什么」——主语是用户本人（「用户/我」）或明确属于用户的字段（称呼/所在地/职业…）；禁止主语缺失的观察句。",
    "15. 「常用语言」不是画像字段，不要输出该条目。",
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
 * 对话内抽取 + 确定性落位
 * ────────────────────────────────────────────────────────────── */

export class UserProfileAggregator {
  private readonly store = new UserProfileStore();
  private readonly config: ProfileAggregatorConfig;
  private readonly client: OpenAI | null;

  /** actorId → 画像写操作串行链（抽取/统一抽取落位互不并发覆盖） */
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

  /** 是否实际承担画像事实写入（有 LLM key 且抽取开关开启） */
  get canExtract(): boolean {
    return this.client !== null && this.config.enabled && this.config.extractEnabled;
  }

  /**
   * 每轮 finalizeTurn 收尾时调用（2026-09-29 从 brain-center 阶段3.6.1 迁入：
   * 原位传 cognitive.response 恒空串，画像只见用户半边；finalizeTurn 拿真实全文）。
   *
   * 画像只在对话内写入：统一抽取（每轮那一次 LLM）捎带 profileOps → 确定性落位。
   * 不再维护「待合成轮次队列」，也不在后台做整文 LLM 重写（主流 agent 的画像
   * 都是对话内事实 upsert 驱动，后台只做确定性整理）。
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

    // 条件 LLM 抽取 → 结构化操作确定性写入画像。
    // token 闸：高信号轮或个人陈述预筛命中才跑 MINI 抽取，寒暄轮跳过。
    if (user && this.shouldExtractNow(user, opts?.highSignal === true)) {
      void this.extractAndApply(actorId, user, assistant).catch((err) => {
        // 2026-10-22：失败不再完全静默——「时好时坏」排查第一步是确认抽取跑没跑/败没败
        console.warn(
          `[ProfileAggregator] 画像抽取失败（不影响主链路）actor=${actorId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /**
   * 画像抽取 token 闸（2026-10-21 合并）：
   * - 统一抽取通道启用时，本类不再单独发画像抽取 LLM——画像操作由 ingest 的
   *   同一次统一抽取调用捎带（见 applyProfileOpsFromUnified），每轮只 1 次 LLM；
   * - 统一抽取关闭时回退原行为：正则预筛命中才跑本地抽取。
   */
  private shouldExtractNow(userText: string, highSignal: boolean): boolean {
    if (isMemoryUnifiedExtractEnabled()) return false;
    if (!this.config.extractPrescreen) return true;
    if (highSignal) return true;
    return isProfileExtractHint(userText);
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
        // 回灌防线（2026-10-19）：画像是权威库的**投影**，不是新证据。若画像里
        // 这个值已经是该字段的历史值（旧居住地/旧称呼，权威库有据可查），回灌
        // 等于把旧值写回去——"搬走后又变回原籍"的环流事故。已知历史值一律不写。
        const active = store.getFact?.(actorId, c.field);
        if (active && active.value === c.value) continue; // 已一致，省一次写
        const known = store.getAllValuesForField?.(actorId, c.field) ?? [];
        if (known.includes(c.value)) {
          console.info(
            `[structured-facts] 画像回灌跳过（历史值不回写）actor=${actorId} ` +
              `${c.field}=${c.value}` +
              (active ? `（现状：${active.value}）` : ""),
          );
          continue;
        }
        store.applyFact({
          actorId,
          field: c.field,
          value: c.value,
          sourceRef: "profile-aggregator",
          // 夜间批量提炼的确定性中等：低于对话内直述，但仍足以登记；
          // 低于 0.8 也让置信度闸能挡住它去覆盖用户刚刚确认过的值。
          confidence: 0.7,
          temporal: "current",
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
   * 存量画像净噪（启动时一次性，幂等）：扫描画像目录下所有 actor 的
   * USER_PROFILE.md，用确定性规则清掉历史坏行——疑问句、对助手的 meta 观察、
   * 临时行程、行为频率描述、不确定推断、无权威字段（「常用语言」）、以及
   * 「已有真实事实却仍残留的占位行」。零 LLM、零 token；无变化不写盘。
   * 返回清理过的 actor 数（仅日志用）。
   */
  async sanitizeStoredProfiles(): Promise<number> {
    const actorIds = await this.store.listActorIds();
    let cleaned = 0;
    for (const actorId of actorIds) {
      try {
        let raw: string;
        try {
          raw = await readFile(this.store.profilePath(actorId), "utf8");
        } catch {
          continue; // 目录在但没有画像文件：跳过（不创建）
        }
        const md = raw.trim();
        if (!md) continue;
        const next = sanitizeProfileMarkdown(md);
        if (next === md) continue;
        await this.store.write(actorId, next);
        cleaned++;
      } catch {
        /* 单个 actor 失败不影响其余 */
      }
    }
    if (cleaned > 0) {
      console.info(`[ProfileAggregator] 存量画像净噪完成: ${cleaned} 个 actor 的清噪结果已落盘`);
    }
    return cleaned;
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
          actorId,
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
      return this.applyOpsAndPersist(actorId, currentProfile, ops);
    });
  }

  /**
   * 读取当前画像（供 ingest 的统一抽取捎带画像任务时使用）。
   * 读失败按空画像处理，不阻断记忆主链路。
   */
  async readProfile(actorId: string): Promise<string> {
    try {
      return (await this.store.read(actorId)) ?? "";
    } catch {
      return "";
    }
  }

  /**
   * 消费统一抽取产物里的画像操作（与记忆/承诺/事实同一次 LLM 输出）。
   * 落位路径与 extractAndApply 完全一致：确定性 apply → 权威库回灌 → 投影 → 写后校验。
   */
  async applyProfileOpsFromUnified(actorId: string, ops: ProfileOp[]): Promise<boolean> {
    if (!this.config.enabled || ops.length === 0) return false;
    return this.runSerialized(actorId, async () => {
      const currentProfile = await this.store.read(actorId);
      return this.applyOpsAndPersist(actorId, currentProfile, ops);
    });
  }

  /** 确定性落位 + 权威库回灌 + 写后校验（抽取/统一抽取共用的唯一写入路径） */
  private async applyOpsAndPersist(
    actorId: string,
    currentProfile: string,
    ops: ProfileOp[],
  ): Promise<boolean> {
    const { profile: next, applied, skipped } = applyProfileOps(currentProfile, ops);
    if (skipped.length > 0) {
      console.info(
        `[ProfileAggregator] 画像写入拒绝噪声条目: ${actorId} (${skipped.length} 条: ${skipped.join(" | ")})`,
      );
    }
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
  }
}

/** 工厂：始终返回实例（无 key 时只跳过 LLM 抽取，不影响主链路） */
export function createUserProfileAggregator(): UserProfileAggregator {
  return new UserProfileAggregator();
}
