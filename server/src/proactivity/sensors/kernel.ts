// SensorKernel —— 常驻传感层内核（五层主动性架构 L1 的地基）。
//
// 职责：注册/轮询传感器 → 指纹去重 → 水位推进（重启续采）→ 落盘环形缓冲 →
// 分发给订阅者（评估器链 / 观察流）→ 健康追踪（连续失败熔断，半开恢复）。
// 全部零 LLM；后续家居/手机/电子产品等物理设备以新传感器接入，不改内核。
//
// 持久化：
//  - data/proactivity/sensors/watermarks.json  每 sensor 采集水位（重启续采）
//  - data/proactivity/signals.jsonl            信号环形日志（诊断/回放，超 5MB 轮转）
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProactiveSensor, SensorHealth, SensorTransport, Signal, SignalStream } from "./types.js";

/** 每 sensor 指纹去重窗口容量（LRU，防长期运行膨胀） */
const FINGERPRINT_CACHE_MAX = 500;
/** 轮询循环步长（内核单定时器，按各 sensor 下次到期时间调度） */
const KERNEL_TICK_MS = 5_000;
/** 熔断阈值与半开恢复等待 */
const BREAKER_TRIP_FAILS = 3;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
/** 信号日志轮转阈值 */
const SIGNALS_LOG_MAX_BYTES = 5 * 1024 * 1024;

type SensorRuntime = {
  sensor: ProactiveSensor;
  transport: SensorTransport;
  watermark: number;
  fingerprints: Set<string>;
  fpOrder: string[]; // LRU 淘汰序
  health: SensorHealth;
  nextPollAt: number;
  breakerOpenUntil: number;
  /** 连续空轮数（adaptive 退避输入） */
  idleRounds: number;
  lastSignalAt: number | null;
  /** 单轮采集进行中（防 5s tick 在慢采集上重入） */
  polling: boolean;
};

export type SensorKernelOptions = {
  dataPath: string;
  /** 测试注入时钟 */
  nowFn?: () => number;
  /** 测试禁用落盘 */
  disablePersist?: boolean;
};

export class SensorKernel {
  private readonly runtimes = new Map<string, SensorRuntime>();
  private readonly listeners = new Set<(signal: Signal) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly nowFn: () => number;
  private readonly disablePersist: boolean;
  private readonly watermarksPath: string;
  private readonly signalsLogPath: string;

  constructor(private readonly opts: SensorKernelOptions) {
    this.nowFn = opts.nowFn ?? Date.now;
    this.disablePersist = opts.disablePersist === true;
    this.watermarksPath = join(opts.dataPath, "sensors", "watermarks.json");
    this.signalsLogPath = join(opts.dataPath, "signals.jsonl");
    this.loadWatermarks();
  }

  /** 注册传感器（重复 id 覆盖） */
  register(sensor: ProactiveSensor): void {
    const existing = this.runtimes.get(sensor.id);
    const transport: SensorTransport =
      sensor.transport ?? (sensor.pollIntervalMs > 0 ? "poll" : "push");
    this.runtimes.set(sensor.id, {
      sensor,
      transport,
      watermark: existing?.watermark ?? this.nowFn(),
      fingerprints: existing?.fingerprints ?? new Set(),
      fpOrder: existing?.fpOrder ?? [],
      health: {
        sensorId: sensor.id,
        stream: sensor.stream,
        mode: transport === "push" ? "feeder" : transport,
        pollIntervalMs: sensor.pollIntervalMs,
        lastOkAt: existing?.health.lastOkAt ?? null,
        lastFailAt: existing?.health.lastFailAt ?? null,
        consecutiveFails: 0,
        emitted: existing?.health.emitted ?? 0,
        tripped: false,
      },
      nextPollAt: this.nowFn(),
      breakerOpenUntil: 0,
      idleRounds: existing?.idleRounds ?? 0,
      lastSignalAt: existing?.lastSignalAt ?? null,
      polling: false,
    });
  }

  /** 订阅信号流（评估器链 / 观察流桥接用） */
  onSignal(listener: (signal: Signal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 推送型数据源入口（feeder）：外部事件源（对话轮/presence/rhythm/goal…）
   * 采集到事件后调用。去重 + 落盘 + 分发 + 健康记账一条龙。
   */
  emit(sensorId: string, signal: Signal): void {
    const rt = this.runtimes.get(sensorId);
    if (!rt) return;
    if (rt.fingerprints.has(signal.fingerprint)) return;
    this.rememberFingerprint(rt, signal.fingerprint);
    rt.health.lastOkAt = this.nowFn();
    rt.health.consecutiveFails = 0;
    rt.health.emitted += 1;
    rt.idleRounds = 0;
    rt.lastSignalAt = signal.at;
    rt.watermark = Math.max(rt.watermark, signal.at);
    this.dispatch(signal);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), KERNEL_TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    const pollers = [...this.runtimes.values()].filter((r) => r.health.mode === "poll");
    console.log(
      `[SensorKernel] 已启动 sensors=${this.runtimes.size}（轮询 ${pollers.length} / 推送 ${this.runtimes.size - pollers.length}）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persistWatermarks();
  }

  /** 健康快照（诊断面板） */
  health(): SensorHealth[] {
    return [...this.runtimes.values()].map((r) => ({ ...r.health }));
  }

  /** 立即轮询所有到期轮询型传感器（集成测试/诊断用；正常由 start 的 tick 驱动） */
  async pollOnce(): Promise<void> {
    const now = this.nowFn();
    for (const rt of this.runtimes.values()) {
      if (rt.transport === "push" || rt.polling) continue;
      if (rt.health.tripped && now < rt.breakerOpenUntil) continue;
      await this.poll(rt);
    }
  }

  /**
   * 唤醒：下次 tick 立即采集（可指定 sensor）。
   * 用途：外部事件提示"可能有新数据"（用户打开页面、手机重连、手动刷新），
   * 不必等自适应退避走完——退避省的是空转，不是该看的时刻。
   */
  wake(sensorId?: string): number {
    const now = this.nowFn();
    let n = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.transport === "push") continue;
      if (sensorId !== undefined && rt.sensor.id !== sensorId) continue;
      rt.nextPollAt = now;
      n += 1;
    }
    return n;
  }

  /** 最近信号（诊断/评估器回放） */
  recentLog(limit = 50): Signal[] {
    try {
      if (!existsSync(this.signalsLogPath)) return [];
      const lines = readFileSync(this.signalsLogPath, "utf8").trim().split("\n");
      return lines.slice(-limit).map((l) => JSON.parse(l) as Signal);
    } catch {
      return [];
    }
  }

  /** 内核主循环：到期传感器轮询（熔断中跳过，半开重试） */
  private tick(): void {
    const now = this.nowFn();
    for (const rt of this.runtimes.values()) {
      if (rt.transport === "push" || rt.polling) continue;
      if (rt.health.tripped && now < rt.breakerOpenUntil) continue;
      if (now < rt.nextPollAt) continue;
      rt.polling = true;
      void this.poll(rt);
    }
  }

  private async poll(rt: SensorRuntime): Promise<void> {
    rt.polling = true;
    try {
      const signals = await rt.sensor.collect(rt.watermark);
      rt.health.lastOkAt = this.nowFn();
      rt.health.consecutiveFails = 0;
      if (rt.health.tripped) {
        // 半开成功：恢复
        rt.health.tripped = false;
        console.log(`[SensorKernel] 传感器恢复 ${rt.sensor.id}`);
      }
      let fresh = 0;
      for (const signal of signals) {
        if (rt.fingerprints.has(signal.fingerprint)) continue;
        this.rememberFingerprint(rt, signal.fingerprint);
        rt.health.emitted += 1;
        rt.watermark = Math.max(rt.watermark, signal.at);
        rt.lastSignalAt = signal.at;
        fresh += 1;
        this.dispatch(signal);
      }
      // 自适应退避的输入：连续空轮越多，下一轮越晚；有信号即回到快节奏
      rt.idleRounds = fresh > 0 ? 0 : rt.idleRounds + 1;
    } catch (err) {
      rt.health.lastFailAt = this.nowFn();
      rt.health.consecutiveFails += 1;
      rt.health.lastError = String(err).slice(0, 160);
      if (rt.health.consecutiveFails >= BREAKER_TRIP_FAILS && !rt.health.tripped) {
        rt.health.tripped = true;
        rt.breakerOpenUntil = this.nowFn() + BREAKER_COOLDOWN_MS;
        console.log(
          `[SensorKernel] 传感器熔断 ${rt.sensor.id}（${BREAKER_COOLDOWN_MS / 60000}min 后半开重试）: ${rt.health.lastError}`,
        );
      }
    } finally {
      rt.polling = false;
      this.scheduleNext(rt, this.nowFn());
    }
  }

  /** 计算并写入下一轮采集时刻（adaptive：空轮指数退避，封顶 5× 基础间隔） */
  private scheduleNext(rt: SensorRuntime, now: number): void {
    const base = Math.max(rt.sensor.pollIntervalMs, KERNEL_TICK_MS);
    const state = { now, idleRounds: rt.idleRounds, lastSignalAt: rt.lastSignalAt };
    let interval = base;
    if (rt.sensor.nextIntervalMs) {
      interval = rt.sensor.nextIntervalMs(state);
    } else if (rt.transport === "adaptive") {
      interval = Math.min(base * 2 ** Math.min(rt.idleRounds, 3), base * 5);
    }
    rt.nextPollAt = now + Math.max(interval, KERNEL_TICK_MS);
    if (rt.health.mode === "adaptive") {
      rt.health.pollIntervalMs = Math.round(rt.nextPollAt - now);
    }
  }

  private dispatch(signal: Signal): void {
    if (!this.disablePersist) this.appendToLog(signal);
    for (const listener of this.listeners) {
      try {
        listener(signal);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }

  private rememberFingerprint(rt: SensorRuntime, fp: string): void {
    if (!rt.fingerprints.has(fp)) {
      rt.fingerprints.add(fp);
      rt.fpOrder.push(fp);
    }
    while (rt.fpOrder.length > FINGERPRINT_CACHE_MAX) {
      const oldest = rt.fpOrder.shift();
      if (oldest) rt.fingerprints.delete(oldest);
    }
  }

  private appendToLog(signal: Signal): void {
    try {
      mkdirSync(dirname(this.signalsLogPath), { recursive: true });
      if (existsSync(this.signalsLogPath)) {
        const size = statSync(this.signalsLogPath).size;
        if (size > SIGNALS_LOG_MAX_BYTES) {
          // 轮转：保留一代旧日志
          try {
            renameSync(this.signalsLogPath, `${this.signalsLogPath}.1`);
          } catch {
            /* 轮转失败继续追加 */
          }
        }
      }
      appendFileSync(this.signalsLogPath, `${JSON.stringify(signal)}\n`);
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }

  private loadWatermarks(): void {
    if (this.disablePersist) return;
    try {
      if (!existsSync(this.watermarksPath)) return;
      const raw = JSON.parse(readFileSync(this.watermarksPath, "utf8")) as Record<string, number>;
      for (const [id, wm] of Object.entries(raw)) {
        const rt = this.runtimes.get(id);
        if (rt) rt.watermark = wm;
      }
    } catch {
      /* 损坏的水位文件按从头采集处理 */
    }
  }

  private persistWatermarks(): void {
    if (this.disablePersist) return;
    try {
      mkdirSync(dirname(this.watermarksPath), { recursive: true });
      const out: Record<string, number> = {};
      for (const [id, rt] of this.runtimes) out[id] = rt.watermark;
      writeFileSync(this.watermarksPath, JSON.stringify(out));
    } catch {
      /* 落盘失败忽略 */
    }
  }
}

/** feeder 快捷注册：注册一个纯推送型 sensor 槽位，返回 emit 闭包 */
export function registerFeeder(
  kernel: SensorKernel,
  id: string,
  stream: SignalStream,
): (signal: Omit<Signal, "stream">) => void {
  kernel.register({ id, stream, pollIntervalMs: 0, collect: () => [] });
  return (partial) => kernel.emit(id, { ...partial, stream });
}
