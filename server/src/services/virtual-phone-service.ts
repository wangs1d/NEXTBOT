import { randomBytes, randomInt, randomUUID } from "crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { ServerEventType } from "../protocol.js";
import type { TtsService } from "./tts-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
/** 前摇阶段配置 */
export interface RingPhaseConfig {
  /** 振铃持续时间（毫秒），默认 8000ms（8秒振铃） */
  ringDurationMs?: number;
  /** 是否启用前摇阶段；设为 false 则退化为旧逻辑直接推 incoming（向后兼容） */
  enableRingingPhase?: boolean;
}

export type VirtualPhoneRingStyle = "reminder" | "peer";
export type VirtualPhoneInitiator = "user" | "agent";

type PersistedVirtualPhones = {
  byActor: Record<string, string>;
};

export type CallUserParams = {
  fromActorId: string;
  toUserId: string;
  transcript: string;
  ringStyle: VirtualPhoneRingStyle;
  /** 前摇阶段配置（可选，不传则启用默认前摇） */
  ringPhase?: RingPhaseConfig;
};

export type UserCallAgentParams = {
  fromUserId: string;
  toActorId: string;
  userMessage?: string;
  /** 前摇阶段配置（可选） */
  ringPhase?: RingPhaseConfig;
};

/** 用户→Agent 通话接通后的 Agent 回应生成器（bootstrap 接线到 AgentCore） */
export type UserCallAgentHandler = (params: {
  callId: string;
  fromUserId: string;
  toActorId: string;
  userMessage: string;
}) => Promise<{ replyText: string } | null>;

/** 通话中用户回复处理器（bootstrap 接线到 AgentCore 主对话管线） */
export type UserCallReplyHandler = (params: {
  callId: string;
  fromActorId: string;
  toUserId: string;
  text: string;
}) => Promise<void>;

type ActiveCallSession = {
  callId: string;
  /** 通话中的 Agent 一侧（user_to_agent=被叫 Agent；agent_to_user=主叫 Agent） */
  fromActorId: string;
  /** 通话中的用户一侧 */
  toUserId: string;
  direction: "user_to_agent" | "agent_to_user";
  createdAt: number;
  /** 呼出时的语音稿/留言（通话记录落盘用） */
  initialTranscript?: string;
};

type ReplyWaiter = {
  resolve: (value: { text: string } | null) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** 通话会话保活时长：超时后 call_reply 不再路由进 Agent，防映射表无界增长 */
const CALL_SESSION_TTL_MS = 10 * 60_000;
/** 用户→Agent 通话 Agent 生成回应的超时；超时按兜底话术接通 */
const USER_CALL_AGENT_TIMEOUT_MS = (() => {
  const n = Number(process.env.VIRTUAL_PHONE_USER_CALL_AGENT_TIMEOUT_MS ?? 25_000);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
})();
/** 通话记录保留天数（TTL 清理），默认 30 天 */
const CALL_HISTORY_TTL_DAYS = (() => {
  const n = Number(process.env.VIRTUAL_PHONE_HISTORY_TTL_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/**
 * 用户主动呼叫 Agent 的默认振铃时长（毫秒）。
 *
 * 原为 5s：振铃加 realtime 麦克风起流合计近 7s 全程无声音，用户据此判定
 * 「通话没打通」——历史里出现过点了呼叫 0.74s 就 user_hangup 的记录，
 * 那时服务端还没走到 connected。压到 2.5s：留住「呼叫中」的过程感，
 * 又不会让用户对着没声音的界面干等。可用环境变量覆盖（0 表示跳过振铃）。
 */
const DEFAULT_USER_CALL_RING_MS = (() => {
  const n = Number(process.env.VIRTUAL_PHONE_USER_CALL_RING_MS ?? 2_500);
  return Number.isFinite(n) && n >= 0 ? n : 2_500;
})();

/**
 * realtime 语音模式下接通瞬间的开场问候。
 *
 * duplex 实时语音要等客户端二次 WS 握手再开麦克风，这段空窗服务端原本
 * 一言不发（connected 帧不带 transcript/tts），用户听不到任何「已接通」的
 * 信号。补一句极短问候异步下发，既当接通提示音，又不抢用户话轮
 * （客户端只在 TTS 播放期间门控麦克风，播完自动恢复）。
 */
const REALTIME_GREETING_TEXT =
  process.env.VIRTUAL_PHONE_REALTIME_GREETING?.trim() || "我在，你说吧";

/**
 * 按持久化路径串行化的全局写队列（同进程所有 VirtualPhoneService 实例共享）。
 * 同一文件多实例并发落盘时：Windows 上并发 rename 同一目标会 EPERM，
 * 串行化后写入永远原子且有序。
 */
const persistQueues = new Map<string, Promise<void>>();

export class VirtualPhoneService {
  private readonly byActor = new Map<string, string>();
  private readonly byPhone = new Map<string, string>();
  /** 通话回复总线：提醒电话等场景等待用户在通话中输入（phone.call_reply 喂入） */
  private readonly replyWaiters = new Map<string, ReplyWaiter[]>();
  /** 活跃通话会话：callId → 双方身份，用于通话中回复路由与挂断清理 */
  private readonly callSessions = new Map<string, ActiveCallSession>();
  private userCallAgentHandler: UserCallAgentHandler | null = null;
  private userReplyHandler: UserCallReplyHandler | null = null;

  constructor(
    private readonly tts: TtsService,
    private readonly wsRegistry: ClientPushPort,
  ) {}

  /** 注入用户→Agent 通话的接通回应生成器（应在启动时由 bootstrap 调用一次） */
  setUserCallAgentHandler(handler: UserCallAgentHandler): void {
    this.userCallAgentHandler = handler;
  }

  /** 注入通话中用户回复的处理器（应在启动时由 bootstrap 调用一次） */
  setUserReplyHandler(handler: UserCallReplyHandler): void {
    this.userReplyHandler = handler;
  }

  // ============================================================
  // Realtime 语音模式（MiniMax 端到端通话）
  // ============================================================

  /**
   * 通话对话是否由 duplex realtime 引擎接管。
   * 开启后：通话中语音经 /ws/voice-duplex（callId 上下文注入）端到端处理，
   * phone.call_reply 打字回复入口与接通首问 LLM 链路停用。
   */
  private realtimeVoice = false;

  setRealtimeVoiceEnabled(enabled: boolean): void {
    this.realtimeVoice = enabled;
  }

  isRealtimeVoice(): boolean {
    return this.realtimeVoice;
  }

  /**
   * 按通话上下文构建 realtime 会话人设（经 VoiceDuplexService 注入
   * RealtimeDuplexSession 的 instructions）。非活跃通话返回 null（用默认人设）。
   */
  getCallVoiceContext(callId: string): string | null {
    const session = this.callSessions.get(callId.trim());
    if (!session) return null;
    const rules =
      "规则：这是实时语音通话，口语化、每次只说一两句话、直接回答；" +
      "不要报数据清单、不要输出 Markdown 和表情；" +
      "用户说再见/挂了/就这样就礼貌收尾。";
    if (session.direction === "agent_to_user") {
      return (
        `你正与用户实时通话（这通电话是你主动打给用户的）。` +
        (session.initialTranscript
          ? `你接通时已播报：「${session.initialTranscript}」。`
          : "") +
        `接下来的追问由你即时回答，信息以播报内容为准，不知道就说确认后补答。` +
        rules
      );
    }
    return (
      `用户主动来电找你（Agent），正在实时通话中。` +
      (session.initialTranscript
        ? `来电时留言：「${session.initialTranscript}」。`
        : `没有留言，先简短问候并问有什么可以帮忙。`) +
      rules
    );
  }

  // ============================================================
  // 通话结束等待器（realtime 模式下通话循环让位后用于收尾同步）
  // ============================================================

  private readonly callEndWaiters = new Map<string, Array<{ resolve: (ended: boolean) => void; timer?: ReturnType<typeof setTimeout> }>>();

  /**
   * 等待指定通话结束（用户挂断/任一方 endCall/closeCall）。
   * 超时返回 false；通话不存在视为已结束返回 true。
   */
  waitForCallEnd(callId: string, timeoutMs: number): Promise<boolean> {
    const id = callId.trim();
    if (!id) return Promise.resolve(true);
    if (!this.callSessions.has(id)) return Promise.resolve(true);
    if (!(timeoutMs > 0)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: { resolve: (ended: boolean) => void; timer?: ReturnType<typeof setTimeout> } = { resolve };
      const list = this.callEndWaiters.get(id) ?? [];
      const timer = setTimeout(() => {
        const arr = this.callEndWaiters.get(id);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.callEndWaiters.delete(id);
        }
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      waiter.timer = timer;
      list.push(waiter);
      this.callEndWaiters.set(id, list);
    });
  }

  private resolveCallEndWaiters(callId: string): void {
    const arr = this.callEndWaiters.get(callId);
    if (!arr) return;
    this.callEndWaiters.delete(callId);
    for (const w of arr.splice(0, arr.length)) {
      if (w.timer) clearTimeout(w.timer);
      try {
        w.resolve(true);
      } catch {
        /* ignore */
      }
    }
  }

  // ============================================================
  // 通话回复总线：通话中的用户输入（phone.call_reply）与等待方（提醒电话
  // 交互循环 / Agent 主对话管线）在此汇合。
  // ============================================================

  /**
   * 等待用户在指定通话中的下一条输入。
   * 超时或被取消（挂断/强制结束）返回 null；收到输入返回 { text }。
   */
  waitForCallReply(callId: string, timeoutMs: number): Promise<{ text: string } | null> {
    const id = callId.trim();
    if (!id || !(timeoutMs > 0)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: ReplyWaiter = { resolve };
      const list = this.replyWaiters.get(id) ?? [];
      const timer = setTimeout(() => {
        const arr = this.replyWaiters.get(id);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.replyWaiters.delete(id);
        }
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      waiter.timer = timer;
      list.push(waiter);
      this.replyWaiters.set(id, list);
    });
  }

  /** 取消某通电话的全部等待方（以 null 收尾），用于挂断/强制结束时不留悬空 Promise */
  cancelCallReplyWaiters(callId: string): void {
    const id = callId.trim();
    const waiters = this.replyWaiters.get(id);
    if (!waiters) return;
    this.replyWaiters.delete(id);
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  /**
   * 投递用户在通话中的回复。
   * 优先唤醒等待方（提醒电话交互循环）；否则若该通话有活跃会话且已注入
   * userReplyHandler，则路由进 Agent 主对话管线（回复经 TTS 推回用户）。
   */
  deliverCallReply(
    callId: string,
    text: string,
    fromUserId?: string,
  ): { ok: boolean; handled?: "reminder_dialogue" | "chat"; error?: string } {
    const id = callId.trim();
    const body = text.trim();
    if (!id) return { ok: false, error: "缺少 callId" };
    if (!body) return { ok: false, error: "缺少回复内容" };

    const waiters = this.replyWaiters.get(id);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiters.length === 0) this.replyWaiters.delete(id);
      waiter.resolve({ text: body });
      return { ok: true, handled: "reminder_dialogue" };
    }

    const session = this.callSessions.get(id);
    if (session) {
      if (fromUserId && session.toUserId && fromUserId !== session.toUserId) {
        return { ok: false, error: "该通话不属于当前会话" };
      }
      const handler = this.userReplyHandler;
      if (handler) {
        void handler({ callId: id, fromActorId: session.fromActorId, toUserId: session.toUserId, text: body })
          .catch((err) => console.error("[virtual-phone] 通话回复处理失败:", err));
        return { ok: true, handled: "chat" };
      }
      return { ok: false, error: "通话回复处理未启用" };
    }

    return { ok: false, error: "通话不存在或已结束" };
  }

  // ============================================================
  // 通话会话与通话内语音推送
  // ============================================================

  private registerCallSession(session: ActiveCallSession): void {
    // 清理过期会话，防长期运行下映射表无界增长
    const now = Date.now();
    for (const [id, s] of this.callSessions) {
      if (now - s.createdAt > CALL_SESSION_TTL_MS) {
        this.callSessions.delete(id);
        this.recordCallHistory(s, "expired");
      }
    }
    this.callSessions.set(session.callId, session);
    this.scheduleSessionsPersist();
  }

  /**
   * 用户挂断/服务端结束通话：清理会话与等待方，落通话记录，并向用户端推 ended 状态。
   */
  endCall(callId: string, reason = "hangup"): { ok: boolean; error?: string } {
    const id = callId.trim();
    if (!id) return { ok: false, error: "缺少 callId" };
    const session = this.callSessions.get(id);
    const closed = this.closeCall(id, reason);
    if (!closed && !this.replyWaiters.has(id)) {
      return { ok: false, error: "通话不存在或已结束" };
    }
    if (session) {
      this.wsRegistry.trySend(
        session.toUserId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneCallStatus,
          payload: {
            callId: id,
            direction: session.direction,
            status: "ended",
            reason,
          },
        }),
      );
    }
    return { ok: true };
  }

  /**
   * 仅收尾不推送：清理会话/等待方、落通话记录、持久化会话文件。
   * 供自带 ended 推送的调用方（如提醒电话交互循环）使用，避免双 ended 事件。
   */
  closeCall(callId: string, reason = "hangup"): boolean {
    const id = callId.trim();
    if (!id) return false;
    const session = this.callSessions.get(id);
    if (!session) return false;
    this.callSessions.delete(id);
    this.cancelCallReplyWaiters(id);
    this.resolveCallEndWaiters(id);
    this.scheduleSessionsPersist();
    this.recordCallHistory(session, reason);
    return true;
  }

  // ============================================================
  // 并发忙线 / 重启韧性 / 通话记录
  // ============================================================

  /** 该用户是否已有活跃通话会话（同一用户同一时刻只允许一通） */
  private findActiveSessionByUser(toUserId: string): ActiveCallSession | undefined {
    const user = toUserId.trim();
    if (!user) return undefined;
    const now = Date.now();
    for (const [id, s] of this.callSessions) {
      if (s.toUserId !== user) continue;
      if (now - s.createdAt > CALL_SESSION_TTL_MS) {
        // 超龄会话视为已死并就地清理：客户端异常路径（直接关通话窗/断线/丢
        // hangup 事件）留下的残留不得永久占忙线（2026-10-04 实证：桌面挂断
        // 按钮曾漏发 phone.call_hangup，残留会话把用户一切新呼叫挡成忙线）
        this.callSessions.delete(id);
        this.cancelCallReplyWaiters(id);
        this.recordCallHistory(s, "stale_expired");
        continue;
      }
      return s;
    }
    return undefined;
  }

  /**
   * 忙线拒绝：向用户推 busy 状态（客户端不覆盖现有通话），并给调用方可重试的失败。
   */
  private rejectBusy(callId: string, toUserId: string, direction: ActiveCallSession["direction"]): void {
    this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          direction,
          status: "busy",
          message: "当前已在通话中，新呼叫被拒绝",
        },
      }),
    );
  }

  /**
   * 落通话记录（data/virtual-phone-history/{ts}-{callId}.json）。
   * 只记服务端已知信息：双方、方向、起止与结束原因、呼出语音稿；失败吞掉不影响链路。
   */
  private recordCallHistory(session: ActiveCallSession, endReason: string): void {
    const record = {
      callId: session.callId,
      direction: session.direction,
      fromActorId: session.fromActorId,
      toUserId: session.toUserId,
      startedAt: new Date(session.createdAt).toISOString(),
      endedAt: new Date().toISOString(),
      endReason,
      initialTranscript: session.initialTranscript ?? "",
    };
    const dir = this.historyDir;
    const file = join(dir, `${Date.now()}-${session.callId}.json`);
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(record, null, 2), "utf8"))
      .catch((err) => console.warn("[VirtualPhoneService] 通话记录落盘失败:", err));
  }

  private get historyDir(): string {
    return process.env.VIRTUAL_PHONE_HISTORY_DIR ?? join(process.cwd(), "data", "virtual-phone-history");
  }

  private get sessionsPath(): string {
    return process.env.VIRTUAL_PHONE_CALLS_FILE ?? join(process.cwd(), "data", "virtual-phone-calls.json");
  }

  /** 活跃通话会话落盘（原子写 + 全局写队列，同 virtual-phones.json 策略） */
  private scheduleSessionsPersist(): void {
    const path = this.sessionsPath;
    const prev = persistQueues.get(path) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const dir = dirname(path);
        await mkdir(dir, { recursive: true });
        const sessions: ActiveCallSession[] = [...this.callSessions.values()];
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, JSON.stringify({ sessions }, null, 2), "utf8");
        await rename(tmp, path);
      })
      .catch((err: unknown) => {
        console.warn("[VirtualPhoneService] 通话会话落盘失败:", err);
      });
    persistQueues.set(path, next);
  }

  /**
   * 启动恢复：上次进程遗留的活跃会话已随重启失效——对每通补推
   * ended(server_restart) 让客户端干净收尾，然后清空落盘文件。
   * 顺带做通话记录 TTL 清理。
   */
  private async recoverStaleSessions(): Promise<void> {
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const data = JSON.parse(raw) as { sessions?: ActiveCallSession[] };
      for (const s of data.sessions ?? []) {
        if (!s?.callId || !s?.toUserId) continue;
        this.wsRegistry.trySend(
          s.toUserId,
          JSON.stringify({
            type: ServerEventType.VirtualPhoneCallStatus,
            payload: {
              callId: s.callId,
              direction: s.direction,
              status: "ended",
              reason: "server_restart",
            },
          }),
        );
      }
      await unlink(this.sessionsPath).catch(() => undefined);
    } catch {
      // 无遗留会话文件（首次启动/已清理）属正常
    }
    try {
      const dir = this.historyDir;
      const files = await readdir(dir).catch(() => [] as string[]);
      const cutoff = Date.now() - CALL_HISTORY_TTL_DAYS * 24 * 60 * 60_000;
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const ts = Number(f.split("-")[0]);
        if (Number.isFinite(ts) && ts < cutoff) {
          await unlink(join(dir, f)).catch(() => undefined);
        }
      }
    } catch (err) {
      console.warn("[VirtualPhoneService] 通话记录 TTL 清理失败:", err);
    }
  }

  /**
   * 通话中向用户推送 Agent 语音回应（TTS + transcript）。
   * 用于提醒电话交互循环与通话中多轮回复；接通首帧请随 call_connecting 下发。
   */
  async pushVoiceReply(
    callId: string,
    toUserId: string,
    transcript: string,
  ): Promise<{ ok: boolean; pushed?: boolean; error?: string }> {
    const id = callId.trim();
    const toUser = toUserId.trim();
    const text = transcript.trim();
    if (!id || !toUser || !text) {
      return { ok: false, error: "缺少 callId / toUserId / transcript" };
    }
    const ttsResult = await this.tts.synthesizeMp3Base64(text).catch(() =>
      ({ ok: false as const, reason: "tts_synth_failed" }),
    );
    const pushed = this.wsRegistry.trySend(
      toUser,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneVoiceReply,
        payload: {
          callId: id,
          direction: "agent_to_user" as const,
          transcript: text,
          tts: ttsResult.ok
            ? { format: ttsResult.format, base64: ttsResult.base64 }
            : { format: null, skippedReason: ttsResult.reason },
        },
      }),
    );
    return { ok: true, pushed };
  }

  private get persistPath(): string {
    return process.env.VIRTUAL_PHONES_FILE ?? join(process.cwd(), "data", "virtual-phones.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedVirtualPhones;
      // 引导快照：每次成功加载把当时注册表留一份 .bak——此后若被误写污染
      // （如测试未隔离直写真实文件），已申领号码可从快照恢复
      void writeFile(`${this.persistPath}.bak`, raw, "utf8").catch(() => {});
      this.byActor.clear();
      this.byPhone.clear();
      for (const [actor, phone] of Object.entries(data.byActor ?? {})) {
        const a = actor?.trim() ?? "";
        const p = normalizeVirtualPhone(phone);
        if (!a || !p) continue;
        const owner = this.byPhone.get(p);
        if (owner && owner !== a) {
          continue;
        }
        this.byActor.set(a, p);
        this.byPhone.set(p, a);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // 号码文件不存在（首次启动）不算错，继续走重启恢复
      if (err.code !== "ENOENT") throw e;
    }
    // 号码装好后做重启恢复与会话记录 TTL 清理（best-effort，失败不断链）
    await this.recoverStaleSessions();
  }

  private schedulePersist(): void {
    // 按路径的全局写队列：同进程多实例（测试/多会话）写同一文件时串行化，
    // 避免并发 rename 在 Windows 上 EPERM；失败吞掉（warn），链不断
    void this.enqueuePersist().catch((err: unknown) => {
      console.warn("[VirtualPhoneService] persist failed:", err);
    });
  }

  /** 入队一次持久化并返回可等待的句柄（写穿式申领用：落盘成功才算数）。 */
  private enqueuePersist(): Promise<void> {
    const path = this.persistPath;
    const prev = persistQueues.get(path) ?? Promise.resolve();
    const next = prev.then(() => this.persistNow());
    // 队列里存吞错后的链：单次写盘失败不让后续持久化连锁 reject（队列自愈）
    persistQueues.set(path, next.then(
      () => {},
      () => {},
    ));
    return next;
  }

  private async persistNow(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const byActor: Record<string, string> = {};
    for (const [k, v] of this.byActor) byActor[k] = v;
    // 原子写（tmp + rename）：多个实例/进程写同一路径时读方永远看到完整 JSON，
    // 不会出现并发 writeFile 交错出的截断/拼接损坏（同 booking-order-store 策略）
    const tmp = `${this.persistPath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ byActor }, null, 2), "utf8");
    await rename(tmp, this.persistPath);
  }

  getPhoneForActor(actorId: string): string | undefined {
    return this.byActor.get(actorId);
  }

  /**
   * 申领或返回该 Actor（Agent 实例）的 6 位虚拟号码。
   * 号码登记在 Agent 名下，即用户的站内电话号，申领后方可呼出虚拟电话；App 内通话不必另输 6 位号。
   * 除用户明确要求办理（如 `phone.ensure_my_number`）外，用户呼出通话路径
   * （handleUserCallAgent）按「号码由 Agent 代为持有」语义代申领，其余路径不得隐式调用。
   *
   * 硬保证（2026-10-03 号码漂移加固）：
   *   - 写穿：分配结果落盘成功后才返回；写盘失败回滚内存并抛错，绝不出现
   *     「调用方已拿到号但磁盘没有」的窗口（进程重启即漂移）。
   *   - 全局唯一：分配前先从磁盘合流其它实例的申领（并行会话起的多实例
   *     共享同一文件），再查内存 byPhone 表——同一号码不可能分给两个 Actor。
   */
  async ensureNumber(actorId: string): Promise<string> {
    const id = actorId.trim();
    if (!id) throw new Error("actorId 不能为空");
    const existing = this.byActor.get(id);
    if (existing) return existing;

    await this.hydrateFromDisk();

    const maxAttempts = 16_384;
    const poolSize = 1_000_000;
    const taken = this.byPhone.size;
    if (taken >= poolSize) {
      throw new Error("6 位虚拟号已用尽");
    }
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = randomSixDigits();
      if (this.byPhone.has(candidate)) continue;
      this.byActor.set(id, candidate);
      this.byPhone.set(candidate, id);
      try {
        await this.enqueuePersist();
      } catch (err) {
        // 落盘失败：回滚内存，申领不生效（调用方拿到错误，号码不漂移）
        this.byActor.delete(id);
        this.byPhone.delete(candidate);
        throw err;
      }
      return candidate;
    }
    throw new Error("虚拟号池忙碌，请稍后重试");
  }

  /**
   * 从磁盘合流本进程不知的申领（多实例共盘防护）：并行会话起的另一实例
   * 可能已把新号码写进同一文件，分配前不读盘就会把同一号分给别人。
   * 只采纳内存缺失的条目；冲突（同号不同主）以内存为准并忽略磁盘侧。
   */
  private async hydrateFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.persistPath, "utf8");
    } catch {
      return; // 文件不存在/不可读：无事可合流
    }
    let data: PersistedVirtualPhones;
    try {
      data = JSON.parse(raw) as PersistedVirtualPhones;
    } catch {
      return; // 损坏文件不采纳，等下一次成功写覆盖
    }
    for (const [actor, phone] of Object.entries(data.byActor ?? {})) {
      const a = actor?.trim() ?? "";
      const p = normalizeVirtualPhone(phone);
      if (!a || !p) continue;
      if (this.byActor.has(a) || this.byPhone.has(p)) continue;
      this.byActor.set(a, p);
      this.byPhone.set(p, a);
    }
  }

  /**
   * 释放该 Actor 的站内号码（账号注销/用户主动解绑）。
   * 号码回池可被再次随机分给他人；未申领时返回 ok:false。
   */
  releaseNumber(actorId: string): { ok: boolean; released?: string; error?: string } {
    const id = actorId.trim();
    if (!id) return { ok: false, error: "actorId 不能为空" };
    const phone = this.byActor.get(id);
    if (!phone) return { ok: false, error: "该 Actor 尚未申领号码" };
    this.byActor.delete(id);
    this.byPhone.delete(phone);
    this.schedulePersist();
    return { ok: true, released: phone };
  }

  /**
   * Agent 直接呼叫用户（无需用户有虚拟号码）。
   * 通过 WebSocket 向用户的客户端推送来电事件，附带 TTS 语音。
   * 用户可在接听后回复文字或语音，实现双向交互式通话。
   */
  async callUser(params: CallUserParams): Promise<{
    ok: boolean;
    callId?: string;
    pushed?: boolean;
    busy?: boolean;
    toUserId?: string;
    fromPhone?: string;
    error?: string;
  }> {
    const fromActorId = params.fromActorId.trim();
    const toUserId = params.toUserId.trim();
    if (!fromActorId) {
      return { ok: false, error: "主叫方 Actor ID 无效" };
    }
    if (!toUserId) {
      return { ok: false, error: "被叫用户 ID 无效" };
    }
    // 忙线护栏：同一用户同一时刻只允许一通，后来的呼叫推 busy 且不入会话
    const activeCall = this.findActiveSessionByUser(toUserId);
    if (activeCall) {
      const busyCallId = randomUUID();
      this.rejectBusy(busyCallId, toUserId, "agent_to_user");
      return { ok: false, busy: true, error: "用户当前已在通话中，请稍后再试", callId: busyCallId };
    }
    const fromPhone = this.byActor.get(fromActorId);
    const ttsResult = await this.tts.synthesizeMp3Base64(params.transcript);
    const callId = randomUUID();

    const payload: Record<string, unknown> = {
      callId,
      fromActorId,
      fromPhone: fromPhone ?? null,
      toUserId,
      transcript: params.transcript.trim(),
      ringStyle: params.ringStyle,
      initiatedBy: "agent" as const,
      direction: "agent_to_user" as const,
      tts: ttsResult.ok
        ? { format: ttsResult.format, base64: ttsResult.base64 }
        : { format: null, skippedReason: ttsResult.reason },
      replyEnabled: true,
    };

    const pushed = this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneIncoming,
        payload,
      }),
    );

    if (pushed) {
      this.registerCallSession({
        callId,
        fromActorId,
        toUserId,
        direction: "agent_to_user",
        createdAt: Date.now(),
        initialTranscript: params.transcript.trim(),
      });
    }

    return {
      ok: true,
      callId,
      pushed,
      toUserId,
      fromPhone: fromPhone ?? undefined,
    };
  }

  /**
   * Agent 呼叫用户（带前摇振铃阶段）。
   *
   * 分两个阶段推送：
   *   1. ringing_start —— 客户端进入「振铃中」UI，播放振铃音、渐入动画、倒计时
   *   2. call_connecting（延迟后）—— 前摇结束，正式接通，含 TTS 音频 + transcript
   *
   * 若 ringPhase.enableRingingPhase === false 则退化为旧逻辑直接推 incoming。
   */
  async callUserWithRinging(params: CallUserParams): Promise<{
    ok: boolean;
    callId?: string;
    pushed?: boolean;
    busy?: boolean;
    toUserId?: string;
    fromPhone?: string;
    error?: string;
  }> {
    const fromActorId = params.fromActorId.trim();
    const toUserId = params.toUserId.trim();
    if (!fromActorId) {
      return { ok: false, error: "主叫方 Actor ID 无效" };
    }
    if (!toUserId) {
      return { ok: false, error: "被叫用户 ID 无效" };
    }
    // 忙线护栏：同一用户同一时刻只允许一通
    const activeCall = this.findActiveSessionByUser(toUserId);
    if (activeCall) {
      const busyCallId = randomUUID();
      this.rejectBusy(busyCallId, toUserId, "agent_to_user");
      return { ok: false, busy: true, error: "用户当前已在通话中，请稍后再试", callId: busyCallId };
    }

    const ringCfg = params.ringPhase ?? {};
    const enableRinging = ringCfg.enableRingingPhase !== false;
    const ringDurationMs = ringCfg.ringDurationMs ?? 8_000;

    const fromPhone = this.byActor.get(fromActorId);
    const callId = randomUUID();

    // ---- 阶段 1：推送振铃开始事件 ----
    if (enableRinging) {
      const ringingPayload: Record<string, unknown> = {
        callId,
        fromActorId,
        fromPhone: fromPhone ?? null,
        toUserId,
        direction: "agent_to_user" as const,
        status: "ringing",
        ringStyle: params.ringStyle,
        initiatedBy: "agent" as const,
        /** 振铃持续毫秒数，客户端用于倒计时 */
        ringDurationMs,
        /** 预计自动接通时间戳（ISO） */
        estimatedConnectAt: new Date(Date.now() + ringDurationMs).toISOString(),
      };

      this.wsRegistry.trySend(
        toUserId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneRingingStart,
          payload: ringingPayload,
        }),
      );
    }

    // ---- 预生成 TTS（与振铃并行，减少接通等待） ----
    const ttsResult = await this.tts.synthesizeMp3Base64(params.transcript);

    // ---- 等待振铃阶段结束 ----
    if (enableRinging) {
      await new Promise<void>((resolve) => setTimeout(resolve, ringDurationMs));
    }

    // ---- 阶段 2：推送接通事件（含 TTS + 正文） ----
    const connectPayload: Record<string, unknown> = {
      callId,
      fromActorId,
      fromPhone: fromPhone ?? null,
      toUserId,
      transcript: params.transcript.trim(),
      ringStyle: params.ringStyle,
      initiatedBy: "agent" as const,
      direction: "agent_to_user" as const,
      status: "connected",
      tts: ttsResult.ok
        ? { format: ttsResult.format, base64: ttsResult.base64 }
        : { format: null, skippedReason: ttsResult.reason },
      replyEnabled: true,
    };

    const pushed = this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: enableRinging
          ? ServerEventType.VirtualPhoneCallConnecting
          : ServerEventType.VirtualPhoneIncoming,
        payload: connectPayload,
      }),
    );

    if (pushed) {
      this.registerCallSession({
        callId,
        fromActorId,
        toUserId,
        direction: "agent_to_user",
        createdAt: Date.now(),
        initialTranscript: params.transcript.trim(),
      });
    }

    return {
      ok: true,
      callId,
      pushed,
      toUserId,
      fromPhone: fromPhone ?? undefined,
    };
  }

  /**
   * 用户主动拨打 Agent（通过 WebSocket 或 HTTP 触发）。
   * 支持前摇阶段：先推振铃状态 → 延迟后推接通状态。
   * 向用户端推送「通话中」状态序列（ringing -> connecting -> connected）。
   * 返回 callId 供后续消息关联。
   */
  async handleUserCallAgent(params: UserCallAgentParams): Promise<{
    ok: boolean;
    callId?: string;
    busy?: boolean;
    error?: string;
  }> {
    const fromUserId = params.fromUserId.trim();
    const toActorId = params.toActorId.trim();
    if (!fromUserId) {
      return { ok: false, error: "用户 ID 无效" };
    }
    if (!toActorId) {
      return { ok: false, error: "目标 Agent ID 无效" };
    }
    // 号码注册制：站内号由 Agent 代为持有（见联系 Agent 页文案），App 内呼出
    // 无需用户先办号——首次呼出时按代持语义静默申领（登记在用户 Actor 名下、
    // 与 Agent 共用），保证注册表完整；号池耗尽等异常仍如实拒绝。
    if (!this.byActor.get(fromUserId)) {
      try {
        await this.ensureNumber(fromUserId);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "站内号码申领失败，请稍后重试",
        };
      }
    }
    // 忙线护栏：用户已在通话中时拒绝再次发起，避免新会话顶掉进行中的通话
    if (this.findActiveSessionByUser(fromUserId)) {
      return { ok: false, busy: true, error: "当前已在通话中，请先挂断再发起新呼叫" };
    }

    const ringCfg = params.ringPhase ?? {};
    const enableRinging = ringCfg.enableRingingPhase !== false;
    const ringDurationMs = ringCfg.ringDurationMs ?? DEFAULT_USER_CALL_RING_MS; // 用户主动呼叫的振铃时长

    const toPhone = this.byActor.get(toActorId);
    const callId = randomUUID();

    // 登记通话会话（提前到振铃前）：振铃 5s 空窗期二呼也要撞忙线护栏，
    // 且振铃期内用户挂断可正常走 closeCall 收尾。
    this.registerCallSession({
      callId,
      fromActorId: toActorId,
      toUserId: fromUserId,
      direction: "user_to_agent",
      createdAt: Date.now(),
      initialTranscript: (params.userMessage ?? "").trim(),
    });

    // ---- 阶段 1：振铃中 ----
    const ringingPayload: Record<string, unknown> = {
      callId,
      toActorId,
      toPhone: toPhone ?? null,
      userMessage: (params.userMessage ?? "").trim(),
      direction: "user_to_agent" as const,
      status: "ringing",
      /** 振铃持续时间 */
      ringDurationMs: enableRinging ? ringDurationMs : undefined,
      message: "正在呼叫 Agent，请稍候…",
    };

    this.wsRegistry.trySend(
      fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: ringingPayload,
      }),
    );

    // ---- 阶段 2：等待振铃后进入接通/连接中 ----
    if (enableRinging) {
      await new Promise<void>((resolve) => setTimeout(resolve, ringDurationMs));
    }

    // 振铃期内用户已挂断：会话已被 closeCall 清理，不再推进接通续体
    if (!this.callSessions.has(callId)) {
      return { ok: true, callId };
    }

    // 推送「连接中」状态
    this.wsRegistry.trySend(
      fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          toActorId,
          toPhone: toPhone ?? null,
          direction: "user_to_agent" as const,
          status: "connecting",
          message: "Agent 正在接听…",
        },
      }),
    );

    // 登记已提前到振铃前（见上），接通后用户可继续经 phone.call_reply 路由进 Agent

    // Agent 回应生成走异步续体：不阻塞本次 WS 事件处理（避免 Agent 回合
    // 期间同 socket 的后续消息——如 call_reply——被串行阻塞）。
    void this.completeUserCallAgent({
      callId,
      fromUserId,
      toActorId,
      toPhone: toPhone ?? null,
      userMessage: (params.userMessage ?? "").trim(),
    }).catch((err) => console.error("[virtual-phone] user call completion failed:", err));

    return { ok: true, callId };
  }

  /**
   * 用户→Agent 通话的接通续体：等待 Agent 生成回应（带超时兜底），
   * 推送 connected（含回应 transcript + TTS）。后续多轮经 userReplyHandler 走 voice_reply。
   */
  private async completeUserCallAgent(args: {
    callId: string;
    fromUserId: string;
    toActorId: string;
    toPhone: string | null;
    userMessage: string;
  }): Promise<void> {
    // Realtime 语音模式：对话由 duplex realtime 引擎按 callId 上下文接管，
    // 不走首问 LLM、不下发开场 TTS（用户先开口，Agent 实时应答）。
    if (this.realtimeVoice) {
      this.wsRegistry.trySend(
        args.fromUserId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneCallStatus,
          payload: {
            callId: args.callId,
            toActorId: args.toActorId,
            toPhone: args.toPhone,
            direction: "user_to_agent" as const,
            status: "connected",
            realtimeVoice: true,
            message: "Agent 已接听，请直接说话",
          },
        }),
      );
      // 接入后立即补一句开场问候。connected 帧刻意不带音频（合成要 1s 上下，
      // 不能拖慢接通），音频就绪后改走 voice_reply 通道下发——客户端已有该
      // 通道的完整播报逻辑，无需改动。
      void this.emitRealtimeGreeting(args).catch((err) => {
        console.error("[virtual-phone] realtime greeting failed:", err);
      });
      return;
    }

    let replyText = "";
    const handler = this.userCallAgentHandler;
    if (handler) {
      try {
        const result = await Promise.race([
          handler(args),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), USER_CALL_AGENT_TIMEOUT_MS);
            if (typeof t.unref === "function") t.unref();
          }),
        ]);
        replyText = result?.replyText?.trim() ?? "";
      } catch (err) {
        console.error("[virtual-phone] user call agent handler failed:", err);
      }
    }
    if (!replyText) {
      replyText = "您好，我已接通。刚才没能整理出回复，请稍后在对话里告诉我您想说的话。";
    }

    const ttsResult = await this.tts.synthesizeMp3Base64(replyText).catch(() =>
      ({ ok: false as const, reason: "tts_synth_failed" }),
    );

    this.wsRegistry.trySend(
      args.fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId: args.callId,
          toActorId: args.toActorId,
          toPhone: args.toPhone,
          direction: "user_to_agent" as const,
          status: "connected",
          transcript: replyText,
          tts: ttsResult.ok
            ? { format: ttsResult.format, base64: ttsResult.base64 }
            : { format: null, skippedReason: ttsResult.reason },
          message: "Agent 已接听",
        },
      }),
    );
  }

  /**
   * realtime 语音接通后的开场问候：异步合成 TTS，就绪后经 voice_reply 下发。
   *
   * 两处防呆：合成期间用户可能已挂断（下发前重新校验通话仍在）；TTS 不可用
   * 则静默跳过——connected 帧已经先发出去了，不能让一句提示音反过来拖垮通话。
   */
  private async emitRealtimeGreeting(args: {
    callId: string;
    fromUserId: string;
    toActorId: string;
  }): Promise<void> {
    const greeting = REALTIME_GREETING_TEXT.trim();
    if (!greeting) return;
    const ttsResult = await this.tts.synthesizeMp3Base64(greeting).catch(() =>
      ({ ok: false as const, reason: "tts_synth_failed" }),
    );
    if (!ttsResult.ok) return;
    if (!this.callSessions.has(args.callId)) return; // 合成期间用户已挂断
    this.wsRegistry.trySend(
      args.fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneVoiceReply,
        payload: {
          callId: args.callId,
          toActorId: args.toActorId,
          transcript: greeting,
          tts: { format: ttsResult.format, base64: ttsResult.base64 },
        },
      }),
    );
  }
}

export function normalizeVirtualPhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== 6) return null;
  return digits;
}

/** 密码学安全随机，均匀分布于 000000–999999；与 byPhone 配合保证进程内唯一。 */
function randomSixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
