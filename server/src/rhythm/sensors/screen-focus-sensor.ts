import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { Signal } from "../../proactivity/sensors/types.js";
import type { RhythmObservation, RhythmSensor } from "../types.js";

/**
 * 屏幕状态条件化传感器（主动感知的第二条腿：不只学「几点」，还学「什么状态下」）。
 *
 * 数据链路：proactivity 内核 screen 流信号的前台分类（开会/写代码/玩游戏…，
 * 变化即出信号 + 15min 心跳）→ 内核 signals 日志落盘 → 本传感器按小时去重
 * 转成节律观察 → 喂给 receptivity 维度：正事/游戏占用时段以弱负信号把对应
 * 小时的可打扰度拉向 0（与 location_movement 同一先例：移动中人大概率忽略
 * 主动消息）。
 *
 * 「静止不证明可打扰」同理成立：聊天/浏览/闲置等信号不产出观察——高频
 * 普通状态虚增接受度与位置传感器同一坑，只消费强负信号。
 *
 * 注意：屏幕信号日志不带 actorId（内核信号为单主人模型，bootstrap 桥接
 * WorldBoard 时落 primaryActor），本传感器产出观察对任意 actorId 查询等价。
 */

/** 强勿扰前台分类：正事进行中 / 游戏占用，主动消息大概率被忽略 */
const SCREEN_BUSY_KINDS = new Set(["meeting", "game", "coding", "terminal", "office"]);

/** 从内核信号日志中提取的屏幕流信号类型守卫 */
function isScreenSignal(signal: Signal): signal is Signal & {
  payload: { kind?: unknown };
} {
  return signal.stream === "screen" && Number.isFinite(signal.at);
}

export class ScreenFocusSensor implements RhythmSensor {
  readonly id = "screen-focus";
  readonly dimensions = ["receptivity" as const];
  /** 屏幕信号由 screen 流持续产出（15min 心跳兜底），零观察=采样链疑断 */
  readonly expectsObservations = true;

  constructor(
    private readonly screenSignals: () => Signal[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  collect(_actorId: string, since: Date): RhythmObservation[] {
    const sinceMs = since.getTime();
    const nowMs = this.now().getTime();
    const seen = new Set<string>();
    const observations: RhythmObservation[] = [];
    for (const signal of this.screenSignals()) {
      if (!isScreenSignal(signal)) continue;
      const kind = String(signal.payload.kind ?? "");
      if (!SCREEN_BUSY_KINDS.has(kind)) continue;
      const atMs = signal.at;
      // 分析窗口（since）之内才算本轮观察；future 漂移防御
      if (atMs < sinceMs || atMs > nowMs + 60_000) continue;
      const at = new Date(atMs);
      // 每小时每分类一条：EWMA 按小时结算，重复信号会过度拉低
      const dedupKey = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}:${kind}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      observations.push({
        dimension: "receptivity",
        at: at.toISOString(),
        value: 0,
        kind: "screen_busy",
        source: this.id,
      });
    }
    return observations;
  }
}
