import {
  classifyMemorySourceRole,
  normalizeMemorySourceRole,
  type MemorySourceRole,
} from "../services/memory-source-role.js";

export type MemoryAuthority = "user" | "assistant" | "tool" | "system" | "derived" | "unverified";
export type MemoryValidity = "active" | "superseded" | "suppressed" | "forgotten";
export type MemoryRecordKind = "fact" | "preference" | "event" | "understanding" | "interaction";

export interface MemoryRecord {
  readonly actorId: string;
  readonly sourceRef: string;
  readonly sourceRole: MemorySourceRole;
  readonly authority: MemoryAuthority;
  readonly validity: MemoryValidity;
  readonly kind: MemoryRecordKind;
  readonly createdAt: string;
  readonly sourceEventId?: string;
  readonly eventTime?: string;
  readonly supersedes?: readonly string[];
}

export interface MemoryRecordInput {
  actorId: string;
  sourceRef: string;
  text: string;
  sourceRole?: MemorySourceRole;
  authority?: MemoryAuthority;
  validity?: MemoryValidity;
  kind?: MemoryRecordKind;
  createdAt?: string;
  sourceEventId?: string;
  eventTime?: string;
  supersedes?: readonly string[];
}

const AUTHORITY_BY_ROLE: Record<MemorySourceRole, MemoryAuthority> = {
  user: "user",
  assistant: "assistant",
  mixed: "derived",
  tool: "tool",
  system: "system",
  unknown: "unverified",
};

export function createMemoryRecord(input: MemoryRecordInput): MemoryRecord {
  const sourceRole = normalizeMemorySourceRole(input.sourceRole) ?? classifyMemorySourceRole(input.text);
  const supersedes = input.supersedes?.length ? Object.freeze([...new Set(input.supersedes)]) : undefined;
  return Object.freeze({
    actorId: input.actorId.trim(),
    sourceRef: input.sourceRef.trim(),
    sourceRole,
    authority: input.authority ?? AUTHORITY_BY_ROLE[sourceRole],
    validity: input.validity ?? "active",
    kind: input.kind ?? "interaction",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    ...(input.eventTime ? { eventTime: input.eventTime } : {}),
    ...(supersedes ? { supersedes } : {}),
  });
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MemoryRecord>;
  return (
    typeof record.actorId === "string" &&
    typeof record.sourceRef === "string" &&
    normalizeMemorySourceRole(record.sourceRole) !== null &&
    typeof record.authority === "string" &&
    typeof record.validity === "string" &&
    typeof record.kind === "string" &&
    typeof record.createdAt === "string"
  );
}

export function memoryRecordFromMetadata(
  metadata: Record<string, unknown> | undefined,
): MemoryRecord | null {
  return isMemoryRecord(metadata?.memoryRecord) ? metadata.memoryRecord : null;
}

export function memoryRecordMetadata(record: MemoryRecord): Record<string, unknown> {
  return {
    memoryRecord: record,
    sourceRef: record.sourceRef,
    sourceRole: record.sourceRole,
    authority: record.authority,
    validity: record.validity,
    memoryKind: record.kind,
    ...(record.sourceEventId ? { sourceEventId: record.sourceEventId } : {}),
    ...(record.eventTime ? { eventTime: record.eventTime } : {}),
    ...(record.supersedes?.length ? { supersedes: [...record.supersedes] } : {}),
  };
}
