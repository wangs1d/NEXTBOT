/**
 * 生活节律引擎（Task 20）类型契约。
 *
 * 定位：节律画像的唯一所有者（Single Source of Truth）+ 两个可插拔边界：
 *   ① 传感器边界（进）：RhythmSensor 从既有数据源拉取观察
 *   ② 消费方边界（出）：RhythmConsumer 订阅画像变更后各自落权
 * 引擎自身不做消息路由、不做"现在该不该打扰"的决策——后者仍归
 * ProactiveContactPolicy / Fatigue / ProactionCortex 等现有决策链。
 *
 * 建模原则：统计为骨架（中位数/EWMA/星期分布），置信度门槛 + 渐进调整；
 * LLM 解释层（insights 的人话润色）留给后续阶段，当前 insight 全部纯统计生成。
 */

/** 节律维度。新增维度 = 新增一个 RhythmDimensionModel 实现并注册，引擎无感知 */
export type RhythmDimension =
  | "sleep"
  /** 起床（PRD §7.3 从 sleep 拆出：早安 slot 要的是醒的时刻，不是睡的时刻） */
  | "wake"
  /** 通勤（围栏离家 / 到公司 / 离公司的按星期中位数） */
  | "commute"
  | "focus"
  | "overtime"
  | "receptivity";

/** 观察子类型（各模型器据此判别；跨维度复用时以 dimension 先分流） */
export type RhythmObservationKind =
  // sleep
  | "sleep_sample"
  | "sleep_onset"
  // wake
  | "wake_sample"
  // commute
  | "commute_leave_home"
  | "commute_arrive_work"
  | "commute_leave_work"
  | "commute_arrive_home"
  // focus
  | "desktop_active"
  | "interaction"
  | "phone_unlock"
  // receptivity
  | "contact_outcome"
  | "location_movement"
  | "screen_busy"
  // 兜底：新传感器可带自定义子类型，字面量仍享受补全
  | (string & {});
/** 传感器产出的单条观察。value 语义由 dimension 约定（见各模型器注释） */
export type RhythmObservation = {
  dimension: RhythmDimension;
  /** 观察发生时间（ISO） */
  at: string;
  /** 主值：sleep=入睡小时(十进制)；wake=起床小时；commute/focus=时刻或活跃小时；overtime/receptivity=0/1 布尔 */
  value: number;
  /** 辅值：sleep 为醒来小时；其余维度不用 */
  value2?: number;
  /** 观察子类型（如 "sleep_sample" / "desktop_active" / "contact_outcome"） */
  kind?: RhythmObservationKind;
  /** 权重（默认 1） */
  weight?: number;
  /**
   * 产生该观察的传感器 id。同日多样本按它定优先级（见 dimensions/grouping.ts
   * 的 SOURCE_PRIORITY：手机直报 > 桌面观察 > 用户自述），不要随便填。
   */
  source: string;
  /** 可选备注（透传给 insight evidence） */
  note?: string;
};

// ---- 各维度状态 ----

/** 工作日/周末分组键（PRD §7.3 最后一行：各维度都要能按分组读） */
export type RhythmDaypart = "weekday" | "weekend";

/** 按分组挂一份同结构读数（分组只是读法，不是新维度） */
export type DaypartSplit<T> = Record<RhythmDaypart, T>;

export type SleepSample = {
  /** 样本日期 YYYY-MM-DD（去重键；取"上床那天"，醒来时刻落在次日凌晨） */
  date: string;
  /** 入睡时刻（十进制小时，如 23.5） */
  startHour: number;
  /** 醒来时刻（十进制小时） */
  endHour: number;
  /** 来源传感器 id（同日多样本按 SOURCE_PRIORITY 定谁作数，手机 > 桌面 > 自述） */
  source?: string;
};

/** 睡眠窗口的一组读数（总体或某一分组） */
export type SleepWindowStats = {
  /** 中位数入睡/醒来小时；样本不足为 null */
  windowStartHour: number | null;
  windowEndHour: number | null;
  sampleCount: number;
};

export type SleepDimensionState = SleepWindowStats & {
  samples: SleepSample[];
  /** 近 3 个样本 vs 之前样本的入睡中位数偏移（分钟，正=变晚） */
  trendMinutes: number;
  /** 工作日 / 周末分开看（周末晚睡两小时是最常见形态，混在一起会被抹平） */
  byDaypart: DaypartSplit<SleepWindowStats>;
  /** 最近 14 个样本里手机直报的占比（0..1）：档案页/诊断要说清"这份作息是谁给的" */
  phoneSampleRatio: number;
};

export type WakeSample = {
  /** 起床那天 YYYY-MM-DD（去重键） */
  date: string;
  /** 起床时刻（十进制小时） */
  hour: number;
  source?: string;
};

export type WakeTimeStats = {
  /** 中位数起床时刻（十进制小时）；样本不足为 null */
  wakeHour: number | null;
  sampleCount: number;
};

/**
 * 起床维度状态（§7.3 从 sleep 拆出）。
 * 早安 slot / postWakeMinutes 取的就是这里，所以口径要单列：拆出来后
 * "几点起"能按工作日与周末分别统计，而混在 sleep 窗口里时被入睡方差吃掉。
 */
export type WakeDimensionState = WakeTimeStats & {
  samples: WakeSample[];
  /** 近 3 个样本 vs 之前样本的起床中位数偏移（分钟，正=变晚） */
  trendMinutes: number;
  byDaypart: DaypartSplit<WakeTimeStats>;
  phoneSampleRatio: number;
};

/** 一天的通勤时刻（缺失的腿为 null——整天在家的工作日 arrive/leaveWork 就是 null） */
export type CommuteDaySample = {
  date: string;
  weekday: number;
  /** 离家时刻（十进制小时） */
  leaveHomeHour: number | null;
  /** 到公司时刻（十进制小时） */
  arriveWorkHour: number | null;
  /** 离公司时刻（十进制小时） */
  leaveWorkHour: number | null;
  source?: string;
};

export type CommuteLegStats = {
  leaveHomeHour: number | null;
  arriveWorkHour: number | null;
  leaveWorkHour: number | null;
  /** 有任意一条腿样本的天数（置信度分母） */
  days: number;
};

/** 通勤维度状态：三条腿的中位数 + 按星期分布（§7.3） */
export type CommuteDimensionState = {
  days: CommuteDaySample[];
  overall: CommuteLegStats;
  byDaypart: DaypartSplit<CommuteLegStats>;
  /** 0..6 各星期离家中位数（无样本的星期为 null）——"周三你一般 8:10 出门" */
  leaveHomeByWeekday: Array<number | null>;
};

export type FocusPeakBlock = {
  startHour: number;
  endHour: number;
  /** 0..1 归一化强度 */
  score: number;
};

export type FocusGroupStats = {
  hourHistogram: number[];
  peakBlocks: FocusPeakBlock[];
  totalWeight: number;
};

export type FocusDimensionState = {
  /** 24 槽衰减累计活跃强度（每槽 0..~∞，内部值，不对外承诺尺度） */
  hourHistogram: number[];
  peakBlocks: FocusPeakBlock[];
  totalWeight: number;
  /** 同一批观察按工作日/周末各记一份直方图（择时要分组看：周末的高效段不是工作日的） */
  byDaypart: DaypartSplit<FocusGroupStats>;
};

export type OvertimeDayBit = {
  /** 本地日 YYYY-MM-DD（去重键，重复分析同日不叠加） */
  date: string;
  /** 0..6（周日=0） */
  weekday: number;
  /** 该日最后一次活跃是否 ≥ 晚归阈值 */
  late: 0 | 1;
};

export type OvertimeDimensionState = {
  /** 最近若干天的晚归位序列（按日去重，跨星期保留） */
  recentDays: OvertimeDayBit[];
  /** 派生值：0..6 各星期"晚归概率"（该星期最近若干晚归日占比，0..1） */
  byWeekday: number[];
  /** 派生值：0..6 各星期累计观察天数 */
  weekdayDays: number[];
  totalDays: number;
  /** 派生值：工作日 vs 周末的晚归概率（从 recentDays 现算，不另立账本） */
  byDaypart: DaypartSplit<{ lateRatio: number; days: number }>;
};

export type ReceptivityDimensionState = {
  /** 24 槽触达接受度 EWMA（0..1） */
  byHour: number[];
  /** 7 槽星期接受度 EWMA（0..1） */
  byWeekday: number[];
  attempts: number;
  /** 24 槽接受度按工作日/周末各一份 EWMA（同一批反馈分流累计，attempts 不重复计） */
  byDaypartHour: DaypartSplit<number[]>;
};

export type RhythmDimensionStates = {
  sleep: SleepDimensionState;
  wake: WakeDimensionState;
  commute: CommuteDimensionState;
  focus: FocusDimensionState;
  overtime: OvertimeDimensionState;
  receptivity: ReceptivityDimensionState;
};

// ---- 洞察 / 提醒槽位 ----

export type RhythmInsightKind = "trend" | "anomaly" | "observation" | "suggestion";

export type RhythmInsight = {
  id: string;
  generatedAt: string;
  dimension: RhythmDimension;
  kind: RhythmInsightKind;
  text: string;
  evidence: string[];
  confidence: number;
  /** 是否值得主动关怀（强度门槛在 insights 构建器内把关）；消费方仍受自身频控约束 */
  notifiable: boolean;
};

/** 单个节律提醒任务的槽位状态（出口 A 的记账本） */
export type ReminderSlotState = {
  taskId: string;
  /** 当前调度时刻（十进制小时，任务时区） */
  hour: number;
  /** 引擎见过的初始时刻（渐进调整的锚点） */
  originalHour: number;
  /** 接受度 EWMA（0..1）；无反馈数据为 null */
  acceptanceEwma: number | null;
  attempts: number;
  lastAdjustedAt: string | null;
  lastAdjustDirection: "earlier" | "later" | null;
  /** 用户手动固定（用户改过时间/明确说别动），引擎永不调整 */
  pinnedByUser: boolean;
};

export type RhythmProfile = {
  schemaVersion: 1;
  actorId: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次夜间分析日（YYYY-MM-DD，去重键） */
  lastAnalyzedDay: string | null;
  dimensions: RhythmDimensionStates;
  reminderSlots: Record<string, ReminderSlotState>;
  /** 最近一次关怀 candidate 发布（按维度限频用） */
  lastCandidateAt: Partial<Record<RhythmDimension, string>>;
  insights: RhythmInsight[];
};

export type RhythmProfileUpdate = {
  actorId: string;
  changedDimensions: RhythmDimension[];
  /** 各维度模型置信度（0..1），消费方据此决定是否动作 */
  confidences: Record<RhythmDimension, number>;
  insights: RhythmInsight[];
  profile: RhythmProfile;
};

// ---- 可插拔边界 ----

/** 传感器：从既有数据源拉取观察（夜间批处理时 collect） */
export type RhythmSensor = {
  id: string;
  dimensions: RhythmDimension[];
  collect(actorId: string, since: Date): RhythmObservation[] | Promise<RhythmObservation[]>;
  /**
   * 健康自检标记：该传感器正常每轮都应有观察产出（true），还是天然常空
   * （false/缺省，如位置传感器在定位关闭时合法返回空）。只影响 stalled 判定。
   */
  expectsObservations?: boolean;
};

/** 传感器采集健康（采样链自检：0 样本空转不再无人知晓） */
export type RhythmSensorHealth = {
  sensorId: string;
  dimensions: RhythmDimension[];
  collectCount: number;
  errorCount: number;
  observationCount: number;
  lastCollectAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError?: string;
  /** 连续多轮零观察且传感器声明应有产出 → 采样链疑断（健康面板红点） */
  stalled: boolean;
};

/** 引擎整体健康（/api/proactivity/sensors 的 rhythm 块） */
export type RhythmEngineHealth = {
  analysisRunCount: number;
  lastAnalysisAt: string | null;
  /** 引擎可用性：bootstrap 装配且 rhythm 开关打开 */
  enabled: boolean;
  sensors: RhythmSensorHealth[];
};

/** 模型器：纯统计，ingest 返回新状态；confidence 不足时消费方应静默跳过 */
export type RhythmDimensionModel<S = unknown> = {
  dimension: RhythmDimension;
  ingest(
    prev: S | null,
    observations: RhythmObservation[],
    ctx: { now: Date },
  ): S;
  confidence(state: S): number;
};

export type RhythmConsumer = (update: RhythmProfileUpdate) => void | Promise<void>;

export type ReminderFeedbackOutcome = "accepted" | "dismissed" | "snoozed" | "ignored" | "replied";
