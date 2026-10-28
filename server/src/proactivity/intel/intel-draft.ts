// 草稿校验（确定性）：判断阶段顺手写好的 draft，只有站得住才直接开口。
//
// 校验不改写措辞，只做两件事：挡住摘要与详情里都找不到的高风险事实（金额、班次、
// 日期、时刻、单号），以及挡住跨天投递后失真的相对时间（「明天」变成今天说）。
// 不合格就退回成稿阶段重写，不放行半真半假的话。
import type { IntelEntry } from "./intel-types.js";

const MAX_DRAFT_CHARS = 300;

/** 错一个就是事故的事实 token：必须在条目自己的内容里能找到出处 */
const FACT_PATTERNS: RegExp[] = [
  /[¥￥$]\s?\d[\d,]*(?:\.\d+)?/g,
  /\d[\d,]*(?:\.\d+)?\s*(?:元|块钱?|万美元|美元|万元|欧元|日元)/g,
  /\b[A-Z]{1,3}\d{2,4}\b/g,
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g,
  /\d{1,2}\s*[:：]\s*\d{2}/g,
  /\d{4,}[-—]?\d{0,}/g,
  /\d+(?:\.\d+)?\s*%/g,
];

/** 只在本条跨天才有害的相对时间词 */
const RELATIVE_DAY_WORDS = ["今天", "今日", "今晚", "明天", "明日", "明早", "明晚", "后天", "昨天", "昨日", "前天"];

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,，]/g, "");
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function extractFacts(draft: string): string[] {
  const out: string[] = [];
  for (const pattern of FACT_PATTERNS) {
    for (const match of draft.matchAll(pattern)) {
      const token = normalize(match[0]);
      if (token) out.push(token);
    }
  }
  return out;
}

/** 草稿里的每个高风险事实都要在目录行/详情/原文里有出处 */
export function isDraftGrounded(draft: string, entry: IntelEntry): boolean {
  const facts = extractFacts(draft);
  if (facts.length === 0) return true;
  const source = normalize(`${entry.brief}\n${entry.detail}\n${entry.raw.title}\n${entry.raw.text}`);
  return facts.every((fact) => source.includes(fact));
}

/** 草稿能不能直接投；不合格时给出一句话原因（写进面板 lastError，便于排查） */
export function checkJudgeDraft(entry: IntelEntry, now: number): { ok: true } | { ok: false; reason: string } {
  const judgment = entry.judgment;
  const draft = judgment?.draft?.trim();
  if (!judgment || judgment.verdict === "never") return { ok: false, reason: "没有可复用的判断草稿" };
  if (!draft) return { ok: false, reason: "判断未给出草稿" };
  if (draft.length > MAX_DRAFT_CHARS) return { ok: false, reason: "草稿超长" };
  if (judgment.judgedAt !== undefined && localDay(judgment.judgedAt) !== localDay(now)) {
    if (RELATIVE_DAY_WORDS.some((word) => draft.includes(word))) {
      return { ok: false, reason: "草稿里的相对日期已过天" };
    }
  }
  if (!isDraftGrounded(draft, entry)) return { ok: false, reason: "草稿含原文没有的数字或班次" };
  return { ok: true };
}
