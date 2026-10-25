// 主动呼叫器（ProactiveCaller）—— "遇到事情打电话汇报"的真实闭环。
//
// 链路：评估器判定某事件值得打电话（重要/涉第三方/用户 opt-in）→ 本模块
// 发起真实虚拟来电（振铃前摇 → 接通 TTS 播报）→ 通话中多轮对话（用户说话
// 本地 ASR → phone.call_reply 上行 → LLM 口语回复 → TTS 推回）→ 结束后
// 结果分类回灌（replied / no_response / user_hangup / no_device）→ 事件审计。
//
// 用量纪律（零 LLM 判定 + LLM 只在对话轮）：
//  - 是否打电话的决策是确定性规则（kind 白名单 + importance + 静默时段 +
//    分 kind 呼叫冷却 + 设备在线），零 LLM
//  - LLM 只在接通后的每一轮对话回复（口语化短句），每日轮次熔断
//  - 振铃后无应答 → 自动降级为文本消息投递（信息必达，不打扰空响）
//  - PROACTIVE_CALL_ENABLED=0 一键关闭（默认开启）
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { isQuietHourNow } from "./arbiter.js";

/** 通话后 LLM 口语回复函数（bootstrap 注入 externalChat 薄包装） */
export type CallTurnLlm = (history: Array<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<string>;

export type CallOutcome = "replied" | "no_response" | "user_hangup" | "no_device" | "disabled" | "cooldown";

export type ProactiveCallerDeps = {
  virtualPhone: VirtualPhoneService;
  /** 每轮对话回复的 LLM（缺省 null = 播报后只收回复不对话，仍闭环） */
  turnLlm: CallTurnLlm | null;
  dataPath: string;
  /** 用户不在线时的文本兜底投递（信息必达） */
  fallbackTextDelivery?: (actorId: string, title: string, text: string) => void;
  /** 通话结果回灌（outcome/审计/自校准由装配层接线） */
  onOutcome?: (input: { actorId: string; kind: string; outcome: CallOutcome; callId: string; transcript: Array<{ role: string; content: string }> }) => void;
  nowFn?: () => number;
};

const CALL_LOG_MAX_BYTES = 3 * 1024 * 1024;
/** 呼叫冷却（分 kind；未列出的 kind 用默认） */
const CALL_COOLDOWN_MS: Record<string, number> = {
  schedule_change: 30 * 60_000,
  morning_call: 22 * 3600_000,
  meeting_soon: 4 * 3600_000,
  default: 4 * 3600_000,
};
/** 对话轮上限 / 总时长上限 / 等待用户开口上限 */
const MAX_TURNS = 8;
const MAX_CALL_MS = 4 * 60_000;
const REPLY_WAIT_MS = 45_000;
/** 每日 LLM 对话轮熔断（不乱调 LLM） */
const DAILY_TURN_CAP = 60;

const END_PATTERNS = /(再见|拜拜|挂了|就这样|知道了|收到|好的谢谢|嗯嗯好的)/;

type PersistShape = {
  kindLastAt: Array<[string, number]>;
  turnsDate: string;
  turnsToday: number;
};

export class ProactiveCaller {
  private readonly nowFn: () => number;
  private kindLastAt = new Map<string, number>();
  private turnsDate = "";
  private turnsToday = 0;
  private readonly statePath: string;

  constructor(private readonly deps: ProactiveCallerDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.statePath = join(deps.dataPath, "call-state.json");
    this.load();
  }

  enabled(): boolean {
    return process.env.PROACTIVE_CALL_ENABLED !== "0" && this.deps.turnLlm !== null;
  }

  /** 该 kind 现在是否允许打电话（确定性策略，零 LLM） */
  canCallNow(kind: string, importance: string, now = new Date(this.nowFn())): { allowed: boolean; reason: string } {
    if (process.env.PROACTIVE_CALL_ENABLED === "0") return { allowed: false, reason: "kill_switch" };
    // 静默时段只有 critical 唤醒（半夜来电只留给真正紧急的事）
    if (isQuietHourNow(now) && importance !== "critical") {
      return { allowed: false, reason: "quiet_hours" };
    }
    const last = this.kindLastAt.get(kind);
    const cooldown = CALL_COOLDOWN_MS[kind] ?? CALL_COOLDOWN_MS.default;
    if (last !== undefined && this.nowFn() - last < cooldown) {
      return { allowed: false, reason: `cooldown(${kind})` };
    }
    return { allowed: true, reason: "ok" };
  }

  /**
   * 打电话汇报 + 通话内对话。完整闭环：
   * 振铃 → 接通播报 → 多轮对话（LLM）→ 结束 → 结果回灌 onOutcome。
   * 设备全离线 → 立即文本兜底（不空响）；通话结束无对话 → 同样文本兜底补达。
   */
  async callAndReport(input: {
    actorId: string;
    kind: string;
    importance: string;
    title: string;
    /** 接通后 TTS 播报的汇报正文（评估器模板/LLM 生成均可） */
    report: string;
    /** 汇报背景（喂给对话 LLM 的 system，回答用户追问用） */
    context?: string;
  }): Promise<{ ok: boolean; outcome: CallOutcome; callId?: string; reason?: string }> {
    if (!this.enabled()) {
      this.deps.fallbackTextDelivery?.(input.actorId, input.title, input.report);
      return { ok: false, outcome: "disabled", reason: "call_disabled_text_fallback" };
    }
    const gate = this.canCallNow(input.kind, input.importance);
    if (!gate.allowed) {
      this.deps.fallbackTextDelivery?.(input.actorId, input.title, input.report);
      return { ok: false, outcome: "cooldown", reason: gate.reason };
    }

    const call = await this.deps.virtualPhone.callUserWithRinging({
      fromActorId: input.actorId,
      toUserId: input.actorId,
      transcript: input.report,
      ringStyle: "reminder",
      ringPhase: { enableRingingPhase: true, ringDurationMs: 6_000 },
    });
    if (!call.ok || !call.callId || !call.pushed) {
      // 设备全离线（WS 推送失败）→ 不空响，直接文本兜底
      this.deps.fallbackTextDelivery?.(input.actorId, input.title, input.report);
      this.record({ actorId: input.actorId, kind: input.kind, outcome: "no_device", callId: "", transcript: [] });
      return { ok: false, outcome: "no_device", reason: call.error ?? "push_failed" };
    }
    this.kindLastAt.set(input.kind, this.nowFn());
    this.persist();

    // ── Realtime 语音模式：对话由 duplex realtime 引擎接管（callId 上下文注入，
    //    客户端麦克风语音进、语音回），本循环只等通话结束并回灌结果。
    //    汇报正文已在接通首帧播报，信息必达，不再走沉默文本兜底。
    if (this.deps.virtualPhone.isRealtimeVoice?.()) {
      await this.deps.virtualPhone.waitForCallEnd(call.callId, MAX_CALL_MS);
      this.deps.virtualPhone.endCall(call.callId, "completed");
      this.record({
        actorId: input.actorId,
        kind: input.kind,
        outcome: "replied",
        callId: call.callId,
        transcript: [{ role: "assistant", content: input.report }],
      });
      return { ok: true, outcome: "replied", callId: call.callId };
    }

    // ── 通话内对话循环：用户说话 → LLM 口语回复 → TTS 推回 ──
    const transcript: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "assistant", content: input.report },
    ];
    const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content:
          `你刚打电话向用户汇报了一件事，正在通话中。汇报内容：「${input.report}」。` +
          (input.context ? `背景：${input.context}。` : "") +
          `规则：口语化、一两句话、直接回答；用户说再见/知道了/挂了等结束语 → 只输出 [END]；` +
          `听不懂就简短确认；不要报数据清单。`,
      },
    ];
    const startAt = this.nowFn();
    let turns = 0;
    let outcome: CallOutcome = "no_response";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = MAX_CALL_MS - (this.nowFn() - startAt);
      if (remaining <= 0 || turns >= MAX_TURNS) break;
      const reply = await this.deps.virtualPhone.waitForCallReply(call.callId, Math.min(REPLY_WAIT_MS, remaining));
      if (!reply) {
        // 用户没开口：无人接/沉默/挂断都到这里——补文本兜底后结束
        outcome = turns > 0 ? "user_hangup" : "no_response";
        break;
      }
      transcript.push({ role: "user", content: reply.text });
      history.push({ role: "user", content: reply.text });
      if (END_PATTERNS.test(reply.text) || this.turnsToday >= DAILY_TURN_CAP) {
        await this.safeVoiceReply(call.callId, input.actorId, "好的，那先这样，有事随时找我。");
        transcript.push({ role: "assistant", content: "好的，那先这样，有事随时找我。" });
        outcome = "replied";
        break;
      }
      const answer = this.turnsToday < DAILY_TURN_CAP && this.deps.turnLlm ? await this.deps.turnLlm(history).catch(() => "") : "";
      turns += 1;
      this.turnsToday += 1;
      if (!answer || answer.includes("[END]")) {
        await this.safeVoiceReply(call.callId, input.actorId, "好的，那先这样。");
        outcome = "replied";
        break;
      }
      const clean = answer.replace(/\[END\]/g, "").trim();
      transcript.push({ role: "assistant", content: clean });
      history.push({ role: "assistant", content: clean });
      await this.safeVoiceReply(call.callId, input.actorId, clean);
      outcome = "replied";
    }

    this.deps.virtualPhone.endCall(call.callId, outcome === "no_response" ? "no_response" : "completed");
    // 无对话的空响 → 文本兜底补达（信息必达）
    if (outcome === "no_response") {
      this.deps.fallbackTextDelivery?.(input.actorId, input.title, input.report);
    }
    this.record({ actorId: input.actorId, kind: input.kind, outcome, callId: call.callId, transcript });
    return { ok: true, outcome, callId: call.callId };
  }

  /** 呼叫统计（selftest L5 层展示） */
  stats(): { enabled: boolean; turnsToday: number; dailyTurnCap: number; recentCalls: number } {
    return {
      enabled: this.enabled(),
      turnsToday: this.turnsToday,
      dailyTurnCap: DAILY_TURN_CAP,
      recentCalls: this.kindLastAt.size,
    };
  }

  private async safeVoiceReply(callId: string, actorId: string, text: string): Promise<void> {
    try {
      await this.deps.virtualPhone.pushVoiceReply(callId, actorId, text);
    } catch {
      /* TTS 失败不影响通话闭环 */
    }
  }

  private record(input: { actorId: string; kind: string; outcome: CallOutcome; callId: string; transcript: Array<{ role: string; content: string }> }): void {
    this.deps.onOutcome?.(input);
    // 呼叫日志落盘（证据 + 事后追溯）
    try {
      const logPath = join(this.deps.dataPath, "call-log.jsonl");
      mkdirSync(dirname(logPath), { recursive: true });
      if (existsSync(logPath) && statSync(logPath).size > CALL_LOG_MAX_BYTES) {
        renameSync(logPath, `${logPath}.1`);
      }
      appendFileSync(
        logPath,
        `${JSON.stringify({ at: this.nowFn(), ...input })}\n`,
      );
    } catch {
      /* 日志失败不影响通话 */
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistShape;
      this.kindLastAt = new Map(raw.kindLastAt ?? []);
      this.turnsDate = raw.turnsDate ?? "";
      this.turnsToday = raw.turnsToday ?? 0;
    } catch {
      /* 损坏文件按空状态 */
    }
  }

  private persist(): void {
    try {
      const today = new Date(this.nowFn()).toISOString().slice(0, 10);
      if (today !== this.turnsDate) {
        this.turnsDate = today;
        this.turnsToday = 0;
      }
      mkdirSync(dirname(this.statePath), { recursive: true });
      const out: PersistShape = {
        kindLastAt: [...this.kindLastAt],
        turnsDate: this.turnsDate,
        turnsToday: this.turnsToday,
      };
      writeFileSync(this.statePath, JSON.stringify(out));
    } catch {
      /* 落盘失败忽略 */
    }
  }
}
