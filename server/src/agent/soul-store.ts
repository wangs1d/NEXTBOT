/**
 * 人格正文（soul-store，单一人格出口）。
 *
 * 两层：
 *   - 冻结层 = 仓库文档 agent/SOUL.md（唯一来源，人工编辑，本模块只读不写）。
 *     路径优先级 AGENT_SOUL_PATH → <服务根>/agent/SOUL.md（装机随包）→
 *     <服务根>/../agent/SOUL.md（开发态与云端仓库布局）。
 *   - 演化层 = <数据根>/profile/soul/disposition.md，`- 键: 值` 行，周级反思受控更新；
 *     changelog.md 记每次 patch（日期 + 变更 + 首条证据）。
 *
 * 出口只有一个：buildPersonaPrompt() 产出单个【人格】块，经 memory.persona 注入稳定层。
 * 除此之外不存在第二个人格源——不写 KV，不走 soul 播种，没有程序生成的规则行。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../config/model-routing.js";
import { getDataDir } from "../config/data-dir.js";
import { serverRoot } from "../config/paths.js";
import { auditChatCompletion } from "../services/llm-token-audit.js";

const DISPOSITION_FILE = "disposition.md";
const CHANGELOG_FILE = "changelog.md";

const DISPOSITION_SEED = `# 处事层（随互动演化，周级反思受控更新）

- 默契度: 刚认识，还不知道你的雷区在哪
- 玩笑尺度: 正常
- 共同梗: 还没有，处出来说不定就有了`;

const DISPOSITION_HEADER = "# 处事层（随互动演化，周级反思受控更新）";

function soulDir(): string {
  return join(getDataDir(), "profile", "soul");
}

function resolveSoulDocPath(): string | null {
  const candidates = [
    process.env.AGENT_SOUL_PATH?.trim(),
    join(serverRoot(), "agent", "SOUL.md"),
    join(serverRoot(), "..", "agent", "SOUL.md"),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function ensureSeed(): void {
  const dir = soulDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dispositionPath = join(dir, DISPOSITION_FILE);
  if (!existsSync(dispositionPath)) writeFileSync(dispositionPath, DISPOSITION_SEED, "utf8");
}

/** 处事层条目：`- 键: 值` 行（≤12 字键） */
export type DispositionEntry = { key: string; value: string };

function parseDisposition(raw: string): DispositionEntry[] {
  const out: DispositionEntry[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^- ([^：:]{1,12})[：:]\s*(.+?)\s*$/);
    if (m) out.push({ key: m[1]!.trim(), value: m[2]!.trim() });
  }
  return out;
}

function renderDisposition(entries: DispositionEntry[]): string {
  return entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
}

/** 文档正文即人格措辞：剥掉 markdown 标题标记，只留句子。 */
function soulProse(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !/^#/.test(l) && !/^---$/.test(l))
    .join("\n");
}

// 演化层进 prompt 的量：块是每轮固定开销，只取最近几条、每条一句。
const PROMPT_DISPOSITION_MAX_ENTRIES = 4;
const PROMPT_DISPOSITION_MAX_VALUE_CHARS = 40;
const CUT_BOUNDARY_RE = /[。！？；：，、\s]/;

/** 在 max 内回退到最后一个标点处截断；截不出一个像样的分句就整条丢掉（宁缺毋半句）。 */
function truncateAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const window = value.slice(0, max);
  for (let i = window.length - 1; i >= 8; i--) {
    if (!CUT_BOUNDARY_RE.test(window[i]!)) continue;
    let cut = window.slice(0, i + 1).replace(/[，、,：:；;\s]+$/, "");
    // 括号没闭合就退回括号之前：半截括号的残句最容易被模型照着复读
    const open = Math.max(cut.lastIndexOf("（"), cut.lastIndexOf("("));
    if (open >= 0 && !cut.slice(open).includes("）") && !cut.slice(open).includes(")")) {
      cut = cut.slice(0, open).replace(/[，、,：:；;\s]+$/, "");
    }
    return cut.length >= 8 ? cut : "";
  }
  return "";
}

export type PersonaPromptInput = {
  /** 用户指定的称呼（学到的画像事实），缺省不写称呼行 */
  userAlias?: string;
  /** 名字自我认知行（agent-identity.buildIdentityNameLine），缺省不写 */
  identityLine?: string;
};

let personaCache: { key: string; text: string } | null = null;

/**
 * 唯一的【人格】块：名字自我认知 + 冻结层正文 + 称呼行 + 演化层几条默契。
 * 全空返回空串（零注入）。mtime 为缓存键，文件一动即重算。
 */
export function buildPersonaPrompt(input: PersonaPromptInput = {}): string {
  const soulPath = resolveSoulDocPath();
  let soulStamp = 0;
  let dispositionStamp = 0;
  try {
    ensureSeed();
    if (soulPath) soulStamp = statSync(soulPath).mtimeMs;
    dispositionStamp = statSync(join(soulDir(), DISPOSITION_FILE)).mtimeMs;
  } catch {
    return "";
  }
  const alias = input.userAlias?.trim() ?? "";
  const identityLine = input.identityLine?.trim() ?? "";
  const cacheKey = `${soulStamp}|${dispositionStamp}|${alias}|${identityLine}`;
  if (personaCache?.key === cacheKey) return personaCache.text;

  const sections: string[] = [];
  if (identityLine) sections.push(identityLine);
  if (soulPath) {
    try {
      const prose = soulProse(readFileSync(soulPath, "utf8"));
      if (prose) sections.push(prose);
    } catch {
      /* 文档读失败按无冻结层处理 */
    }
  }
  if (alias) sections.push(`对方是你的用户，称呼「${alias}」。`);
  try {
    const entries = parseDisposition(readFileSync(join(soulDir(), DISPOSITION_FILE), "utf8"))
      .map((e) => ({ key: e.key, value: truncateAtBoundary(e.value, PROMPT_DISPOSITION_MAX_VALUE_CHARS) }))
      .filter((e) => e.value)
      .slice(0, PROMPT_DISPOSITION_MAX_ENTRIES);
    if (entries.length > 0) {
      sections.push(
        `处出来的默契（自然内化，别复述这几行）：\n${renderDisposition(entries)}`,
      );
    }
  } catch {
    /* 演化层读失败只剩冻结层 */
  }

  const text = sections.length > 0 ? `【人格】\n${sections.join("\n\n")}` : "";
  personaCache = { key: cacheKey, text };
  return text;
}

// ── 周级反思 + drift guard ────────────────────────────────────────────

const REFLECTION_INTERVAL_DAYS = 7;
const MAX_UPDATES = 6;
const MAX_REMOVALS = 2;
const MAX_ENTRIES = 12;
const MAX_KEY_LEN = 12;
const MAX_VALUE_LEN = 60;
const MAX_TRANSCRIPT_CHARS = 4000;

function readChangelogLastDate(): string | null {
  try {
    const raw = readFileSync(join(soulDir(), CHANGELOG_FILE), "utf8").trim();
    const last = raw.split("\n").filter(Boolean).pop() ?? "";
    return /^- (\d{4}-\d{2}-\d{2})/.exec(last)?.[1] ?? null;
  } catch {
    return null;
  }
}

function daysSince(dateStr: string, now: Date): number {
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return Infinity;
  return (now.getTime() - ts) / 86_400_000;
}

/**
 * 周级反思：transcript（近期对话流水）→ LLM patch → drift guard → 落盘。
 * 门禁不过 / LLM 缺失 / 解析失败一律静默跳过（返回 reason），绝不阻塞夜间任务。
 * 冻结层只读——反思流程永不触碰 SOUL.md。
 */
export async function maybeRunSoulReflection(input: {
  transcript: string;
  now?: Date;
}): Promise<{ applied: boolean; reason: string }> {
  const now = input.now ?? new Date();
  const lastDate = readChangelogLastDate();
  if (lastDate && daysSince(lastDate, now) < REFLECTION_INTERVAL_DAYS) {
    return { applied: false, reason: "cooldown" };
  }
  const llm = resolvePrimaryLlmClientConfig();
  if (!llm || !input.transcript?.trim()) return { applied: false, reason: "no-llm-or-transcript" };

  ensureSeed();
  const dir = soulDir();
  const dispositionRaw = readFileSync(join(dir, DISPOSITION_FILE), "utf8");
  const current = parseDisposition(dispositionRaw);

  const system = [
    "你是 NEXTBOT 的自我梳理（周级反思）。依据本周对话，对「处事层」做渐进演化。",
    "规则：",
    "- 只能改处事层条目（默契度/玩笑尺度/共同梗等），也可新增条目（如 新雷区/最近话题）",
    "- 每条更新必须附对话证据（引用原话片段）；证据不足就别动",
    "- 幅度宁小勿大：一次最多 6 条更新、2 条移除",
    "- 一条值写一个完整短句，别堆细节清单（这些行会进每轮 prompt，长了就是复读机）",
    `只输出 JSON：{"updates":[{"key":"条目名","value":"新值","evidence":"对话原话片段"}],"removals":["条目名"]}`,
    "没有值得改的就输出空数组。",
  ].join("\n");
  const user = [
    "当前处事层：",
    renderDisposition(current),
    "",
    `本周对话（节选）：\n${input.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
  ].join("\n");

  const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, maxRetries: 1 });
  try {
    const response = await openai.chat.completions.create({
      model: getModelForTask(TaskTier.MINI),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...bypassChatRequestExtras(),
    });
    auditChatCompletion({
      stage: "soul_store",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      completion: response,
      model: getModelForTask(TaskTier.MINI),
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return { applied: false, reason: "empty-response" };
    const patch = JSON.parse(content) as {
      updates?: Array<{ key?: unknown; value?: unknown; evidence?: unknown }>;
      removals?: unknown[];
    };

    // ── drift guard（代码硬门禁，不信任模型）──
    const updates: Array<{ key: string; value: string; evidence: string }> = [];
    for (const u of patch.updates ?? []) {
      if (updates.length >= MAX_UPDATES) break;
      const key = typeof u.key === "string" ? u.key.trim().slice(0, MAX_KEY_LEN) : "";
      const value =
        typeof u.value === "string" ? truncateAtBoundary(u.value.trim(), MAX_VALUE_LEN) : "";
      const evidence = typeof u.evidence === "string" ? u.evidence.trim() : "";
      if (!key || !value || evidence.length < 6) continue;
      updates.push({ key, value, evidence });
    }
    const removals: string[] = [];
    for (const r of patch.removals ?? []) {
      if (removals.length >= MAX_REMOVALS) break;
      if (typeof r === "string" && r.trim()) removals.push(r.trim().slice(0, MAX_KEY_LEN));
    }
    if (updates.length === 0 && removals.length === 0) {
      return { applied: false, reason: "empty-patch" };
    }

    // 应用 patch（键去重：updates 后写覆盖先写；总量超限截断）
    const byKey = new Map(current.map((e) => [e.key, e.value]));
    for (const u of updates) byKey.set(u.key, u.value);
    for (const k of removals) byKey.delete(k);
    const next: DispositionEntry[] = [...byKey]
      .slice(0, MAX_ENTRIES)
      .map(([key, value]) => ({ key, value }));

    writeFileSync(join(dir, DISPOSITION_FILE), `${DISPOSITION_HEADER}\n\n${renderDisposition(next)}\n`, "utf8");

    const day = now.toISOString().slice(0, 10);
    const summary = [
      `更新:${updates.map((u) => u.key).join("、") || "无"}`,
      `移除:${removals.join("、") || "无"}`,
      updates[0] ? `证据:「${updates[0]!.evidence.slice(0, 60)}」` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    const changelogPath = join(dir, CHANGELOG_FILE);
    const prevLog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# 演化日志\n";
    writeFileSync(changelogPath, `${prevLog.trimEnd()}\n- ${day} ${summary}\n`, "utf8");
    return { applied: true, reason: `updated=${updates.length} removed=${removals.length}` };
  } catch (err) {
    console.log(`[soul-store] 反思失败（静默跳过）: ${err instanceof Error ? err.message : err}`);
    return { applied: false, reason: "error" };
  }
}
