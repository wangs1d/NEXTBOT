// 「管家记得的你」档案页聚合读接口（需求文档 §6）
//
// GET /api/profile/overview?userId=&sessionId=&days=7
//
// 一次请求把画像的五个分区 + 触点计划 + 在办的事 + 你教过的分寸全部取齐，
// 客户端不再串行拉五次（§6.4）。**纯读聚合**：不新建存储、不新建事件、不写任何库，
// 每个数据源都直接问现有模块要（结构化事实库 / 画像 md / 生活模型 / 在场足迹 /
// 目标板 / 日程 / 台账 / 审计时间线 / 抑制表 / 触点计划），拿不到的就出空数组。
//
// 空态口径（§6.2 验收）：没数据就说没数据，并说明「要几次观察我才敢下结论」——
// 绝不用通用话术填坑，也绝不把 agent 的猜测冒充成用户说过的话。
//
// 条目携带的 `forget` 只是**句柄**（kind + ref），删除动作由客户端打既有端点
// （/api/memory/facts/forget、/api/memory/life/forget、/api/profile/manage/line），
// 本接口不提供任何写路径。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { getPresenceFootprintStore } from "../../rhythm/presence-footprint-store.js";
import type { AuditEntry } from "../../proactivity/audit-timeline.js";
import type { GoalRecord } from "../../proactivity/goal-board.js";
import type { OutcomeRecord } from "../../proactivity/outcome-store.js";
import type { SuppressionEntry } from "../../proactivity/suppression-store.js";
import type { TouchpointPlan } from "../../proactivity/touchpoint-planner.js";
import type { BillParcelSummary } from "../../services/bill-parcel-ledger.js";
import type { ScheduleTaskRecord } from "../../services/schedule-task-service.js";
import { isTriviaTask } from "../../services/schedule-task-service.js";

/** 分区键（客户端按这个顺序渲染，键名与 PRD §6.2 的五个分区 + 三个补充区对齐） */
export type ProfileGroupKey =
  | "rhythm"
  | "habits"
  | "places"
  | "people"
  | "recent"
  | "plan"
  | "watching"
  | "feedback";

/** 档案条目（渲染 + 定位删除用的最小完备形状） */
export interface OverviewItem {
  id: string;
  /** 一行正文（"不吃香菜" / "妹妹·小满"） */
  text: string;
  /** 副行（字段名、别名、判定依据；没有就 null） */
  detail: string | null;
  /** 来源人读标签（"对话里你说的"）——绝不留空，未知就写明未知 */
  source: string;
  /** 该条被说出/确认的时刻（ms）；无从判定为 null */
  at: number | null;
  /** 敏感类（健康 / 感情 / 财务细节）：客户端默认折叠，点开才看（§6.3） */
  sensitive: boolean;
  /** 用户固定过：引擎不再自动改（§6.3） */
  pinned: boolean;
  /** 置信度 0..1；null = 该数据源不产出置信度（不拿 1.0 冒充确定） */
  confidence: number | null;
  /** 近 N 天新增/变更（「最近新学到」的小红点口径） */
  isNew: boolean;
  /** 删除句柄：客户端据此打既有端点；null = 该条由系统观察所得，只能在源头改 */
  forget: { kind: "fact" | "entity" | "profileLine"; ref: string } | null;
}

export interface OverviewGroup {
  key: ProfileGroupKey;
  title: string;
  items: OverviewItem[];
  /** 空态文案（诚实说明为什么是空的） */
  emptyText: string;
  /** 口径说明（样本数 / 时间窗 / 未装配的数据源）；无则 null */
  note: string | null;
}

export type ProfileOverview = {
  ok: true;
  actorId: string;
  generatedAt: number;
  /** 近 N 天算「新学到」的窗口（天） */
  recentDays: number;
  groups: OverviewGroup[];
  meta: {
    counts: Record<string, number>;
    /** 默认折叠的敏感条数（客户端用来提示"N 条已折叠"） */
    sensitiveCount: number;
    /** 触点计划摘要（今日几个触点、说出去几个）；无计划为 null */
    plan: {
      date: string;
      frequencyTier: string;
      slots: number;
      sent: number;
      dropped: string | null;
    } | null;
  };
};

// ─── 入参形状（route 侧从各 store 取回来的原始行；全部为只读快照） ───

export type OverviewFact = {
  field: string;
  value: string;
  /** 类目标签：identity/rhythm/preference/aversion/relations/comms/goals/health/spending/note */
  category: string | null;
  confidence: number | null;
  sourceRef: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type OverviewProfileLine = {
  section: string;
  line: string;
  lastConfirmedAt: string | null;
};

export type OverviewUnderstanding = { topic: string; note: string; kind: string };

export type OverviewEntity = {
  id: string;
  kind: "person" | "place" | "pet" | "org" | "self";
  name: string;
  aliases: string[];
  sensitivity: "normal" | "sensitive";
  lastSeenAt: string | null;
  confidence: number | null;
};

export type OverviewRelation = {
  id: string;
  /** 关系类别（family/romantic/friend/colleague/pet/…） */
  kind: string;
  subKind: string | null;
  /** 指向的人/地（已解析成名字） */
  to: string;
  intimacy: number | null;
  status: string;
  sensitivity: "normal" | "sensitive";
  updatedAt: string | null;
};

export type OverviewRhythm = {
  /** 推导入睡点（十进制小时，23.5 = 23:30）；证据不足为 null */
  sleepStartHour: number | null;
  wakeHour: number | null;
  /** 有效夜样本数（<3 时上面两个必为 null） */
  nightCount: number;
  /** 近两周逐日足迹（算"这两周睡晚了"的趋势用） */
  days: Array<{ date: string; firstHour: number | null; lastHour: number | null }>;
};

export type OverviewTouchpoints = { plan: TouchpointPlan; dropped: string | null };

export type ProfileOverviewSources = {
  actorId: string;
  recentDays?: number;
  facts?: OverviewFact[];
  profileLines?: OverviewProfileLine[];
  understandings?: OverviewUnderstanding[];
  entities?: OverviewEntity[];
  relations?: OverviewRelation[];
  rhythm?: OverviewRhythm | null;
  touchpoints?: OverviewTouchpoints | null;
  goals?: GoalRecord[];
  tasks?: ScheduleTaskRecord[];
  ledger?: BillParcelSummary | null;
  audit?: AuditEntry[];
  suppressions?: SuppressionEntry[];
  outcomes?: OutcomeRecord[];
};

const MS_DAY = 86_400_000;
/** 敏感类目（健康 / 财务 / 感情细节）默认折叠（§6.3） */
const SENSITIVE_FACT_CATEGORIES = new Set(["health", "spending", "relations"]);
/** 没有类目字段的条目（理解条目 / 画像行）按文本判敏感：宁可多折一刀，不可裸奔 */
const SENSITIVE_TEXT_RE = /健康|疾病|药|体检|收入|工资|存款|还款|贷款|余额|账单|恋|暧昧|分手|离婚|相亲/;
/** 习惯与偏好取的事实类目（健康 / 财务也归在这里，但一律打 sensitive 折叠） */
const HABIT_FACT_CATEGORIES = new Set([
  "preference",
  "aversion",
  "comms",
  "note",
  "goals",
  "health",
  "spending",
]);
/** 作息类事实类目 */
const RHYTHM_FACT_CATEGORIES = new Set(["rhythm"]);
/** 人际/宠物关系标签（只做人读映射，未知类别原样透出，不编称呼） */
const RELATION_LABELS: Record<string, string> = {
  family: "家人",
  romantic: "感情对象",
  friend: "朋友",
  colleague: "同事",
  classmate: "同学",
  pet: "宠物",
  service: "服务关系",
};

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 十进制小时 → "07:20" */
export function hourLabel(hour: number | null): string | null {
  if (hour === null || !Number.isFinite(hour)) return null;
  const h = ((hour % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const carry = mm >= 60 ? 1 : 0;
  const finalH = (hh + carry) % 24;
  const finalM = carry ? mm - 60 : mm;
  return `${String(finalH).padStart(2, "0")}:${String(finalM).padStart(2, "0")}`;
}

/** 当日分钟数 → "07:20" */
function minuteLabel(minuteOf: number): string {
  const m = Math.max(0, Math.round(minuteOf));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const SLOT_TITLES: Record<string, string> = {
  morning: "早安简报",
  leave_home: "出门路上",
  midday: "午间",
  leave_work: "下班路上",
  tomorrow_preview: "明日速览",
};

const SLOT_STATUS_LABELS: Record<string, string> = {
  planned: "还没到点",
  open: "正在攒内容",
  sent: "已经说了",
  skipped: "这次跳过了",
  merged: "并到别的时间说了",
};

/** 来源标记 → 人读标签（未知前缀如实写明"来源标记：xxx"，不冒充对话） */
export function sourceLabelOf(ref: string | null | undefined): string {
  const raw = String(ref ?? "").trim();
  if (!raw) return "对话里你说的";
  const prefix = (raw.split(":")[0] ?? "").toLowerCase();
  if (/profile|wizard|onboard|setting|manual|user_report/.test(prefix)) return "你自己在设置里填的";
  if (/sms|mail|email|notif/.test(prefix)) return "短信/邮件里看到的";
  if (/ingest|upload|note|file|ics/.test(prefix)) return "你上传的资料里";
  if (/extract|chat|turn|dialog|understanding/.test(prefix)) return "对话里你说的";
  if (/rhythm|sensor|observe|presence|signal/.test(prefix)) return "我观察出来的";
  return `来源标记：${raw}`;
}

/**
 * 画像 md 的中文段名 → /api/profile/manage/line 的 section 键（与
 * user-profile-store 的 SECTION_TITLE_TO_KEY 同表）。删除句柄里带上键，
 * 客户端就能直接打既有端点，不必再解析一遍画像。
 */
const SECTION_TITLE_TO_KEY: Record<string, string> = {
  基本信息: "basic",
  兴趣与习惯: "interest",
  沟通偏好: "communication",
  备注: "note",
};

function profileLineRef(section: string, line: string): string {
  return `${SECTION_TITLE_TO_KEY[section] ?? "note"}::${line}`;
}

function mkItem(over: Partial<OverviewItem> & { id: string; text: string }): OverviewItem {
  return {
    id: over.id,
    text: over.text,
    detail: over.detail ?? null,
    source: over.source ?? "来源未知",
    at: over.at ?? null,
    sensitive: over.sensitive ?? false,
    pinned: over.pinned ?? false,
    confidence: over.confidence ?? null,
    isNew: over.isNew ?? false,
    forget: over.forget ?? null,
  };
}

function group(
  key: ProfileGroupKey,
  title: string,
  items: OverviewItem[],
  emptyText: string,
  note: string | null,
): OverviewGroup {
  return { key, title, items, emptyText, note };
}

// ─── 分区一：作息节律（只读节律引擎的推导结果，§7.1「档案页不各自统计」） ───

function buildRhythmGroup(s: ProfileOverviewSources, now: number): OverviewGroup {
  const recentDays = s.recentDays ?? 7;
  const items: OverviewItem[] = [];
  const rhythm = s.rhythm ?? null;
  const wake = hourLabel(rhythm?.wakeHour ?? null);
  const sleep = hourLabel(rhythm?.sleepStartHour ?? null);
  // 置信度用样本数折算（3 夜≈0.5，10 夜≈0.85）：这是"看过多少"的诚实刻度，
  // 不是节律引擎自己吐的模型置信度，所以 detail 里写清样本数。
  const confidence = rhythm ? clamp01(0.3 + rhythm.nightCount * 0.06) : null;
  const lastDay = rhythm?.days?.[rhythm.days.length - 1]?.date ?? null;
  const lastMs = lastDay ? toMs(`${lastDay}T12:00:00`) : null;

  if (wake) {
    items.push(
      mkItem({
        id: "rhythm:wake",
        text: `起床大概 ${wake}`,
        detail: `按最近 ${rhythm?.nightCount ?? 0} 个有效夜的在场时间推的`,
        source: "我观察出来的",
        at: lastMs,
        confidence,
      }),
    );
  }
  if (sleep) {
    items.push(
      mkItem({
        id: "rhythm:sleep",
        text: `入睡大概 ${sleep}`,
        detail: `末次在场 + 入睡缓冲，样本 ${rhythm?.nightCount ?? 0} 夜`,
        source: "我观察出来的",
        at: lastMs,
        confidence,
      }),
    );
  }
  // 「这两周睡晚了 30 分钟」：后 1/3 与更早部分的入睡点均值差（各 ≥2 天才比）
  const shift = sleepDriftMinutes(rhythm?.days ?? []);
  if (shift !== null) {
    items.push(
      mkItem({
        id: "rhythm:drift",
        text:
          shift > 0
            ? `最近比之前晚睡约 ${Math.abs(shift)} 分钟`
            : `最近比之前早睡约 ${Math.abs(shift)} 分钟`,
        detail: "逐日在场足迹对比，只做趋势陈述，不改你的作息设定",
        source: "我观察出来的",
        at: lastMs,
        confidence,
      }),
    );
  }

  for (const f of s.facts ?? []) {
    if (!RHYTHM_FACT_CATEGORIES.has(f.category ?? "")) continue;
    const at = toMs(f.updatedAt) ?? toMs(f.createdAt);
    items.push(
      mkItem({
        id: `fact:${f.field}`,
        text: `${f.field}：${f.value}`,
        detail: f.category ? `事实类目 ${f.category}` : null,
        source: sourceLabelOf(f.sourceRef),
        at,
        pinned: f.confidence !== null && f.confidence >= 1,
        confidence: f.confidence,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "fact", ref: f.field },
      }),
    );
  }
  for (const u of s.understandings ?? []) {
    if (!/作息|睡觉|起床|熬夜|午睡/.test(`${u.topic} ${u.note}`)) continue;
    items.push(
      mkItem({
        id: `understanding:${u.topic}`,
        text: u.note.slice(0, 120),
        detail: `理解条目（${u.kind}）`,
        source: "对话里你说的",
        at: null,
      }),
    );
  }

  const note =
    rhythm && rhythm.nightCount > 0
      ? `观察样本：${rhythm.nightCount} 个有效夜（不足 3 夜我不下结论）`
      : null;
  return group(
    "rhythm",
    "作息节律",
    items,
    "还没看出你的作息——我要在夜里和清晨各看到你几次（至少 3 个有效夜）才敢下结论，或者直接告诉我几点睡几点起。",
    note,
  );
}

/** 入睡点漂移（分钟）：近 1/3 天 vs 更早天，两段各 ≥2 天才算；不足返回 null */
function sleepDriftMinutes(days: OverviewRhythm["days"]): number | null {
  const nights = days
    .filter((d) => d.date && d.lastHour !== null && (d.lastHour as number) >= 18)
    .map((d) => ({ date: d.date, lastHour: d.lastHour as number }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (nights.length < 4) return null;
  const cut = Math.max(2, Math.floor(nights.length * (2 / 3)));
  const early = nights.slice(0, cut);
  const late = nights.slice(cut);
  if (early.length < 2 || late.length < 2) return null;
  const avg = (rows: { lastHour: number }[]) =>
    rows.reduce((sum, r) => sum + r.lastHour, 0) / rows.length;
  return Math.round((avg(late) - avg(early)) * 60);
}

// ─── 分区二：习惯与偏好（事实库 preference/aversion/comms + 画像 md 行） ───

function buildHabitsGroup(
  s: ProfileOverviewSources,
  now: number,
): { items: OverviewItem[]; group: OverviewGroup } {
  const recentDays = s.recentDays ?? 7;
  const items: OverviewItem[] = [];
  const seen = new Set<string>();
  for (const f of s.facts ?? []) {
    const cat = f.category ?? "";
    if (!HABIT_FACT_CATEGORIES.has(cat) && cat !== "identity") continue;
    const at = toMs(f.updatedAt) ?? toMs(f.createdAt);
    const text = cat === "identity" ? f.value : `${f.field}：${f.value}`;
    items.push(
      mkItem({
        id: `fact:${f.field}`,
        text,
        detail: f.category ? `类目 ${f.category}` : null,
        source: sourceLabelOf(f.sourceRef),
        at,
        sensitive: SENSITIVE_FACT_CATEGORIES.has(cat),
        pinned: f.confidence !== null && f.confidence >= 1,
        confidence: f.confidence,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "fact", ref: f.field },
      }),
    );
    seen.add(text.replace(/\s+/g, ""));
  }
  for (const line of s.profileLines ?? []) {
    if (!/兴趣|习惯|偏好|沟通|备注/.test(line.section)) continue;
    const key = line.line.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    const at = toMs(line.lastConfirmedAt);
    items.push(
      mkItem({
        id: `profile:${line.section}:${line.line}`,
        text: line.line,
        detail: `画像「${line.section}」段`,
        source: "对话里你说的",
        at,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "profileLine", ref: profileLineRef(line.section, line.line) },
      }),
    );
  }
  for (const u of s.understandings ?? []) {
    if (u.kind !== "preference" && u.kind !== "correction") continue;
    items.push(
      mkItem({
        id: `understanding:${u.topic}`,
        text: u.note.slice(0, 120),
        detail: `理解条目（${u.kind}）：${u.topic}`,
        source: "对话里你说的",
        at: null,
        sensitive: SENSITIVE_TEXT_RE.test(u.note),
      }),
    );
  }
  return {
    items,
    group: group(
      "habits",
      "习惯与偏好",
      items,
      "还没记下你的偏好。聊天里说一声「我不吃香菜」，我就会存进这里。",
      null,
    ),
  };
}

// ─── 分区三：常去的地方（Life Model 地点实体 + 画像「常去地点」行） ───

function buildPlacesGroup(
  s: ProfileOverviewSources,
  now: number,
): OverviewGroup {
  const recentDays = s.recentDays ?? 7;
  const items: OverviewItem[] = [];
  for (const e of s.entities ?? []) {
    if (e.kind !== "place") continue;
    const at = toMs(e.lastSeenAt);
    items.push(
      mkItem({
        id: `entity:${e.id}`,
        text: e.name,
        detail: e.aliases.length > 0 ? `也叫 ${e.aliases.slice(0, 3).join("、")}` : null,
        source: "对话里你说的",
        at,
        sensitive: e.sensitivity === "sensitive",
        confidence: e.confidence,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "entity", ref: e.id },
      }),
    );
  }
  for (const f of s.facts ?? []) {
    if (!/居住|住址|老家|工作地|常去|公司|学校/.test(f.field)) continue;
    if (items.some((it) => it.text === f.value)) continue;
    const at = toMs(f.updatedAt) ?? toMs(f.createdAt);
    items.push(
      mkItem({
        id: `fact:${f.field}`,
        text: `${f.field}：${f.value}`,
        source: sourceLabelOf(f.sourceRef),
        at,
        confidence: f.confidence,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "fact", ref: f.field },
      }),
    );
  }
  for (const line of s.profileLines ?? []) {
    if (!/常去|地点/.test(line.section) && !/常去/.test(line.line)) continue;
    if (items.some((it) => it.text === line.line)) continue;
    const at = toMs(line.lastConfirmedAt);
    items.push(
      mkItem({
        id: `profile:${line.section}:${line.line}`,
        text: line.line,
        detail: `画像「${line.section}」段`,
        source: "我观察出来的",
        at,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "profileLine", ref: profileLineRef(line.section, line.line) },
      }),
    );
  }
  return group(
    "places",
    "常去的地方",
    items,
    "还没有地点记录。你设了围栏、或说过「我常去××」，这里才会长出条目。",
    null,
  );
}

// ─── 分区四：身边的人（Life Model 实体 + 关系边；PRD 示例"妹妹·小满"） ───

function buildPeopleGroup(
  s: ProfileOverviewSources,
  now: number,
): OverviewGroup {
  const recentDays = s.recentDays ?? 7;
  const items: OverviewItem[] = [];
  const entityByName = new Map<string, OverviewEntity>();
  for (const e of s.entities ?? []) {
    if (e.kind === "self") continue;
    entityByName.set(e.name, e);
  }
  const covered = new Set<string>();
  for (const r of s.relations ?? []) {
    if (r.status === "ended") continue;
    const label = r.subKind?.trim() || RELATION_LABELS[r.kind] || r.kind;
    const entity = entityByName.get(r.to);
    const at = toMs(r.updatedAt) ?? toMs(entity?.lastSeenAt ?? null);
    items.push(
      mkItem({
        id: `relation:${r.id}`,
        text: `${label}·${r.to}`,
        detail:
          r.intimacy !== null
            ? `亲密度 ${Math.round(r.intimacy * 100)}%`
            : r.kind in RELATION_LABELS
              ? RELATION_LABELS[r.kind]
              : null,
        source: "对话里你说的",
        at,
        sensitive: r.sensitivity === "sensitive" || r.kind === "romantic",
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: entity ? { kind: "entity", ref: entity.id } : null,
      }),
    );
    covered.add(r.to);
  }
  for (const e of s.entities ?? []) {
    if (e.kind !== "person" && e.kind !== "pet" && e.kind !== "org") continue;
    if (covered.has(e.name)) continue;
    const at = toMs(e.lastSeenAt);
    items.push(
      mkItem({
        id: `entity:${e.id}`,
        text: e.kind === "pet" ? `宠物·${e.name}` : e.name,
        detail: e.aliases.length > 0 ? `也叫 ${e.aliases.slice(0, 3).join("、")}` : null,
        source: "对话里你说的",
        at,
        sensitive: e.sensitivity === "sensitive",
        confidence: e.confidence,
        isNew: at !== null && now - at <= recentDays * MS_DAY,
        forget: { kind: "entity", ref: e.id },
      }),
    );
  }
  return group(
    "people",
    "身边的人",
    items,
    "还没有记下你身边的人。聊天里提到过名字和关系（「我妹妹叫小满」），次日就会出现在这里。",
    null,
  );
}

// ─── 分区五：最近新学到（前四个分区里近 N 天新增/变更的条目） ───

function buildRecentGroup(pool: OverviewItem[], recentDays: number): OverviewGroup {
  const items = pool
    .filter((it) => it.isNew)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 20);
  return group(
    "recent",
    "最近新学到",
    items,
    `这 ${recentDays} 天没有新增或变更的条目。`,
    items.length > 0 ? `口径：近 ${recentDays} 天新增或被你说过的同一件事再次确认` : null,
  );
}

// ─── 分区六：它打算什么时候跟我说什么（§3.4 触点计划，只读 planner 快照） ───

function buildPlanGroup(s: ProfileOverviewSources): OverviewGroup {
  const tp = s.touchpoints ?? null;
  const items: OverviewItem[] = [];
  if (tp) {
    for (const slot of tp.plan.slots) {
      items.push(
        mkItem({
          id: `slot:${slot.slotId}`,
          text: `${SLOT_TITLES[slot.kind] ?? slot.kind} ${minuteLabel(slot.minuteOf)}`,
          detail:
            `${minuteLabel(slot.windowStart)}–${minuteLabel(slot.windowEnd)} 窗口 · ` +
            `${SLOT_STATUS_LABELS[slot.status] ?? slot.status}` +
            (slot.candidates.length > 0 ? ` · 攒了 ${slot.candidates.length} 条` : "") +
            (slot.reason ? ` · ${slot.reason}` : ""),
          source:
            slot.basis.source === "rhythm"
              ? "按你的作息定的"
              : "默认时间（还没学到你的作息）",
          at: slot.sentAt ?? null,
          confidence: slot.basis.confidence,
        }),
      );
    }
  }
  return group(
    "plan",
    "它打算什么时候跟我说什么",
    items,
    "今天还没排触点计划（主动性未开启，或还没到生成时刻）。",
    tp
      ? `日期 ${tp.plan.date} · 频率档 ${tp.plan.frequencyTier}` +
        (tp.dropped ? ` · 没排进去的原因：${tp.dropped}` : "")
      : null,
  );
}

// ─── 分区七：它在盯的事（目标板 + 日程 + 台账；只读，不产生新动作） ───

function buildWatchingGroup(s: ProfileOverviewSources, now: number): OverviewGroup {
  const items: OverviewItem[] = [];
  for (const g of s.goals ?? []) {
    if (g.status === "done" || g.status === "expired") continue;
    items.push(
      mkItem({
        id: `goal:${g.goalId}`,
        text: g.title.slice(0, 120),
        detail:
          g.kind === "track"
            ? "盯一件事"
            : g.kind === "preexec"
              ? "在后台先备着"
              : "长期目标分步推进" + (g.successCriteria ? `｜验收：${g.successCriteria.slice(0, 60)}` : ""),
        source: "我记下的待办",
        at: g.createdAt ?? null,
        isNew: (g.createdAt ?? 0) >= now - (s.recentDays ?? 7) * MS_DAY,
      }),
    );
  }
  for (const t of s.tasks ?? []) {
    if (isTriviaTask(t)) continue;
    if (t.status === "cancelled" || t.status === "completed") continue;
    const at = toMs(t.nextRunAt ?? t.runAt);
    items.push(
      mkItem({
        id: `task:${t.taskId}`,
        text: (t.shortTitle ?? t.title ?? t.description).slice(0, 120),
        detail:
          (t.recurrence === "none" ? "一次性" : `每${t.recurrence === "daily" ? "天" : t.recurrence === "weekly" ? "周" : "年"}`) +
          (t.location ? `｜${t.location}` : ""),
        source: t.source === "ics" ? "你订阅的日历里" : "你让我盯着的日程",
        at,
        isNew: (at ?? 0) >= now - (s.recentDays ?? 7) * MS_DAY,
      }),
    );
  }
  const ledger = s.ledger ?? null;
  if (ledger) {
    if (ledger.parcels.awaitingPickup > 0) {
      items.push(
        mkItem({
          id: "ledger:parcel",
          text: `有 ${ledger.parcels.awaitingPickup} 个快递等你取`,
          detail: ledger.parcels.latestPickup
            ? `最近一件：${ledger.parcels.latestPickup.title}${
                ledger.parcels.latestPickup.pickupCode ? `（取件码 ${ledger.parcels.latestPickup.pickupCode}）` : ""
              }`
            : null,
          source: "短信/邮件里看到的",
          at: ledger.parcels.latestPickup?.occurredAt ?? null,
        }),
      );
    }
    if (ledger.bills.count > 0) {
      items.push(
        mkItem({
          id: "ledger:bill",
          text: `近 ${ledger.window.days} 天自动记了 ${ledger.bills.count} 笔账单`,
          detail:
            ledger.bills.amountCount > 0
              ? `有金额的 ${ledger.bills.amountCount} 笔，合计 ${Math.round(ledger.bills.totalAmount)} 元`
              : "都没识别出金额",
          source: "短信/邮件里看到的",
          at: ledger.recent[0]?.occurredAt ?? null,
          sensitive: true,
        }),
      );
    }
  }
  return group(
    "watching",
    "它在盯的事",
    items,
    "眼下没有盯着的事。",
    ledger ? `账单/快递窗口：近 ${ledger.window.days} 天` : null,
  );
}

// ─── 分区八：你教过的分寸（抑制表 + 近期 outcome 回声） ───

function buildFeedbackGroup(s: ProfileOverviewSources): OverviewGroup {
  const items: OverviewItem[] = [];
  for (const entry of s.suppressions ?? []) {
    const at = toMs(entry.createdAt);
    items.push(
      mkItem({
        id: `suppression:${entry.id}`,
        text:
          entry.keywords.length > 0
            ? `别再提「${entry.keywords.slice(0, 3).join("、")}」`
            : `整类不再提：${entry.kind}`,
        detail: entry.note ? entry.note.slice(0, 120) : `类别 ${entry.kind}`,
        source: "你说过「别再提醒我这个」",
        at,
      }),
    );
  }
  const echo = summarizeOutcomes(s.outcomes ?? [], s.actorId);
  if (echo.positive > 0 || echo.negative > 0) {
    items.push(
      mkItem({
        id: "outcome:echo",
        text: `最近你回应了 ${echo.positive + echo.negative} 次：认账 ${echo.positive}、不认 ${echo.negative}`,
        detail:
          echo.worstKind && echo.worstNegative >= 2
            ? `最不待见的一类：${echo.worstKind}`
            : "同一类的冷却时长会据此自动调整",
        source: "你对主动消息表过态",
        at: echo.lastAt,
      }),
    );
  }
  return group(
    "feedback",
    "你教过的分寸",
    items,
    "还没有收到你的「这条不对 / 别再提」。这些反馈会自动拉长同类触达的冷却。",
    echo.windowDays ? `outcome 统计窗口：近 ${echo.windowDays} 天` : null,
  );
}

function summarizeOutcomes(records: OutcomeRecord[], actorId: string): {
  positive: number;
  negative: number;
  lastAt: number | null;
  worstKind: string | null;
  worstNegative: number;
  windowDays: number;
} {
  const decided = records.filter(
    (r) => r.actorId === actorId && ["accepted", "replied", "snoozed", "dismissed", "ignored"].includes(r.outcome),
  );
  let positive = 0;
  let negative = 0;
  let lastAt: number | null = null;
  const negByKind = new Map<string, number>();
  for (const r of decided) {
    lastAt = Math.max(lastAt ?? 0, r.at);
    if (r.outcome === "accepted" || r.outcome === "replied" || r.outcome === "snoozed") positive += 1;
    else {
      negative += 1;
      negByKind.set(r.kind, (negByKind.get(r.kind) ?? 0) + 1);
    }
  }
  let worstKind: string | null = null;
  let worstNegative = 0;
  for (const [kind, n] of negByKind) {
    if (n > worstNegative) {
      worstNegative = n;
      worstKind = kind;
    }
  }
  const oldest = decided.reduce((min, r) => Math.min(min, r.at), Number.POSITIVE_INFINITY);
  return {
    positive,
    negative,
    lastAt: Number.isFinite(lastAt ?? NaN) ? lastAt : null,
    worstKind,
    worstNegative,
    windowDays:
      decided.length > 0 && Number.isFinite(oldest)
        ? Math.max(1, Math.round((Date.now() - oldest) / MS_DAY))
        : 0,
  };
}

/**
 * 纯聚合函数（无 IO，单测直接喂假数据）。
 * 各数据源缺省即空数组 / null——缺哪个区块出空态，接口恒 ok:true。
 */
export function buildProfileOverview(s: ProfileOverviewSources, now = Date.now()): ProfileOverview {
  const recentDays = s.recentDays ?? 7;
  const habits = buildHabitsGroup(s, now);
  const places = buildPlacesGroup(s, now);
  const people = buildPeopleGroup(s, now);
  // 「最近新学到」从上面三个内容分区派生（不含系统侧的触点/在办/反馈区）：
  // 口径与分区里完全一致，不会出现「新学到里有条目、分区里却找不到」的分裂视图。
  const recent = buildRecentGroup([...habits.items, ...places.items, ...people.items], recentDays);
  const groups: OverviewGroup[] = [
    buildRhythmGroup(s, now),
    habits.group,
    places,
    people,
    recent,
    buildPlanGroup(s),
    buildWatchingGroup(s, now),
    buildFeedbackGroup(s),
  ];
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.key] = g.items.length;
  // 敏感条数只数内容分区（recent 是派生视图，重复计一次会把折叠数放大）
  const sensitiveCount = groups
    .filter((g) => g.key !== "recent")
    .reduce((sum, g) => sum + g.items.filter((it) => it.sensitive).length, 0);
  const tp = s.touchpoints ?? null;
  return {
    ok: true,
    actorId: s.actorId,
    generatedAt: now,
    recentDays,
    groups,
    meta: {
      counts,
      sensitiveCount,
      plan: tp
        ? {
            date: tp.plan.date,
            frequencyTier: tp.plan.frequencyTier,
            slots: tp.plan.slots.length,
            sent: tp.plan.slots.filter((sl) => sl.status === "sent").length,
            dropped: tp.dropped,
          }
        : null,
    },
  };
}

// ─── 路由装配：把现有 store 的原始行喂给上面的纯函数 ───

export type ProfileOverviewRouteDeps = {
  /** 管道只读面：触点计划快照 + outcome 窗口（未装配时该两区为空态） */
  pipeline?: {
    planSnapshot(actorId: string): { plan: TouchpointPlan; dropped: string | null } | null;
    funnelWindow?(days?: number): { outcomes: OutcomeRecord[] };
  } | null;
  goalBoard?: { list(actorId?: string): GoalRecord[] } | null;
  scheduleTasks?: {
    listTasksBySession(sessionId: string, range?: { from?: string; to?: string }): ScheduleTaskRecord[];
  } | null;
  ledger?: { summary(opts: { actorId?: string; days?: number }): BillParcelSummary } | null;
  auditTrail?: { timeline(actorId: string, limit?: number): AuditEntry[] } | null;
  suppressions?: { list(actorId: string): SuppressionEntry[] } | null;
};

/** 事实库行 → 聚合入参（只挑档案页要用的字段，别把整行原样吐给客户端） */
function pickFact(f: {
  field: string;
  value: string;
  category?: string | null;
  confidence: number | null;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}): OverviewFact {
  return {
    field: f.field,
    value: f.value,
    category: f.category ?? null,
    confidence: f.confidence,
    sourceRef: f.sourceRef,
    updatedAt: f.updatedAt ?? null,
    createdAt: f.createdAt ?? null,
  };
}

export function registerProfileOverviewRoutes(
  app: FastifyInstance,
  deps: ProfileOverviewRouteDeps,
): void {
  app.get("/api/profile/overview", async (request) => {
    const q = request.query as {
      userId?: string;
      sessionId?: string;
      actorId?: string;
      days?: string;
    };
    // 身份一律取周界裁决后的结果（auth hook 已把 query.userId 钉死成本人）
    const actorId = resolveActorId({
      userId: q.userId ?? request.accessIdentity?.actorId,
      sessionId: q.sessionId ?? "",
    });
    const recentDays = Math.max(1, Math.min(30, Number.parseInt(q.days ?? "7", 10) || 7));
    const now = Date.now();

    // ── 画像事实 / 理解 / 生活模型：记忆组件按现有懒加载口取（未启用即空） ──
    let facts: OverviewFact[] = [];
    let understandings: OverviewUnderstanding[] = [];
    let entities: OverviewEntity[] = [];
    let relations: OverviewRelation[] = [];
    let profileLines: OverviewProfileLine[] = [];
    try {
      const { getMemoryComponents } = await import("../../agentic-memory/index.js");
      const components = getMemoryComponents();
      facts = (components.factStore?.getActiveFacts(actorId) ?? []).map(pickFact);
      understandings = (components.understandingStore?.getActiveUnderstandings(actorId) ?? []).map(
        (n) => ({ topic: n.topic, note: n.note, kind: n.kind }),
      );
      const store = components.lifeModel;
      if (store) {
        const all = store.listEntities(actorId);
        const byId = new Map(all.map((e) => [e.id, e]));
        entities = all
          .filter((e) => e.kind !== "self")
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.canonicalName,
            aliases: e.aliases,
            sensitivity: e.sensitivity,
            lastSeenAt: e.lastSeenAt,
            confidence: e.confidence,
          }));
        relations = store
          .getEdges(actorId)
          .filter((e) => e.kind !== "self_agent")
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            subKind: e.subKind,
            to: byId.get(e.toEntityId)?.canonicalName ?? e.toEntityId,
            intimacy: e.intimacy,
            status: e.status,
            sensitivity: e.sensitivity,
            updatedAt: e.updatedAt,
          }));
      }
    } catch {
      /* 记忆系统未启用 → 各分区走空态 */
    }
    try {
      const { UserProfileStore } = await import(
        "../../services/user-personalization/user-profile-store.js"
      );
      const { parseProfileLines, readProfileMeta } = await import("../../brain/profile-lines-meta.js");
      const markdown = await new UserProfileStore().read(actorId);
      const meta = await readProfileMeta(actorId);
      const metaByLine = new Map(meta.map((m) => [m.line, m]));
      profileLines = parseProfileLines(markdown).map((p) => ({
        section: p.section,
        line: p.line,
        lastConfirmedAt: metaByLine.get(p.line)?.lastConfirmedAt ?? null,
      }));
    } catch {
      /* 画像 md 读不到 → 只靠事实库 */
    }

    // ── 作息：只读节律引擎的推导结果（档案页不自己统计，§7.1） ──
    let rhythm: OverviewRhythm | null = null;
    try {
      const footprint = getPresenceFootprintStore();
      if (footprint) {
        const derived = footprint.deriveSleepWindow(actorId, { lookbackDays: 14 });
        rhythm = {
          sleepStartHour: derived.sleepStartHour,
          wakeHour: derived.wakeHour,
          nightCount: derived.nightCount,
          days: footprint.recentDays(actorId, 14).map((d) => ({
            date: d.date,
            firstHour: d.firstHour,
            lastHour: d.lastHour,
          })),
        };
      }
    } catch {
      /* 足迹未装配 */
    }

    const touchpoints = (() => {
      try {
        return deps.pipeline?.planSnapshot(actorId) ?? null;
      } catch {
        return null;
      }
    })();
    const outcomes = (() => {
      try {
        const window = deps.pipeline?.funnelWindow?.(30);
        return (window?.outcomes ?? []).filter((o) => o.actorId === actorId);
      } catch {
        return [];
      }
    })();

    const sources: ProfileOverviewSources = {
      actorId,
      recentDays,
      facts,
      profileLines,
      understandings,
      entities,
      relations,
      rhythm,
      touchpoints,
      goals: (() => {
        try {
          return deps.goalBoard?.list(actorId) ?? [];
        } catch {
          return [];
        }
      })(),
      tasks: (() => {
        try {
          return deps.scheduleTasks?.listTasksBySession(q.sessionId ?? actorId) ?? [];
        } catch {
          return [];
        }
      })(),
      ledger: (() => {
        try {
          return deps.ledger?.summary({ actorId, days: 30 }) ?? null;
        } catch {
          return null;
        }
      })(),
      audit: (() => {
        try {
          return deps.auditTrail?.timeline(actorId, 40) ?? [];
        } catch {
          return [];
        }
      })(),
      suppressions: (() => {
        try {
          return deps.suppressions?.list(actorId) ?? [];
        } catch {
          return [];
        }
      })(),
      outcomes,
    };
    return buildProfileOverview(sources, now);
  });
}
