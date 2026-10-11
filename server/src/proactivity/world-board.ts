// WorldBoard —— 主动性世界状态板（程序层「采集 → 整理」的产物）。
//
// 设计定稿（2026-09-24 用户拍板）：程序层只负责**采集与分层整理**，不负责判断；
// 传感器/服务把信号整理进这份分层、幂等、有界、可持久化的「专属给规则看的
// 状态板」，映射执行器（mapping-executor）是它唯一的决策消费者。
//
// 四层：
//   obligations 义务层 —— 用户点名要的事（下一个日程、就绪目标、待跟进……）
//   current     当下层 —— 此刻状态（presence、屏幕焦点、未读消息窗口……）
//   session     会话层 —— 最近对话轮（程序截断入板，规则不翻原文）
//   background  背景层 —— 环境尾迹（file/clipboard 等次要信号最后一条）
//
// 全零 LLM；所有值必须是可 JSON 序列化的纯数据；列表键有硬上限（防膨胀）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Signal } from "./sensors/types.js";

export type BoardLayerName = "obligations" | "current" | "session" | "background";

export type BoardActorData = Record<BoardLayerName, Record<string, unknown>>;

export type WorldBoardOptions = {
  /** 持久化目录（缺省不落盘，测试用） */
  dataPath?: string;
  nowFn?: () => number;
};

const PERSIST_DEBOUNCE_MS = 30_000;
/** 列表键默认上限（append 时裁剪） */
export const BOARD_LIST_CAP_DEFAULT = 50;

function emptyActorData(): BoardActorData {
  return { obligations: {}, current: {}, session: {}, background: {} };
}

/** 稳定字符串哈希（djb2；指纹/诊断用，非安全） */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export class WorldBoard {
  private readonly actors = new Map<string, BoardActorData>();
  private readonly listeners = new Set<(actorId: string, layer: BoardLayerName, key: string) => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly boardPath: string | null;
  private readonly nowFn: () => number;

  constructor(private readonly opts: WorldBoardOptions = {}) {
    this.nowFn = opts.nowFn ?? Date.now;
    this.boardPath = opts.dataPath ? join(opts.dataPath, "world-board.json") : null;
    this.restore();
  }

  // ---- 写入（程序层唯一入口） ----

  /** 幂等 upsert：同 key 覆盖为最新值（"状态板只有现在"） */
  ingest(actorId: string, layer: BoardLayerName, key: string, value: unknown): void {
    const data = this.actors.get(actorId) ?? emptyActorData();
    this.actors.set(actorId, data);
    data[layer][key] = value;
    this.markDirty(actorId, layer, key);
  }

  /** 列表追加（新值在前），超出 cap 裁掉尾部 */
  append(
    actorId: string,
    layer: BoardLayerName,
    key: string,
    item: unknown,
    cap: number = BOARD_LIST_CAP_DEFAULT,
  ): void {
    const data = this.actors.get(actorId) ?? emptyActorData();
    this.actors.set(actorId, data);
    const list = Array.isArray(data[layer][key]) ? (data[layer][key] as unknown[]) : [];
    list.unshift(item);
    if (list.length > cap) list.length = cap;
    data[layer][key] = list;
    this.markDirty(actorId, layer, key);
  }

  /** 订阅变更（诊断/E2E 等待用；fire-and-forget，不阻塞写入方） */
  onChange(listener: (actorId: string, layer: BoardLayerName, key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- 读取 ----

  getBoard(actorId: string): BoardActorData | null {
    return this.actors.get(actorId) ?? null;
  }

  /** 读取某层某 key（缺省 undefined） */
  read<T>(actorId: string, layer: BoardLayerName, key: string): T | undefined {
    return this.actors.get(actorId)?.[layer]?.[key] as T | undefined;
  }

  knownActors(): string[] {
    return [...this.actors.keys()];
  }

  /** 内容指纹（同内容同指纹；诊断与"状态未变跳过"依据） */
  fingerprint(actorId: string): string {
    const data = this.actors.get(actorId);
    if (!data) return "";
    return String(hash32(JSON.stringify(data)));
  }

  // ---- 传感信号 → 状态板（一行桥接，bootstrap 与测试共用） ----

  /** 消费一条传感信号，按流映射到对应层（actorId 缺省落 defaultActorId） */
  ingestSignal(signal: Signal, defaultActorId?: string | null): void {
    const actorId = signal.actorId ?? defaultActorId ?? "local_user";
    const at = signal.at;
    const payload = signal.payload ?? {};
    switch (signal.stream) {
      case "presence":
        // 幂等状态：{state, since}（since=该状态的起始时刻，away_return 计算离开时长用）
        this.ingest(actorId, "current", "presence", { state: String(payload.state ?? "unknown"), since: at });
        break;
      case "screen": {
        // 屏幕焦点：kind 不变则保留原 since（连续工作时长跨信号累计）
        const prev = this.read<{ kind: string; since: number }>(actorId, "current", "screenFocus");
        const kind = String(payload.kind ?? "unknown");
        const since = prev && prev.kind === kind ? prev.since : at;
        this.ingest(actorId, "current", "screenFocus", { kind, since, lastSeenAt: at });
        break;
      }
      case "schedule": {
        // 两种形状：
        //  a) 任务集合快照（schedule-sensor）：nextRunAt + nextTitle
        //  b) 日历订阅事件（ics-sensor，2026-10-11 收编）：startMs + summary
        // 原来只认 a)，ICS 信号在此被**静默丢弃**——订阅日历永远驱动不了 meeting_soon。
        const legacyRunAt = typeof payload.nextRunAt === "number" ? payload.nextRunAt : null;
        const legacyTitle = String(payload.nextTitle ?? "");
        if (legacyRunAt !== null && legacyTitle) {
          this.ingest(actorId, "obligations", "nextEvent", {
            title: legacyTitle,
            runAt: legacyRunAt,
            updatedAt: at,
          });
          break;
        }
        const startMs = typeof payload.startMs === "number" ? payload.startMs : null;
        const summary = String(payload.summary ?? "");
        // 注意：ICS 适配器的 signal.at 就是**事件开始时刻**，不是观测时刻，
        // 因此"是否未来事件"必须对比板钟，不能对比 at（否则恒等、永远不入板）
        if (startMs !== null && summary && startMs > this.nowFn()) {
          // 订阅一次可能送来多个事件：只在"更近的未来事件"时覆盖，避免远事件挤掉近事件
          const prev = this.read<{ runAt: number }>(actorId, "obligations", "nextEvent");
          if (!prev || startMs < prev.runAt) {
            this.ingest(actorId, "obligations", "nextEvent", { title: summary, runAt: startMs, updatedAt: at });
          }
        }
        break;
      }
      case "message":
        if (payload.sender) {
          this.append(actorId, "current", "unreadRecent", { at, sender: String(payload.sender) });
        }
        break;
      case "mail": {
        // 2026-10-11：邮件收编进板（原来落 background 尾迹 → unread_burst 永不触发）。
        // 营销邮件在 MailWatchService 侧已过滤，能到这里的都是真人来信。
        const sender = String(payload.from ?? payload.sender ?? "未知发件人");
        this.append(actorId, "current", "unreadRecent", {
          at,
          sender,
          source: "mail",
          ...(payload.subject ? { subject: String(payload.subject) } : {}),
          ...(payload.importance ? { importance: String(payload.importance) } : {}),
        });
        break;
      }
      case "finance":
        // 2026-10-11：账本条目入板（原来落 background 尾迹 → 无任何消费方）。
        // 驱动 spend_alert（大额支出）等财务类规则；金额/商户是可 JSON 化纯数据。
        this.append(
          actorId,
          "current",
          "recentTx",
          {
            at,
            id: String(payload.id ?? ""),
            amount: Number(payload.amount ?? 0),
            type: String(payload.type ?? "expense"),
            ...(payload.merchant ? { merchant: String(payload.merchant) } : {}),
            ...(payload.category ? { category: String(payload.category) } : {}),
          },
          20,
        );
        break;
      case "goal":
        this.append(
          actorId,
          "obligations",
          "recentGoals",
          {
            at,
            goalId: String(payload.goalId ?? ""),
            title: String(payload.title ?? ""),
            body: String(payload.body ?? ""),
          },
          20,
        );
        break;
      default:
        // file/clipboard/device 等次要信号：只留最后一条尾迹（背景层）
        this.ingest(actorId, "background", "lastEnv", {
          stream: signal.stream,
          delta: signal.delta ?? "",
          at,
        });
        break;
    }
  }

  // ---- 持久化（防抖 + 退出 flush；重启不丢状态板） ----

  flush(): void {
    if (!this.boardPath) return;
    try {
      mkdirSync(dirname(this.boardPath), { recursive: true });
      const actors: Record<string, BoardActorData> = {};
      for (const [k, v] of this.actors) actors[k] = v;
      writeFileSync(this.boardPath, JSON.stringify({ actors }));
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }

  private schedulePersist(): void {
    if (!this.boardPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  private restore(): void {
    if (!this.boardPath || !existsSync(this.boardPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.boardPath, "utf8")) as {
        actors?: Record<string, BoardActorData>;
      };
      for (const [actorId, data] of Object.entries(raw.actors ?? {})) {
        this.actors.set(actorId, { ...emptyActorData(), ...data });
      }
    } catch {
      /* 损坏文件按空板处理 */
    }
  }

  private markDirty(actorId: string, layer: BoardLayerName, key: string): void {
    this.schedulePersist();
    for (const l of this.listeners) {
      try {
        l(actorId, layer, key);
      } catch {
        /* 单订阅者失败不影响其他 */
      }
    }
  }
}

/** L1→板 一行桥接：内核信号进状态板（bootstrap 与测试共用同一接线函数） */
export function bridgeSensorKernelToBoard(
  kernel: { onSignal(listener: (signal: Signal) => void): () => void },
  board: WorldBoard,
  defaultActorId?: string | null | (() => string | null),
): () => void {
  return kernel.onSignal((signal) => {
    try {
      const fallback =
        typeof defaultActorId === "function" ? defaultActorId() : (defaultActorId ?? null);
      board.ingestSignal(signal, fallback);
    } catch {
      /* 单信号入板失败不影响内核分发 */
    }
  });
}
