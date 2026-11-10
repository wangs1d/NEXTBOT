/**
 * 闹钟/即时提醒领域类型 —— 手机端 Agent 提醒能力（docs/mobile-agent-reminder-alarm-design.md）
 *
 * 设计要点：
 *  - 触发以客户端本地调度为主路（Android 精确闹钟 / iOS 本地通知），服务端调度兜底；
 *  - 重复周期用 RFC5545 RRULE 表达；nextFireAt 是唯一调度依据，每次触发后单跳推进；
 *  - 触发回执（trigger-callback）幂等：同一 alarmId 同一跳只记一次。
 */

export type AlarmKind = "alarm" | "reminder";

export type AlarmStatus = "active" | "paused" | "done" | "canceled";

/** 二阶段语音叫醒配置；一阶段客户端忽略本字段 */
export type AlarmWakeMode = {
  /** gentle_normal 普通闹铃 | voice_talk 语音叫醒 | music 播放音乐 */
  level: "gentle_normal" | "voice_talk" | "music";
  /** Agent 开场白（voice_talk 模式），缺省由 TTS 模板兜底 */
  voiceScript?: string;
  /** music 模式播放列表 id */
  musicPlaylist?: string;
  /** 音量渐强 */
  volumeRamp?: boolean;
};

export type AlarmRepeat = {
  /** RFC5545 RRULE 字符串（如 "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"）；单次为 null */
  rule: string | null;
  until?: string | null;
  count?: number | null;
};

export type AlarmSnooze = {
  enabled: boolean;
  presetsMinutes: number[];
  maxCount: number;
};

export type AlarmDnd = {
  /** 用户显式创建的闹钟默认突破免打扰；Agent 主动提醒默认 false */
  bypass: boolean;
};

export interface Alarm {
  id: string;
  actorId: string;
  /** 创建设备 id；null 表示跟随用户任意在线设备触发 */
  deviceId?: string | null;
  label: string;
  kind: AlarmKind;
  /** 首次触发时间（ISO8601，带时区偏移） */
  fireAt: string;
  repeat: AlarmRepeat;
  snooze: AlarmSnooze;
  wakeMode?: AlarmWakeMode;
  dnd: AlarmDnd;
  status: AlarmStatus;
  createdAt: string;
  updatedAt: string;
  lastFiredAt?: string | null;
  /** 下一跳触发时刻（本地时钟语义展开后的 epoch ms 存 ISO 字符串） */
  nextFireAt?: string | null;
  /** 幂等键（客户端 ULID），重复创建返回既有条目 */
  idempotencyKey?: string | null;
  /** 已贪睡次数 */
  snoozeCount?: number;
  /** 创建来源：agent 意图解析 | user 手动 | sync 跨设备 */
  source?: "agent" | "user" | "sync";
}

/** 即时提醒（一次性投递）—— 复用 Alarm 存储，kind=reminder + channelPlan */
export type ReminderPlanStep = "voice_call" | "tts_broadcast" | "popup" | "notification" | "in_app_banner";

export interface ReminderRecord extends Alarm {
  /** 升级链：按序尝试，任一环节确认即止 */
  channelPlan: ReminderPlanStep[];
  /** 当前通道未确认多少秒后升级下一级 */
  escalateAfterSec: number;
  requireAck: boolean;
  remindText: string;
}

/** 触发台账（喂学习 + 兜底判定 + 幂等去重） */
export interface AlarmTriggerRecord {
  alarmId: string;
  /** 触发跳的 epoch ms（同跳幂等键取分钟粒度） */
  firedAtMs: number;
  via: "local" | "server" | "fallback_push";
  outcome: "ringing" | "missed" | "acked" | "snoozed";
  snoozeCount?: number;
  actualChannel?: string;
  reportedAt: string;
}

/** 触发时刻对客户端的下行 payload（WS alarm.trigger / 兜底推送共用） */
export type AlarmTriggerPayload = {
  alarmId: string;
  label: string;
  kind: AlarmKind;
  firedAtMs: number;
  /** epoch ms，客户端可据此决定是否本地已触发（去重） */
  via: "server" | "local";
  wakeMode?: AlarmWakeMode;
  /** Agent 生成的叫醒话术文本（无音频时端侧可按文本兜底展示） */
  voiceText?: string | null;
  /** 服务端已合成的开场白语音（mp3 base64）；无 TTS 能力时为 null（客户端按文本兜底） */
  tts?: { format: "mp3"; base64: string } | null;
};
