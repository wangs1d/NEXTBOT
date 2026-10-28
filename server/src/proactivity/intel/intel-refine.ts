// 确定性提炼：把原文压成「目录行 + 详情」两段，不额外花一次模型调用。
//
// 目录行给判断看（一行、去噪、带发件人与主题），详情留在面板里，等判定要开口
// 才交给成稿模型。结构化信源（邮件）用标题+首句已足够判断；正文里的引用历史、
// 退订尾巴、页脚这类不帮助判断的内容在提炼时就被削掉。

const DETAIL_MAX = 4000;
const BRIEF_MAX = 140;

/** 引用历史/签名分隔线的起点（从这里往后的内容基本是重复或噪音） */
const QUOTE_BOUNDARY =
  /^(?:-{2,}\s*(?:原始邮件|original message|forwarded message|转发的邮件)\s*-{2,}|在\s*.{0,40}\s*写道[:：]|on\s.+wrote:|>{1,}|发件人[:：]\s|from:\s|sent:\s|退订|取消订阅|unsubscribe)/i;

const GREETING = /^(?:你好|您好|hi|hello|亲爱的用户|尊敬的客户)[，,、:：\s]*/i;

function normalize(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
}

/** 去掉引用历史与页脚：只保留第一段有效正文 */
export function stripQuotedAndFooter(text: string): string {
  const normalized = normalize(text);
  const lines = normalized.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (QUOTE_BOUNDARY.test(t)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** 首句（按中英文句末切），跳过纯问候开头 */
function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(GREETING, "");
  if (!clean) return "";
  const match = clean.match(/^.{6,120}?(?:[。！？!?]|\.(?:\s|$))/);
  return (match ? match[0] : clean).replace(/[。！？!?.\s]+$/, "").trim();
}

/** 目录行：主题 + 首句，压成一行；主题已含关键信息时不重复 */
export function extractBrief(title: string, text: string): string {
  const cleanTitle = title.replace(/^(?:re|fw|fwd|回复|转发)[:：]\s*/gi, "").replace(/\s+/g, " ").trim();
  const body = stripQuotedAndFooter(text).replace(/\s+/g, " ").trim();
  const sentence = firstSentence(body);
  const parts: string[] = [];
  if (cleanTitle) parts.push(cleanTitle);
  if (sentence && !cleanTitle.includes(sentence) && !sentence.includes(cleanTitle.slice(0, 20))) {
    parts.push(sentence);
  }
  const line = parts.join("｜").trim();
  if (line.length <= BRIEF_MAX) return line || cleanTitle || body.slice(0, BRIEF_MAX);
  return `${line.slice(0, BRIEF_MAX - 1)}…`;
}

/** 详情：主题 + 发件人/时间 + 去噪正文（截断到 4000 字） */
export function extractDetail(input: {
  title: string;
  text: string;
  from?: string;
  date?: string;
  source: string;
}): string {
  const header: string[] = [];
  if (input.title) header.push(`主题：${input.title}`);
  if (input.from) header.push(`来自：${input.from}`);
  if (input.date) header.push(`时间：${input.date}`);
  const body = stripQuotedAndFooter(input.text);
  const merged = [header.join("\n"), body].filter(Boolean).join("\n\n").trim();
  return merged.length > DETAIL_MAX ? `${merged.slice(0, DETAIL_MAX - 1)}…` : merged;
}
