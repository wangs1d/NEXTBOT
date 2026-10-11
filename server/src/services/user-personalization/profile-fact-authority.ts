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

export interface KvSlotCleanResult {
  value: string;
  removed: number;
  changed: boolean;
}

/**
 * KV 槽位清理：剔除档案字段副本（权威库已有该字段值）并归并完全重复行。
 * 不做替换——权威块由 prompt 单独注入，槽位里保留第二份只会造成双写漂移。
 */
export function cleanProfileFieldCopiesFromSlot(
  raw: string,
  fields: ReadonlySet<string>,
  knownValues?: ReadonlyMap<string, readonly string[]>,
): KvSlotCleanResult {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { value: raw, removed: 0, changed: false };
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (fields.size > 0 && isProfileFieldCopyLine(line, fields, knownValues)) {
      removed += 1;
      continue;
    }
    if (seen.has(line)) {
      removed += 1;
      continue;
    }
    seen.add(line);
    kept.push(line);
  }
  const value = kept.join("\n");
  return { value, removed, changed: value !== raw };
}

/** 行式事实库（JSON）条目外观 */
export interface UserFactLike {
  kind?: string;
  subject?: string;
  value: string;
}

/**
 * 行式事实库（data/user-facts/*.json）清理：剔除档案字段副本 + 同 subject 去重。
 * 该库是夜间巩固产物，同样是权威库的投影面，不能自留第二份称呼。
 */
export function filterUserFactLikeEntries<T extends UserFactLike>(
  facts: readonly T[],
  fields: ReadonlySet<string>,
  knownValues?: ReadonlyMap<string, readonly string[]>,
): { kept: T[]; removed: number } {
  const kept: T[] = [];
  const seen = new Set<string>();
  let removed = 0;
  for (const f of facts) {
    const subjectField = f.subject ? profileFieldOfLabel(f.subject) : "";
    if (
      fields.size > 0 &&
      (isProfileFieldCopyLine(f.value, fields, knownValues) ||
        (subjectField && fields.has(subjectField)))
    ) {
      removed += 1;
      continue;
    }
    const key = `${f.kind ?? ""}|${f.subject ?? ""}|${f.value}`.replace(
      /[\s，。；！？、,.;:!?'""''「」（）()\[\]【】~～]/g,
      "",
    );
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    kept.push(f);
  }
  return { kept, removed };
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
  /** 需要清理的 KV 槽位；缺省 memory_facts / memory_preferences */
  kvKeys?: readonly string[];
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
  /** 画像全文的 KV 副本是否被同步 */
  profileKvSynced: boolean;
  kvRemoved: number;
}

const DEFAULT_KV_KEYS: readonly string[] = ["memory_facts", "memory_preferences"];

/**
 * 一次收敛：把 USER_PROFILE.md 的档案字段行重渲染为权威投影，同步画像全文的 KV
 * 副本，并清掉 KV 槽位里的档案字段副本（含历史陈旧值）。幂等——无变化不写盘。
 *
 * 注意：调用方需保证与该 actor 画像的其它写操作串行（聚合器用 runSerialized）。
 */
export async function reconcileProfileFactsFromStores(
  actorId: string,
  deps: ProfileAuthorityDeps,
): Promise<ProfileAuthorityReport> {
  const facts = deps.factStore?.getActiveFacts(actorId) ?? [];
  const canon = canonicalFieldMap(facts);
  const fields = [...canon.keys()];
  const fieldSet = new Set(fields);

  // 已知值（当前 + 历史）：用于识别「旧值副本」（改了称呼后别处还写着旧称呼）
  const knownValues = new Map<string, readonly string[]>();
  for (const f of fields) {
    const hist = deps.factStore?.getAllValuesForField?.(actorId, f);
    const current = canon.get(f);
    knownValues.set(f, [...new Set([...(hist ?? []), ...(current ? [current] : [])])]);
  }

  let profileChanged = false;
  let projectedMd: string | null = null;
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
    projectedMd = next;
  }

  let profileKvSynced = false;
  const profileKvKey = deps.profileKvKey === undefined ? "user_profile" : deps.profileKvKey;
  if (deps.memorySync && profileKvKey && projectedMd !== null) {
    const { entries } = deps.memorySync.getSnapshot(actorId, [profileKvKey]);
    const current =
      typeof entries[profileKvKey] === "string" ? (entries[profileKvKey] as string).trim() : "";
    if (current !== projectedMd) {
      deps.memorySync.setEntry(actorId, profileKvKey, projectedMd);
      profileKvSynced = true;
    }
  }

  let kvRemoved = 0;
  if (deps.memorySync && canon.size > 0) {
    for (const key of deps.kvKeys ?? DEFAULT_KV_KEYS) {
      const { entries } = deps.memorySync.getSnapshot(actorId, [key]);
      const raw = typeof entries[key] === "string" ? (entries[key] as string) : "";
      if (!raw) continue;
      const cleaned = cleanProfileFieldCopiesFromSlot(raw, fieldSet, knownValues);
      if (cleaned.changed) {
        deps.memorySync.setEntry(actorId, key, cleaned.value);
        kvRemoved += cleaned.removed;
      }
    }
  }

  return {
    actorId,
    fields: Object.fromEntries(canon),
    profileChanged,
    profileKvSynced,
    kvRemoved,
  };
}
