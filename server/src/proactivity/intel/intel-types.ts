// 情报链路的三层形状：原始素材 → 面板条目（目录行 + 详情）→ 开口成稿。
//
// 判断一次调用给出取舍（说不说、何时说）与草稿（怎么说）；草稿过不了事实校验时
// 才升级成稿重写。本文件只定义契约。
// 时间一律存绝对时刻（epoch ms），展示时再渲染成「今天 10:32」「还剩 14 小时」。

/** 原始素材（信源原样交进来，不做关键词归类） */
export type IntelRaw = {
  source: string;
  title: string;
  text: string;
  from?: string;
  date?: string;
};

/** 入口闸分类：一次性口令 / 营销 / 账号类系统噪音 */
export type IntelGateCategory = "otp" | "marketing" | "noise";

export type IntelGateVerdict = { allow: true } | { allow: false; category: IntelGateCategory; rule: string };

export type IntelGateSample = {
  at: number;
  source: string;
  from?: string;
  title: string;
  category: IntelGateCategory;
  rule: string;
};

export type IntelGateStats = {
  checked: number;
  allowed: number;
  blocked: number;
  byCategory: Record<IntelGateCategory, number>;
  samples: IntelGateSample[];
};

/**
 * 面板条目状态：
 *   new        已进面板、等模型判断（判断失败留在 new，按退避重试）
 *   held       模型判了「到点说」，等到 dueAt
 *   to_compose 已判定值得说（或到点），等成稿/投递
 *   unconfirmed 已发出，用户还没回应（只给高风险事项）
 *   dropped    模型明确放弃 / 过期 / 通道拒投
 * 说出后条目从面板删除，只留历史与墓碑。
 */
export type IntelEntryState = "new" | "held" | "to_compose" | "unconfirmed" | "dropped";

export type IntelVerdict = "now" | "later" | "never";

export type IntelJudgment = {
  verdict: IntelVerdict;
  /** 判断理由（内部留痕，不给用户看） */
  reason: string;
  /** 判断阶段写好的草稿（now/later）；校验通过直接投递 */
  draft?: string;
  /** 用户必须回一句才算闭环 */
  needsConfirm?: boolean;
  /** 日后仍需记得的承诺/待办 */
  memoryCandidate?: string;
  /** 摘要不足以判断或写准草稿，要求带详情再判一次（仅少量条目） */
  needDetail?: boolean;
  /** later 的开口时刻（ms） */
  dueAt?: number;
  /** 过了这个时刻信息就没用（ms） */
  expiresAt?: number;
  judgedAt?: number;
};

/** 面板条目：目录行（brief）给判断看，详情（detail）只在成稿时懒加载 */
export type IntelEntry = {
  id: string;
  /** 事件键：跨来源同一件事共用一个键（缺省即 id），说出后写进墓碑 */
  eventKey: string;
  actorId: string;
  source: string;
  receivedAt: number;
  updatedAt: number;
  /** 同一事件被补充信息时的版本号（判断会重跑） */
  version: number;
  /** 合并进来的来源引用（source:externalId） */
  refs: string[];
  raw: IntelRaw;
  brief: string;
  detail: string;
  state: IntelEntryState;
  /** 已尝试判断/投递次数（失败可见，状态面板不假装在干活） */
  attempts: number;
  lastError?: string;
  /** 失败退避时刻（判断或投递） */
  nextRetryAt?: number;
  judgment?: IntelJudgment;
  dueAt?: number;
  expiresAt?: number;
  composed?: { message: string; at: number; needsConfirm?: boolean; memoryCandidate?: string };
  spokenAt?: number;
  /** 已发未确认的追问截止（到期仍未回应则落历史） */
  confirmBy?: number;
};

/** 已说出/已删除的条目备忘（judge 的密度输入 + 面板已读 + 墓碑去重） */
export type IntelHistoryItem = {
  id: string;
  eventKey: string;
  actorId: string;
  source: string;
  brief: string;
  message: string;
  at: number;
  needsConfirm?: boolean;
  acknowledged?: boolean;
};

/** 墓碑：同一事件说过一次后，重复通知不再开口 */
export type IntelTombstone = {
  eventKey: string;
  topic: string;
  message: string;
  at: number;
};

/** 判断看到的目录行：一行一条，不带详情；needDetail 追问时才附详情 */
export type IntelDirectoryLine = {
  id: string;
  source: string;
  from?: string;
  /** 收到时刻（绝对 ms；渲染由调用方负责） */
  at: number;
  brief: string;
  state: IntelEntryState;
  dueAt?: number;
  detail?: string;
};

export type IntelJudgeFeedback = {
  /** 最近说过的话（判断密度与重复感） */
  recentSpoken: Array<{ at: number; message: string }>;
  /** 最近投递回执（用户接受/忽略/静音） */
  recentOutcomes: Array<{ at: number; kind: string; outcome: string }>;
};

export type IntelJudgeInput = {
  now: number;
  timezone: string;
  presence: "active" | "idle" | "offline";
  inConversation: boolean;
  /** 本轮待判断的目录行（只有摘要，没有正文） */
  lines: IntelDirectoryLine[];
  feedback: IntelJudgeFeedback;
  /** 用户画像浅层（称呼/偏好）；null=无 */
  styleBrief?: string | null;
  /** 说话风格卡（只影响草稿措辞，不影响取舍） */
  voiceCard?: string | null;
};

export type IntelJudgeResult = {
  id: string;
  verdict: IntelVerdict;
  reason: string;
  /** now/later 的现成一句话；缺失时由成稿阶段兜底 */
  draft?: string;
  needsConfirm?: boolean;
  memoryCandidate?: string;
  dueAt?: number;
  expiresAt?: number;
  needDetail?: boolean;
};

export type IntelJudge = (input: IntelJudgeInput) => Promise<IntelJudgeResult[]>;

/** 成稿输入：只有被判定要说的条目才带详情 */
export type IntelComposeItem = {
  id: string;
  source: string;
  from?: string;
  at: number;
  brief: string;
  detail: string;
};

export type IntelComposeInput = {
  actorId: string;
  now: number;
  timezone: string;
  presence: "active" | "idle" | "offline";
  inConversation: boolean;
  items: IntelComposeItem[];
  styleBrief?: string | null;
  recentSpoken: Array<{ at: number; message: string }>;
};

export type IntelComposeResult = {
  id: string;
  message: string;
  needsConfirm?: boolean;
  /** 需要日后仍记得的事（承诺/待办），由记忆模块自行遗忘 */
  memoryCandidate?: string;
};

export type IntelComposer = (input: IntelComposeInput) => Promise<IntelComposeResult[]>;

export type IntelIngestInput = {
  actorId: string;
  source: string;
  title: string;
  text: string;
  from?: string;
  date?: string;
  /** 信源侧稳定 id（邮件 UID 等）；缺省时按内容指纹去重 */
  externalId?: string;
  /** 跨来源事件键（同一次会议变更从邮件+微信各来一条时共用） */
  eventKey?: string;
  /** 信源已完成提炼时可直接给目录行与详情（缺省走确定性提炼） */
  brief?: string;
  detail?: string;
};
