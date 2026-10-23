import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentPairingService } from "../services/agent-pairing-service.js";
import type { AgentRelayService, RelayMessageRecord } from "../services/agent-relay-service.js";
import { relayRequiresPairEnv } from "../services/agent-pairing-service.js";
import type { AuditService } from "../services/audit-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
import { ServerEventType } from "../protocol.js";

import type {
  AllianceRecord,
  AipProposalRecord,
  AipWireEnvelope,
  ConflictRecord,
} from "./aip-types.js";
import { AIP_VERSION } from "./aip-types.js";
import { parseAipEnvelope, summarizeAipForRelayText } from "./aip-validate.js";

type PersistedAipStateV1 = {
  version: 1;
  proposals: Record<string, AipProposalRecord>;
  alliances: Record<string, AllianceRecord>;
  conflicts: Record<string, ConflictRecord>;
};

export class AipService {
  private readonly proposals = new Map<string, AipProposalRecord>();
  private readonly alliances = new Map<string, AllianceRecord>();
  private readonly conflicts = new Map<string, ConflictRecord>();

  private get persistPath(): string {
    return process.env.AIP_STATE_FILE ?? join(getDataDir(), "aip-state.json");
  }

  constructor(
    private readonly relay: AgentRelayService,
    private readonly wsRegistry: ClientPushPort,
    private readonly pairing: AgentPairingService,
    private readonly audit?: AuditService,
  ) {}

  /** 启动时加载；文件不存在则保持空状态。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedAipStateV1;
      if (data.version !== 1 || data.proposals == null || typeof data.proposals !== "object") return;
      this.proposals.clear();
      this.alliances.clear();
      this.conflicts.clear();
      for (const [k, v] of Object.entries(data.proposals ?? {})) {
        if (v && typeof v === "object" && typeof v.proposalId === "string") {
          this.proposals.set(k, v as AipProposalRecord);
        }
      }
      for (const [k, v] of Object.entries(data.alliances ?? {})) {
        if (v && typeof v === "object" && typeof v.allianceId === "string") {
          this.alliances.set(k, v as AllianceRecord);
        }
      }
      for (const [k, v] of Object.entries(data.conflicts ?? {})) {
        if (v && typeof v === "object" && typeof v.conflictId === "string") {
          this.conflicts.set(k, v as ConflictRecord);
        }
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
    const payload: PersistedAipStateV1 = {
      version: 1,
      proposals: Object.fromEntries(this.proposals),
      alliances: Object.fromEntries(this.alliances),
      conflicts: Object.fromEntries(this.conflicts),
    };
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private schedulePersistAndAudit(params: {
    fromSessionId: string;
    toSessionId: string;
    envelope: AipWireEnvelope;
    record: RelayMessageRecord;
    traceId?: string;
  }): void {
    const { fromSessionId, toSessionId, envelope, record, traceId } = params;
    const conflictIdRaw = envelope.payload["conflictId"];
    const conflictId = typeof conflictIdRaw === "string" ? conflictIdRaw : undefined;
    void (async () => {
      await this.persist();
      await this.audit?.record({
        type: "aip_dispatch",
        at: new Date().toISOString(),
        fromSessionId,
        toSessionId,
        kind: envelope.kind,
        messageId: record.messageId,
        proposalId: envelope.proposalId,
        conflictId,
        traceId,
        chatUserMessageId: record.chatUserMessageId,
      });
    })().catch((err) => {
      console.error("[AipService] persist or audit failed:", err);
    });
  }

  listAlliancesForSession(sessionId: string): AllianceRecord[] {
    return [...this.alliances.values()].filter((a) => a.members.includes(sessionId));
  }

  listOpenConflictsForSession(sessionId: string): ConflictRecord[] {
    return [...this.conflicts.values()].filter(
      (c) =>
        (c.declarerSessionId === sessionId || c.targetSessionId === sessionId) && c.status === "open",
    );
  }

  getProposal(proposalId: string): AipProposalRecord | undefined {
    return this.proposals.get(proposalId);
  }

  /**
   * 投递 AIP 消息：校验、更新结盟/冲突状态机、写入中继并尝试 WS 推送。
   */
  dispatch(params: {
    fromSessionId: string;
    toSessionId: string;
    rawEnvelope: unknown;
    traceId?: string;
    chatUserMessageId?: string;
  }): { ok: true; record: RelayMessageRecord; pushedToPeer: boolean } | { ok: false; message: string } {
    const { fromSessionId, toSessionId, rawEnvelope, traceId, chatUserMessageId } = params;
    if (fromSessionId === toSessionId) {
      return { ok: false, message: "不能向自己的 session 投递 AIP" };
    }
    if (relayRequiresPairEnv() && !this.pairing.arePaired(fromSessionId, toSessionId)) {
      return {
        ok: false,
        message:
          "AIP 投递受配对约束：请双方先 POST /agent/pair 使用相同配对码，或开发环境关闭 AGENT_RELAY_REQUIRE_PAIR。",
      };
    }

    const parsed = parseAipEnvelope(rawEnvelope);
    if (!parsed.ok) return parsed;

    let envelope = parsed.envelope;
    const sm = this.applyStateMachine(fromSessionId, toSessionId, envelope);
    if (!sm.ok) return sm;
    envelope = sm.envelope;

    const text = summarizeAipForRelayText(envelope);
    const record = this.relay.postMessage({
      fromSessionId,
      toSessionId,
      text,
      subject: `aip:${envelope.kind}`,
      traceId,
      chatUserMessageId,
      aip: envelope,
    });

    const pushed = this.wsRegistry.trySend(
      toSessionId,
      JSON.stringify({
        type: ServerEventType.AgentPeerMessage,
        payload: {
          messageId: record.messageId,
          fromSessionId: record.fromSessionId,
          toSessionId: record.toSessionId,
          text: record.text,
          subject: record.subject,
          receivedAt: record.createdAt,
          ...(record.chatUserMessageId ? { chatUserMessageId: record.chatUserMessageId } : {}),
          aip: record.aip,
        },
      }),
    );

    this.schedulePersistAndAudit({
      fromSessionId,
      toSessionId,
      envelope,
      record,
      traceId,
    });

    return { ok: true, record, pushedToPeer: pushed };
  }

  private applyStateMachine(
    from: string,
    to: string,
    envelope: AipWireEnvelope,
  ): { ok: true; envelope: AipWireEnvelope } | { ok: false; message: string } {
    const now = new Date().toISOString();
    const out: AipWireEnvelope = {
      ...envelope,
      aipVersion: AIP_VERSION,
      payload: { ...envelope.payload },
    };

    switch (envelope.kind) {
      case "trade_proposal": {
        const pid = `tp-${randomUUID()}`;
        this.proposals.set(pid, {
          proposalId: pid,
          kind: "trade_proposal",
          fromSessionId: from,
          toSessionId: to,
          payload: envelope.payload,
          status: "pending",
          createdAt: now,
        });
        out.proposalId = pid;
        return { ok: true, envelope: out };
      }
      case "trade_response": {
        const proposalId = String(envelope.payload.proposalId ?? "");
        const p = this.proposals.get(proposalId);
        if (!p || p.kind !== "trade_proposal") {
          return { ok: false, message: `trade_response: 未知 proposalId ${proposalId}` };
        }
        if (p.toSessionId !== from || p.fromSessionId !== to) {
          return { ok: false, message: "trade_response: 仅受邀方可回应该交易提议" };
        }
        const decision = String(envelope.payload.decision ?? "");
        p.status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "pending";
        if (decision === "counter") p.status = "pending";
        return { ok: true, envelope: out };
      }
      case "alliance_invite": {
        const invitee = String(envelope.payload.inviteeSessionId ?? to);
        if (invitee !== to) {
          return { ok: false, message: "alliance_invite: inviteeSessionId 必须与收件人 toSessionId 一致" };
        }
        const pid = `al-${randomUUID()}`;
        this.proposals.set(pid, {
          proposalId: pid,
          kind: "alliance_invite",
          fromSessionId: from,
          toSessionId: to,
          payload: envelope.payload,
          status: "pending",
          createdAt: now,
        });
        out.proposalId = pid;
        return { ok: true, envelope: out };
      }
      case "alliance_response": {
        const proposalId = String(envelope.payload.proposalId ?? "");
        const p = this.proposals.get(proposalId);
        if (!p || p.kind !== "alliance_invite") {
          return { ok: false, message: `alliance_response: 未知或非结盟邀请 proposalId` };
        }
        if (p.toSessionId !== from || p.fromSessionId !== to) {
          return { ok: false, message: "alliance_response: 仅被邀请方可回应" };
        }
        const decision = String(envelope.payload.decision ?? "");
        if (decision === "accept") {
          p.status = "accepted";
          const aid = `alliance-${randomUUID()}`;
          const rec: AllianceRecord = {
            allianceId: aid,
            members: [p.fromSessionId, p.toSessionId],
            createdAt: now,
            leaderSessionId: p.fromSessionId,
          };
          this.alliances.set(aid, rec);
        } else {
          p.status = "rejected";
        }
        return { ok: true, envelope: out };
      }
      case "conflict_declare": {
        const target = String(envelope.payload.targetSessionId ?? "");
        if (target !== to) {
          return { ok: false, message: "conflict_declare: targetSessionId 必须与收件人 toSessionId 一致" };
        }
        const cid = `cf-${randomUUID()}`;
        this.conflicts.set(cid, {
          conflictId: cid,
          declarerSessionId: from,
          targetSessionId: to,
          reason: String(envelope.payload.reason ?? ""),
          status: "open",
          createdAt: now,
          updatedAt: now,
        });
        (out.payload as Record<string, unknown>).conflictId = cid;
        return { ok: true, envelope: out };
      }
      case "conflict_response": {
        const conflictId = String(envelope.payload.conflictId ?? "");
        const c = this.conflicts.get(conflictId);
        if (!c) {
          return { ok: false, message: `conflict_response: 未知 conflictId` };
        }
        const isParty =
          (c.declarerSessionId === from && c.targetSessionId === to) ||
          (c.targetSessionId === from && c.declarerSessionId === to);
        if (!isParty) {
          return { ok: false, message: "conflict_response: 仅冲突双方可互相投递回应" };
        }
        const action = String(envelope.payload.action ?? "");
        const t = new Date().toISOString();
        if (action === "withdraw") c.status = "withdrawn";
        else if (action === "offer_truce") c.status = "truce_offered";
        else if (action === "acknowledge" || action === "escalate") c.status = "open";
        c.updatedAt = t;
        return { ok: true, envelope: out };
      }
      default:
        return { ok: true, envelope: out };
    }
  }
}
