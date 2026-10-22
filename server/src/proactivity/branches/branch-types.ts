// 可插拔消息聚合「树枝」类型定义（2026-10-22 定调，树状架构 Phase 1）。
//
// 架构语义（用户拍板）：消息聚合做成树状——每个信息源是一根树枝，
// 树枝 = 接入 connector + 闸（本目录 BranchGate）+ 精简上报（Summarizer）。
// 闸不只是放行/拦截：L1 确定性规则 → L2 游标增量 → L3 按需精简（LLM）。
// 管道只收压缩视图（Signal），原文留在树枝权威库（不丢失原文）。
//
// 两种供货节奏（同一抽象）：streaming（Muse 式授权连接源，游标增量）
// 与 upload（用户上传课表/行程表，批量 + 版本链，信号是"事实主张"而非事件）。

/** 树枝供货模式：streaming=持续连接源；upload=用户批量上传物（版本链） */
export type BranchMode = "streaming" | "upload";

/** L1 确定性闸策略（零 LLM、宁误放不误杀；用户可按树枝覆盖） */
export type BranchGatePolicy = {
  /** 全放行（upload/批量树枝：内容是用户主动给的，只走 L2 指纹去重） */
  passthrough?: boolean;
  /** 强噪声正则（字符串源，命中即挡） */
  strongNoise?: string;
  /** 商业推广词密度挡（去重命中 ≥ n 才挡；0/缺省=关） */
  commercialDensity?: number;
  /** 豁免谓词：返回 true 直接放行（人际触达/日程变动信号等强证据） */
  exempt?: (text: string, meta?: Record<string, unknown>) => boolean;
  /** 现役闸委托：消息树枝直接复用 message-gate 语义（零行为漂移的接缝） */
  delegate?: (text: string, meta?: Record<string, unknown>) => { gated: boolean; reason?: string };
};

/** 树枝清单（manifest）：注册制可插拔的声明单元 */
export type BranchManifest = {
  id: string;
  /** SourceStore 流名（跨源检索的 stream 维度） */
  stream: string;
  mode: BranchMode;
  /** 人话名（诊断面板/配置面直接展示） */
  label: string;
  gate: BranchGatePolicy;
};

/** 闸裁决：stage 说明是哪一层挡下/放行（L1 规则 / L2 指纹去重） */
export type BranchGateVerdict = {
  allowed: boolean;
  stage: "L1" | "L2";
  reason?: string;
};

/** 树枝统一上报形状（压缩视图；对齐 sensors Signal 的字段纪律） */
export type BranchSignal = {
  stream: string;
  at: number;
  fingerprint: string;
  salience: "low" | "medium" | "high";
  delta: string;
  payload: Record<string, unknown>;
  entities?: string[];
};
