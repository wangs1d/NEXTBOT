// 今日看板（2026-11-23 常驻通知 + 桌面小组件，需求文档 §5.2/§5.3）
//
// 一句话说清它是干什么的：手机状态栏那条常驻通知和桌面小组件上那几行字，
// 内容由这里算。展示字段在这里排好序、去好敏——客户端只负责把字贴上，
// 不再自己拼业务逻辑（否则 Android/iOS/桌面卡片各拼一套，改一条文案要动三个仓库）。
//
// 只走「用户此刻需要知道」的四档，按优先级取前两条：
//   下一件事 → 待取件 → 今天到期 → 都没有就说句安心话。
// 金额一律不进这里（§5.3 隐私：默认隐藏），账单只报「今天到期」这件事。
import { isTriviaTask, type ScheduleTaskRecord } from "./schedule-task-service.js";
import type { BillParcelEntry, BillParcelListQuery } from "./bill-parcel-ledger.js";

export type TodayBoardLineKind = "next_event" | "parcel_pending" | "bill_due" | "idle";

export type TodayBoardLine = {
  kind: TodayBoardLineKind;
  /** 一行正文，已含倒计时/件数，客户端直接贴 */
  text: string;
  /** 可定位的业务实体（日程 taskId / 台账条目 id）：小组件深链与「完成」按钮用 */
  ref?: string;
};

/** 常驻通知/小组件上那个真的能改变业务状态的按钮（token 即授权，客户端只透传） */
export type TodayBoardAction = { actionId: string; label: string; token: string };

export type TodayBoard = {
  ok: true;
  updatedAt: number;
  /** 常驻通知标题（一行） */
  title: string;
  /** 常驻通知正文（一行） */
  text: string;
  /** 全部展示行（已按优先级排序；小组件取更多行时用这个） */
  lines: TodayBoardLine[];
  /** 「下一件事完成」按钮的落点；没有下一件事时整个字段缺席 */
  nextEvent?: { taskId: string; title: string; startMs: number; startLabel: string };
  /** 与 nextEvent 同生同灭：没有下一件事就没有可完成的按钮 */
  completeAction?: TodayBoardAction;
};

export type TodayBoardDeps = {
  scheduleTasks: {
    listTasksBySession(
      sessionId: string,
      range?: { from?: string; to?: string },
    ): ScheduleTaskRecord[];
  };
  /** 账单/快递台账（未装配时只报日程，不报错） */
  ledger?: { list(query: BillParcelListQuery): BillParcelEntry[] } | null;
  /**
   * 「完成」按钮的凭据签发方（未注入 = 看板只有字没有按钮）。
   * 由装配层接到 ActionIntentService 上，客户端点它 = 真的 completeTask。
   */
  intents?: {
    completeAction(
      actorId: string,
      task: { taskId: string; title: string },
    ): TodayBoardAction | null;
  } | null;
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 24 小时内时刻 → "15:00" */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 倒计时口语化：马上 / 40 分钟 / 1 小时 20 分 / 3 小时 */
export function countdownLabel(msUntilStart: number): string {
  if (msUntilStart <= 60_000) return "马上";
  const totalMin = Math.round(msUntilStart / 60_000);
  if (totalMin < 60) return `还有 ${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `还有 ${h} 小时` : `还有 ${h} 小时 ${m} 分`;
}

/**
 * 今日「下一件事」：只认用户自己的正事提醒——
 * trivia（喝水/节律这类系统自造的轻提醒）不进状态栏，否则常驻通知会被碎提醒刷满，
 * 用户第一眼看到的就不是「牙医 15:00」而是「该喝水了」。
 */
function nextEventToday(
  deps: TodayBoardDeps,
  actorId: string,
  now: number,
): ScheduleTaskRecord | undefined {
  const endOfToday = startOfDay(now) + 24 * 60 * 60_000;
  return deps.scheduleTasks
    .listTasksBySession(actorId, {
      from: new Date(now).toISOString(),
      to: new Date(endOfToday).toISOString(),
    })
    .find(
      (t) =>
        t.kind === "reminder" &&
        t.status === "active" &&
        !isTriviaTask(t) &&
        Number.isFinite(Date.parse(t.nextRunAt ?? t.runAt)),
    );
}

/** 待取件（未 resolve 的 parcel 条目）：一件时直接给取件码，多件报数 */
function pendingParcels(deps: TodayBoardDeps, actorId: string): TodayBoardLine | null {
  const list =
    deps.ledger
      ?.list({ actorId, category: "parcel", limit: 200 })
      .filter((e) => !e.resolvedAt) ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) {
    const only = list[0];
    const code = only.pickupCode?.trim();
    return {
      kind: "parcel_pending",
      text: code ? `1 个快递待取 · 取件码 ${code}` : "1 个快递待取",
      ref: only.id,
    };
  }
  return { kind: "parcel_pending", text: `${list.length} 个快递待取`, ref: list[0].id };
}

/** 今天到期的账单：只说「今天到期」，金额不进常驻通知（§5.3 隐私默认） */
function billsDueToday(deps: TodayBoardDeps, actorId: string, now: number): TodayBoardLine | null {
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const list =
    deps.ledger
      ?.list({ actorId, category: "bill", limit: 200 })
      .filter(
        (e) => !e.resolvedAt && e.occurredAt >= dayStart && e.occurredAt < dayEnd,
      ) ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) {
    const only = list[0];
    const type = (only.billType || only.title || "账单").replace(/\s*\d[\d,.]*\s*元?$/, "").trim();
    return { kind: "bill_due", text: `${type || "账单"}今天到期`, ref: only.id };
  }
  return { kind: "bill_due", text: `${list.length} 笔账单今天到期`, ref: list[0].id };
}

/**
 * 组装看板。`title`/`text` 是常驻通知那一行（Android 状态栏只放得下两行字），
 * `lines` 是完整清单（小组件按需取更多条）。
 */
export function buildTodayBoard(deps: TodayBoardDeps, actorId: string, now = Date.now()): TodayBoard {
  const lines: TodayBoardLine[] = [];
  let nextEvent: TodayBoard["nextEvent"];

  const ev = nextEventToday(deps, actorId, now);
  if (ev) {
    const startMs = Date.parse(ev.nextRunAt ?? ev.runAt);
    const label = hhmm(startMs);
    const name = ev.shortTitle?.trim() || ev.title?.trim() || ev.description;
    lines.push({
      kind: "next_event",
      text: `${label} ${name} · ${countdownLabel(startMs - now)}`,
      ref: ev.taskId,
    });
    nextEvent = { taskId: ev.taskId, title: name, startMs, startLabel: label };
  }
  const parcel = pendingParcels(deps, actorId);
  if (parcel) lines.push(parcel);
  const bill = billsDueToday(deps, actorId, now);
  if (bill) lines.push(bill);
  if (lines.length === 0) lines.push({ kind: "idle", text: "今天没什么要操心的" });

  // 状态栏两行：有下一件事时标题就是它（时间 + 事项），正文留给倒计时；
  // 否则标题报第一条待办，正文报还剩几件事。
  const [first] = lines;
  let title: string;
  let text: string;
  if (nextEvent && first) {
    title = `${nextEvent.startLabel} ${nextEvent.title}`;
    text = lines
      .slice(1)
      .map((l) => l.text)
      .join(" · ") || "今天没有别的事了";
  } else {
    title = first?.text ?? "今天没什么要操心的";
    text = lines.length > 1 ? `另有 ${lines.length - 1} 项待办` : "管家在";
  }
  // 按钮与下一件事同生同灭：没有事项就不给「完成」——按了没反应的按钮比没有按钮更糟
  const completeAction =
    nextEvent && deps.intents
      ? deps.intents.completeAction(actorId, { taskId: nextEvent.taskId, title: nextEvent.title }) ??
        undefined
      : undefined;
  return {
    ok: true,
    updatedAt: now,
    title,
    text,
    lines,
    ...(nextEvent ? { nextEvent } : {}),
    ...(completeAction ? { completeAction } : {}),
  };
}
