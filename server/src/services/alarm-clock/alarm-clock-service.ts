/**
 * 闹钟调度服务（服务端兜底路）—— 触发主路在客户端本地（Android 精确闹钟 / iOS 本地通知），
 * 服务端负责：意图落库、跨设备同步（alarm.sync）、到点兜底触发（alarm.trigger）、
 * 客户端超时未回报时的系统级推送兜底、触发台账。
 *
 * 时序约定（docs/mobile-agent-reminder-alarm-design.md §8.3）：
 *  - tick 每 15s 扫描 nextFireAt ≤ now 的 active 闹钟 → 触发；
 *  - WS 直推成功 → 客户端应在 FALLBACK_MS 内回报 trigger-callback；
 *  - WS 失败（全离线）→ FALLBACK_OFFLINE_MS 后走 MobilePushService 系统推送；
 *  - 回报幂等由 AlarmStore.recordTrigger 保证。
 *
 * 叫醒语音缓存「用完即删除」（2026-11-09 用户定调，事件驱动而非等 TTL）：
 *  - 主路：端侧把 mp3 落到应用私有文件、本地精确闹钟排好后回报 voice/consume，
 *    云端立即删内存 Map + voice-clips/<alarmId>.json；音频此后只存在于端侧。
 *  - 收敛事件：dismiss / cancel / 触发确认(acked) 同样即时删。
 *  - TTL **只作异常兜底**：端侧离线、旧版本、进程崩溃没回报时，最多留到到点后
 *    一小段宽限即清。正常路径云端持有音频的时间是「生成 → 端侧确认」，秒级。
 *  - 重复闹钟每推进一跳 = 新的一次使用：旧音频删掉，按下一跳时刻重新实时生成。
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { WsConnectionRegistry } from "../ws-connection-registry.js";
import { readJson, writeJson } from "../../proactivity/persist-file.js";
import type { MobilePushChannel } from "../../proactivity/mobile-push-service.js";
import { advanceAlarmNextFireMs } from "./alarm-rrule.js";
import { AlarmStore, type AlarmCreateInput } from "./alarm-store.js";
import type { Alarm, AlarmTriggerPayload } from "./alarm-types.js";
import { inspectMp3 } from "./voice-quality.js";

export type TtsSynthesizeFn = (text: string) => Promise<{ format: "mp3"; base64: string } | null>;

/** 建钟时预生成的叫醒语音：离线主路的唯一音频来源 */
export type AlarmVoiceClip = {
  text: string;
  tts: { format: "mp3"; base64: string } | null;
  generatedAt: string;
  /** 兜底到期时刻（ISO）：仅在端侧没回报「已消费」时生效，过期内存与磁盘一起清除 */
  expiresAt: string;
};

/** 叫醒话术生成器（由 SpeechHub 注入）：失败返回 null，调用方走确定性兜底 */
export type WakeScriptFn = (input: {
  actorId: string;
  label: string;
  /** UTC ISO 时刻（内部存储形态，程序用） */
  fireAt: string;
  /** 已本地化为用户时区的可读时刻（如「11月9日周一 19:45」），直接进话术 facts */
  fireAtLocal: string;
  /** 用户时区本地小时（0-23），供兜底话术判断「早上好/你好」 */
  fireAtLocalHour: number;
  repeatRule: string | null;
}) => Promise<string | null>;

export type AlarmClockServiceDeps = {
  wsRegistry: WsConnectionRegistry;
  /** 离线必达推送（MobilePushService）；未装配时兜底降级为仅 WS */
  mobilePush?: MobilePushChannel | null;
  dataDir: string;
  /** 用户时区拉取器（actorContext.resolveClock(actorId).timezone）；缺省回退服务器时区 */
  resolveTimezone?: ((actorId: string) => string | undefined | null) | null;
  /** 二阶段语音叫醒：TTS 合成开场白；不可用时为 null（客户端按文本兜底） */
  synthesizeSpeech?: TtsSynthesizeFn | null;
  /** Agent 叫醒话术（SpeechHub light 档）；不可用时用确定性短句 */
  composeWakeScript?: WakeScriptFn | null;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
};

/** 限时等待：超时返回 fallback，同时清掉 timer（不拖住进程退出） */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** UTC 时刻 → 用户时区的可读时刻。时区缺失/非法/格式化异常时回退服务器时区或原串。
 * 返回 hour 为用户时区本地小时（0-23），供兜底话术判断「早上好/你好」。 */
export function localizeFireAt(fireAt: string, timezone?: string | null): { text: string; hour: number } {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return { text: fireAt, hour: 12 };
  const wanted = timezone?.trim();
  let tz: string | undefined;
  if (wanted) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: wanted });
      tz = wanted;
    } catch {
      tz = undefined; // 非法 IANA 名：宁可回退服务器时区，也不能让话术念错
    }
  }
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d),
    );
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
    const day = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(d);
    return { text: `${day} ${time}`, hour };
  } catch {
    return { text: fireAt, hour: d.getHours() };
  }
}

/** 无 LLM / 无 TTS 时的确定性兜底话术（永不空口）。localHour = 用户时区本地小时，
 * 服务器时区 ≠ 用户时区时必须由调用方传 localizeFireAt().hour，否则问候语会错档。 */
export function buildWakeFallback(label: string, fireAt: string, localHour?: number): string {
  const hour = Number.isFinite(localHour) ? (localHour as number) : new Date(fireAt).getHours();
  const opening = hour >= 5 && hour < 10 ? "早上好" : "你好";
  return `${opening}，${label.trim() || "时间到了"}，该起床啦。`;
}

const TICK_MS = 15_000;
// 兜底 TTL：正常路径由 consume/dismiss/cancel 事件即时删除，这里只覆盖「端侧没回报」
// 的异常路径（离线/旧客户端/崩溃），留一小段宽限给 5min 兜底推送与 REST 对账。
// 可用 ALARM_VOICE_CLIP_TTL_MS 覆盖（单位 ms）。
const VOICE_CLIP_AFTER_FIRE_TTL_MS = 30 * 60_000;
/** 最短存活：fireAt 解析失败或已过时，也不会刚生成就被清掉 */
const VOICE_CLIP_MIN_TTL_MS = 30 * 60_000;
const FALLBACK_MS = 5 * 60_000; // WS 已送达但客户端未回报 → 5 分钟后推送兜底
const FALLBACK_OFFLINE_MS = 30_000; // WS 全离线 → 30 秒后推送兜底
const MAX_SNOOZE_HARD_CAP = 10; // 贪睡硬上限（防客户端死循环顺延）
/** 提醒智能路由的"活跃窗口"：窗口内有真人活动的设备 = 用户此刻所在端，提醒只发它。
 * 可用 AGENT_REMINDER_ACTIVE_WINDOW_MS 覆盖；窗口内无活跃端（人在两端都不动/全离线）
 * 时降级为全端 fan-out——宁多勿漏，位置未知时不能赌。 */
const DEFAULT_ACTIVE_WINDOW_MS = 120_000;

export class AlarmClockService {
  readonly store: AlarmStore;
  private timer: NodeJS.Timeout | null = null;
  private readonly fallbacks = new Map<string, NodeJS.Timeout>(); // `${alarmId}:${firedAtMs}` → timer
  private readonly wsRegistry: WsConnectionRegistry;
  private readonly mobilePush: MobilePushChannel | null;
  private readonly synthesizeSpeech: TtsSynthesizeFn | null;
  private readonly composeWakeScript: WakeScriptFn | null;
  private readonly resolveTimezone: ((actorId: string) => string | undefined | null) | null;
  private readonly now: () => number;
  private readonly voiceClipDir: string;
  private readonly voiceClips = new Map<string, AlarmVoiceClip>();
  /**
   * 已交付给端侧的 alarmId（内存态即可，重启后 alarm 若仍 active 会由端侧对账重新确认）。
   * 两个用途：① 消费后别再被重复对账/重复创建反复合成；
   *          ② 到点兜底 trigger 无需再临时合成（端侧已有音频）。
   */
  private readonly deliveredVoiceClips = new Set<string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: { info: (msg: string) => void; warn: (msg: string) => void };
  private firing = new Set<string>(); // 同 tick 去重

  constructor(deps: AlarmClockServiceDeps) {
    this.wsRegistry = deps.wsRegistry;
    this.mobilePush = deps.mobilePush ?? null;
    this.synthesizeSpeech = deps.synthesizeSpeech ?? null;
    this.composeWakeScript = deps.composeWakeScript ?? null;
    this.resolveTimezone = deps.resolveTimezone ?? null;
    this.now = deps.now ?? Date.now;
    this.voiceClipDir = join(deps.dataDir, "voice-clips");
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? { info: (m) => console.info(`[alarm-clock] ${m}`), warn: (m) => console.warn(`[alarm-clock] ${m}`) };
    this.store = new AlarmStore(deps.dataDir);
    this.loadVoiceClips();
  }

  // ─── 叫醒语音：建钟时预生成 + 预合成，随 alarm.sync / REST 下发 ───

  private loadVoiceClips(): void {
    const nowMs = this.now();
    try {
      if (!existsSync(this.voiceClipDir)) return;
      for (const name of readdirSync(this.voiceClipDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        const file = join(this.voiceClipDir, name);
        const clip = readJson<AlarmVoiceClip | null>(file, null);
        if (!clip || typeof clip.text !== "string") continue;
        // 升级前落盘的老缓存没有 expiresAt：能找到对应闹钟就按它下一次触发时刻重算 TTL；
        // 找不到（孤儿文件）一律清掉——云端不该留着没人认领的音频。
        let legacy = false;
        if (!clip.expiresAt) {
          legacy = true;
          if (!this.store.get(id)) {
            rmSync(file, { force: true });
            continue;
          }
          clip.expiresAt = this.clipExpiry(id, nowMs);
        }
        if (this.isClipExpired(clip, nowMs)) {
          rmSync(file, { force: true });
          this.log.info(`voice clip expired on startup alarm=${id}`);
          continue;
        }
        // 重启后旧缓存也要过同一道门禁：门禁上线前落盘的坏 mp3（错误 JSON /
        // 静音占位 / 截断流）不能因为「已在磁盘上」就复活成到点静音。
        if (clip.tts?.base64) {
          const v = inspectMp3(Buffer.from(clip.tts.base64, "base64"), clip.text.length);
          if (!v.ok) {
            this.log.warn(`discard bad cached voice clip ${name}: ${v.reasons.join("; ")}`);
            clip.tts = null;
          }
        }
        this.voiceClips.set(id, clip);
        if (legacy) this.persistVoiceClip(id, clip);
      }
    } catch {
      /* 语音缓存损坏不影响闹钟主链 */
    }
  }

  /** 兜底 TTL 基准 = 下一次触发时刻 + 宽限；至少保底 30 分钟。ALARM_VOICE_CLIP_TTL_MS 可调宽限。 */
  private clipExpiry(alarmId: string, nowMs: number): string {
    const alarm = this.store.get(alarmId);
    const fireMs = Date.parse(alarm?.nextFireAt ?? alarm?.fireAt ?? "");
    const raw = Number(this.env.ALARM_VOICE_CLIP_TTL_MS);
    const ttl = Number.isFinite(raw) && raw > 0 ? raw : VOICE_CLIP_AFTER_FIRE_TTL_MS;
    const base = Number.isFinite(fireMs) ? fireMs + ttl : nowMs + ttl;
    return new Date(Math.max(nowMs + VOICE_CLIP_MIN_TTL_MS, base)).toISOString();
  }

  private isClipExpired(clip: AlarmVoiceClip, nowMs: number): boolean {
    const t = Date.parse(clip.expiresAt);
    return !Number.isFinite(t) || t <= nowMs;
  }

  /** 读取时惰性过期：过期立即清内存 + 磁盘，绝不把过期音频下发给端侧 */
  private liveVoiceClip(alarmId: string, nowMs: number = this.now()): AlarmVoiceClip | null {
    const clip = this.voiceClips.get(alarmId);
    if (!clip) return null;
    if (this.isClipExpired(clip, nowMs)) {
      this.deleteVoiceClip(alarmId);
      this.log.info(`voice clip expired alarm=${alarmId}`);
      return null;
    }
    return clip;
  }

  /** 贪睡顺延等场景刷新兜底 TTL，避免异常路径上音频提前被清（已消费时是 no-op） */
  private refreshVoiceClipExpiry(alarmId: string): void {
    const clip = this.voiceClips.get(alarmId);
    if (!clip) return;
    clip.expiresAt = this.clipExpiry(alarmId, this.now());
    this.persistVoiceClip(alarmId, clip);
  }

  private persistVoiceClip(alarmId: string, clip: AlarmVoiceClip): void {
    try {
      mkdirSync(this.voiceClipDir, { recursive: true });
      writeJson(join(this.voiceClipDir, `${alarmId}.json`), clip);
    } catch (e) {
      this.log.warn(`persist voice clip failed: ${String(e)}`);
    }
  }

  private deleteVoiceClip(alarmId: string): void {
    this.voiceClips.delete(alarmId);
    try {
      rmSync(join(this.voiceClipDir, `${alarmId}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }

  getVoiceClip(alarmId: string): AlarmVoiceClip | null {
    return this.liveVoiceClip(alarmId);
  }

  /**
   * 「用完即删除」的主触发点（端侧回执）：mp3 已落到应用私有文件、本地精确闹钟已排好。
   * 云端这份音频的使命到此结束，立即删内存 Map + voice-clips/<id>.json；
   * 文本话术已在 wakeMode.voiceScript 落库，不随音频一起消失。幂等。
   */
  consumeVoiceClip(alarmId: string): { consumed: boolean; delivered: boolean } {
    this.deliveredVoiceClips.add(alarmId);
    if (!this.liveVoiceClip(alarmId)) return { consumed: false, delivered: true };
    this.deleteVoiceClip(alarmId);
    this.log.info(`voice clip consumed and deleted alarm=${alarmId}`);
    return { consumed: true, delivered: true };
  }

  /** 生命周期收敛事件（取消 / 关闭 / 触发确认）：同样即时清云端音频，不等 TTL */
  private discardVoiceClip(alarmId: string): void {
    const had = this.liveVoiceClip(alarmId) !== null;
    this.deleteVoiceClip(alarmId);
    if (had) this.log.info(`voice clip discarded after use alarm=${alarmId}`);
  }

  /** 下行展开：音频只走 WS/HTTP 载荷，不进 alarms.json（避免全量重写放大） */
  toPayload(alarm: Alarm): Alarm & { voiceText: string | null; ttsBase64: string | null; voiceReady: boolean } {
    const clip = this.liveVoiceClip(alarm.id);
    return {
      ...alarm,
      voiceText: clip?.text ?? alarm.wakeMode?.voiceScript ?? null,
      ttsBase64: clip?.tts?.base64 ?? null,
      voiceReady: clip?.tts != null,
    };
  }

  /** REST 对账 / WS 重连后补齐：音频已交付并删除时只带文本，端侧本地文件是事实源 */
  listAlarmsPayload(actorId: string, status?: string): ReturnType<AlarmClockService["toPayload"]>[] {
    return this.listAlarms(actorId, status).map((a) => this.toPayload(a));
  }

  /** 读用户时区（provider 异常绝不影响建钟链路；未装配返回 undefined → 服务器时区） */
  private resolveActorTimezone(actorId: string): string | undefined {
    try {
      return this.resolveTimezone?.(actorId)?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 生成叫醒话术 → 合成 mp3 → 落盘缓存 → 补发一次带音频的 alarm.sync。
   * 这一动作发生在「设置闹钟」时而非「到点」时：原生闹钟的价值就是
   * 杀进程/锁屏/断网也响，任何依赖到点联网的 LLM/TTS 都不能做主路。
   */
  private async prepareVoiceClip(alarm: Alarm, force = false): Promise<void> {
    if (alarm.wakeMode?.level !== "voice_talk") return;
    // 已交付给端侧（云端已删）或闹钟已终结：只补状态同步，不为同一预约反复合成。
    // force 只在改期 / 重复闹钟推进下一跳 / 显式刷新时用 —— 那是新的一次使用。
    if (!force && (this.deliveredVoiceClips.has(alarm.id) || alarm.status !== "active")) {
      this.syncToDevices(alarm, "upsert");
      return;
    }
    // 重复闹钟推进下一跳后按新时刻生成话术，不念过期的首次时刻
    const scriptFireAt = alarm.nextFireAt ?? alarm.fireAt;
    // 话术里念的时刻必须是用户时区的本地时间（服务器可能跑在 UTC），
    // 否则「今晚19:45」的闹钟会被 LLM 念成「11点45」
    const fireLocal = localizeFireAt(scriptFireAt, this.resolveActorTimezone(alarm.actorId));
    // 惰性过期：兜底 TTL 已到的旧音频先清掉，再按当前话术重新生成，绝不复用过期产物
    const existing = this.liveVoiceClip(alarm.id);
    if (existing && !force && existing.tts) {
      this.syncToDevices(alarm, "upsert");
      return;
    }
    const fallback = buildWakeFallback(alarm.label, scriptFireAt, fireLocal.hour);
    let text = fallback;
    if (this.composeWakeScript) {
      const generated = await withTimeout(
        this.composeWakeScript({
          actorId: alarm.actorId,
          label: alarm.label,
          fireAt: scriptFireAt,
          fireAtLocal: fireLocal.text,
          fireAtLocalHour: fireLocal.hour,
          repeatRule: alarm.repeat.rule,
        }),
        3_000,
        null,
      );
      if (generated && generated.trim()) text = generated.trim().slice(0, 120);
    }
    let tts: { format: "mp3"; base64: string } | null = null;
    if (this.synthesizeSpeech) {
      tts = await withTimeout(this.synthesizeSpeech(text), 8_000, null);
    }
    const nowMs = this.now();
    const clip: AlarmVoiceClip = {
      text,
      tts,
      generatedAt: new Date(nowMs).toISOString(),
      expiresAt: this.clipExpiry(alarm.id, nowMs),
    };
    // 新生成的一跳允许再次被端侧 ACK（改期 / 重复闹钟下一跳）
    if (force) this.deliveredVoiceClips.delete(alarm.id);
    this.voiceClips.set(alarm.id, clip);
    this.persistVoiceClip(alarm.id, clip);
    this.store.update(alarm.id, { wakeMode: { ...alarm.wakeMode, voiceScript: text } });
    this.syncToDevices(this.store.get(alarm.id) ?? alarm, "upsert");
    this.log.info(`voice clip ready alarm=${alarm.id} tts=${tts != null} chars=${text.length}`);
  }

  /** 外部（HTTP PATCH / 测试）显式触发重生成 */
  refreshVoiceClip(alarmId: string): void {
    const alarm = this.store.get(alarmId);
    if (alarm) void this.prepareVoiceClip(alarm, true);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.log.info(`scheduler started (tick=${TICK_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.fallbacks.values()) clearTimeout(t);
    this.fallbacks.clear();
  }

  // ─── CRUD（HTTP 路由薄壳直接透传到这里） ───

  createAlarm(input: AlarmCreateInput): { alarm: Alarm; duplicate: boolean } {
    const dup = this.store.findDuplicate(input.actorId, input);
    if (dup) {
      // 重复口头创建：补发预约状态同步。音频已交付给端侧的话云端不再持有，
      // 端侧沿用本地私有文件；未交付（端侧离线）时补生成并再次下发。
      this.syncToDevices(dup, "upsert");
      if (dup.wakeMode?.level === "voice_talk") void this.prepareVoiceClip(dup);
      return { alarm: dup, duplicate: true };
    }
    const alarm = this.store.create(input);
    this.syncToDevices(alarm, "upsert");
    // 语音叫醒：立即异步生成话术 + 预合成音频，完成后补发一次 alarm.sync。
    // 第一次同步不带音频，保证端侧先把本地精确闹钟排上，不等 LLM/TTS。
    if (alarm.wakeMode?.level === "voice_talk") void this.prepareVoiceClip(alarm);
    if (alarm.repeat.rule) {
      const next = advanceAlarmNextFireMs(alarm.repeat, new Date(alarm.fireAt).getTime(), this.now());
      if (next !== null) this.log.info(`repeating alarm ${alarm.id} next=${new Date(next).toISOString()}`);
    }
    return { alarm, duplicate: false };
  }

  listAlarms(actorId: string, status?: string): Alarm[] {
    return this.store.listByActor(actorId, status);
  }

  getAlarm(id: string): Alarm | undefined {
    return this.store.get(id);
  }

  updateAlarm(id: string, patch: Partial<AlarmCreateInput>): Alarm | undefined {
    const alarm = this.store.update(id, patch);
    if (!alarm) return undefined;
    // 时间/标签/叫醒模式变了 → 旧话术不再贴合，重生成；否则只同步状态
    const needsRefresh =
      patch.fireAt !== undefined || patch.label !== undefined || patch.wakeMode !== undefined;
    if (needsRefresh && alarm.wakeMode?.level === "voice_talk") {
      void this.prepareVoiceClip(alarm, true);
    } else {
      this.syncToDevices(alarm, "upsert");
    }
    return alarm;
  }

  cancelAlarm(id: string): Alarm | undefined {
    const alarm = this.store.update(id, { status: "canceled" });
    if (alarm) {
      this.discardVoiceClip(id); // 取消 = 这次音频再也不会被用，立即删（不等 TTL）
      this.syncToDevices(alarm, "delete");
    }
    return alarm;
  }

  snoozeAlarm(id: string, minutes: number): Alarm | undefined {
    const alarm = this.store.get(id);
    if (!alarm) return undefined;
    if ((alarm.snoozeCount ?? 0) >= Math.min(alarm.snooze.maxCount, MAX_SNOOZE_HARD_CAP)) {
      // 超过贪睡上限：不再顺延，交由触发链自然完成（响铃仍在继续，需显式关闭）
      return alarm;
    }
    const updated = this.store.snooze(alarm, minutes, this.now());
    // 贪睡期间端侧还要再响一次：本地 mp3 保留，云端若因异常路径尚有缓存则顺延兜底 TTL
    this.refreshVoiceClipExpiry(updated.id);
    this.syncToDevices(updated, "upsert");
    return updated;
  }

  dismissAlarm(id: string): Alarm | undefined {
    const alarm = this.store.get(id);
    if (!alarm) return undefined;
    // dismiss = 用户确认停止本次响铃：单次 → done；重复 → 推进到下一跳
    if (alarm.repeat.rule) {
      this.store.advanceAfterFire(alarm, this.now());
    } else {
      this.store.update(id, { status: "done" });
    }
    const fresh = this.store.get(id)!;
    // 用完即删：这一跳的云端音频使命结束（端侧同时删本地 mp3）
    this.discardVoiceClip(id);
    this.syncToDevices(fresh, "upsert"); // 先把新状态 / 下一跳同步给端侧
    if (fresh.status === "active") {
      // 重复闹钟推进下一跳 = 新的一次使用：按新时刻重新实时生成，再走一次「生成→下发→用完即删」
      this.deliveredVoiceClips.delete(id);
      void this.prepareVoiceClip(fresh, true);
    }
    return fresh;
  }

  // ─── 触发与回执 ───

  /** 客户端回报触发结果（幂等）；via=local 表示客户端本地调度先响，服务端兜底跳自动失效 */
  reportTriggerCallback(
    alarmId: string,
    body: { firedAtMs: number; via?: string; outcome?: string; snoozeCount?: number; actualChannel?: string },
  ): { accepted: boolean; duplicate: boolean } {
    const firedAtMs = Number(body.firedAtMs);
    if (!Number.isFinite(firedAtMs)) return { accepted: false, duplicate: false };
    this.clearFallback(alarmId, firedAtMs);
    const result = this.store.recordTrigger({
      alarmId,
      firedAtMs,
      via: (body.via as "local" | "server" | "fallback_push") ?? "local",
      outcome: (body.outcome as "ringing" | "missed" | "acked" | "snoozed") ?? "ringing",
      snoozeCount: body.snoozeCount,
      actualChannel: body.actualChannel,
      reportedAt: new Date(this.now()).toISOString(),
    });
    // 端侧确认这一跳已接手（本地已响/用户已确认）：云端音频用完，立即删
    if (body.outcome === "acked") this.discardVoiceClip(alarmId);
    return result;
  }

  listTriggers(alarmId: string) {
    return this.store.listTriggers(alarmId);
  }

  /** 语音模型健康探测（二阶段降级判定用）：本服务无独立模型进程，按 ttsService 能力上报 */
  voiceHealth(): { ok: boolean; model: string; available: boolean; reason?: string } {
    const available = this.synthesizeSpeech !== null && this.env.ALARM_VOICE_DISABLED !== "1";
    return {
      ok: true,
      model: this.env.ALARM_VOICE_MODEL ?? "e2e-tts",
      available,
      ...(available ? {} : { reason: "tts_unavailable" }),
    };
  }

  // ─── 内部：调度 tick 与投递 ───

  private async tick(): Promise<void> {
    await this.tickAll(this.now());
  }

  /** 每 15s 随调度 tick 清扫兜底 TTL：只清「端侧没回报已消费」的异常残留 */
  private sweepExpiredVoiceClips(nowMs: number): void {
    for (const [id, clip] of this.voiceClips) {
      if (!this.isClipExpired(clip, nowMs)) continue;
      this.deleteVoiceClip(id);
      this.log.info(`voice clip ttl fallback swept alarm=${id}`);
    }
  }

  private async tickAll(nowMs: number): Promise<void> {
    this.sweepExpiredVoiceClips(nowMs);
    for (const alarm of this.allActive()) {
      const nextMs = alarm.nextFireAt ? new Date(alarm.nextFireAt).getTime() : NaN;
      if (!Number.isFinite(nextMs) || nextMs > nowMs) continue;
      const fireKey = `${alarm.id}:${nextMs}`;
      if (this.firing.has(fireKey)) continue;
      this.firing.add(fireKey);
      void this.fireAlarm(alarm, nextMs).finally(() => this.firing.delete(fireKey));
    }
  }

  private allActive(): Alarm[] {
    // 直接读内部数据（跨 actor 全量）；store.listByActor 是单 actor 语义
    return (this.store as unknown as { data: { alarms: Alarm[] } }).data.alarms.filter(
      (a) => a.status === "active" && !!a.nextFireAt,
    );
  }

  private async fireAlarm(alarm: Alarm, firedAtMs: number): Promise<void> {
    // 端侧已确认落盘 = 音频在端上，云端那份早已删掉；到点不必也不该再临时合成
    const delivered = this.deliveredVoiceClips.has(alarm.id);
    const clip = this.liveVoiceClip(alarm.id);
    const payload: AlarmTriggerPayload = {
      alarmId: alarm.id,
      label: alarm.label,
      kind: alarm.kind,
      firedAtMs,
      via: "server",
      wakeMode: alarm.wakeMode,
      voiceText: clip?.text ?? alarm.wakeMode?.voiceScript ?? null,
      // 主路：建钟时预合成的音频；到点不再依赖 LLM 与网络
      tts: clip?.tts ?? null,
    };
    // 异常路径兜底：端侧从未回报「已消费」（离线 / 旧客户端 / 预合成失败）时，
    // 到点临时合成一次让 alarm.trigger 不至于只有文字。产物只进 WS 载荷、不落盘
    // （用完即弃）；端侧已交付过就绝不重复调 TTS —— 到点链路保持零网络。
    if (!payload.tts && !delivered && alarm.wakeMode?.level === "voice_talk" && this.synthesizeSpeech) {
      const local = localizeFireAt(alarm.nextFireAt ?? alarm.fireAt, this.resolveActorTimezone(alarm.actorId));
      const text =
        clip?.text || alarm.wakeMode.voiceScript || buildWakeFallback(alarm.label, alarm.fireAt, local.hour);
      const tts = await withTimeout(this.synthesizeSpeech(text), 1_500, null);
      if (tts) payload.tts = tts;
    }
    const sent = this.deliverTrigger(alarm, JSON.stringify({ type: "alarm.trigger", payload }));
    this.log.info(
      `fired ${alarm.kind} ${alarm.id} "${alarm.label}" route=${sent.route} delivered=${sent.ok} at=${new Date(firedAtMs).toISOString()}`,
    );
    // 推进下一跳（重复闹钟），单次置 done —— 但若客户端此后贪睡会再次改写 nextFireAt
    this.store.advanceAfterFire(alarm, firedAtMs);
    const advanced = this.store.get(alarm.id);
    if (advanced?.status === "active") {
      // 重复闹钟下一跳 = 新的一次使用：旧音频用完即删，按下一跳时刻重新实时生成，
      // 端侧重新落盘并回报消费，绝不复用上一跳的音频。
      this.discardVoiceClip(alarm.id);
      this.deliveredVoiceClips.delete(alarm.id);
      this.syncToDevices(advanced, "upsert"); // 先把下一跳状态同步下去
      void this.prepareVoiceClip(advanced, true);
    } else {
      // 单次：等 dismiss / acked 收尾删；异常路径（端侧一直没回报）由兜底 TTL 收敛
      this.refreshVoiceClipExpiry(alarm.id);
    }
    // 兜底：客户端超时未回报 → 系统级推送
    this.scheduleFallback(alarm, firedAtMs, sent.ok ? FALLBACK_MS : FALLBACK_OFFLINE_MS);
    // 即时提醒（kind=reminder）补一条 reminder.deliver 供客户端按 channelPlan 升级链展示
    if (alarm.kind === "reminder") {
      this.deliverTrigger(
        alarm,
        JSON.stringify({
          type: "reminder.deliver",
          payload: {
            reminderId: alarm.id,
            text: (alarm as Alarm & { remindText?: string }).remindText ?? alarm.label,
            channelPlan: (alarm as Alarm & { channelPlan?: string[] }).channelPlan ?? ["notification", "popup"],
            escalateAfterSec: (alarm as Alarm & { escalateAfterSec?: number }).escalateAfterSec ?? 120,
            requireAck: (alarm as Alarm & { requireAck?: boolean }).requireAck ?? true,
          },
        }),
      );
    }
  }

  /**
   * 触发投递的智能路由（2026-10-08）：判断用户当前在手机端还是电脑端，只发一端、不两端齐发。
   *
   *  - kind=alarm（闹钟）：跟人睡的地方走 → mobile 优先独占，手机全离线才退 desktop；
   *    全离线返回 ok=false 交给推送兜底。闹钟在两端齐响是事故级体验，必须单端。
   *  - kind=reminder（即时提醒）：发给「活跃窗口内最近有真人活动的设备」（用户此刻所在端）；
   *    窗口内无活跃端（位置未知）→ 降级全端 fan-out，宁多勿漏。
   *
   * alarm.sync 的跨设备同步不走这里（fan-out 是对的：每台设备都要排上本地调度）。
   */
  private deliverTrigger(alarm: Alarm, data: string): { ok: boolean; route: string } {
    if (alarm.kind === "alarm") {
      const ok = this.wsRegistry.trySendToDeviceClassOrder(alarm.actorId, data, ["mobile", "desktop"]);
      return { ok, route: ok ? "alarm_mobile_first" : "offline" };
    }
    const windowMs = Number(this.env.AGENT_REMINDER_ACTIVE_WINDOW_MS) || DEFAULT_ACTIVE_WINDOW_MS;
    if (this.wsRegistry.trySendToActiveDevice(alarm.actorId, data, windowMs)) {
      return { ok: true, route: "reminder_active_device" };
    }
    const ok = this.wsRegistry.trySend(alarm.actorId, data);
    return { ok, route: ok ? "reminder_fanout_location_unknown" : "offline" };
  }

  private scheduleFallback(alarm: Alarm, firedAtMs: number, delayMs: number): void {
    const key = `${alarm.id}:${firedAtMs}`;
    const prev = this.fallbacks.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.fallbacks.delete(key);
      void this.fireFallbackPush(alarm, firedAtMs).catch(() => {});
    }, delayMs);
    this.fallbacks.set(key, timer);
  }

  private clearFallback(alarmId: string, firedAtMs: number): void {
    const key = `${alarmId}:${firedAtMs}`;
    const timer = this.fallbacks.get(key);
    if (timer) {
      clearTimeout(timer);
      this.fallbacks.delete(key);
    }
  }

  private async fireFallbackPush(alarm: Alarm, firedAtMs: number): Promise<void> {
    if (!this.mobilePush) return;
    // 客户端可能已回报（竞态）：台账里已有非 ringing 记录则跳过
    const reported = this.store
      .listTriggers(alarm.id)
      .some((t) => Math.abs(t.firedAtMs - firedAtMs) < 90_000 && t.outcome !== "ringing");
    if (reported) return;
    const result = await this.mobilePush.push({
      actorId: alarm.actorId,
      title: alarm.kind === "alarm" ? `闹钟：${alarm.label}` : `提醒：${alarm.label}`,
      body: `手机端本地闹钟未响应（可能已离线/被杀进程），此为服务端兜底推送。`,
      importance: alarm.dnd.bypass ? "high" : "normal",
      kind: "alarm_fallback",
      deliveryId: `alarmfb_${randomUUID()}`,
    });
    this.log.info(`fallback push alarm=${alarm.id} ok=${result.ok} provider=${result.provider}`);
    this.store.recordTrigger({
      alarmId: alarm.id,
      firedAtMs,
      via: "fallback_push",
      outcome: "missed",
      reportedAt: new Date().toISOString(),
    });
  }

  /** 跨设备同步：把最新状态 fan-out 到该用户全部在线设备（客户端写入本地闹钟库并重排本地调度） */
  private syncToDevices(alarm: Alarm, op: "upsert" | "delete"): void {
    this.wsRegistry.trySend(
      alarm.actorId,
      JSON.stringify({
        type: "alarm.sync",
        // 展开对象带 voiceText / ttsBase64 / voiceReady：端侧据此缓存音频到原生层
        payload: { alarm: op === "delete" ? alarm : this.toPayload(alarm), op },
      }),
    );
  }
}
