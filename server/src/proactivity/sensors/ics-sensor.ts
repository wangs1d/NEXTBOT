// IcsSensor —— IcsSubscriptionService → ProactiveSensor 适配器（2026-10-10 外部信源收编）。
//
// 日历订阅（.ics）此前自行轮询 + 自行落成日程，产出不进统一采集层，
// 导致「邮件里的航班 + 日历里的行程」无法跨源拼图。本适配器只做形状转换。
import type { ProactiveSensor, Signal } from "./types.js";

/** IcsSubscriptionService 的只读取数口 */
export interface IcsReadPort {
  fetchEventsSince(since: number): Array<{
    feed: string;
    key: string;
    summary: string;
    location?: string;
    startMs: number;
    allDay: boolean;
    durationMinutes?: number;
  }>;
}

export class IcsSensor implements ProactiveSensor {
  readonly id = "ics_subscription";
  readonly stream = "schedule" as const;
  /** 订阅轮询间隔由服务自身控制；内核侧 10min 兜底同步进库 */
  readonly pollIntervalMs = 600_000;

  constructor(private readonly port: IcsReadPort) {}

  collect(since: number): Signal[] {
    const events = this.port.fetchEventsSince(since);
    return events.map((e) => ({
      stream: "schedule" as const,
      at: e.startMs,
      // 事件键天然唯一（feed + occurrence key）→ 稳定指纹
      fingerprint: `ics:${e.feed}:${e.key}`,
      salience: e.startMs - Date.now() <= 60 * 60_000 ? "high" : "low",
      delta: `日历事件：${e.summary}${e.location ? `（${e.location}）` : ""}`,
      payload: {
        source: "ics",
        feed: e.feed,
        summary: e.summary,
        location: e.location,
        startMs: e.startMs,
        allDay: e.allDay,
        // 跨源实体候选：地点 + 事件名（"三亚"能同时命中邮件航班与日历行程）
        entities: [e.location, e.summary].filter((v): v is string => !!v && v.length <= 40),
      },
    }));
  }
}
