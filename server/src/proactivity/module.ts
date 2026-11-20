// 统一模块层（2026-11-19 用户拍板：方案 A「统一注册表 + 门面」）。
//
// 目的：agent 主动性作为**一块**——所有主动触发源（状态板规则 / 事件触发器 /
// 分支监听 / 定时服务 / 情报层 / 目标推进）在装配期自登记进一张注册表，
// 本模块是唯一的全景视图与查询门面。加一个主动场景 = 在 buildBuiltinProactiveSources
// 目录里加一行（或调用 registerProactiveSource），删一个 = 删一行。
//
// 边界：本模块只做「登记 + 描述」，不参与仲裁/频控/投递——那些职责仍在
// ProactivePipeline / FrequencyGovernor / ArbiterV2。describe() 的消费方
// （HTTP 状态接口、客户端设置页、审计）后续按需接。
//
// 2026-11-19：away_return / work_marathon / unread_burst / spend_alert 四个
// 触发源按用户拍板整体下线，目录中不再登记。

/** 触发源所属层（对应主动性系统的六层结构） */
export type ProactiveSourceLayer =
  | "board_rule" // 世界板映射规则：每分钟读状态板，状态命中 → 模板直出（零 LLM）
  | "event_trigger" // 事件触发器：入站事件（日程变动/位置流转/任务完成/偏好变化）驱动
  | "branch" // 分支监听：多源信号聚合后命中（盯梢命中/导入日程冲突）
  | "scheduled" // 定时与生命周期服务：晨报/睡前速览/恶劣天气/到点提醒/闹钟
  | "sensor_intel" // 传感器 → 情报/发现层：intel 管线与 agent-pulse 审阅（LLM 参与）
  | "goal"; // 目标与代办：goal_confirm/goal_progress/goal_blocked，有状态变化才开口

/** 一个主动触发源的统一描述（登记与全景视图的最小单元） */
export interface ProactiveSourceDescriptor {
  /** 稳定 id（同 id 重复登记 = 后写覆盖，用于运行期启停覆盖目录默认值） */
  id: string;
  layer: ProactiveSourceLayer;
  /** 产出提案/意图的 kind（频控冷却与审计日志的键） */
  kinds: string[];
  /** 一句话触发条件（给人看的） */
  trigger: string;
  /** 频控摘要（如「每日 1 次」「6h 冷却」），无频控可省 */
  cooldown?: string;
  /** 目录默认值；运行期可用 setProactiveSourceEnabled 覆盖 */
  enabled?: boolean;
}

export interface RegisteredProactiveSource extends ProactiveSourceDescriptor {
  enabled: boolean;
  registeredAt: number;
}

const registry = new Map<string, RegisteredProactiveSource>();

/** 登记一个触发源（同 id 覆盖：保留运行期 enabled 覆盖，其余字段以新值为准） */
export function registerProactiveSource(d: ProactiveSourceDescriptor): void {
  const prev = registry.get(d.id);
  registry.set(d.id, {
    ...d,
    enabled: d.enabled ?? prev?.enabled ?? true,
    registeredAt: Date.now(),
  });
}

/** 注销（触发源下线时调用；2026-11-19 下线的四个源即从此处移除） */
export function unregisterProactiveSource(id: string): void {
  registry.delete(id);
}

/** 运行期启停覆盖（不动目录默认值） */
export function setProactiveSourceEnabled(id: string, enabled: boolean): boolean {
  const s = registry.get(id);
  if (!s) return false;
  s.enabled = enabled;
  return true;
}

/** 全量列出（可按层过滤），按 layer → id 稳定排序 */
export function listProactiveSources(filter?: { layer?: ProactiveSourceLayer }): RegisteredProactiveSource[] {
  return [...registry.values()]
    .filter((s) => !filter?.layer || s.layer === filter.layer)
    .sort((a, b) => (a.layer === b.layer ? a.id.localeCompare(b.id) : a.layer.localeCompare(b.layer)));
}

/** 门面：主动性全景快照（供状态接口/设置页/审计直接消费） */
export function describeProactivity(): {
  total: number;
  enabled: number;
  byLayer: Record<ProactiveSourceLayer, string[]>;
  sources: RegisteredProactiveSource[];
} {
  const sources = listProactiveSources();
  const byLayer = Object.fromEntries(
    (["board_rule", "event_trigger", "branch", "scheduled", "sensor_intel", "goal"] as const).map((l) => [
      l,
      sources.filter((s) => s.layer === l).map((s) => s.id),
    ]),
  ) as Record<ProactiveSourceLayer, string[]>;
  return {
    total: sources.length,
    enabled: sources.filter((s) => s.enabled).length,
    byLayer,
    sources,
  };
}

/** 测试隔离用：清空注册表 */
export function resetProactiveSourcesForTest(): void {
  registry.clear();
}

/**
 * 内置触发源目录——「agent 主动性全景」的唯一事实来源。
 * 在 bootstrap 装配主动性子系统时调用一次；此后 describeProactivity() 即全景。
 * 加/删主动场景从这份目录开始（实现体仍在各自文件里，目录只做登记与描述）。
 */
export function registerBuiltinProactiveSources(): void {
  const S = (d: ProactiveSourceDescriptor) => registerProactiveSource(d);

  // ── 一、世界板映射规则（mapping-rules.ts，每分钟读状态板，零 LLM）──
  S({ id: "morning_brief", layer: "board_rule", kinds: ["greeting"], trigger: "每天 7-10 点首次活跃（旗舰预执行场景，支持晨间来电汇报）", cooldown: "每日 1 次" });
  S({ id: "meeting_soon", layer: "board_rule", kinds: ["schedule_upcoming", "meeting_early"], trigger: "日程临近：60min 预告 + 15min 临近双档", cooldown: "每档每次日程 1 次" });
  S({ id: "goal_ready", layer: "board_rule", kinds: ["life_reminder"], trigger: "预执行目标就绪进入 readyTray（「哇」时刻）", cooldown: "每目标 1 次" });
  S({ id: "sleep_boundary", layer: "board_rule", kinds: ["sleep_care"], trigger: "23 点屏幕仍活跃（节律关怀），当晚过期", cooldown: "每晚最多 1 次" });

  // ── 二、事件触发器（triggers/）──
  S({ id: "schedule_change", layer: "event_trigger", kinds: ["life_reminder"], trigger: "聊天/邮件里发现日程变动信号（带「让助手处理」确认按钮）" });
  S({ id: "place_transition", layer: "event_trigger", kinds: ["location_arrival"], trigger: "到家/离家/到公司/抵达新城市四类流转", cooldown: "同地点 6h" });
  S({ id: "location_arrival", layer: "event_trigger", kinds: ["geofence_event"], trigger: "进入设定地理围栏", cooldown: "30min" });
  S({ id: "task_celebration", layer: "event_trigger", kinds: ["task_celebration"], trigger: "后台任务或聊过的事办成（祝贺）", cooldown: "每任务 1 次" });
  S({ id: "followup", layer: "event_trigger", kinds: ["followup"], trigger: "对话中出现等待跟进的事", cooldown: "4h" });
  S({ id: "preference_change", layer: "event_trigger", kinds: ["life_reminder"], trigger: "口味反转确认 / 偏好变化记录" });

  // ── 三、分支监听（branches/）──
  S({ id: "watch_task_hit", layer: "branch", kinds: ["life_reminder"], trigger: "盯梢任务命中（可带「设提醒」按钮）" });
  S({ id: "schedule_conflict", layer: "branch", kinds: ["life_reminder"], trigger: "导入的日程与现有安排冲突" });

  // ── 四、定时与生命周期服务 ──
  S({ id: "evening_digest", layer: "scheduled", kinds: ["digest"], trigger: "睡前提醒 + 明日速览（天气/重要日子已并入）", cooldown: "每晚 1 次" });
  S({ id: "weather_alert", layer: "scheduled", kinds: ["weather_alert"], trigger: "晨报生成时联动检测恶劣天气（暴雨/高温/寒潮）", cooldown: "30min" });
  S({ id: "important_day", layer: "scheduled", kinds: ["life_reminder"], trigger: "当天命中重要日子 → LLM 祝福草稿", cooldown: "每日 1 次" });
  S({ id: "schedule_reminder", layer: "scheduled", kinds: ["life_reminder"], trigger: "到点提醒 + 离线补投（reminder-redelivery）" });
  S({ id: "alarm", layer: "scheduled", kinds: ["alarm_wake", "alarm_fallback"], trigger: "闹钟唤醒与兜底通道" });
  S({ id: "ics_mail_schedule", layer: "scheduled", kinds: ["life_reminder"], trigger: "ICS 订阅/邮件提取的日程入板 → 触发临会提醒" });

  // ── 五、传感器 → 情报/发现层（LLM 审阅）──
  S({ id: "intel_brief", layer: "sensor_intel", kinds: ["intel"], trigger: "mail/ics/finance/clipboard/file/screen 七传感器 → intel 管线（draft→judge→refine→compose）" });
  S({ id: "discovery_share", layer: "sensor_intel", kinds: ["interest_share"], trigger: "发现层 openMouth 开口 + agent-pulse 每日审阅聚合", cooldown: "每日 1 次" });
  S({ id: "interest_watch", layer: "sensor_intel", kinds: ["interest_alert", "interest_share"], trigger: "关注的话题有新料（热搜命中）", cooldown: "alert 4h / share 每日 1 次" });

  // ── 六、目标与代办 ──
  S({ id: "goal_progress", layer: "goal", kinds: ["goal_confirm", "goal_progress", "goal_blocked"], trigger: "目标等拍板 / 阶段汇报 / 卡住，有状态变化才开口" });
  S({ id: "bill_parcel", layer: "goal", kinds: ["life_reminder"], trigger: "通知捕捉命中快递/账单（快递 10min、账单 6h 冷却）" });
}
