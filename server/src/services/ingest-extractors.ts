/**
 * 数据入口（Ingest）——按信息形态划分的抽取器。
 *
 * 四种形态，四种抽取路径，**不按来源分支**：
 *
 *   extractStructured   .ics → 确定性解析（复用 ics-subscription-service 的 RFC5545 子集）
 *   extractTabular      .csv/.tsv/复制的表格 → 表头别名映射（矩阵式 / 长表式两种布局）
 *   extractProse        自然语言 / 邮件正文 → LLM 结构化
 *   extractImage        截图 → 视觉模型（注入，未配置则如实报缺）
 *
 * 设计取舍：
 *   1. **确定性优先**。ics 有规范、表格有表头，能算的绝不过模型——零 token、
 *      零幻觉、毫秒级。只有真需要"读懂"时才请 LLM。
 *   2. **抽不到就承认**。每个抽取器都返回 dropped（丢了几行、为什么），
 *      而不是静默吞掉。用户传一屏课表只认出 3 门课，必须能看见"另外 5 行
 *      因为缺节次被跳过"，否则会以为系统坏了。
 *   3. **周几节次不编日期**。课表截图没有校历就只能是"周一第1-2节"，
 *      硬算成某天会让整学期提醒全错（见 ingest-types 的说明）。
 */

import * as XLSX from "xlsx";

import {
  parseIcsCalendar,
  resolveIcsOccurrences,
  type IcsOccurrence,
} from "./ics-subscription-service.js";
import {
  isoWeekday,
  makeIngestItem,
  normalizeIngestTitle,
  parseWeekdayCN,
  validateIngestItem,
  type IngestExtractResult,
  type IngestItem,
  type IngestWeeklySlot,
} from "./ingest-types.js";

// ---------------------------------------------------------------------- //
// LLM / 视觉通道（结构化最小接口，与 pet-reaction 的约定一致）
// ---------------------------------------------------------------------- //

export interface IngestChatLike {
  isEnabled(): boolean;
  streamCompletion(
    sessionId: string,
    userTurn: { text: string; clientMessageId?: string },
    onDelta: (delta: string) => void,
    tools?: unknown,
    streamOpts?: {
      ephemeralTurn?: boolean;
      systemPromptOverride?: string;
      maxOutputTokens?: number;
      disableThinking?: boolean;
    },
  ): Promise<string>;
}

/**
 * 视觉抽取通道：输入图片 + 完整提示词，返回模型原文（应含 JSON）。
 *
 * 提示词由 {@link extractImage} 构造好再传进来——通道只负责"送达并取回文字"，
 * 不关心要抽什么，这样换模型/换接口都不用改抽取逻辑。
 *
 * 为什么不在这里直接调某个模型：视觉通路装配（选模型、判断该模型是否支持
 * image_url）属于 bootstrap 的事，抽取层只管"给我一张图，还我文字"。
 * 未注入时 extractImage 返回 needs，明确告诉用户"当前没配视觉模型"，
 * 绝不静默返回 0 条假装这张图是空的。
 */
export type IngestVisionExtract = (
  imageBase64: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

// ---------------------------------------------------------------------- //
// 共用：LLM 输出 → 条目
// ---------------------------------------------------------------------- //

/** 抽取用的 JSON 契约。写成常量便于 prompt 与解析共用同一份口径。 */
const ITEM_JSON_CONTRACT = `严格输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏：
{"items":[{"kind":"deadline|class|event|commitment","title":"事项名称","date":"YYYY-MM-DD","time":"HH:mm","endTime":"HH:mm","weekday":"周一","periods":"1-2","location":"地点","category":"分类","weeks":"1-16周","confidence":0.0~1.0}]}
规则：
- kind 判断：有明确截止/要交的 → deadline；每周固定重复的课 → class；一次性的会议/活动 → event；答应别人要做的事 → commitment。
- date/time 只在原文明确给出时填，**不要推算**；课表通常只有 weekday+periods，那就只填这两个。
- periods 用中文节次原文之外的数字区间，如 "1-2" 表示第1、2节；不确定就不填。
- confidence 是你对这条抽取正确性的自评，看不清/有歧义就低于 0.6。
- 同一门课在不同周几出现，输出多条，每条一个 weekday。`;

function safeParseJsonObject(raw: string): unknown {
  let text = (raw ?? "").trim();
  // 剥 markdown 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  // 取第一个 { 到最后一个 }（模型常在前后加解释）
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** "1-2" / "1,2" / "第1-2节" / "3" → [1,2] / [1,2] / [1,2] / [3] */
export function parsePeriods(raw: string | undefined): number[] {
  if (!raw) return [];
  const s = String(raw);
  const out = new Set<number>();
  const rangeRe = /(\d{1,2})\s*[-~至到]\s*(\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && b >= a && b <= 20) {
      for (let i = a; i <= b; i += 1) out.add(i);
    }
  }
  if (out.size === 0) {
    const singleRe = /\d{1,2}/g;
    while ((m = singleRe.exec(s))) {
      const n = Number(m[0]);
      if (n >= 1 && n <= 20) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * "2026-03-05" + "14:00" → ISO。缺时区的按本地时区解释（用户看到的就是本地时间）。
 * 拿不到合法日期返回 null——不猜。
 */
export function composeLocalIso(date?: string, time?: string): string | null {
  if (!date) return null;
  const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const tm = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  const hh = tm ? Number(tm[1]) : 0;
  const mm = tm ? Number(tm[2]) : 0;
  if (hh > 23 || mm > 59) return null;
  const dt = new Date(y, mo - 1, d, hh, mm, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  // 反查验证：2 月 31 日会被 Date 滚动成 3 月，视为非法
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.toISOString();
}

/** 模型返回的原始条目（结构宽松，全部字段可能缺失/类型错） */
interface RawModelItem {
  kind?: unknown;
  title?: unknown;
  date?: unknown;
  time?: unknown;
  endTime?: unknown;
  weekday?: unknown;
  periods?: unknown;
  location?: unknown;
  category?: unknown;
  weeks?: unknown;
  confidence?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** 把模型条目的松结构转成合法 IngestItem；不合法进 dropped。 */
export function normalizeModelItems(
  raw: unknown,
  evidenceLabel: string,
): { items: IngestItem[]; dropped: { count: number; reason: string }[] } {
  const dropped: { count: number; reason: string }[] = [];
  const list = Array.isArray((raw as { items?: unknown })?.items)
    ? ((raw as { items: unknown[] }).items)
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  if (list.length === 0) {
    dropped.push({ count: 1, reason: "模型未返回任何条目" });
    return { items: [], dropped };
  }

  const items: IngestItem[] = [];
  let badTime = 0;
  let noTime = 0;
  let noTitle = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      noTitle += 1;
      continue;
    }
    const r = entry as RawModelItem;
    const title = str(r.title);
    if (!title) {
      noTitle += 1;
      continue;
    }
    const kindRaw = str(r.kind)?.toLowerCase();
    const kind: IngestItem["kind"] =
      kindRaw === "deadline" || kindRaw === "class" || kindRaw === "event" || kindRaw === "commitment"
        ? kindRaw
        : "event";

    const weekday = r.weekday ? parseWeekdayCN(String(r.weekday)) : null;
    const periods = parsePeriods(str(r.periods));
    const weeklySlot: IngestWeeklySlot | undefined =
      weekday != null ? { weekday, periods, weeks: str(r.weeks) } : undefined;

    const startsAt = composeLocalIso(str(r.date), str(r.time)) ?? undefined;
    const endsAt = composeLocalIso(str(r.date), str(r.endTime)) ?? undefined;
    const dueAt = kind === "deadline" ? startsAt : undefined;

    if (!startsAt && !weeklySlot) {
      noTime += 1;
      continue;
    }
    if (startsAt && !Number.isFinite(Date.parse(startsAt))) {
      badTime += 1;
      continue;
    }

    const item = makeIngestItem({
      kind,
      title,
      startsAt,
      endsAt,
      dueAt,
      weeklySlot,
      location: str(r.location),
      category: str(r.category),
      confidence: typeof r.confidence === "number" ? r.confidence : 0.6,
      evidence: evidenceLabel,
    });
    const invalid = validateIngestItem(item);
    if (invalid) {
      if (invalid.includes("截止时间")) noTime += 1;
      else noTitle += 1;
      continue;
    }
    items.push(item);
  }

  if (noTitle > 0) dropped.push({ count: noTitle, reason: "缺少标题" });
  if (noTime > 0) dropped.push({ count: noTime, reason: "定位不到时间（既无日期也无周几节次）" });
  if (badTime > 0) dropped.push({ count: badTime, reason: "日期格式无法解析" });
  return { items, dropped };
}

// ---------------------------------------------------------------------- //
// 1. structured：ics
// ---------------------------------------------------------------------- //

/**
 * ics 确定性解析。周期事件按次展开成独立条目（课表型日历每周一条），
 * 这样"每周三 14:00 的课"会变成多条带绝对日期的记录，可直接进 DDL 雷达。
 *
 * 展开窗口默认 120 天：一个学期的课表大致在这个量级；再长的交给日历订阅轮询
 * （那条路会持续增量同步，一次性上传只需覆盖到下次上传为止）。
 */
export function extractStructured(
  text: string,
  now: Date,
  lookaheadDays = 120,
): IngestExtractResult {
  const events = parseIcsCalendar(text);
  if (events.length === 0) {
    return {
      items: [],
      extractor: "ics",
      dropped: [{ count: 1, reason: "文件里没有找到任何日历事件（BEGIN:VEVENT）" }],
    };
  }
  const startMs = now.getTime();
  const endMs = startMs + Math.min(365, Math.max(1, lookaheadDays)) * 86_400_000;
  const occurrences = resolveIcsOccurrences(events, startMs, endMs);
  const items: IngestItem[] = [];
  let skippedPast = 0;

  for (const occ of occurrences) {
    const startIso = occ.startIso;
    if (Date.parse(startIso) < startMs - 86_400_000) {
      skippedPast += 1;
      continue;
    }
    const startAt = new Date(startIso);
    const summary = occ.summary;
    const isDeadline = DDL_WORDS.test(summary);
    const item = makeIngestItem({
      kind: isDeadline ? "deadline" : "event",
      title: summary,
      startsAt: startIso,
      dueAt: isDeadline ? startIso : undefined,
      durationMinutes: occ.durationMinutes ?? undefined,
      location: occ.location,
      category: isDeadline ? "截止" : "日程",
      confidence: 1,
      evidence: `ics ${occ.uid}`,
      // ics 里带了绝对日期，同时给出周几节次没有意义（会干扰去重键），故意不填
    });
    if (!validateIngestItem(item)) items.push(item);
  }

  const dropped: { count: number; reason: string }[] = [];
  if (skippedPast > 0) dropped.push({ count: skippedPast, reason: "早于今天，已跳过" });
  return { items, extractor: "ics", dropped };
}

/** ics 摘要里出现这些词就当截止项而非普通日程（与 ddl-radar 的口径一致）。 */
const DDL_WORDS = /(截止|deadline|\bddl\b|\bdue\b|到期|提交|上交|答辩|考试|报名)/i;

// ---------------------------------------------------------------------- //
// 2. tabular：表格（矩阵式 / 长表式）
// ---------------------------------------------------------------------- //

/** RFC4180 风格的简单行切分：支持双引号包裹与 "" 转义。 */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * 自动判定分隔符。
 *
 * **不能只看第一行**：从教务系统/课表 App 复制出来的内容，首行常是
 * "2026-2027学年第一学期课表" 或 "姓名：张三 学号：xxx" 这种单列说明行，
 * 没有分隔符，按它判断会把整张表压成一列。取前几行的合计：制表符不小于
 * 逗号就用 TSV（从网页/Excel 复制的主流形态）。
 */
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  const tabs = (head.match(/\t/g) ?? []).length;
  const commas = (head.match(/,/g) ?? []).length;
  return tabs >= commas && tabs > 0 ? "\t" : ",";
}

/** 表头别名。**这是"任意来源都能接"的真正资产**，加来源时一般只需加别名。 */
const HEADER_ALIASES = {
  title: ["课程", "课程名称", "科目", "事项", "任务", "作业", "内容", "名称", "事件", "标题", "subject", "title", "course", "task", "name"],
  weekday: ["星期", "周几", "上课日", "weekday", "day", "日期"],
  periods: ["节次", "节", "时段", "时间", "period", "time"],
  location: ["教室", "地点", "位置", "上课地点", "场地", "location", "room", "place"],
  due: ["截止", "截止时间", "截止日期", "deadline", "due", "ddl", "交付日期"],
  category: ["类型", "分类", "类别", "category", "type"],
} as const;

type SheetLike = ReturnType<typeof XLSX.read>["Sheets"][string];
type CellRange = { s: { r: number; c: number }; e: { r: number; c: number } };

/**
 * `xlsx@0.18.5` 的**运行时**只有 `XLSX.utils.sheet_to_json`，顶层没有这个函数
 * （但项目里的 .d.ts 把它声明在了顶层，写 `XLSX.sheet_to_json` 能过类型检查、
 * 运行时直接 "is not a function"）。所以这里显式走 utils，并用局部类型断言
 * 绕开不完整的类型声明。
 */
const sheetToJson = (
  XLSX.utils as unknown as {
    sheet_to_json: (sheet: unknown, opts?: Record<string, unknown>) => unknown[][];
  }
).sheet_to_json;

/**
 * 单个 sheet → 二维字符串数组。
 *
 * 合并单元格必须展开：教务/自己画的课表极常用"一格跨两行"表示连堂课，
 * 展开前第二行是空的，抽取时会当成"没课"直接漏掉。
 */
function sheetToAoa(sheet: SheetLike): string[][] {
  const aoa = sheetToJson(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  }) as unknown as unknown[][];

  const merges = ((sheet as unknown as { "!merges"?: CellRange[] })["!merges"] ?? []) as CellRange[];
  for (const m of merges) {
    const v = aoa[m.s.r]?.[m.s.c];
    if (v == null || v === "") continue;
    for (let r = m.s.r; r <= m.e.r; r += 1) {
      const row = aoa[r];
      if (!row) continue;
      for (let c = m.s.c; c <= m.e.c; c += 1) row[c] = v;
    }
  }

  return aoa.map((row) =>
    (row ?? []).map((cell) => (cell == null ? "" : String(cell).replace(/\s+/g, " ").trim())),
  );
}

/**
 * Excel 文件 → 制表符分隔文本。
 *
 * 为什么要这一步：用户在 Excel 里整理好的课表/DDL 清单是最干净的数据源，
 * 但它是二进制，不解码就只剩一个文件名（表现是"上传成功了，但一条都没抽到"）。
 * 解成 TSV 之后直接复用 {@link extractTabular}，两种布局识别全都能吃到。
 *
 * 多 sheet 拼接：课表常见"总表 + 分学期"的做法，全部拼上再用表头探测兜住，
 * 比只取第一个 sheet 少丢数据。解不出来返回 null，由调用方如实报错。
 */
export function xlsxBase64ToText(fileBase64: string): string | null {
  if (!fileBase64) return null;
  try {
    const buf = Buffer.from(fileBase64, "base64");
    if (buf.length === 0) return null;
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const aoa = sheetToAoa(sheet);
      // 只留含真实文字的行：损坏/伪造的文件会被 xlsx 解出一堆控制字符，
      // 那种"内容"进到表格抽取只会变成找不到表头，不如直接判为解不出
      const lines = aoa
        .map((row) => row.join("\t"))
        .filter((l) => /[\p{L}\p{N}]/u.test(l));
      if (lines.length > 0) parts.push(lines.join("\n"));
    }
    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

/**
 * 表头 → 字段。**取命中最长的别名**，不是第一个命中的。
 *
 * 坑：「截止日期」既含 weekday 的别名「日期」，也含 due 的「截止日期」。
 * 按遍历顺序取首个会把截止列当成星期列，整张 DDL 清单变成"周几"。最长匹配
 * 让更具体的别名赢（「截止日期」4 字 > 「日期」2 字），规则简单且可预测。
 */
function matchHeader(header: string): keyof typeof HEADER_ALIASES | null {
  const h = header.toLowerCase().replace(/\s+/g, "");
  let best: { key: keyof typeof HEADER_ALIASES; len: number } | null = null;
  for (const key of Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]) {
    for (const alias of HEADER_ALIASES[key]) {
      const a = alias.toLowerCase();
      if (h.includes(a) && (!best || a.length > best.len)) best = { key, len: a.length };
    }
  }
  return best?.key ?? null;
}

/**
 * 表格抽取，两种布局都认：
 *
 * ① 矩阵式（教务系统/课表 App 复制出来的典型样子）——列头是周几：
 *      | 节次 | 周一 | 周二 |
 *      | 第1-2节 | 高等数学 A301 | |
 *
 * ② 长表式（自己整理的表、DDL 清单）——每行一条：
 *      | 课程 | 星期 | 节次 | 教室 |
 *      | 高数 | 周一 | 1-2 | A301 |
 *
 * 表头**不假设在第一行**：从教务网页/课表 App 复制出来的内容前面常带学期标题、
 * 姓名学号、空行。所以先在前 5 行里找"含两个以上周几"的行当矩阵式表头，
 * 找不到再退回第一行当长表表头。
 */
export function extractTabular(text: string): IngestExtractResult {
  const delimiter = detectDelimiter(text);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { items: [], extractor: "table", dropped: [{ count: 1, reason: "表格为空" }] };
  }

  const rows = lines.map((l) => splitDelimitedLine(l, delimiter));

  // 矩阵式表头探测：一行里出现 >=2 个"周几/星期X"就当表头
  let matrixHeaderIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i += 1) {
    const wdCount = rows[i].filter((cell) => parseWeekdayCN(cell) != null).length;
    if (wdCount >= 2) {
      matrixHeaderIdx = i;
      break;
    }
  }

  if (matrixHeaderIdx >= 0) {
    const header = rows[matrixHeaderIdx];
    const weekdayCols: { index: number; weekday: number }[] = [];
    header.forEach((h, i) => {
      const wd = parseWeekdayCN(h);
      if (wd != null) weekdayCols.push({ index: i, weekday: wd });
    });
    const result = extractMatrixTable(rows.slice(matrixHeaderIdx + 1), weekdayCols);
    if (matrixHeaderIdx > 0) {
      result.dropped.push({ count: matrixHeaderIdx, reason: "表头之前的标题/说明行已跳过" });
    }
    return result;
  }

  return extractLongTable(rows);
}

function extractMatrixTable(
  dataRows: string[][],
  weekdayCols: { index: number; weekday: number }[],
): IngestExtractResult {
  const items: IngestItem[] = [];
  let noPeriods = 0;

  // 第一列常是"节次/时间"标签；若认不出，就按行序当第 1、2、3 节（并如实降级）
  const firstColIsPeriod = dataRows.some(
    (r) => /[第\d]/u.test(r[0] ?? "") && /节/.test(r[0] ?? ""),
  );

  dataRows.forEach((row, rowIdx) => {
    const label = row[0] ?? "";
    const periods = firstColIsPeriod ? parsePeriods(label) : [rowIdx + 1];
    if (firstColIsPeriod && periods.length === 0) noPeriods += 1;

    for (const col of weekdayCols) {
      const cell = (row[col.index] ?? "").replace(/\r?\n/g, " ").trim();
      if (!cell || /^[-—–/\\]+$/.test(cell) || /^(无|空|休息)$/.test(cell)) {
        // 空格子是课表的常态（没课），不是错误，不计数
        continue;
      }
      // 单元格常见形态："高等数学\n张老师\nA301" / "高等数学 A301" / "高等数学(1-16周)"
      const parts = cell.split(/[\s/]+/).filter(Boolean);
      const title = (parts[0] ?? cell).replace(/[()（）]/g, "");
      const weeksMatch = /(\d{1,2}\s*[-~]\s*\d{1,2}\s*周|单周|双周)/.exec(cell);
      const locationMatch = /([A-Za-z]?\d{2,4}|[A-Za-z]+\d*[-—]\d+|[一二三四五六七八九十]教\S*)/.exec(
        cell.replace(title, ""),
      );
      const item = makeIngestItem({
        kind: "class",
        title,
        weeklySlot: {
          weekday: col.weekday,
          periods,
          weeks: weeksMatch?.[1],
        },
        location: locationMatch?.[1],
        category: "课程",
        confidence: firstColIsPeriod ? 0.9 : 0.6,
        evidence: `${label || "第" + (rowIdx + 1) + "行"} × 周${col.weekday}: ${cell}`,
      });
      if (!validateIngestItem(item)) items.push(item);
    }
  });

  const dropped: { count: number; reason: string }[] = [];
  if (noPeriods > 0) dropped.push({ count: noPeriods, reason: "有课程行认不出节次" });
  const merged = coalesceSessions(items);
  const needs: string[] = [];
  if (merged.length > 0) needs.push("课表只有周几与节次，需要校历（开学日期 + 每节课时间）才能变成具体日期");
  return {
    items: merged,
    extractor: "table-matrix",
    dropped,
    needs,
  };
}

/** 把节次集合切成连续段：[1,2,3,4] → [[1,2,3,4]]；[1,2,5,6] → [[1,2],[5,6]] */
function coalescePeriods(list: number[]): number[][] {
  const sorted = [...new Set(list)].filter((n) => n > 0).sort((a, b) => a - b);
  const out: number[][] = [];
  let cur: number[] = [];
  for (const n of sorted) {
    if (cur.length === 0 || n === cur[cur.length - 1] + 1) cur.push(n);
    else {
      out.push(cur);
      cur = [n];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 连堂合并。
 *
 * Excel/矩阵课表里"一格跨两行"表示连堂，展开合并单元格后同一门课会出现两条
 *（第1-2节 / 第3-4节）。按 周几+标题+地点 聚合后把连续节次连成一段，
 * 既不漏课，也不会把一门连堂课算成两门。
 *
 * 不连续的两段（上午一节、下午一节）仍然分开——那是真的两段课。
 */
function coalesceSessions(items: IngestItem[]): IngestItem[] {
  const kept: IngestItem[] = [];
  const buckets = new Map<
    string,
    { base: IngestItem; periods: number[]; evidence: string[] }
  >();

  for (const item of items) {
    const slot = item.weeklySlot;
    if (!slot) {
      kept.push(item);
      continue;
    }
    const key = `${slot.weekday}|${normalizeIngestTitle(item.title)}|${item.location ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.periods.push(...slot.periods);
      if (item.evidence) bucket.evidence.push(item.evidence);
    } else {
      buckets.set(key, {
        base: item,
        periods: [...slot.periods],
        evidence: item.evidence ? [item.evidence] : [],
      });
    }
  }

  for (const bucket of buckets.values()) {
    const runs = coalescePeriods(bucket.periods);
    // 没认过节次的一段：保持原样，不要凭空补一个节次
    const effectiveRuns = runs.length > 0 ? runs : [[]];
    for (const run of effectiveRuns) {
      kept.push(
        makeIngestItem({
          kind: bucket.base.kind,
          title: bucket.base.title,
          startsAt: bucket.base.startsAt,
          endsAt: bucket.base.endsAt,
          dueAt: bucket.base.dueAt,
          durationMinutes: bucket.base.durationMinutes,
          weeklySlot: {
            weekday: bucket.base.weeklySlot!.weekday,
            periods: run,
            weeks: bucket.base.weeklySlot!.weeks,
          },
          location: bucket.base.location,
          category: bucket.base.category,
          confidence: bucket.base.confidence,
          evidence: bucket.evidence.join(" / ") || undefined,
        }),
      );
    }
  }
  return kept;
}

function extractLongTable(rows: string[][]): IngestExtractResult {
  const header = rows[0];
  const colMap = new Map<keyof typeof HEADER_ALIASES, number>();
  header.forEach((h, i) => {
    const key = matchHeader(h);
    if (key && !colMap.has(key)) colMap.set(key, i);
  });

  const titleIdx = colMap.get("title");
  if (titleIdx == null) {
    return {
      items: [],
      extractor: "table-long",
      dropped: [{ count: rows.length - 1, reason: "表头里找不到「课程/事项/任务」这类标题列" }],
    };
  }

  const items: IngestItem[] = [];
  let noTime = 0;

  rows.slice(1).forEach((row) => {
    const title = row[titleIdx]?.trim();
    if (!title) return;

    const weekdayRaw = colMap.has("weekday") ? row[colMap.get("weekday")!] : "";
    const weekday = weekdayRaw ? parseWeekdayCN(weekdayRaw) : null;
    const periodsRaw = colMap.has("periods") ? row[colMap.get("periods")!] : "";
    const periods = parsePeriods(periodsRaw);

    const dueRaw = colMap.has("due") ? (row[colMap.get("due")!] ?? "") : "";
    const dueIso = parseLooseDateTime(dueRaw);

    // 表格里的"时间"列可能是绝对日期，也可能只是节次；先试绝对
    const periodsIsDate = !dueIso && periodsRaw ? parseLooseDateTime(periodsRaw) : null;
    const absolute = dueIso ?? periodsIsDate;

    if (!absolute && weekday == null) {
      noTime += 1;
      return;
    }

    const kind: IngestItem["kind"] = absolute && (DDL_WORDS.test(title) || /截止|deadline|ddl/i.test(header.join("")))
      ? "deadline"
      : weekday != null
        ? "class"
        : "event";

    const item = makeIngestItem({
      kind,
      title,
      startsAt: absolute ?? undefined,
      dueAt: kind === "deadline" ? (absolute ?? undefined) : undefined,
      weeklySlot: weekday != null ? { weekday, periods } : undefined,
      location: colMap.has("location") ? row[colMap.get("location")!]?.trim() || undefined : undefined,
      category: colMap.has("category") ? row[colMap.get("category")!]?.trim() || undefined : "未分类",
      confidence: absolute ? 0.9 : 0.85,
      evidence: row.filter(Boolean).join(" | "),
    });
    if (!validateIngestItem(item)) items.push(item);
  });

  const dropped: { count: number; reason: string }[] = [];
  if (noTime > 0) dropped.push({ count: noTime, reason: "定位不到时间（既无日期也无周几）" });
  return { items, extractor: "table-long", dropped };
}

/**
 * 宽松日期时间解析（表格单元格用）。认这些形态：
 *   2026-03-05 / 2026/3/5 / 3月5日 / 3/5（当年）/ 2026-03-05 14:00 / 3月5日 下午2点
 * 认不出返回 null——**不猜年份之外的任何东西**。
 */
export function parseLooseDateTime(raw: string, now = new Date()): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  // 2026-03-05 [14:00] / 2026/3/5
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(s);
  let y: number | null = null;
  let mo: number | null = null;
  let d: number | null = null;
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    // 3月5日 / 3/5
    m = /(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/.exec(s);
    if (m) {
      y = now.getFullYear();
      mo = Number(m[1]);
      d = Number(m[2]);
    }
  }
  if (y == null || mo == null || d == null) return null;

  // 时间：14:00 / 下午2点 / 上午9:30
  let hh = 0;
  let mm = 0;
  const tm = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s);
  const cn = /(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分)?/.exec(s);
  if (tm) {
    hh = Number(tm[1]);
    mm = Number(tm[2]);
    if (/下午|晚上/.test(s) && hh < 12) hh += 12;
  } else if (cn) {
    hh = Number(cn[2]);
    mm = cn[3] ? Number(cn[3]) : 0;
    if ((cn[1] === "下午" || cn[1] === "晚上") && hh < 12) hh += 12;
  }
  if (hh > 23 || mm > 59) return null;

  const dt = new Date(y, mo - 1, d, hh, mm, 0, 0);
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.toISOString();
}

// ---------------------------------------------------------------------- //
// 3. prose：自然语言 / 邮件正文 → LLM
// ---------------------------------------------------------------------- //

const PROSE_SYSTEM_PROMPT = `你是日程信息抽取器。从用户给的材料里抽取出结构化的时间事项。
只输出 JSON。宁缺毋滥：看不清的时间不要编。
今天是 ${""}（以用户消息中给出的当前日期为准）。`;

/**
 * 文本抽取。走一次性 LLM（ephemeral，不进对话线程、不污染前缀缓存）。
 *
 * 超时 20s：抽取是用户主动上传后等结果的同步链路，比桌宠台词宽松得多，
 * 但也要有上限，否则前端转圈到天荒地老。
 */
export async function extractProse(
  text: string,
  opts: {
    chat: IngestChatLike | null;
    now: Date;
    hint?: string;
    sessionId: string;
    timeoutMs?: number;
  },
): Promise<IngestExtractResult> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { items: [], extractor: "prose-llm", dropped: [{ count: 1, reason: "内容为空" }] };
  }
  if (!opts.chat || !opts.chat.isEnabled()) {
    return {
      items: [],
      extractor: "prose-llm",
      dropped: [],
      error: "当前没有可用的语言模型，无法解析这段文字。可以改传 .ics / .csv 文件，这两种不需要模型。",
    };
  }

  const nowIso = opts.now.toISOString();
  const system = `${PROSE_SYSTEM_PROMPT.replace("今天是 （以用户消息中给出的当前日期为准）。", `今天是 ${nowIso}（本地时区）。`)}
${ITEM_JSON_CONTRACT}`;
  const userText = [
    opts.hint ? `材料类型提示：${opts.hint}` : "",
    "---- 材料开始 ----",
    trimmed.slice(0, 12_000), // 防超长文本打爆上下文；截断处会体现在 dropped 里
    "---- 材料结束 ----",
  ]
    .filter(Boolean)
    .join("\n");

  const timeoutMs = opts.timeoutMs ?? 20_000;
  let raw = "";
  try {
    raw = await Promise.race([
      opts.chat.streamCompletion(
        opts.sessionId,
        { text: userText },
        () => {
          /* 一次性抽取不流式展示，delta 丢弃 */
        },
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxOutputTokens: 2000,
          systemPromptOverride: system,
        },
      ),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`抽取超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    return {
      items: [],
      extractor: "prose-llm",
      dropped: [],
      error: `解析失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = safeParseJsonObject(raw);
  if (!parsed) {
    return {
      items: [],
      extractor: "prose-llm",
      dropped: [{ count: 1, reason: "模型没有按 JSON 格式返回" }],
      error: "解析失败：模型输出的不是结构化数据，可以重试或改用表格/ics",
    };
  }

  const { items, dropped } = normalizeModelItems(parsed, "文本材料");
  const result: IngestExtractResult = { items, extractor: "prose-llm", dropped };
  if (trimmed.length > 12_000) {
    result.needs = [`材料过长，只解析了前 12000 字（共 ${trimmed.length} 字）`];
  }
  return result;
}

// ---------------------------------------------------------------------- //
// 4. image：截图 → 视觉模型
// ---------------------------------------------------------------------- //

/**
 * 图片抽取。**必须注入视觉通道**——服务端不会自己挑模型，因为"当前模型是否
 * 支持 image_url"是运行时信息（见 external-model/vision-support.ts）。
 *
 * 未注入时返回明确错误而不是 0 条：用户传了课表截图却什么都没发生，
 * 比报错更让人困惑。
 */
export async function extractImage(
  imageBase64: string,
  mimeType: string,
  opts: {
    visionExtract?: IngestVisionExtract | null;
    hint?: string;
    timeoutMs?: number;
  },
): Promise<IngestExtractResult> {
  if (!imageBase64) {
    return { items: [], extractor: "image-vlm", dropped: [{ count: 1, reason: "没有收到图片数据" }] };
  }
  if (!opts.visionExtract) {
    return {
      items: [],
      extractor: "image-vlm",
      dropped: [],
      error:
        "当前没有配置视觉模型，读不了图片。可以改传 .ics 文件，或把课表文字复制成表格粘贴进来——这两种路径不需要视觉模型。",
    };
  }

  const prompt = [
    "请把这张图片里的时间信息抽取成结构化数据。",
    opts.hint ? `图片类型提示：${opts.hint}` : "",
    "课表截图通常是一个二维表：行是节次、列是周一到周日，格子里的文字是课程名/教室/老师。",
    "请按每个「非空格子」输出一条，weekday 用「周一」这种写法，periods 用数字区间。",
    ITEM_JSON_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n");

  const timeoutMs = opts.timeoutMs ?? 30_000;
  let raw = "";
  try {
    raw = await Promise.race([
      opts.visionExtract(imageBase64, mimeType, prompt),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`视觉解析超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    return {
      items: [],
      extractor: "image-vlm",
      dropped: [],
      error: `读图失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = safeParseJsonObject(raw);
  if (!parsed) {
    return {
      items: [],
      extractor: "image-vlm",
      dropped: [{ count: 1, reason: "视觉模型没有按 JSON 返回" }],
      error: "读图失败：模型输出不是结构化数据，可以裁剪截图后重试（只截课表区域，去掉页眉广告）",
    };
  }
  const { items, dropped } = normalizeModelItems(parsed, "截图");
  return { items, extractor: "image-vlm", dropped };
}

// ---------------------------------------------------------------------- //
// 汇总：按形态分发
// ---------------------------------------------------------------------- //

/** 供测试与展示用：把「周几节次」翻译成人话 */
export function describeWeeklySlot(item: IngestItem): string | null {
  const slot = item.weeklySlot;
  if (!slot) return null;
  const day = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][slot.weekday] ?? "";
  const periods = slot.periods.length > 0 ? `第${slot.periods.join("、")}节` : "节次未知";
  const weeks = slot.weeks ? ` ${slot.weeks}` : "";
  return `${day} ${periods}${weeks}`;
}

/** 供测试断言：条目在本地时区的相对天数 */
export function daysFrom(now: Date, iso: string): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso);
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** 供测试断言：ISO 转本地周几 */
export function weekdayOfIso(iso: string): number {
  return isoWeekday(new Date(iso));
}
