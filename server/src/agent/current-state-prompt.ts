// 当下状态 prompt 块（P0，2026-10-01「顺嘴要贴此刻」根修）：
// WorldBoard.current（presence + screenFocus）→ 聊天动态层一行块。
//
// 背景：状态板此前只喂映射规则引擎，聊天回复对「用户此刻在干嘛」零输入，
// 模型只能拿旧记忆套模板（熬夜→劝睡）。本块把板上已有的此刻信号接进对话面，
// 零 LLM、零新增采集、确定性输出；陈旧数据（lastSeenAt 超 10 分钟）不冒充现在。
//
// 块内自带一条使用纪律：顺嘴须与此刻状态相符，对方专注/娱乐中不给作息类建议
// ——这条纪律只在本块出现（人格正文不带规则清单），没有新鲜状态时也就不存在顺嘴场景。
import type { WorldBoard } from "../proactivity/world-board.js";

/** screenFocus lastSeenAt 超过该时长视为陈旧，不注入（桌面信号断供时不编现在） */
const FOCUS_STALE_MS = 10 * 60_000;
/** presence since 超过该时长只报状态不带时长（长时间离线/挂机，时长无信息量） */
const PRESENCE_MAX_DURATION_MS = 24 * 60 * 60_000;

const FOCUS_LABELS: Record<string, string> = {
  coding: "写代码",
  browsing: "浏览网页",
  game: "打游戏",
  idle: "空闲",
  unknown: "未知",
};

const PRESENCE_LABELS: Record<string, string> = {
  active: "活跃在线",
  idle: "挂机",
  away: "离开",
  offline: "离线",
  unknown: "未知",
};

function label(map: Record<string, string>, key: unknown): string {
  const k = typeof key === "string" ? key : "unknown";
  return map[k] ?? k;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `约${hours}小时`;
  return `约${Math.floor(hours / 24)}天`;
}

/**
 * 把状态板当下层格式化成 prompt 块正文（不含【当下状态】标题，由 assembler 统一加）。
 * 无任何新鲜信号时返回 null（零注入，不占 token）。
 */
export function formatCurrentStatePrompt(
  board: WorldBoard,
  actorId: string,
  nowMs: number = Date.now(),
): string | null {
  if (!actorId) return null;
  const parts: string[] = [];

  const focus = board.read<{ kind: string; since: number; lastSeenAt: number }>(
    actorId,
    "current",
    "screenFocus",
  );
  if (
    focus &&
    typeof focus.lastSeenAt === "number" &&
    nowMs - focus.lastSeenAt <= FOCUS_STALE_MS
  ) {
    const dur = formatDuration(nowMs - focus.since);
    parts.push(`屏幕焦点=${label(FOCUS_LABELS, focus.kind)}${dur ? `（已${dur}）` : ""}`);
  }

  const presence = board.read<{ state: string; since: number }>(
    actorId,
    "current",
    "presence",
  );
  if (presence && typeof presence.since === "number" && Number.isFinite(presence.since)) {
    const dur =
      nowMs - presence.since <= PRESENCE_MAX_DURATION_MS
        ? formatDuration(nowMs - presence.since)
        : "";
    parts.push(`在线状态=${label(PRESENCE_LABELS, presence.state)}${dur ? `（已${dur}）` : ""}`);
  }

  if (parts.length === 0) return null;
  return [
    `用户此刻：${parts.join("；")}。`,
    `（顺嘴要贴此刻状态；他在专注或娱乐中时不给作息/休息类建议）`,
  ].join("\n");
}
