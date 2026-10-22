// 盯梢任务（WatchTask）+ 截止时间推理（DeadlineWatch）—— Muse 对齐件（2026-10-22）。
//
// Muse 的两大看家能力，对齐并超越：
//  ① 任务驱动盯梢（"帮我盯着学校邮件，有选拔告诉我"）：Muse 后台持续用 LLM 判断
//     "值不值得说"；本项目改为 **创建时花一次 LLM 提取关键词，运行期零 LLM 确定性
//     匹配**——便宜、稳定、可解释（匹配为什么命中一目了然）。
//  ② 截止×日历缺口推理（Muse 成名案例：邮件说选拔截止，日历没有这一项 → 提醒）：
//     extractDeadline 零 LLM 抽取截止时间（动词×时间表达），再查日历缺口——
//     缺口成立才升级为"要我设个提醒吗"的行动提案。
//
// 门槛纪律（Muse："主动消息门槛必须很高"）：**只有用户点名要盯的任务才触发**。
// 没有盯梢任务时本模块完全沉默——主动性的音量由用户显式控制，不是系统猜。
import { createHash } from "node:crypto";

import { readJson, writeJson } from "../persist-file.js";
import { resolveBaseActorId } from "../../agent/master-chat-session.js";
import type { ProactiveProposal } from "../pipeline-types.js";

// ─── 盯梢任务存储 ───────────────────────────────────────────

export type WatchTask = {
  id: string;
  actorId: string;
  /** 人话名（"学校邮件里的选拔信息"），创建时由 LLM 从用户原话提炼 */
  label: string;
  /** 匹配关键词（运行期子串命中；2-8 字 token，≤8 个） */
  keywords: string[];
  createdAt: number;
  active: boolean;
};

type PersistedTasks = { tasks?: WatchTask[] };

export type WatchTaskStoreDeps = {
  persistPath: string;
  nowFn?: () => number;
  /** 每 actor 任务上限（防滥用；缺省 20） */
  capPerActor?: number;
};

export class WatchTaskStore {
  private readonly tasks = new Map<string, WatchTask>();
  private readonly nowFn: () => number;
  private readonly cap: number;

  constructor(private readonly deps: WatchTaskStoreDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.cap = deps.capPerActor ?? 20;
    const raw = readJson<PersistedTasks>(deps.persistPath, {});
    for (const t of raw.tasks ?? []) this.tasks.set(t.id, t);
  }

  private flush(): void {
    writeJson(this.deps.persistPath, { tasks: [...this.tasks.values()] });
  }

  /** 创建盯梢任务。keywords 清洗去重（2-8 字 token，≤8 个）；空关键词拒绝。 */
  create(actorId: string, label: string, keywords: string[]): WatchTask {
    const clean = [...new Set(keywords.map((k) => String(k ?? "").trim()).filter((k) => k.length >= 2 && k.length <= 8))].slice(0, 8);
    if (clean.length === 0) throw new Error("keywords 不能为空（每个 2-12 字）");
    const mine = [...this.tasks.values()].filter((t) => t.actorId === actorId);
    if (mine.length >= this.cap) throw new Error(`盯梢任务已达上限（${this.cap}），请先删除不用的`);
    // 同 actor 同 label 幂等：已存在直接返回
    const dup = mine.find((t) => t.label === label.trim());
    if (dup) return dup;
    const t: WatchTask = {
      id: `wa_${createHash("sha1").update(`${actorId}|${label}|${this.nowFn()}`).digest("hex").slice(0, 8)}`,
      actorId,
      label: label.trim().slice(0, 40),
      keywords: clean,
      createdAt: this.nowFn(),
      active: true,
    };
    this.tasks.set(t.id, t);
    this.flush();
    return t;
  }

  remove(actorId: string, id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.actorId !== actorId) return false;
    this.tasks.delete(id);
    this.flush();
    return true;
  }

  setActive(actorId: string, id: string, active: boolean): boolean {
    const t = this.tasks.get(id);
    if (!t || t.actorId !== actorId) return false;
    t.active = active;
    this.flush();
    return true;
  }

  list(actorId?: string): WatchTask[] {
    return [...this.tasks.values()]
      .filter((t) => (actorId ? t.actorId === actorId : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 运行期匹配（零 LLM）：活跃任务 × 关键词子串命中，最长关键词优先（更具体） */
  match(actorId: string, text: string): WatchTask | null {
    let best: { task: WatchTask; kw: string } | null = null;
    for (const t of this.tasks.values()) {
      if (!t.active || t.actorId !== actorId) continue;
      for (const kw of t.keywords) {
        if (text.includes(kw) && (!best || kw.length > best.kw.length)) best = { task: t, kw };
      }
    }
    return best?.task ?? null;
  }
}

// ─── 截止时间抽取（零 LLM，宁漏不误） ─────────────────────────

export type DeadlineHit = { deadlineAt: number; verb: string; dayText: string };

/** 截止动词：出现即候选（还需时间表达才成立） */
const DEADLINE_VERB = /(报名|提交|申请|递交|缴费|注册|确认参加|截止)/;
/** 时间表达（天）：今天/明天/后天/大后天/周X/X月X日（下周算下周的周X） */
const DAY_RE = /(今天|明天|后天|大后天|(?:下{1,2})?(?:周|星期)([一二三四五六日末])|(\d{1,2})月(\d{1,2})[日号])/;
/** 时间表达（钟点）：可选时段 + X点(半|Y分)? */
const TIME_RE = /(上午|下午|晚上|中午)?\s*(\d{1,2})[点:：](半|(\d{1,2})分?)?/;

const WEEKDAY_INDEX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 末: 6 };

/**
 * 从文本抽取截止时间（确定性规则）。不满足动词 × 天 ×（钟点或默认当天末）三件套
 * 一律返回 null——不知道什么时候截止就不猜（宁漏不误）。
 * "前/之前/以前" 后缀不参与判定（口语里"周五前报名"和"周五报名"都是周五为限）。
 */
export function extractDeadline(text: string, now: number): DeadlineHit | null {
  const s = String(text ?? "");
  const verb = s.match(DEADLINE_VERB)?.[0];
  if (!verb) return null;
  const dayM = s.match(DAY_RE);
  if (!dayM) return null;

  const base = new Date(now);
  let day: Date;
  if (dayM[1] === "今天") day = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  else if (dayM[1] === "明天") day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  else if (dayM[1] === "后天") day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 2);
  else if (dayM[1] === "大后天") day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 3);
  else if (dayM[2] !== undefined) {
    // 周X：从明天起找下一个匹配（"下"/"下下"前缀各加 7/14 天）
    const target = WEEKDAY_INDEX[dayM[2]] ?? 1;
    const prefixLen = dayM[1].startsWith("下下") ? 14 : dayM[1].startsWith("下") ? 7 : 0;
    day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
    for (let i = 0; i < 8; i++) {
      if (day.getDay() === target) break;
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + prefixLen);
  } else {
    const mo = Number(dayM[3]) - 1;
    const d = Number(dayM[4]);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    day = new Date(base.getFullYear(), mo, d);
    if (day.getTime() < now - 24 * 3600_000) day = new Date(base.getFullYear() + 1, mo, d); // 已过 → 明年
  }

  // 钟点：天匹配之后的一小段里找（"周五下午5点前"）；找不到 → 当天 23:59（截止日末）
  const tail = s.slice((dayM.index ?? 0) + dayM[1].length, (dayM.index ?? 0) + dayM[1].length + 12);
  const timeM = tail.match(TIME_RE);
  let h = 23;
  let m = 59;
  if (timeM) {
    const part = timeM[1] ?? "";
    h = Number(timeM[2]);
    m = timeM[3] === "半" ? 30 : Number(timeM[4] ?? 0) || 0;
    if (!Number.isFinite(h) || h > 24) return null;
    if (part === "下午" && h < 12) h += 12;
    if (part === "晚上" && h < 12) h += 12;
    if (part === "中午" && h !== 12) h = 12;
    if (part === "" && timeM[1] === undefined && h <= 12 && m === 0 && !/\d{1,2}[点:：]/.test(tail)) {
      // 裸数字兜底保护（"3月5日" 后面误吞）；此处 day-only 走默认 23:59
      h = 23;
      m = 59;
    }
  }
  const deadlineAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0).getTime();
  // 窗口纪律：已过期 1 小时以上，或远超 14 天 → 不猜
  if (deadlineAt < now - 3600_000) return null;
  if (deadlineAt > now + 14 * 24 * 3600_000) return null;
  return { deadlineAt, verb, dayText: dayM[1] };
}

// ─── 盯梢触发器（入站消息回调） ───────────────────────────────

export type WatchTaskWatcherDeps = {
  store: WatchTaskStore;
  submitProposal: (p: ProactiveProposal) => void;
  /** 日历缺口检查：时间窗内是否已有含相关关键词的活跃日程（bootstrap 接 ScheduleTaskService） */
  hasRelatedEntry?: (actorId: string, keywords: string[], startMs: number, endMs: number) => boolean;
  now?: () => number;
  /** 同任务冷却（缺省 1 小时） */
  cooldownMs?: number;
};

const MAX_TEXT = 300;

export class WatchTaskWatcher {
  private readonly lastFiredAt = new Map<string, number>();
  private readonly nowFn: () => number;
  private readonly cooldownMs: number;

  constructor(private readonly deps: WatchTaskWatcherDeps) {
    this.nowFn = deps.now ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? 3600_000;
  }

  /** MessageHub 入站回调：同步、零 LLM、异常静默（不阻断落库主链路） */
  handleInbound(input: { actorId: string; text: string; channelId?: string; platform?: string }): void {
    try {
      const text = String(input.text ?? "").trim();
      if (text.length < 4 || text.length > MAX_TEXT) return;
      const now = this.nowFn();
      const actorId = resolveBaseActorId(input.actorId);
      const task = this.deps.store.match(actorId, text);
      if (!task) return;

      const cooldownKey = `${actorId}:${task.id}`;
      const last = this.lastFiredAt.get(cooldownKey);
      if (last != null && now - last < this.cooldownMs) return;
      this.lastFiredAt.set(cooldownKey, now);

      const excerpt = text.replace(/\s+/g, " ").slice(0, 120);
      const fingerprint = createHash("sha1").update(`${task.id}|${excerpt}`).digest("hex").slice(0, 16);

      // Muse 成名案例路径：盯梢命中 × 截止时间可抽 × 日历缺口 → 行动提案
      let directText =
        `你让我盯着「${task.label}」，刚看到一条相关的：「${excerpt}」。要展开看看吗？`;
      let confirmAction: { label: string } | undefined;
      const evidence = ["watch_task", `task:${task.id}`, `keyword:${task.keywords.find((k) => text.includes(k)) ?? ""}`];
      const detail: Record<string, string> = { 任务: task.label, 原文: excerpt };

      const dl = extractDeadline(text, now);
      if (dl) {
        const hasEntry = this.deps.hasRelatedEntry
          ? this.deps.hasRelatedEntry(actorId, [...task.keywords, ...hitSubjects(text)], now, dl.deadlineAt)
          : true;
        evidence.push(`deadline:${dl.dayText}`, ...(hasEntry ? [] : ["calendar_gap"]));
        if (!hasEntry) {
          directText =
            `你让我盯着「${task.label}」——刚看到「${excerpt}」，` +
            `${formatWhen(dl.deadlineAt)}就是${dl.verb}截止时间，但你的日程里还没有这一项。要我帮你设个提醒吗？`;
          confirmAction = { label: "设提醒" };
          detail["截止"] = formatWhen(dl.deadlineAt);
        }
      }

      this.deps.submitProposal({
        proposalId: `wt_${fingerprint}`,
        actorId,
        kind: "watch_task_hit",
        tier: "must", // 用户点名要盯的事 = 用户自己下的单，绕过社交预算
        importance: "high",
        dedupKey: `watch_task:${task.id}:${fingerprint}`,
        title: `盯梢命中：${task.label}`,
        summary: excerpt,
        evidence,
        directText,
        createdAt: now,
        source: "watch_task",
        subject: task.label,
        needsUser: true,
        detail,
        ...(confirmAction ? { confirmAction } : {}),
        utility: {
          risk: { reversible: true, financialImpact: "none", dataSensitivity: "personal", thirdPartyImpact: false },
          authorization: "none",
        },
      });
    } catch {
      /* 盯梢失败不影响消息主链路 */
    }
  }
}

/** 从消息里补抓 2-4 字主体词（日历缺口检索的第二把尺子，与盯梢关键词并集） */
function hitSubjects(text: string): string[] {
  const runs = String(text).match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
  return [...new Set(runs)].slice(0, 6);
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400_000);
  const dayLabel = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : dayDiff === 2 ? "后天" : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${dayLabel} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
