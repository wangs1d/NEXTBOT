/**
 * 数据入口（Ingest）——统一条目模型。
 *
 * 定位（2026-10-22）：**不为每个数据源写适配器，只为每种信息形态写抽取器。**
 *
 * 原方案的坑：课表、行程表、DDL、会议邀请……如果按"来源"写 fromXxx，
 * 每来一个新来源（超级课程表、飞书日历、教务系统、健身房课表）就要加一次
 * 代码，用户永远等不到。真正稳定的分类维度是**载体里装的是什么形态的信息**，
 * 而形态只有四种：
 *
 *   - structured  机器可读（.ics / .csv / .xlsx）→ 确定性解析，零 LLM 零 token
 *   - tabular     半结构化（从教务网页复制的表格、聊天里的排班表）→ 列映射
 *   - image       位图（手机截图、教室门口拍的课表）→ 视觉模型
 *   - prose       自然语言（"每周二三四上午有课"、邮件正文）→ LLM 结构化
 *
 * 四种形态覆盖全来源。加来源 = 用户自己传，不需要改代码。
 *
 * ## 为什么条目要分「有时刻」和「无时刻」两种
 *
 * 截图里拿到的课表是「周一 第1-2节 高等数学 A301」，**没有绝对日期**——
 * 学期第一周是哪天取决于校历，抽取层不知道也不该猜。强行编一个日期
 * 会导致 16 周里 15 周的提醒全错（铁律：不预测，只验证）。
 *
 * 所以：
 *   - `startsAt`   绝对时刻（DDL 截止、单次会议、已带日期的课）→ 可进 DDL 雷达
 *   - `weeklySlot` 相对时刻（周几 + 第几节）→ 落成 `weekly` 周期日程（见
 *     ingest-schedule-bridge）：**不需要校历**，周期日程只要"下一个周几"做基准日。
 *     校历只影响单双周/停课这类更高精度，不阻塞提醒生效。
 *
 * 两者互斥但都可选；都没有的条目视为无效（抽取失败），不进草稿。
 */

/** 条目语义类别。决定落库去向与展示分组，不决定来源。 */
export type IngestItemKind = "deadline" | "class" | "event" | "commitment";

export const INGEST_ITEM_KINDS: readonly IngestItemKind[] = [
  "deadline",
  "class",
  "event",
  "commitment",
] as const;

/**
 * 相对时刻：周几 + 第几节。
 * `weekday` 用 ISO 口径（1=周一 … 7=周日），与 Date.getDay() 的 0=周日不同，
 * 转换见 {@link isoWeekday}。`periods` 是节次序号（1 起），拿不到就空数组。
 */
export interface IngestWeeklySlot {
  weekday: number;
  periods: number[];
  /** 周次范围原文（如 "1-16周" / "单周"），仅展示与提醒用，不参与排期计算 */
  weeks?: string;
}

export interface IngestItem {
  /**
   * 稳定自然键（不含来源、不含时间戳）：同一件事重复上传时靠它认出"还是那条"。
   * 由 {@link buildItemKey} 生成，抽取器不需要自己拼。
   */
  key: string;
  kind: IngestItemKind;
  title: string;
  /** 绝对开始时刻（ISO）。课表只有周几节次时留空。 */
  startsAt?: string;
  /** 绝对结束时刻（ISO），有 duration 时优于 durationMinutes */
  endsAt?: string;
  /** 截止时刻（ISO）。kind=deadline 时一般等于 startsAt，单独留字段便于语义清楚 */
  dueAt?: string;
  durationMinutes?: number;
  weeklySlot?: IngestWeeklySlot;
  location?: string;
  /** 课程/事项分类（如 "专业课" / "考试" / "会议"），抽取不到就空 */
  category?: string;
  /**
   * 抽取置信度 0~1。预览页据此决定默认是否勾选：
   * 确定性解析恒 1；LLM/视觉抽取按模型自评，低于 0.6 默认不勾，让用户确认。
   */
  confidence: number;
  /** 证据片段（原文一行 / 图片中的位置描述），预览页展示供人核对，不落库 */
  evidence?: string;
}

/** 单次抽取的结果与诊断。抽取失败必须如实说明原因，不能返回空数组假装成功。 */
export interface IngestExtractResult {
  items: IngestItem[];
  /** 实际使用的抽取器 id（便于用户/排查理解"为什么这么慢/这么快"） */
  extractor: string;
  /** 被丢弃的行数与原因（如"3 行缺少时间，无法定位"） */
  dropped: { count: number; reason: string }[];
  /** 需要用户补齐的外部条件（如缺校历无法把周几节次变成日期） */
  needs?: string[];
  /** 抽取器级失败原因（此时 items 必为空） */
  error?: string;
}

// ---------------------------------------------------------------------- //
// 载体判定
// ---------------------------------------------------------------------- //

/**
 * 载体形态。注意 `structured` 与 `tabular` 的区别是**是否可无歧义解析**，
 * 不是文件后缀：.csv 是 tabular（列名靠猜），.ics 是 structured（有规范）。
 */
export type IngestPayloadKind = "structured" | "tabular" | "image" | "prose";

export interface IngestPayload {
  kind: IngestPayloadKind;
  /** 纯文本内容（structured/tabular/prose 必填；.ics 文件也走这里，客户端读成文本） */
  text?: string;
  /**
   * 二进制文件（base64，不含 data: 前缀）。**目前只用于 xlsx/xls**：
   * Excel 课表是用户最常见的"整理好的表"，不解码就只剩一个文件名。
   * ics 是纯文本，客户端直接读成 text 传过来即可，不需要走二进制。
   */
  fileBase64?: string;
  /** 图片（base64，不含 data: 前缀） */
  imageBase64?: string;
  imageMimeType?: string;
  /** 文件名，用于识别 .ics/.csv/.xlsx 与展示 */
  fileName?: string;
  /**
   * 用户给的提示（"这是课表" / "这是这学期的作业安排"）。
   * 只当提示词用，不参与分支判断——分支只按载体形态走。
   */
  hint?: string;
}

/**
 * 从文件名/提示推断形态。判定顺序刻意把 structured 放最前：
 * .ics 无论用户怎么称呼都必须走确定性解析（最准、最省）。
 */
export function detectPayloadKind(payload: IngestPayload): IngestPayloadKind {
  if (payload.imageBase64) return "image";
  const name = (payload.fileName ?? "").toLowerCase();
  const text = payload.text ?? "";
  if (name.endsWith(".ics") || name.endsWith(".ical")) return "structured";
  if (/^\s*BEGIN:VCALENDAR/im.test(text)) return "structured";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "tabular";
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "tabular";
  // CSV 冒烟：至少两行，且首行含逗号/制表符分隔的多个字段
  if (/[,\t]/.test(text.split("\n")[0] ?? "") && text.split("\n").length >= 2) {
    return "tabular";
  }
  return "prose";
}

// ---------------------------------------------------------------------- //
// 自然键与归一化
// ---------------------------------------------------------------------- //

/** 标题归一：去空白、全半角括号统一、小写。跨来源对同一件事稳定可比。 */
export function normalizeIngestTitle(raw: string): string {
  return (raw ?? "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[【\[]/g, "[")
    .replace(/[】\]]/g, "]")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 生成条目自然键。
 *
 * 关键取舍：**键里不放 startsAt**。课表改期、DDL 延期时，用户重传的目的是
 * "更新那一条"，而不是"多出一条"。若把时间编进键，同一门课换个教室就会变成
 * 两条重复。时间变化由 commit 阶段的 diff 处理（同键不同时 → 更新）。
 *
 * 但 `kind` 要进键：同一标题周一时是课、期末是考试，语义不同不该合并。
 */
export function buildItemKey(item: Pick<IngestItem, "kind" | "title" | "weeklySlot">): string {
  const title = normalizeIngestTitle(item.title);
  const slot = item.weeklySlot
    ? `@${item.weeklySlot.weekday}-${item.weeklySlot.periods.join(".")}`
    : "";
  return `${item.kind}:${title}${slot}`;
}

/** ISO 口径周几（1=周一 … 7=周日），Date.getDay() 是 0=周日，差一。 */
export function isoWeekday(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/** 中文周几 → ISO 数字；识别不到返回 null（不要瞎猜成周一）。 */
export function parseWeekdayCN(raw: string): number | null {
  const s = raw.trim();
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
  };
  const m = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/.exec(s);
  if (m) {
    const token = m[1];
    if (/[1-7]/.test(token)) return Number(token);
    return map[token] ?? null;
  }
  // 纯英文缩写（ics 里常见）
  const en = /^(mon|tue|wed|thu|fri|sat|sun)/i.exec(s);
  if (en) {
    return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(en[1].toLowerCase()) + 1;
  }
  return null;
}

/** 修剪标题到可展示长度（不改变语义，只在超长时截断加省略号）。 */
export function clipIngestTitle(raw: string, max = 40): string {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "未命名事项";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * 条目合法性闸门。返回 null 表示可用，否则返回不可用原因。
 *
 * 拒绝条件（宁可少收，不能收错）：
 *   - 标题为空
 *   - kind=deadline 但没有可用截止时刻（没截止时间的"作业"进不了 DDL 雷达，
 *     也提醒不了，收进来只会变成一条永远不动的僵尸）
 *   - 既无绝对时刻也无周几节次（定位不到任何时间点，无法展示也无法提醒）
 *   - 时间不可解析
 */
export function validateIngestItem(item: IngestItem): string | null {
  if (!item.title || !normalizeIngestTitle(item.title)) return "标题为空";
  const hasAbsolute = Boolean(item.startsAt || item.dueAt);
  const hasSlot = Boolean(item.weeklySlot && item.weeklySlot.weekday >= 1 && item.weeklySlot.weekday <= 7);
  if (item.kind === "deadline" && !hasAbsolute) return "截止项缺少截止时间";
  if (!hasAbsolute && !hasSlot) return "既无时刻也无周几节次，无法定位";
  for (const iso of [item.startsAt, item.dueAt, item.endsAt]) {
    if (iso && !Number.isFinite(Date.parse(iso))) return "时间不可解析";
  }
  return null;
}

/** 构造条目并补齐 key / 置信度裁剪。抽取器统一走这里，避免各自拼字段。 */
export function makeIngestItem(
  raw: Omit<IngestItem, "key" | "confidence"> & { confidence?: number },
): IngestItem {
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 1;
  const item: IngestItem = {
    ...raw,
    title: clipIngestTitle(raw.title),
    confidence,
    key: "",
  };
  item.key = buildItemKey(item);
  return item;
}
