/**
 * 事实词表统一（Fact Vocabulary）——**标准档案字段的唯一识别器**。
 *
 * 问题（2026-11-13）：同一份用户事实此前有两套词表——
 *   - 对话内统一抽取（unified-extractor）：标准档案字段
 *     称呼 / 职业 / 居住地 / 技术栈 / 生日 / 公司 / 学历；
 *   - 夜间巩固抽取（nightly-memory-task-service）：自由文本 + 行式库自己的
 *     subject（身份 / 居住地 / 职业 / 项目 / 配偶…）。
 * 于是同一条事实两边各有一份、字段名还不一样，召回时口径分裂——
 * 「记忆准确」无从谈起（用户问「我住哪」，两套答案可能不一致）。
 *
 * 收敛后的规矩：
 *   1. 标准档案字段以 structured-fact-store 的 PROFILE_FIELDS 为准，
 *      本模块只负责「从一段自由文本里认出它是不是档案字段、值是什么」；
 *   2. 夜间抽到档案字段类事实 → 落**权威库**（structured_facts），
 *      不再另存一份到行式 JSON 库；
 *   3. 认不准就返回 null——宁可留在长尾事实库，也不要把猜错的值写进权威库。
 */

import { canonicalFactField, isProfileField } from "../agentic-memory/structured-fact-store.js";

export interface DetectedProfileFact {
  /** 标准档案字段（已归一） */
  field: string;
  /** 短值（无主语） */
  value: string;
}

/** 值的长度上限（技术栈可以长一点） */
const MAX_VALUE_LEN = 20;

/** 明显不是值的词（句子残片 / 带主语） */
const VALUE_REJECT_RE = /^(?:我|我的|本人|用户)/;
const VALUE_JUNK_RE = /(?:是|的|了|呢|吧|吗|在|和|与|或)/;

/** 字段 → 文本模式（保守：只认明确线索词，认不准就不认） */
const FIELD_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // 姓名：用户全名/姓名/名字是王铭川；用户叫王铭川；我就叫王铭川
  ["姓名", /(?:用户|我|本人)的?(?:全名|姓名|名字)(?:是|为|叫|叫是)?\s*[「『"']?([^「」『』"'，。；！？,.;!?\s]{1,12})/],
  ["姓名", /(?:用户|我|本人)(?:就)?(?:名叫|全名叫|真名叫|叫)\s*[「『"']?([^「」『』"'，。；！？,.;!?\s]{1,12})/],
  // 称呼：用户希望被称作「王哥」/ 用户称呼是王哥 / 用户昵称是…
  ["称呼", /(?:用户|我|本人)的?(?:称呼|昵称|外号|花名)(?:是|为)\s*[「『"']?([^「」『』"'，。；！？,.;!?\s]{1,12})/],
  ["称呼", /(?:希望|可以|请)?(?:被)?(?:称作|称为|称呼为|叫我)\s*[「『"']?([^「」『』"'，。；！？,.;!?\s]{1,12})/],
  // 年龄：用户年龄是20岁 / 我今年20岁
  ["年龄", /(?:用户|我|本人)的?(?:年龄|岁数|年纪)(?:是|为)?\s*([0-9]{1,3}\s*岁?)/],
  ["年龄", /(?:用户|我|本人)(?:今年|现在)?\s*([0-9]{1,3})\s*岁/],
  // 居住地：用户住在兴义 / 用户所在地是兴义
  ["居住地", /(?:用户)?(?:现在)?(?:住在|定居在|定居于)\s*([^「」『』"'，。；！？,.;!?\s]{2,12})/],
  ["居住地", /(?:用户的?)?(?:所在地|所在地|居住地)(?:是|为)\s*([^「」『』"'，。；！？,.;!?\s]{2,12})/],
  // 职业：用户的职业是后端开发
  ["职业", /(?:用户的?)?(?:职业|工作|职位)(?:是|为)\s*([^「」『』"'，。；！？,.;!?\s]{2,12})/],
  // 技术栈：用户的技术栈是TS和Python
  ["技术栈", /(?:用户的?)?(?:技术栈|编程语言|技术方向)(?:是|为)\s*([^「」『』"'，。；！？,.;!?\s]{2,20})/],
  // 生日：用户的生日是3月5日
  ["生日", /(?:用户的?)?(?:生日|出生日期)(?:是|为|在)?\s*([^「」『』"'，。；！？,.;!?\s]{2,16})/],
  // 公司：用户在兴义XX公司
  ["公司", /(?:用户)?(?:在|就职于|任职于|供职于)\s*([^「」『』"'，。；！？,.;!?\s]{2,16}?(?:公司|集团|科技|银行|医院|事务所|工作室))/],
  // 学历：用户的学历是本科 / 用户毕业于贵州大学
  ["学历", /(?:用户的?)?学历(?:是|为)\s*([^「」『』"'，。；！？,.;!?\s]{2,16})/],
  ["学历", /用户毕业于\s*([^「」『』"'，。；！？,.;!?\s]{2,16})/],
];

/** 值是否可用（够短、无主语、不是句子残片） */
export function isUsableProfileValue(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX_VALUE_LEN) return false;
  if (VALUE_REJECT_RE.test(v)) return false;
  if (VALUE_JUNK_RE.test(v)) return false;
  return true;
}

/**
 * 从自由文本里识别标准档案字段与短值。
 *
 * 识别不出来返回 null（调用方据此保留在长尾事实库）。
 * 两种输入形态都支持：
 *   1. 「字段：值」——如「职业：后端开发」「居住地：兴义」（提示词里的规范写法）；
 *   2. 自然句——如「用户住在兴义」「用户希望被称作「王哥」」。
 */
export function detectProfileFieldFromText(text: string): DetectedProfileFact | null {
  const raw = text?.trim();
  if (!raw) return null;

  // 形态 1：字段：值
  const colon = /^(?:用户)?\s*([^：:]{1,10})\s*[：:]\s*(.+)$/.exec(raw);
  if (colon) {
    const field = canonicalFactField(colon[1]!);
    const value = colon[2]!.trim().replace(/^[「『"']|[」』"']$/g, "").trim();
    if (isProfileField(field) && isUsableProfileValue(value)) {
      return { field, value };
    }
  }

  // 形态 2：自然句
  for (const [field, re] of FIELD_PATTERNS) {
    const m = re.exec(raw);
    const value = m?.[1]?.trim().replace(/^[「『"']|[」』"']$/g, "").trim();
    if (!value) continue;
    if (!isUsableProfileValue(value)) continue;
    if (!isProfileField(field)) continue;
    return { field, value };
  }
  return null;
}

/**
 * 校验一份「模型给的字段 + 值」是否可用（夜间抽取用）。
 *
 * 字段必须能归一到标准档案字段，值必须像短值——两头都过才落权威库。
 */
export function normalizeDetectedProfileFact(
  field: unknown,
  value: unknown,
): DetectedProfileFact | null {
  if (typeof field !== "string" || typeof value !== "string") return null;
  const canonical = canonicalFactField(field.trim());
  if (!isProfileField(canonical)) return null;
  const v = value.trim().replace(/^[「『"']|[」』"']$/g, "").trim();
  if (!isUsableProfileValue(v)) return null;
  return { field: canonical, value: v };
}
