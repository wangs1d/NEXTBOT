/**
 * 灵魂文件库（soul-store，2026-10-13 架构方案最小落地）。
 *
 * 分层人格（ACL 2026 L/M/S 思路）：
 *   - identity.md    冻结层：身份/使命/底线。本模块只读不写——仅用户显式决策
 *                    可修改（编辑文件本身），任何反思/演化流程不得触碰。
 *   - disposition.md 演化层：与用户的默契/习惯/时效关注，周级反思受控演化。
 *                    格式为 key: value 行（`- 键: 值`），机器与人工皆可编辑。
 *   - changelog.md   演化审计：每次 patch 追加一行（日期 + 变更 + 首条证据）。
 *
 * voice（few-shot 语感基准）由既有 voice-baseline 机制承担，此处不重复。
 *
 * 注入：getSoulOverlay() 产出稳定层文本，经 buildPersonaStaticBlock 的
 * soulOverlay 参数并入【人格·静态】（mtime 缓存，会话内字节稳定，前缀缓存友好）。
 *
 * 演化：maybeRunSoulReflection() 周级门禁（changelog 最近一条 ≥7 天才跑），
 * 一次 LLM 产出结构化 patch，drift guard 硬门禁后落盘。模型自身人格漂移
 * 方向不可控（BFI-Adapt 结论），故演化必须走显式文件 diff，不靠 prompt 内隐。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import OpenAI from "openai";

import {
  resolvePrimaryLlmClientConfig,
  bypassChatRequestExtras,
} from "../external-model/resolve-provider.js";
import { getModelForTask, TaskTier } from "../config/model-routing.js";
import { auditChatCompletion } from "../services/llm-token-audit.js";

function soulDir(): string {
  const base = process.env.PA_DATA_DIR?.trim() || "data";
  return join(base, "profile", "soul");
}

const IDENTITY_FILE = "identity.md";
const DISPOSITION_FILE = "disposition.md";
const CHANGELOG_FILE = "changelog.md";

const IDENTITY_SEED = `# 身份（冻结层）

我是 NEXTBOT，一个球形小机器人——黑的壳，亮的芯。
使命：做你的私人管家兼搭档，事办得成、话接得住。
底线：安全/金钱/健康/法律话题严肃办；不装懂，拿不准就说拿不准；自己的锅自己认。
人格可以随相处慢慢变，但这一页不动。
（本文件仅用户显式决策可修改，反思/演化流程不得改写。）`;

const DISPOSITION_SEED = `# 处事层（随互动演化，周级反思受控更新）

- 默契度: 刚认识，还不知道你的雷区在哪
- 玩笑尺度: 正常
- 共同梗: 还没有，处出来说不定就有了`;

const DISPOSITION_HEADER = "# 处事层（随互动演化，周级反思受控更新）";

function ensureSeed(): void {
  const dir = soulDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const identityPath = join(dir, IDENTITY_FILE);
  if (!existsSync(identityPath)) writeFileSync(identityPath, IDENTITY_SEED, "utf8");
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

/** 灵魂稳定层文本（identity + disposition；全空返回 null 零注入）。mtime 缓存。 */
let overlayCache: { identityMs: number; dispositionMs: number; text: string | null } | null = null;

export function getSoulOverlay(): string | null {
  try {
    ensureSeed();
    const dir = soulDir();
    const identityPath = join(dir, IDENTITY_FILE);
    const dispositionPath = join(dir, DISPOSITION_FILE);
    const identityMs = statSync(identityPath).mtimeMs;
    const dispositionMs = statSync(dispositionPath).mtimeMs;
    if (overlayCache && overlayCache.identityMs === identityMs && overlayCache.dispositionMs === dispositionMs) {
      return overlayCache.text;
    }
    const identity = readFileSync(identityPath, "utf8").trim();
    const disposition = renderDisposition(parseDisposition(readFileSync(dispositionPath, "utf8")));
    const sections: string[] = [];
    if (identity) sections.push(`【灵魂·身份】\n${identity}`);
    if (disposition) sections.push(`【灵魂·处事】\n（与这位用户相处沉淀的默契，自然内化用）\n${disposition}`);
    const text = sections.length > 0 ? sections.join("\n\n") : null;
    overlayCache = { identityMs, dispositionMs, text };
    return text;
  } catch {
    return null;
  }
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
 * 周级灵魂反思：transcript（近期对话流水）→ LLM patch → drift guard → 落盘。
 * 门禁不过 / LLM 缺失 / 解析失败一律静默跳过（返回 reason），绝不阻塞夜间任务。
 */
export async function maybeRunSoulReflection(input: {
  transcript: string;
  now?: Date;
}): Promise<{ applied: boolean; reason: string }> {
  const now = input.now ?? new Date();
  // 周级门禁：changelog 最近一条不足 7 天 → 跳过（每次夜间至多一次 LLM 调用）
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
      const value = typeof u.value === "string" ? u.value.trim().slice(0, MAX_VALUE_LEN) : "";
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
