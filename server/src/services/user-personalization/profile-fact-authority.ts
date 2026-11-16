/**
 * 档案字段单一权威源（Profile Fact Authority）
 *
 * 背景（2026-10-09 收敛）：同一份用户档案字段（称呼/职业/居住地/技术栈/生日/
 * 公司/学历）此前同时落在 5~7 个地方，各自独立写入、各自覆盖，谁改都可能漏
 * 其它几处 —— 典型症状是「以后叫我王哥」之后界面仍显示旧称呼。收敛后的规矩：
 *
 *   权威源 = structured_facts（StructuredFactStore，字段级 + supersede 演变链）
 *   USER_PROFILE.md「基本信息」的字段行 = 权威值的**投影**（本文件负责重渲染）
 *   KV 槽位（memory_facts / memory_preferences）= 不再保存档案字段的副本
 *   （权威块已单独注入 prompt，重复保存既是 token 浪费也是漂移来源）
 *
 * 本模块只做**确定性字符串变换**（纯函数），不碰 IO —— 编排见
 * reconcileProfileFactsFromStores；这样投影规则可被单测完全覆盖。
 */

import {
  PROFILE_FIELDS,
  canonicalFactField,
} from "../../agentic-memory/structured-fact-store.js";

/** 投影用最小事实外观（StructuredFact 的子集） */
export interface CanonicalFieldFact {
  field: string;
  value: string;
}

/** markdown 里的一个「字段：值」行 */
export interface ParsedFieldLine {
  label: string;
  value: string;
}

/**
 * 字段标签归一：把「用户称呼 / 我的称呼 / 称呼 / 职业相关 / 职业」这类写法
 * 收敛到标准档案字段；不是档案字段返回 ""（如「常用语言」「回复偏好」）。
 */
export function profileFieldOfLabel(label: string): string {
  const raw = label.trim();
  if (!raw) return "";
  if (PROFILE_FIELDS.includes(canonicalFactField(raw))) return canonicalFactField(raw);
  // 去常见前后缀再试：用户称呼→称呼、职业相关→职业、居住地（城市）→居住地
  const stripped = raw
    .replace(/^(?:用户|我的|我|本人|当前)/, "")
    .replace(/(?:相关|信息|情况|是|的)$/, "")
    .replace(/[（(].*?[)）]/g, "")
    .trim();
  const c2 = canonicalFactField(stripped);
  if (PROFILE_FIELDS.includes(c2)) return c2;
  // 前缀包含：职业相关 / 称呼与礼仪 → 取首个匹配的标准字段
  for (const f of PROFILE_FIELDS) {
    if (raw.startsWith(f) || (stripped && stripped.startsWith(f))) return f;
  }
  return "";
}

/** 解析「- 称呼：王哥」为 { label, value }；非「字段：值」行返回 null */
export function parseFieldLine(line: string): ParsedFieldLine | null {
  const body = line.replace(/^\s*[-*+]\s*/, "").trim();
  if (!body) return null;
  const m = /^([^：:]{1,16})[：:]\s*(.+)$/.exec(body);
  if (!m) return null;
  return { label: m[1]!.trim(), value: m[2]!.trim() };
}

/** 权威渲染：档案字段行（markdown 列表项） */
export function renderCanonicalLine(fact: CanonicalFieldFact): string {
  return `- ${fact.field}：${fact.value}`;
}

/** 取「权威字段 → 值」映射（同字段重复时首个生效） */
export function canonicalFieldMap(
  facts: readonly CanonicalFieldFact[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of facts) {
    const field = canonicalFactField(f.field);
    const value = f.value?.trim();
    if (!field || !value || !PROFILE_FIELDS.includes(field)) continue;
    if (!map.has(field)) map.set(field, value);
  }
  return map;
}

function stripListPrefix(line: string): string {
  return line.replace(/^\s*[-*+]\s*/, "");
}

/**
 * USER_PROFILE.md 投影：把「基本信息」section 内的档案字段行替换为权威值。
 *
 * - 同一字段的多个别名行（称呼 / 用户称呼）合并成**一行**权威行；
 * - 行内历史注解（「称呼：王哥；也曾使用"王king"」）被清掉——演变链归权威库；
 * - 插入位置沿用该 section 内首个被替换行的位置，保持已有行序；
 * - 权威库没有的字段（无 fact）保持原样，不擅自删用户可见内容；
 * - facts 为空 → 原样返回（零注入）。
 */
export function projectProfileMarkdown(
  md: string,
  facts: readonly CanonicalFieldFact[],
): string {
  const canon = canonicalFieldMap(facts);
  if (canon.size === 0) return md;

  const lines = md.split("\n");
  const bounds = sectionBounds(lines, "基本信息");
  if (!bounds) return md;
  const { start, end } = bounds;

  const kept: string[] = [];
  let insertAt = -1;
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const parsed = parseFieldLine(line);
    const field = parsed ? profileFieldOfLabel(parsed.label) : "";
    if (field && canon.has(field)) {
      if (insertAt < 0) insertAt = kept.length;
      continue; // 该字段行由权威投影替代
    }
    kept.push(line);
  }
  if (insertAt < 0) insertAt = 0;

  // 稳定顺序：按标准字段表顺序渲染（称呼 → 职业 → 居住地 …）
  const authoritative = PROFILE_FIELDS.filter((f) => canon.has(f)).map((f) =>
    renderCanonicalLine({ field: f, value: canon.get(f)! }),
  );

  const rebuilt = [...kept.slice(0, insertAt), ...authoritative, ...kept.slice(insertAt)];
  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)].join("\n");
}

/** 定位 markdown `## 标题` section 的内容行区间 [start, end) */
export function sectionBounds(
  lines: readonly string[],
  title: string,
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === `## ${title}` || t === `## ${title} ` || t.startsWith(`## ${title}`)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * 每个档案字段的「显式线索词」——仅当一行**明确**在陈述该字段时才判定为副本。
 * 刻意不收「工作」「家」「城市」这类泛词：`工作节奏偏忙…` 是自由习惯描述，
 * 不是「职业」字段的副本，误删会丢真信息。
 */
const FIELD_CUES: Readonly<Record<string, readonly string[]>> = {
  称呼: ["称呼", "名字", "姓名", "昵称", "叫我", "全名", "名儿"],
  职业: ["职业", "职位", "岗位", "职务", "行业"],
  居住地: ["居住地", "住在", "定居", "所在地", "坐标"],
  技术栈: ["技术栈", "编程语言", "技术方向"],
  生日: ["生日", "出生日期"],
  公司: ["公司", "雇主", "任职单位"],
  学历: ["学历", "毕业院校"],
};

const COPY_LINE_MAX_CHARS = 60;

/** 「我是 X / 我叫 X / 叫我 X」式自称——用于按“值”识别陈旧称呼副本 */
const SELF_CLAIM_RE = /^(?:我(?:是|叫|名字叫)|叫我)/;

/**
 * 判断一条 KV 记忆行是否为某个「已有权威值」的档案字段副本。
 * 两条判据（取或）：
 *   1) 行内出现该字段的显式线索词，且行足够短（是短断言而非长段落）；
 *   2) 行是「我是X/我叫X」式自称，且 X 命中了该字段的**已知值**（含历史值）——
 *      这条专门治「改了称呼后别处还留着旧值」（"我是王king"）。
 */
export function isProfileFieldCopyLine(
  line: string,
  fields: ReadonlySet<string>,
  knownValues?: ReadonlyMap<string, readonly string[]>,
): boolean {
  const text = stripListPrefix(line).replace(/^\[[^\]]+\]\s*(\[[^\]]+\]\s*)?/, "").trim();
  if (!text || text.length > COPY_LINE_MAX_CHARS) return false;
  const parsed = parseFieldLine(text);
  if (parsed) {
    const f = profileFieldOfLabel(parsed.label);
    if (f && fields.has(f)) return true;
  }
  for (const field of fields) {
    const cues = FIELD_CUES[field];
    if (cues?.some((cue) => text.includes(cue))) return true;
  }
  if (SELF_CLAIM_RE.test(text) && knownValues) {
    for (const field of fields) {
      for (const value of knownValues.get(field) ?? []) {
        if (value.length >= 2 && text.includes(value)) return true;
      }
    }
  }
  return false;
}

/**
 * 解析**已渲染**的结构化事实块 → 字段 → 当前值。
 *
 * 只认「当前值」形态的行：`- 字段：值（登记时间…）`。
 *   - 〔历史〕/〔计划〕/〔原计划〕形态的行**不算**当前值——那不是现状，
 *     画像里的对应行不能因此被当成副本删掉（否则「以前住杭州」会被误伤）；
 *   - 值取第一个全角括号之前的内容（「此前」注解、登记时间都在括号里）。
 *
 * 这份映射是「画像里的行是不是重复」的**唯一判据**：只有当另一块确实渲染
 * 了这个字段，才允许把画像里的同一字段行剔除。判据缺失 → 一律保留。
 */
export function parseRenderedFactBlock(
  renderedBlock: string | undefined | null,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!renderedBlock) return map;
  for (const raw of renderedBlock.split("\n")) {
    const parsed = parseFieldLine(raw);
    if (!parsed) continue;
    const field = profileFieldOfLabel(parsed.label);
    if (!field || map.has(field)) continue;
    const rest = parsed.value.trim();
    if (!rest || rest.startsWith("〔")) continue; // 〔历史〕/〔计划〕不是现状
    const value = rest.split("（")[0]!.trim();
    if (!value) continue;
    map.set(field, value);
  }
  return map;
}

/**
 * 剔除画像正文里的档案字段副本行（prompt 渲染层专用，纯函数）。
 *
 * USER_PROFILE.md 的「字段：值」行是 structured_facts 的**投影**。当档案
 * 字段块（【用户档案·结构化事实】）已经渲染了同一个字段时，画像里的那一行
 * 就是同一份数据的第二次渲染——「王哥」在三处重复就是这么来的。
 *
 * 剔除判据（2026-11-13 收紧，回应「称呼：王哥 剔掉了」的质疑）：
 *   1. **必须确认另一块真的渲染了这个字段**（parseRenderedFactBlock 有它）。
 *      没渲染 → 画像行保留。这条是防丢信息的底线：结构化块每轮按需注入，
 *      字段数超限时会被截断，若只看「本轮白名单」就删画像行，那个字段会
 *      在本轮**彻底消失**（称呼就是这么丢过一次）。
 *   2. 确认渲染后：值逐字相同 → 纯副本，剔；值不同 → 画像是陈旧副本，
 *      权威块带的是当前值，剔掉陈旧行（否则同一字段两个值进 prompt，
 *      模型可能喊错称呼）。
 *
 * 兜底：没有任何字段被确认渲染时，一个字都不删（宁可重复，不可丢失）。
 *
 * @param renderedBlock 本轮实际注入的结构化事实块原文。
 */
export function stripProfileFactDuplicateLines(
  profileText: string,
  renderedBlock?: string | null,
): { text: string; removed: number; staleRemoved: number } {
  const empty = { text: profileText, removed: 0, staleRemoved: 0 };
  if (!profileText) return empty;
  const rendered = parseRenderedFactBlock(renderedBlock);
  if (rendered.size === 0) return empty;

  const kept: string[] = [];
  let removed = 0;
  let staleRemoved = 0;
  for (const raw of profileText.split("\n")) {
    const parsed = parseFieldLine(raw);
    if (parsed) {
      const field = profileFieldOfLabel(parsed.label);
      const current = field ? rendered.get(field) : undefined;
      if (current !== undefined) {
        removed += 1;
        if (current !== parsed.value) staleRemoved += 1;
        continue;
      }
    }
    kept.push(raw);
  }
  return { text: kept.join("\n"), removed, staleRemoved };
}

/* ─────────────────────────── 编排（IO） ─────────────────────────── */

export interface ProfileAuthorityDeps {
  profileStore: {
    read(actorId: string): Promise<string>;
    write(actorId: string, content: string): Promise<void>;
  };
  factStore: {
    getActiveFacts(actorId: string): readonly CanonicalFieldFact[];
    /** 该字段的全部已知值（当前 + 历史）；缺省则不启用陈旧值识别 */
    getAllValuesForField?(actorId: string, field: string): readonly string[];
  } | null;
  memorySync?: {
    getSnapshot(actorId: string, keys?: string[]): { revision: number; entries: Record<string, unknown> };
    setEntry(actorId: string, key: string, value: unknown): void;
  } | null;
  /**
   * 画像全文的 KV 副本键（缺省 user_profile）。该键必须与 USER_PROFILE.md 同步——
   * 否则画像投影后 KV 里还留着旧全文，又是「一处一个样」。
   */
  profileKvKey?: string | null;
}

export interface ProfileAuthorityReport {
  actorId: string;
  /** 权威库中的档案字段（投影依据） */
  fields: Record<string, string>;
  profileChanged: boolean;
  /** @deprecated 2026-11-12 起画像不再写 KV 副本，恒为 false */
  profileKvSynced: boolean;
  /** 是否清掉了存量的 KV user_profile 全文副本（一次性迁移，幂等） */
  legacyProfileKvCleared: boolean;
}

/**
 * 一次收敛：把 USER_PROFILE.md 的档案字段行重渲染为权威投影，并清掉 KV 里
 * 存量的画像全文副本。幂等——无变化不写盘。
 *
 * 注意：调用方需保证与该 actor 画像的其它写操作串行（聚合器用 runSerialized）。
 */
export async function reconcileProfileFactsFromStores(
  actorId: string,
  deps: ProfileAuthorityDeps,
): Promise<ProfileAuthorityReport> {
  const facts = deps.factStore?.getActiveFacts(actorId) ?? [];
  const canon = canonicalFieldMap(facts);

  let profileChanged = false;
  if (canon.size > 0) {
    const mdRaw = await deps.profileStore.read(actorId);
    const md = mdRaw.trim();
    // 首尾空白归一：UserProfileStore.write 落盘时会 trim，比较/存储必须同口径，
    // 否则每次收敛都判定「有变化」，幂等性破产。
    const next = projectProfileMarkdown(md, facts).trim();
    if (next !== md) {
      await deps.profileStore.write(actorId, next);
      profileChanged = true;
    }
  }

  const profileKvSynced = false;
  // 2026-11-12 权威源收敛：画像全文只以 USER_PROFILE.md 为准，不再往 KV 写副本。
  // 此前 `user_profile` 键与 md 逐字节相同（实测 392/393 字符），是纯粹的冗余副本：
  // 写入要同步两处、读取可能拿到旧版、删除要删两处。现在读取侧直接从 md 实时投影
  // （见 PromptContextBuilder），`profileKvKey` 保留参数只为兼容调用方签名。

  // 顺带清掉存量副本：老实例升级后 KV 里可能还留着上一次同步的全文，必须一并作废，
  // 否则「读到旧副本」的风险窗口仍然存在（幂等：空了就不再写）。
  // 2026-11-13：memory_facts / memory_preferences 的 KV 槽位已整体退役
  // （键清空、写方全删），这里的槽位副本清理随之移除。
  let legacyProfileKvCleared = false;
  const legacyKey = deps.profileKvKey === null ? null : (deps.profileKvKey ?? "user_profile");
  if (deps.memorySync && legacyKey) {
    const { entries } = deps.memorySync.getSnapshot(actorId, [legacyKey]);
    const current = typeof entries[legacyKey] === "string" ? (entries[legacyKey] as string) : "";
    if (current.trim()) {
      deps.memorySync.setEntry(actorId, legacyKey, "");
      legacyProfileKvCleared = true;
    }
  }

  return {
    actorId,
    fields: Object.fromEntries(canon),
    profileChanged,
    profileKvSynced,
    legacyProfileKvCleared,
  };
}
