import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import type { SkillManagerLike } from "../host-types.js";
import type { SkillManifestLike } from "../host-types.js";

import { allowAgentWorldPlaceholderRegister } from "../config/world-register-placeholder.js";

import type { VerifyChallengeResult, WorldRegisterChallenge } from "./world-agent-registration.js";
import { WorldAgentRegistrationService } from "./world-agent-registration.js";

export type WorldMutationOptions = {
  /** 若传入且与当前 `revision` 不一致则拒绝写入（乐观并发）。 */
  expectedRevision?: number;
};

export type WorldState = {
  /** 房间 ID（持久化键）；个人房与历史数据常为拥有者 sessionId，共享房为 `wr-<uuid>`。 */
  roomId: string;
  /** 房间拥有者（唯一可改世界状态的主体，除非后续扩展成员写权限）。 */
  ownerSessionId: string;
  /**
   * @deprecated 与 `ownerSessionId` 相同，兼容旧读码与审计字段。
   */
  sessionId: string;
  /**
   * 分区状态修订号：每次世界可变字段变更 +1，供 AWP 乐观并发与多连接订阅对齐。
   * 旧持久化数据缺省为 0。
   */
  revision: number;
  sceneId: string;
  /**
   * 开放式 Agent World：自动化 Agent 须先完成注册题（SHA-256 挑战）后方可使用世界工具/多数写操作。
   * 持久化数据中缺省该字段时视为 true（旧数据兼容）。
   */
  agentWorldRegistered: boolean;
  /**
   * 仅在 Agent World（商店、休闲等）内流通的点数，与真实资金钱包无关。
   * @see RealFundsWalletService
   */
  agentWorldCredits: number;
  /** 最近的世界点数入账审计（仅记录加币事件）。 */
  creditAuditTrail: CreditAuditEntry[];
  ownedSkillIds: string[];
  leisureCount: number;
  /**
   * 作为发包方时，未完结 A2A 契约锁定的悬赏合计（与 `a2a-contracts.json` 可对账）。
   */
  a2aEscrowReserved: number;
};

/** 世界修订通知：`partitionId` 即 `roomId`。 */
export type WorldRevisionEvent = {
  partitionId: string;
  /** 房间拥有者 sessionId。 */
  sessionId: string;
  revision: number;
  state: WorldState;
  /** 增量变更字段；存在时订阅者可只广播 delta，缺省时广播全量 state。 */
  changes?: Partial<WorldState>;
};

export type CreditAuditEntry = {
  auditId: string;
  sessionId: string;
  amount: number;
  reason: AgentWorldCreditReason;
  balanceAfter: number;
  createdAt: string;
};

export type CreditAuditSummaryEntry = {
  reason: AgentWorldCreditReason;
  totalAmount: number;
  count: number;
  lastCreatedAt: string;
};

/** 供宿主挂载「养成 / 叙事记忆」等副作用；个人房 `actorSessionId` 与 `userId` 对齐时由服务端写入 UAP。 */
export type WorldServiceEvolutionHooks = {
  onWorldCreditsCredited?: (ev: {
    roomId: string;
    actorSessionId: string;
    amount: number;
    reason: AgentWorldCreditReason;
    balanceAfter: number;
    createdAt: string;
  }) => void;
  onSkillPurchased?: (ev: {
    roomId: string;
    actorSessionId: string;
    skillId: string;
    pricePaid: number;
    balanceAfter: number;
  }) => void;
};

/** 新会话首次创建时的世界内点数；在 `session.init`（WS）或首次 `getOrCreate`（仅 HTTP）时生效。 */
export const INITIAL_AGENT_WORLD_CREDITS = 200;

/** @deprecated 使用 INITIAL_AGENT_WORLD_CREDITS */
export const INITIAL_WORLD_COINS = INITIAL_AGENT_WORLD_CREDITS;

/**
 * 世界点数入账白名单：后续新增发币场景时，必须先在此显式登记。
 */
export const AGENT_WORLD_CREDIT_REASONS = {
  A2aContractPayout: "a2a.contract_payout",
  A2aContractRefund: "a2a.contract_refund",
  A2aPersistRollbackRefund: "a2a.persist_rollback_refund",
} as const;

export type AgentWorldCreditReason =
  (typeof AGENT_WORLD_CREDIT_REASONS)[keyof typeof AGENT_WORLD_CREDIT_REASONS];

const AGENT_WORLD_CREDIT_REASON_SET: ReadonlySet<string> = new Set(
  Object.values(AGENT_WORLD_CREDIT_REASONS),
);
const MAX_CREDIT_AUDIT_TRAIL = 200;

type WorldPersistedFileV1 = {
  version: 1;
  sessions: Record<string, WorldState>;
};

type WorldPersistedFileV2 = {
  version: 2;
  rooms: Record<string, WorldState>;
};

/**
 * 按技能元数据生成稳定 mock 价格（框架期占位）。
 */
export function mockSkillPrice(
  manifest: Pick<SkillManifestLike, "name" | "version"> & { tags?: SkillManifestLike["tags"] },
): number {
  const name = manifest.name;
  const ver = manifest.version || "0.0.0";
  const tagBonus = (manifest.tags?.length ?? 0) * 12;
  let n = 0;
  for (let i = 0; i < name.length; i++) n += name.charCodeAt(i);
  const v = ver.split(".").reduce((a: number, x: string) => a + (parseInt(x, 10) || 0), 0);
  const base = 40 + (n % 120) + (v % 40) + tagBonus;
  return Math.min(480, Math.max(15, base));
}

function normalizeWorldState(roomKey: string, raw: unknown): WorldState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ridRaw = o.roomId;
  const roomId = typeof ridRaw === "string" && ridRaw.length > 0 ? ridRaw : roomKey;
  const ownRaw = o.ownerSessionId;
  const ownerSessionId =
    typeof ownRaw === "string" && ownRaw.length > 0
      ? ownRaw
      : typeof o.sessionId === "string" && o.sessionId.length > 0
        ? (o.sessionId as string)
        : roomKey;
  const sid = ownerSessionId;
  const credits = o.agentWorldCredits;
  const escrow = o.a2aEscrowReserved;
  const regRaw = o.agentWorldRegistered;
  const agentWorldRegistered = typeof regRaw === "boolean" ? regRaw : true;
  const revRaw = o.revision;
  const revision =
    typeof revRaw === "number" && Number.isFinite(revRaw) ? Math.max(0, Math.floor(revRaw)) : 0;
  return {
    roomId,
    ownerSessionId,
    sessionId: sid,
    revision,
    sceneId: typeof o.sceneId === "string" ? o.sceneId : "plaza",
    agentWorldRegistered,
    agentWorldCredits:
      typeof credits === "number" && Number.isFinite(credits) ? Math.max(0, Math.floor(credits)) : INITIAL_AGENT_WORLD_CREDITS,
    ownedSkillIds: Array.isArray(o.ownedSkillIds)
      ? o.ownedSkillIds.filter((x): x is string => typeof x === "string")
      : [],
    creditAuditTrail: Array.isArray(o.creditAuditTrail)
      ? o.creditAuditTrail
          .filter((x): x is CreditAuditEntry => {
            if (!x || typeof x !== "object") return false;
            const e = x as Record<string, unknown>;
            return (
              typeof e.auditId === "string" &&
              typeof e.sessionId === "string" &&
              typeof e.amount === "number" &&
              Number.isFinite(e.amount) &&
              typeof e.reason === "string" &&
              typeof e.balanceAfter === "number" &&
              Number.isFinite(e.balanceAfter) &&
              typeof e.createdAt === "string"
            );
          })
          .slice(0, MAX_CREDIT_AUDIT_TRAIL)
      : [],
    leisureCount:
      typeof o.leisureCount === "number" && Number.isFinite(o.leisureCount)
        ? Math.max(0, Math.floor(o.leisureCount))
        : 0,
    a2aEscrowReserved:
      typeof escrow === "number" && Number.isFinite(escrow) ? Math.max(0, Math.floor(escrow)) : 0,
  };
}

export class WorldService {
  private readonly states = new Map<string, WorldState>();
  private readonly agentRegistration = new WorldAgentRegistrationService();
  private readonly revisionSubscribers = new Set<(e: WorldRevisionEvent) => void>();
  /** 最近一次已广播的快照（按 roomId），用于计算增量 diff。 */
  private readonly lastEmittedSnapshot = new Map<string, WorldState>();
  private evolutionHooks: Partial<WorldServiceEvolutionHooks> = {};
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  /**
   * 外部注册判定（宿主装配层注入）：本世界状态未注册时咨询宿主「该主体是否
   * 已有注册账号」。已注册邮箱账号在另一处登录时不得再走一遍世界注册流程
   * （2026-10-16），故宿主账号存在即视为已注册，并在首次判定时物化到世界
   * 状态（与挑战注册同路径发放初始点数）。
   */
  private externalRegistrationResolver: ((sessionId: string) => boolean) | null = null;

  /** 注入外部注册判定（如宿主 AgentAccountService 的账号存在性查询）。 */
  setExternalRegistrationResolver(resolver: ((sessionId: string) => boolean) | null): void {
    this.externalRegistrationResolver = resolver;
  }

  /** 入账 / 购技能等事件回调（可选）。 */
  setEvolutionHooks(hooks: Partial<WorldServiceEvolutionHooks>): void {
    this.evolutionHooks = { ...this.evolutionHooks, ...hooks };
  }

  private get persistPath(): string {
    return process.env.WORLD_STATE_FILE ?? join(process.cwd(), "data", "world-state.json");
  }

  /** 启动时加载；无文件则保持空映射（会话首次访问时再创建）。支持 v1 `sessions` 与 v2 `rooms`。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as WorldPersistedFileV1 | WorldPersistedFileV2 | Record<string, unknown>;
      let rec: Record<string, unknown> = {};
      if (data && typeof data === "object") {
        if ("version" in data && data.version === 2 && "rooms" in data && data.rooms && typeof data.rooms === "object") {
          rec = data.rooms as Record<string, unknown>;
        } else if ("sessions" in data && data.sessions && typeof data.sessions === "object") {
          rec = data.sessions as Record<string, unknown>;
        }
      }
      this.states.clear();
      for (const [roomKey, value] of Object.entries(rec)) {
        const s = normalizeWorldState(roomKey, value);
        if (s) this.states.set(s.roomId, s);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  /** 所有房间 ID（持久化键）。 */
  listRoomIds(): string[] {
    return [...this.states.keys()];
  }

  /** @deprecated 使用 `listRoomIds` */
  listSessionIds(): string[] {
    return this.listRoomIds();
  }

  /**
   * 订阅世界状态修订（同一 partition 上任意工具/服务写入后触发）。
   * 返回取消订阅函数。
   */
  onWorldRevision(listener: (e: WorldRevisionEvent) => void): () => void {
    this.revisionSubscribers.add(listener);
    return () => this.revisionSubscribers.delete(listener);
  }

  private emitWorldRevision(roomId: string, state: WorldState, changes?: Partial<WorldState>): void {
    const snapshot: WorldState = { ...state, ownedSkillIds: [...state.ownedSkillIds], creditAuditTrail: [...state.creditAuditTrail] };
    const ev: WorldRevisionEvent = {
      partitionId: roomId,
      sessionId: state.ownerSessionId,
      revision: snapshot.revision,
      state: snapshot,
      changes,
    };
    for (const cb of this.revisionSubscribers) {
      try {
        cb(ev);
      } catch (e) {
        console.error("[WorldService] revision subscriber error", e);
      }
    }
    this.lastEmittedSnapshot.set(roomId, snapshot);
  }

  /** 可变字段变更后调用：revision++、落盘、通知订阅者。 */
  markWorldMutated(roomId: string): void {
    const s = this.states.get(roomId);
    if (!s) return;
    // 标记前保存旧快照（最近一次广播的状态），用于计算增量 diff
    const prev = this.lastEmittedSnapshot.get(roomId);
    s.revision = (s.revision ?? 0) + 1;
    this.schedulePersist();
    const changes = this.computeChanges(prev, s);
    this.emitWorldRevision(roomId, s, changes);
  }

  /** 比较最近一次广播快照与当前状态，返回变更字段（缺省表示无差异或首次广播）。 */
  private computeChanges(
    prev: WorldState | undefined,
    next: WorldState,
  ): Partial<WorldState> | undefined {
    if (!prev) return undefined;
    const changes: Partial<WorldState> = {};
    let hasChange = false;
    for (const key of Object.keys(next) as Array<keyof WorldState>) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        (changes as Record<string, unknown>)[key] = next[key];
        hasChange = true;
      }
    }
    return hasChange ? changes : undefined;
  }

  private checkExpectedRevision(roomId: string, expected: number | undefined): void {
    if (expected === undefined) return;
    const s = this.states.get(roomId);
    if (!s) throw new Error(`WORLD_REVISION_CONFLICT: room ${roomId} not found`);
    if (s.revision !== expected) {
      throw new Error(
        `WORLD_REVISION_CONFLICT: current revision is ${s.revision}, expected ${expected} (roomId=${roomId})`,
      );
    }
  }

  /**
   * 多步扣款前对发起方分区做乐观并发预检，避免已扣部分后再因 revision 失败。
   * 语义与工具/HTTP 的 `expectedRevision` 一致；未传则不校验。
   */
  assertRevisionIfProvided(roomId: string, expectedRevision?: number | null): void {
    if (expectedRevision === undefined || expectedRevision === null) return;
    const n = Math.max(0, Math.floor(Number(expectedRevision)));
    this.checkExpectedRevision(roomId, n);
  }

  /**
   * 仅房间拥有者可改世界状态（个人房拥有者即该 session）。
   */
  assertRoomWritable(actorSessionId: string, roomId: string): void {
    const s = this.states.get(roomId);
    if (!s) throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
    if (s.ownerSessionId !== actorSessionId) {
      throw new Error("ROOM_WRITE_FORBIDDEN: 仅房间拥有者可修改该房间的世界状态");
    }
  }

  /**
   * 创建共享房间（世界状态与拥有者 session 解耦）。返回新 `roomId`（`wr-` 前缀）。
   */
  createSharedRoom(ownerSessionId: string): string {
    this.assertAgentWorldRegistered(ownerSessionId);
    const roomId = `wr-${randomUUID()}`;
    const s: WorldState = {
      roomId,
      ownerSessionId,
      sessionId: ownerSessionId,
      revision: 0,
      sceneId: "plaza",
      agentWorldRegistered: true,
      agentWorldCredits: 0,
      creditAuditTrail: [],
      ownedSkillIds: [],
      leisureCount: 0,
      a2aEscrowReserved: 0,
    };
    this.states.set(roomId, s);
    this.schedulePersist();
    return roomId;
  }

  /** 延迟落盘。 */
  schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistChain = this.persistChain
        .then(() => this.writeToDisk())
        .catch((e) => console.error("[WorldService] persist failed", e));
    }, 200);
  }

  /** 立即写入（对账后、进程退出前等）。 */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistChain;
    this.persistChain = Promise.resolve();
    await this.writeToDisk();
  }

  private async writeToDisk(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const rooms: Record<string, WorldState> = {};
    for (const [k, v] of this.states) {
      rooms[k] = { ...v };
    }
    const payload: WorldPersistedFileV2 = { version: 2, rooms };
    const body =
      process.env.WORLD_STATE_JSON_PRETTY === "1"
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload);
    await writeFile(this.persistPath, body, "utf8");
  }

  /** 仅返回已存在房间状态，不创建。 */
  getExisting(roomId: string): WorldState | undefined {
    return this.states.get(roomId);
  }

  /**
   * 获取或创建房间。共享房 ID（`wr-` 前缀）不会在未存在时自动创建，请使用 `createSharedRoom`。
   */
  getOrCreateRoom(roomId: string, ownerSessionIdForNew: string): WorldState {
    let s = this.states.get(roomId);
    if (!s) {
      if (roomId.startsWith("wr-")) {
        throw new Error(
          `ROOM_NOT_FOUND: 共享房间 ${roomId} 不存在，请先使用 createSharedRoom 或 world.room.create`,
        );
      }
      const owner = ownerSessionIdForNew;
      s = {
        roomId,
        ownerSessionId: owner,
        sessionId: owner,
        revision: 0,
        sceneId: "plaza",
        agentWorldRegistered: false,
        agentWorldCredits: 0,
        creditAuditTrail: [],
        ownedSkillIds: [],
        leisureCount: 0,
        a2aEscrowReserved: 0,
      };
      this.states.set(roomId, s);
      this.schedulePersist();
    }
    return s;
  }

  /** 个人房快捷方式：`roomId` 即默认拥有者时的 get-or-create。 */
  getOrCreate(sessionId: string): WorldState {
    return this.getOrCreateRoom(sessionId, sessionId);
  }

  listCreditAudit(roomId: string, limit = 50): CreditAuditEntry[] {
    const state = roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreate(roomId);
    if (!state) return [];
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    return state.creditAuditTrail.slice(-n).reverse();
  }

  summarizeCreditAudit(roomId: string): CreditAuditSummaryEntry[] {
    const state = roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreate(roomId);
    if (!state) return [];
    const summaryMap = new Map<AgentWorldCreditReason, CreditAuditSummaryEntry>();
    for (const item of state.creditAuditTrail) {
      const prev = summaryMap.get(item.reason);
      if (!prev) {
        summaryMap.set(item.reason, {
          reason: item.reason,
          totalAmount: item.amount,
          count: 1,
          lastCreatedAt: item.createdAt,
        });
        continue;
      }
      prev.totalAmount += item.amount;
      prev.count += 1;
      if (new Date(item.createdAt).getTime() > new Date(prev.lastCreatedAt).getTime()) {
        prev.lastCreatedAt = item.createdAt;
      }
      summaryMap.set(item.reason, prev);
    }
    return [...summaryMap.values()].sort((a, b) => b.totalAmount - a.totalAmount);
  }

  /** 是否已完成开放式 Agent 注册（旧持久化数据缺字段视为已注册）。 */
  isAgentWorldRegistered(sessionId: string): boolean {
    if (this.getOrCreate(sessionId).agentWorldRegistered === true) return true;
    // 宿主已注册账号（邮箱主体）即视为已注册：另一处登录不重走注册流程。
    // 首次判定时物化（发放初始点数），此后走上面常规路径。
    if (this.externalRegistrationResolver?.(sessionId)) {
      this.grantAgentWorldRegistrationIfNeeded(sessionId);
      return true;
    }
    return false;
  }

  /** 颁发注册挑战（任意域名上的 Agent 可用 HTTP 或工具完成）。 */
  issueAgentWorldRegisterChallenge(sessionId: string): WorldRegisterChallenge {
    this.getOrCreate(sessionId);
    return this.agentRegistration.issueChallenge(sessionId);
  }

  /** 校验答案并通过注册（发放初始世界点数，若尚未发放）。 */
  verifyAgentWorldRegister(sessionId: string, nonce: string, answerHex: string): VerifyChallengeResult {
    this.getOrCreate(sessionId);
    const v = this.agentRegistration.verifyAndConsume(sessionId, nonce, answerHex);
    if (!v.ok) return v;
    this.grantAgentWorldRegistrationIfNeeded(sessionId);
    return { ok: true };
  }

  /**
   * 【占位】Agent 一键注册：仅当 `AGENT_WORLD_PLACEHOLDER_REGISTER=1` 时可用。
   * 正式题目与风控上线后应关闭此开关，改走 challenge/verify。
   */
  tryAgentQuickRegister(
    sessionId: string,
  ): { ok: true; state: WorldState } | { ok: false; reason: string; message: string } {
    if (!allowAgentWorldPlaceholderRegister()) {
      return {
        ok: false,
        reason: "PLACEHOLDER_DISABLED",
        message:
          "一键占位注册未开启。请使用 POST /world/register/challenge 与 /world/register/verify，或工具 world.open_registry.get_challenge / submit。开发环境可设置环境变量 AGENT_WORLD_PLACEHOLDER_REGISTER=1。",
      };
    }
    this.getOrCreate(sessionId);
    this.grantAgentWorldRegistrationIfNeeded(sessionId);
    return { ok: true, state: this.getOrCreate(sessionId) };
  }

  private grantAgentWorldRegistrationIfNeeded(sessionId: string): void {
    const s = this.getOrCreate(sessionId);
    if (!s.agentWorldRegistered) {
      s.agentWorldRegistered = true;
      if (s.agentWorldCredits === 0 && s.ownedSkillIds.length === 0 && s.leisureCount === 0) {
        s.agentWorldCredits = INITIAL_AGENT_WORLD_CREDITS;
      }
      s.sceneId = "plaza";
      this.markWorldMutated(s.roomId);
    }
  }

  /**
   * 世界工具 / 写操作前调用：未注册则抛出带指引的 Error。
   */
  assertAgentWorldRegistered(sessionId: string): void {
    if (this.isAgentWorldRegistered(sessionId)) return;
    throw new Error("WORLD_REGISTRATION_REQUIRED: 请先完成 Agent World 注册");
  }

  /** A2A：发包方新增一笔锁定托管（与 `tryDebitCredits` 配套，在契约写入成功后调用）。 */
  addA2aEscrowReserved(sessionId: string, amount: number, opts?: WorldMutationOptions): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.assertAgentWorldRegistered(sessionId);
    const roomId = sessionId;
    this.checkExpectedRevision(roomId, opts?.expectedRevision);
    const s = this.getOrCreate(sessionId);
    s.a2aEscrowReserved += Math.floor(amount);
    this.markWorldMutated(s.roomId);
  }

  /** A2A：释放发包方托管（取消退款、验收打给接单方前）。 */
  releaseA2aEscrowReserved(sessionId: string, amount: number, opts?: WorldMutationOptions): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.assertAgentWorldRegistered(sessionId);
    const s = this.getOrCreate(sessionId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.a2aEscrowReserved = Math.max(0, s.a2aEscrowReserved - Math.floor(amount));
    this.markWorldMutated(s.roomId);
  }

  /** 进入自由市场场景（技能交易、A2A 外包等均属此经济域）。 */
  visitFreeMarket(roomId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    const s =
      roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreateRoom(roomId, actorSessionId ?? roomId);
    if (!s) throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
    const actor = actorSessionId ?? s.ownerSessionId;
    this.assertAgentWorldRegistered(actor);
    this.assertRoomWritable(actor, s.roomId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.sceneId = "free_market";
    this.markWorldMutated(s.roomId);
    return s;
  }

  /** 与 `visitFreeMarket` 相同；保留名称供旧路由与客户端兼容。 */
  visitShop(roomId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    return this.visitFreeMarket(roomId, actorSessionId, opts);
  }

  /** 休闲占位：仅增加计数，不直接产出世界点数。 */
  recordLeisure(roomId: string, _actionId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    const s =
      roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreateRoom(roomId, actorSessionId ?? roomId);
    if (!s) throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
    const actor = actorSessionId ?? s.ownerSessionId;
    this.assertAgentWorldRegistered(actor);
    this.assertRoomWritable(actor, s.roomId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.leisureCount += 1;
    if (s.sceneId === "shop" || s.sceneId === "free_market") {
      s.sceneId = "plaza";
    }
    this.markWorldMutated(s.roomId);
    return s;
  }

  /** 进入 Agent 互动动态（类推文）场景。 */
  visitSocial(roomId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    const s =
      roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreateRoom(roomId, actorSessionId ?? roomId);
    if (!s) throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
    const actor = actorSessionId ?? s.ownerSessionId;
    this.assertAgentWorldRegistered(actor);
    this.assertRoomWritable(actor, s.roomId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.sceneId = "social";
    this.markWorldMutated(s.roomId);
    return s;
  }

  /** 进入一起听音乐场景。 */
  visitMusicRoom(roomId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    const s =
      roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreateRoom(roomId, actorSessionId ?? roomId);
    if (!s) throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
    const actor = actorSessionId ?? s.ownerSessionId;
    this.assertAgentWorldRegistered(actor);
    this.assertRoomWritable(actor, s.roomId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.sceneId = "music_room";
    this.markWorldMutated(s.roomId);
    return s;
  }



  /**
   * 扣减世界点数（Agent World 内虚拟币）。余额不足时返回 false，不改变状态。
   * `roomId` 一般为玩家个人房（与 sessionId 相同）。
   */
  tryDebitCredits(roomId: string, amount: number, opts?: WorldMutationOptions): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    let s = this.getExisting(roomId);
    if (!s && !roomId.startsWith("wr-")) {
      s = this.getOrCreateRoom(roomId, roomId);
    }
    if (!s) return false;
    if (!this.isAgentWorldRegistered(s.ownerSessionId)) {
      return false;
    }
    if (s.agentWorldCredits < amount) return false;
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    s.agentWorldCredits -= amount;
    this.markWorldMutated(s.roomId);
    return true;
  }

  /**
   * 增加世界点数（仅允许白名单来源）。
   * 后续新功能若需发币，必须先在 `AGENT_WORLD_CREDIT_REASONS` 登记。
   */
  creditCredits(roomId: string, amount: number, reason: AgentWorldCreditReason, opts?: WorldMutationOptions): WorldState {
    if (!Number.isFinite(amount) || amount <= 0) return this.getOrCreate(roomId);
    if (!AGENT_WORLD_CREDIT_REASON_SET.has(reason)) {
      throw new Error(`UNSAFE_CREDIT_REASON: ${reason}`);
    }
    const s = this.getOrCreate(roomId);
    this.assertAgentWorldRegistered(s.ownerSessionId);
    this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    const delta = Math.floor(amount);
    s.agentWorldCredits += delta;
    const createdAt = new Date().toISOString();
    s.creditAuditTrail.push({
      auditId: `credit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: s.ownerSessionId,
      amount: delta,
      reason,
      balanceAfter: s.agentWorldCredits,
      createdAt,
    });
    if (s.creditAuditTrail.length > MAX_CREDIT_AUDIT_TRAIL) {
      s.creditAuditTrail = s.creditAuditTrail.slice(-MAX_CREDIT_AUDIT_TRAIL);
    }
    this.markWorldMutated(s.roomId);
    this.evolutionHooks.onWorldCreditsCredited?.({
      roomId: s.roomId,
      actorSessionId: s.ownerSessionId,
      amount: delta,
      reason,
      balanceAfter: s.agentWorldCredits,
      createdAt,
    });
    return s;
  }

  purchaseSkill(
    roomId: string,
    skillId: string,
    skillManager: SkillManagerLike,
    actorSessionId?: string,
    opts?: WorldMutationOptions,
  ): { ok: true; state: WorldState } | { ok: false; reason: string; message: string } {
    const manifest = skillManager.get(skillId);
    if (!manifest) {
      return { ok: false, reason: "SKILL_NOT_FOUND", message: "商店中找不到该技能" };
    }

    const s =
      roomId.startsWith("wr-") ? this.getExisting(roomId) : this.getOrCreateRoom(roomId, actorSessionId ?? roomId);
    if (!s) {
      return { ok: false, reason: "ROOM_NOT_FOUND", message: "房间不存在" };
    }
    const actor = actorSessionId ?? s.ownerSessionId;

    if (!this.isAgentWorldRegistered(actor)) {
      return {
        ok: false,
        reason: "WORLD_REGISTRATION_REQUIRED",
        message: "请先完成 Agent World 注册",
      };
    }

    try {
      this.assertRoomWritable(actor, s.roomId);
      this.checkExpectedRevision(s.roomId, opts?.expectedRevision);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("WORLD_REVISION_CONFLICT")) {
        return { ok: false, reason: "WORLD_REVISION_CONFLICT", message: msg };
      }
      return { ok: false, reason: "ROOM_WRITE_FORBIDDEN", message: msg };
    }

    if (s.ownedSkillIds.includes(skillId)) {
      return { ok: false, reason: "ALREADY_OWNED", message: "已拥有该技能" };
    }

    const price = mockSkillPrice(manifest);
    if (s.agentWorldCredits < price) {
      return { ok: false, reason: "INSUFFICIENT_COINS", message: "世界点数不足" };
    }

    /** 购买确认时当场扣点（与 A2A 发布悬赏扣款时机一致：交易成立即收取）。 */
    s.agentWorldCredits -= price;
    s.ownedSkillIds.push(skillId);

    try {
      skillManager.setEnabled(skillId, true);
      if (manifest.permissions?.length) {
        skillManager.grantPermissions(skillId, manifest.permissions);
      }
    } catch (e) {
      s.agentWorldCredits += price;
      s.ownedSkillIds = s.ownedSkillIds.filter((id) => id !== skillId);
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: "SKILL_ENABLE_FAILED", message: msg };
    }

    this.markWorldMutated(s.roomId);
    this.evolutionHooks.onSkillPurchased?.({
      roomId: s.roomId,
      actorSessionId: actor,
      skillId,
      pricePaid: price,
      balanceAfter: s.agentWorldCredits,
    });
    return { ok: true, state: s };
  }
}
