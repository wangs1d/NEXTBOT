import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { getDataDir } from "../config/data-dir.js";
import {
  AGENT_WORLD_CREDIT_REASONS,
  type WorldService,
} from "./world-service.js";

export type A2aContractStatus = "open" | "in_progress" | "delivered" | "completed" | "cancelled";

export type A2aOutsourcingContract = {
  contractId: string;
  clientSessionId: string;
  providerSessionId: string | null;
  /** 若设置，仅该 session 可接单（定向外包） */
  assigneeSessionId: string | null;
  title: string;
  specification: string;
  rewardCredits: number;
  status: A2aContractStatus;
  deliverable: string | null;
  /** 最近一次发包方驳回交付时填写的说明（若有） */
  lastRejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type A2aListFilter = "open" | "mine";

export type A2aContractMutationResult =
  | { ok: true; contract: A2aOutsourcingContract }
  | { ok: false; reason: string; message: string };

type PersistedFile = {
  version: 1;
  contracts: A2aOutsourcingContract[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function newContractId(): string {
  return `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeContract(raw: unknown): A2aOutsourcingContract | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const contractId = typeof o.contractId === "string" ? o.contractId : "";
  const clientSessionId = typeof o.clientSessionId === "string" ? o.clientSessionId : "";
  const status = o.status as A2aContractStatus;
  const validStatuses: A2aContractStatus[] = [
    "open",
    "in_progress",
    "delivered",
    "completed",
    "cancelled",
  ];
  if (!contractId || !clientSessionId || !validStatuses.includes(status)) return null;
  return {
    contractId,
    clientSessionId,
    providerSessionId: typeof o.providerSessionId === "string" ? o.providerSessionId : null,
    assigneeSessionId: typeof o.assigneeSessionId === "string" ? o.assigneeSessionId : null,
    title: typeof o.title === "string" ? o.title : "",
    specification: typeof o.specification === "string" ? o.specification : "",
    rewardCredits: typeof o.rewardCredits === "number" && Number.isFinite(o.rewardCredits) ? o.rewardCredits : 0,
    status,
    deliverable: typeof o.deliverable === "string" ? o.deliverable : null,
    lastRejectionReason: typeof o.lastRejectionReason === "string" ? o.lastRejectionReason : null,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : nowIso(),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
  };
}

/**
 * Agent World 自由市场 — 任务外包（A2A）：
 * - **发布时立即扣款**：悬赏点数在创建契约时从发包方当场扣除并锁定，直至验收通过、取消或驳回后重新交付（锁定关系由契约状态表达；与 `WorldService` 余额配合使用）。
 * - 验收通过后打给接单方；发包方取消（未交付或进行中）全额退回；持久化见 `data/a2a-contracts.json`（可用 `A2A_CONTRACTS_FILE` 覆盖）。
 */
export class A2aOutsourcingService {
  private readonly contracts = new Map<string, A2aOutsourcingContract>();

  constructor(private readonly worldService: WorldService) {}

  private get persistPath(): string {
    return process.env.A2A_CONTRACTS_FILE ?? join(getDataDir(), "a2a-contracts.json");
  }

  /** 进程启动时加载；文件不存在则空。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedFile | { contracts?: unknown[] };
      const list = Array.isArray(data.contracts) ? data.contracts : [];
      this.contracts.clear();
      for (const item of list) {
        const c = normalizeContract(item);
        if (c) this.contracts.set(c.contractId, c);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const payload: PersistedFile = {
      version: 1,
      contracts: [...this.contracts.values()].sort(
        (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      ),
    };
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), "utf8");
  }

  listContracts(sessionId: string, filter: A2aListFilter): A2aOutsourcingContract[] {
    const all = [...this.contracts.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    if (filter === "open") {
      return all.filter((c) => c.status === "open");
    }
    return all.filter(
      (c) => c.clientSessionId === sessionId || c.providerSessionId === sessionId,
    );
  }

  getContract(contractId: string): A2aOutsourcingContract | undefined {
    return this.contracts.get(contractId);
  }

  /** 全量契约（启动对账等）。 */
  listAllContracts(): A2aOutsourcingContract[] {
    return [...this.contracts.values()];
  }

  async createContract(params: {
    clientSessionId: string;
    title: string;
    specification: string;
    rewardCredits: number;
    assigneeSessionId?: string | null;
  }): Promise<A2aContractMutationResult> {
    const title = params.title.trim();
    const specification = params.specification.trim();
    const reward = Math.floor(params.rewardCredits);
    if (!title) {
      return { ok: false, reason: "INVALID_TITLE", message: "标题不能为空" };
    }
    if (!specification) {
      return { ok: false, reason: "INVALID_SPEC", message: "任务说明不能为空" };
    }
    if (specification.length > 12000) {
      return { ok: false, reason: "SPEC_TOO_LONG", message: "任务说明过长（≤12000 字符）" };
    }
    if (!Number.isFinite(reward) || reward < 1) {
      return { ok: false, reason: "INVALID_REWARD", message: "悬赏须为至少 1 的世界点数" };
    }

    const assignee =
      params.assigneeSessionId !== undefined && params.assigneeSessionId !== null
        ? String(params.assigneeSessionId).trim()
        : "";
    const assigneeSessionId = assignee.length > 0 ? assignee : null;

    /** 发布即扣款（购买托管），与技能商店购买扣点时机一致。 */
    if (!this.worldService.tryDebitCredits(params.clientSessionId, reward)) {
      return {
        ok: false,
        reason: "INSUFFICIENT_CREDITS",
        message: "世界点数不足，无法支付悬赏（发布契约时即当场扣款）",
      };
    }

    const t = nowIso();
    const contract: A2aOutsourcingContract = {
      contractId: newContractId(),
      clientSessionId: params.clientSessionId,
      providerSessionId: null,
      assigneeSessionId,
      title,
      specification,
      rewardCredits: reward,
      status: "open",
      deliverable: null,
      lastRejectionReason: null,
      createdAt: t,
      updatedAt: t,
    };
    this.contracts.set(contract.contractId, contract);
    this.worldService.addA2aEscrowReserved(params.clientSessionId, reward);
    try {
      await this.persist();
    } catch (e) {
      this.contracts.delete(contract.contractId);
      this.worldService.releaseA2aEscrowReserved(params.clientSessionId, reward);
      this.worldService.creditCredits(
        params.clientSessionId,
        reward,
        AGENT_WORLD_CREDIT_REASONS.A2aPersistRollbackRefund,
      );
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: "PERSIST_FAILED", message: `契约未保存，已退回扣款：${msg}` };
    }
    return { ok: true, contract };
  }

  async acceptContract(params: {
    contractId: string;
    providerSessionId: string;
  }): Promise<A2aContractMutationResult> {
    const c = this.contracts.get(params.contractId);
    if (!c) {
      return { ok: false, reason: "NOT_FOUND", message: "契约不存在" };
    }
    if (c.status !== "open") {
      return { ok: false, reason: "NOT_OPEN", message: "该契约不在可接单状态" };
    }
    if (c.clientSessionId === params.providerSessionId) {
      return { ok: false, reason: "SELF_ACCEPT", message: "不能接自己的单" };
    }
    if (c.assigneeSessionId && c.assigneeSessionId !== params.providerSessionId) {
      return { ok: false, reason: "NOT_ASSIGNEE", message: "该单为定向任务，仅指定 Agent 可接" };
    }

    c.providerSessionId = params.providerSessionId;
    c.status = "in_progress";
    c.updatedAt = nowIso();
    await this.persist();
    return { ok: true, contract: c };
  }

  async deliverContract(params: {
    contractId: string;
    providerSessionId: string;
    deliverable: string;
  }): Promise<A2aContractMutationResult> {
    const c = this.contracts.get(params.contractId);
    if (!c) {
      return { ok: false, reason: "NOT_FOUND", message: "契约不存在" };
    }
    if (c.status !== "in_progress") {
      return { ok: false, reason: "NOT_IN_PROGRESS", message: "当前状态不可交付" };
    }
    if (c.providerSessionId !== params.providerSessionId) {
      return { ok: false, reason: "NOT_PROVIDER", message: "仅接单方可提交交付物" };
    }
    const deliverable = params.deliverable.trim();
    if (!deliverable) {
      return { ok: false, reason: "EMPTY_DELIVERABLE", message: "交付内容不能为空" };
    }
    if (deliverable.length > 64000) {
      return { ok: false, reason: "DELIVERABLE_TOO_LONG", message: "交付内容过长" };
    }

    c.deliverable = deliverable;
    c.status = "delivered";
    c.lastRejectionReason = null;
    c.updatedAt = nowIso();
    await this.persist();
    return { ok: true, contract: c };
  }

  /** 发包方驳回交付：回到进行中，接单方可重新提交；悬赏仍锁定。 */
  async rejectDelivery(params: {
    contractId: string;
    clientSessionId: string;
    reason?: string | null;
  }): Promise<A2aContractMutationResult> {
    const c = this.contracts.get(params.contractId);
    if (!c) {
      return { ok: false, reason: "NOT_FOUND", message: "契约不存在" };
    }
    if (c.status !== "delivered") {
      return { ok: false, reason: "NOT_DELIVERED", message: "仅可在已交付待验收时驳回" };
    }
    if (c.clientSessionId !== params.clientSessionId) {
      return { ok: false, reason: "NOT_CLIENT", message: "仅发包方可驳回交付" };
    }

    const note =
      params.reason !== undefined && params.reason !== null ? String(params.reason).trim() : "";
    if (note.length > 4000) {
      return { ok: false, reason: "REASON_TOO_LONG", message: "驳回说明过长（≤4000 字符）" };
    }

    c.status = "in_progress";
    c.deliverable = null;
    c.lastRejectionReason = note.length > 0 ? note : null;
    c.updatedAt = nowIso();
    await this.persist();
    return { ok: true, contract: c };
  }

  async completeContract(params: {
    contractId: string;
    clientSessionId: string;
  }): Promise<A2aContractMutationResult> {
    const c = this.contracts.get(params.contractId);
    if (!c) {
      return { ok: false, reason: "NOT_FOUND", message: "契约不存在" };
    }
    if (c.status !== "delivered") {
      return { ok: false, reason: "NOT_DELIVERED", message: "须先由接单方提交交付物" };
    }
    if (c.clientSessionId !== params.clientSessionId) {
      return { ok: false, reason: "NOT_CLIENT", message: "仅发包方可确认验收" };
    }
    const provider = c.providerSessionId;
    if (!provider) {
      return { ok: false, reason: "NO_PROVIDER", message: "契约数据异常" };
    }

    const paid = c.rewardCredits;
    this.worldService.releaseA2aEscrowReserved(c.clientSessionId, paid);
    this.worldService.creditCredits(
      provider,
      paid,
      AGENT_WORLD_CREDIT_REASONS.A2aContractPayout,
    );
    c.status = "completed";
    c.updatedAt = nowIso();
    await this.persist();
    return { ok: true, contract: c };
  }

  async cancelContract(params: {
    contractId: string;
    clientSessionId: string;
  }): Promise<A2aContractMutationResult> {
    const c = this.contracts.get(params.contractId);
    if (!c) {
      return { ok: false, reason: "NOT_FOUND", message: "契约不存在" };
    }
    if (c.clientSessionId !== params.clientSessionId) {
      return { ok: false, reason: "NOT_CLIENT", message: "仅发包方可取消" };
    }
    if (c.status !== "open" && c.status !== "in_progress") {
      return {
        ok: false,
        reason: "NOT_CANCELLABLE",
        message: "当前状态不可取消（已交付请验收或驳回后让对方重交）",
      };
    }

    const refund = c.rewardCredits;
    this.worldService.releaseA2aEscrowReserved(c.clientSessionId, refund);
    this.worldService.creditCredits(
      c.clientSessionId,
      refund,
      AGENT_WORLD_CREDIT_REASONS.A2aContractRefund,
    );
    c.status = "cancelled";
    c.updatedAt = nowIso();
    await this.persist();
    return { ok: true, contract: c };
  }
}
