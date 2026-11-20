/**
 * 工具常驻声明 —— **单一事实源（SOT）**（2026-11-20 归一化）。
 *
 * 背景：此前有四处各自回答「哪些工具常驻」——`CHAT_LANE_CORE_NAMES`、
 * `TASK_LANE_CORE_NAMES`、`CORE_TOOL_LIBRARY`（core tier）、
 * `ALWAYS_INCLUDED_TOOLS`（关键词保底）。ride_hailing 写进了后两处却没进
 * 车道名单，导致「工具不进口袋也不在手上」，模型只能文字应答。
 *
 * 现在：**每个工具要不要每轮可见，只在这里声明一次**，两条车道分别是
 * 「可视面」的 resident 部分；未列出者一律进延迟目录（deferred catalog），
 * 由 tool_discover / 域预载 / 高频晋升按需到达。
 *
 * 准入规则（沿用既有安全边界，勿放宽）：
 *   - 感知类（只读）可常驻；
 *   - 单步轻动作（低副作用）可常驻；
 *   - 写操作（转账/下单/智能家居控制）与多步流程（浏览器/代码/桌面）
 *     默认不常驻，走 discover；
 *   - **例外**：时点性刚需（打车两阶段确认）即使含写操作也必须常驻，
 *     否则错过 1-2 轮窗口即失效（2026-10-18 live e2e 实证）。
 *
 * 变更流程：只改本表 + 跑 `test/exposure-guard.test.ts`；禁止在别处新增
 * 常驻名单。lane 字段：
 *   - `chat`：普通对话轮（每轮可见面）
 *   - `task`：后台任务执行器 / 计划续跑
 */

export type ExposureLane = "chat" | "task";

export interface ResidentTool {
  name: string;
  lanes: ExposureLane[];
  /** 为什么常驻（缺省说明为什么必须每轮可见，写清楚原因再合并） */
  note?: string;
}

/**
 * 顺序无关（可见面按注册表序解析）；表内按「基础设施 → 对话高频 →
 * 车道专用 → 桥工具」分组，便于审阅。
 */
export const RESIDENT_TOOLS: readonly ResidentTool[] = [
  // ── 会话基础设施（感知只读）──
  { name: "clock.get_user_location", lanes: ["chat", "task"], note: "时间/定位感知，几乎每轮" },
  { name: "web_search", lanes: ["chat", "task"], note: "复合检索（天气/行情/图片/视频/热搜/深搜 action 合一）" },
  { name: "web_fetch", lanes: ["chat", "task"], note: "网页正文抓取" },
  { name: "agent", lanes: ["chat", "task"], note: "子 Agent 委派" },
  { name: "brain.recall", lanes: ["chat", "task"], note: "记忆回溯" },
  { name: "obs_recall", lanes: ["chat", "task"], note: "压缩结果的原文读回（服务每轮被折叠的工具输出）" },

  // ── 对话高频单步动作 ──
  { name: "calendar", lanes: ["chat", "task"], note: "日程/提醒唯一入口" },
  { name: "phone", lanes: ["chat"], note: "手机号查询（口语召回不稳，进目录即嘴硬“没权限”）" },
  { name: "world.link", lanes: ["chat", "task"], note: "Agent World 链接" },
  { name: "profile.update", lanes: ["chat"], note: "用户画像自编辑（进目录模型会忘记搜、谎称已记）" },

  // ── 时点性刚需（写操作例外）──
  {
    name: "ride_hailing",
    lanes: ["chat"],
    note: "打车单入口（quote/book/status/cancel 合一）：选点卡续报价与两阶段确认都必须在本轮窗口内完成",
  },

  // ── 任务车道执行主力 ──
  { name: "task.dispatch", lanes: ["chat", "task"], note: "任务派发" },
  { name: "task.status", lanes: ["chat", "task"], note: "任务状态" },
  { name: "task.cancel", lanes: ["chat", "task"], note: "任务取消" },
  { name: "perception.overview", lanes: ["task"], note: "感知总览" },
  { name: "browser.session.list", lanes: ["task"], note: "后台浏览器会话" },
  { name: "code.run", lanes: ["task"], note: "代码执行" },
  { name: "code.write_file", lanes: ["task"], note: "写文件" },
  { name: "code.read_file", lanes: ["task"], note: "读文件" },

  // ── 桥（延迟目录入口，必须在可见面）──
  { name: "tool_discover", lanes: ["task"], note: "延迟目录发现桥（chat 车道由 prepareTools 自动注入）" },
];

/** 某车道的常驻名单（派生，勿在别处硬编码）。 */
export function residentNamesForLane(lane: ExposureLane): readonly string[] {
  return RESIDENT_TOOLS.filter((t) => t.lanes.includes(lane)).map((t) => t.name);
}

/** 判断某工具是否在指定车道常驻（供观测/断言用）。 */
export function isResident(name: string, lane: ExposureLane): boolean {
  return RESIDENT_TOOLS.some((t) => t.name === name && t.lanes.includes(lane));
}
