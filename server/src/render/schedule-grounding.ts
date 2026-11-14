/**
 * 日程查询轮正文对账（2026-11-15「红树林赶海」编造事故的根修防线）。
 *
 * 背景：模型在回答「明天的日程安排」时，正文虚构了数据库里不存在的日程
 * （「十点半红树林赶海」「傍晚海边溜达一圈」），而 list_tasks 回执只有 1 条
 * 真实日程。prompt 级约束（工具描述/快照脚注/场景边界）只是请求不是保证——
 * 本模块把对账做成确定性管线步骤：凡本轮存在 calendar.list_tasks 回执，
 * 正文里每一条「时间锚定的日程主张」必须能在回执任务（按任务时区的本地钟点）
 * 或任务标题里找到依据，找不到的子句整条剔除，不依赖模型自觉。
 *
 * 判定原则（宁可漏判、不可误杀）：
 *   - 只在本轮真的查过日程（list_tasks 回执在场）时激活；其他轮原样放行。
 *   - 钟点主张（八点/十点半/HH:MM）恒判定；时段主张（傍晚/晚上等）仅在
 *     正文处于「枚举模式」（含钟点主张或 ≥2 条时段主张）时判定，避免误伤
 *     「晚上早点睡」这类口语收尾。
 *   - 无时间信号的中性子句随锚继承：紧跟被剔子句的描述性从句一并剔除
 *     （「记得看退潮时间，穿能下水的鞋」不会孤悬），紧跟有据子句的照常保留。
 *   - 「第一时间」「退潮时间」等伪钟点（时+间/候/刻）不构成主张。
 *   - 句号/换行重置锚，「就这些，别再问了，睡。」这类语气句永不误杀。
 *
 * 时机安全性：文字回复只由 assistant_done.finalText 一次性落屏（打字机已
 * 退役），且日程卡轮 tool-loop holdAnswer 不流式——renderTurn(full) 在
 * done 装配前运行，剔除发生在用户看到之前。cards-only 是 done 阶段补卡，
 * 正文已定稿，不做对账。
 */

import type { TurnEffect } from "./types.js";

export interface GroundedTask {
  hour: number;
  minute: number;
  /** 回执里的任务标题（提醒消息优先），用于标题子串兜底判定 */
  title: string;
}

export interface ScheduleGroundingResult {
  text: string;
  /** 被剔除的子句（观测口径：日志/测试断言用） */
  strippedClauses: string[];
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → 整数（支持 十一/二十/二十三/两 等口语形态） */
function cnNumeralToInt(raw: string): number {
  if (raw.includes("十")) {
    const [left, right] = raw.split("十");
    const tens = left ? (CN_DIGIT[left] ?? NaN) : 1;
    const ones = right ? (CN_DIGIT[right] ?? NaN) : 0;
    return tens * 10 + ones;
  }
  return CN_DIGIT[raw] ?? NaN;
}

/**
 * 钟点主张：HH:MM / 8点 / 8点半 / 8点30(分) / 十点半 / 十一点五十五(分)。
 * 「时」后跟 间/候/刻 视为普通词（第一时间/时候/时刻），不算钟点。
 */
const CLOCK_RE =
  /(\d{1,2})\s*[:：]\s*(\d{2})|(\d{1,2})\s*[点时](?!间|候|刻)\s*(半|(\d{1,2})\s*分?)?|([零一二两三四五六七八九十]{1,3})\s*[点时](?!间|候|刻)\s*(半|([零一二三四五六七八九十]{1,3})\s*分?)?/;

export function parseClockClaim(clause: string): { hour: number; minute: number } | null {
  const m = CLOCK_RE.exec(clause);
  if (!m) return null;
  if (m[1] != null) {
    // HH:MM
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return validClock(hour, minute);
  }
  if (m[3] != null) {
    // 阿拉伯数字 + 点/时
    const hour = Number(m[3]);
    const minute = m[4] === "半" ? 30 : m[5] != null ? Number(m[5]) : 0;
    return validClock(hour, minute);
  }
  if (m[6] != null) {
    // 中文数字 + 点/时
    const hour = cnNumeralToInt(m[6]);
    const minute = m[7] === "半" ? 30 : m[8] != null ? cnNumeralToInt(m[8]) : 0;
    return validClock(hour, Number.isNaN(minute) ? -1 : minute);
  }
  return null;
}

function validClock(hour: number, minute: number): { hour: number; minute: number } | null {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** 时段主张：词 → [起, 止) 小时区间（b>24 表示跨午夜，按 wrap 判） */
const DAYPARTS: Array<[RegExp, number, number]> = [
  [/凌晨/, 3, 6],
  [/清晨|早上|早晨|早间/, 5, 11],
  [/上午/, 8, 12],
  [/中午|午间/, 11, 14],
  [/午后|下午/, 13, 18],
  [/傍晚|黄昏/, 17, 19],
  [/晚上|晚间|夜里|夜晚|今晚|明晚|夜间/, 18, 24],
  [/深夜|半夜|午夜/, 22, 26],
];

function hourInDaypart(hour: number, from: number, to: number): boolean {
  return to <= 24 ? hour >= from && hour < to : hour >= from || hour < to - 24;
}

/** 回执任务按其时区的本地钟点（与调度器/日程页同口径） */
function taskClock(task: Record<string, unknown>): { hour: number; minute: number } | null {
  const raw = String(task.nextRunAt ?? task.runAt ?? "").trim();
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  const tz = typeof task.timezone === "string" ? task.timezone.trim() : "";
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(ms));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const hour = Number(get("hour"));
      const minute = Number(get("minute"));
      return validClock(hour, minute);
    } catch {
      // 非法时区：落到服务器本地口径
    }
  }
  const d = new Date(ms);
  return validClock(d.getHours(), d.getMinutes());
}

/** 本轮 list_tasks 回执里的权威任务集（回执在场 = 本轮真的查过日程） */
export function collectGroundingTasks(effects: TurnEffect[] | undefined): {
  queried: boolean;
  tasks: GroundedTask[];
} {
  const tasks: GroundedTask[] = [];
  let queried = false;
  for (const effect of effects ?? []) {
    if (effect.tool !== "calendar" || !effect.result) continue;
    const result = effect.result as Record<string, unknown>;
    if (result.action !== "list_tasks") continue;
    queried = true;
    const list = Array.isArray(result.tasks) ? result.tasks : [];
    for (const task of list) {
      if (!task || typeof task !== "object") continue;
      const t = task as Record<string, unknown>;
      const clock = taskClock(t);
      if (!clock) continue;
      const title = String(t.title ?? "").trim();
      tasks.push({ ...clock, title });
    }
  }
  return { queried, tasks };
}

function clockGrounded(
  claim: { hour: number; minute: number },
  tasks: GroundedTask[],
): boolean {
  return tasks.some((t) => t.hour === claim.hour && t.minute === claim.minute);
}

function titleGrounded(clause: string, tasks: GroundedTask[]): boolean {
  return tasks.some((t) => t.title.length >= 2 && clause.includes(t.title));
}

const DELIM_CHARS = new Set(["，", "。", "！", "？", "!", "?", "；", ";", "\n"]);

interface ClauseToken {
  text: string;
  delim: string;
}

/** 按子句/句子切分，保留原标点（含连续标点与段前换行）以便按序重组 */
function tokenize(sentence: string): ClauseToken[] {
  const tokens: ClauseToken[] = [];
  let text = "";
  let idx = 0;
  while (idx < sentence.length) {
    const ch = sentence[idx]!;
    if (DELIM_CHARS.has(ch)) {
      let delim = "";
      while (idx < sentence.length && DELIM_CHARS.has(sentence[idx]!)) {
        delim += sentence[idx]!;
        idx += 1;
      }
      tokens.push({ text, delim });
      text = "";
    } else {
      text += ch;
      idx += 1;
    }
  }
  if (text) tokens.push({ text, delim: "" });
  return tokens;
}

export function groundScheduleBody(
  text: string,
  effects: TurnEffect[] | undefined,
): ScheduleGroundingResult {
  const strippedClauses: string[] = [];
  const { queried, tasks } = collectGroundingTasks(effects);
  if (!queried || !text) return { text, strippedClauses };

  // 语义切句（。！？!?；;换行），句内再切子句（，、）。锚只在句内继承。
  const sentences = text.split(/(?<=[。！？!?；;\n])/);

  let clockClaimCount = 0;
  let daypartClaimCount = 0;
  for (const sentence of sentences) {
    if (parseClockClaim(sentence)) clockClaimCount += 1;
    else if (DAYPARTS.some(([re]) => re.test(sentence))) daypartClaimCount += 1;
  }
  // 枚举模式：正文在逐条叙述日程——有钟点主张，或 ≥2 条时段主张——才判时段主张；
  // 孤立一句「晚上早点睡哦」是口语收尾，不判。
  const judgeDaypart = clockClaimCount >= 1 || daypartClaimCount >= 2;

  const rebuiltBySentence: Array<string | null> = [];
  for (const sentence of sentences) {
    const tokens = tokenize(sentence);
    const kept: ClauseToken[] = [];
    let anchor: "keep" | "strip" = "keep";
    for (const token of tokens) {
      const clause = token.text;
      if (!clause) {
        // 纯标点/换行段：不构成主张，换行保留版式，其余随锚
        if (anchor === "keep" || token.delim.includes("\n")) kept.push(token);
        continue;
      }
      const clock = parseClockClaim(clause);
      if (clock) {
        if (clockGrounded(clock, tasks) || titleGrounded(clause, tasks)) {
          anchor = "keep";
          kept.push(token);
        } else {
          anchor = "strip";
          strippedClauses.push(clause);
        }
        continue;
      }
      if (judgeDaypart) {
        const daypart = DAYPARTS.find(([re]) => re.test(clause));
        if (daypart) {
          const [, from, to] = daypart;
          if (tasks.some((t) => hourInDaypart(t.hour, from, to)) || titleGrounded(clause, tasks)) {
            anchor = "keep";
            kept.push(token);
          } else {
            anchor = "strip";
            strippedClauses.push(clause);
          }
          continue;
        }
      }
      // 无时间信号：随锚继承（描述性从句跟主句同生共死）
      if (anchor === "keep") kept.push(token);
      else strippedClauses.push(clause);
    }
    rebuiltBySentence.push(kept.length > 0 ? kept.map((t) => t.text + t.delim).join("") : null);
  }
  // 整句被剔后，前一句末尾可能留下悬空的顿逗/分号——剥掉并回填被剔段末尾的
  // 句末号（。！？），保持「…吃口早饭。」这类完整收束。
  for (let i = 0; i < rebuiltBySentence.length - 1; i++) {
    const current = rebuiltBySentence[i];
    if (current === null || rebuiltBySentence[i + 1] !== null) continue;
    let j = i + 1;
    let terminal = "";
    while (j < rebuiltBySentence.length && rebuiltBySentence[j] === null) {
      const droppedDelim = sentences[j]?.match(/[。！？!?]\s*$/)?.[0]?.trim();
      if (droppedDelim) terminal = droppedDelim;
      j += 1;
    }
    rebuiltBySentence[i] = current.replace(/[，；;]+$/, "") + terminal;
  }
  if (strippedClauses.length === 0) return { text, strippedClauses };
  return { text: rebuiltBySentence.filter((s) => s !== null).join(""), strippedClauses };
}
