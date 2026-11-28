import type { TurnUnderstanding } from "./task-router.js";
import type { MemoryDomainKind } from "../brain/types.js";
import { shouldRecallLongTerm } from "./recall-gate.js";

export type MemoryRecallChannel =
  | "agentic"
  | "narrative"
  | "lifeModel"
  | "association"
  | "relationship"
  | "experienceLearning"
  | "event"
  | "tailFacts"
  | "profile";

export type MemoryConflictPolicy = "authority_then_recency" | "latest_wins" | "single_source";

export interface MemoryRecallPlan {
  trigger: boolean;
  reason: string;
  channels: readonly MemoryRecallChannel[];
  candidateK: Readonly<Partial<Record<MemoryRecallChannel, number>>>;
  finalN: number;
  budgetChars: number;
  conflictPolicy: MemoryConflictPolicy;
  skipReasons: readonly string[];
}

export interface MemoryRecallPlanInput {
  text: string;
  threadMessageCount?: number;
  understanding?: TurnUnderstanding;
  domain?: MemoryDomainKind;
  force?: boolean;
}

const CORE_CHANNELS: readonly MemoryRecallChannel[] = [
  "agentic",
  "narrative",
  "lifeModel",
  "association",
  "relationship",
  "experienceLearning",
  "event",
  "tailFacts",
  "profile",
];

const PERSONAL_FACT_CHANNELS: readonly MemoryRecallChannel[] = [
  "agentic",
  "lifeModel",
  "relationship",
  "tailFacts",
  "profile",
];

const ANAPHORA_CHANNELS: readonly MemoryRecallChannel[] = [
  "agentic",
  "narrative",
  "association",
];

function candidateBudgets(
  channels: readonly MemoryRecallChannel[],
  primaryK: number,
): MemoryRecallPlan["candidateK"] {
  return Object.fromEntries(channels.map((channel) => [channel, channel === "agentic" ? primaryK : Math.min(4, primaryK)]));
}

export function planMemoryRecall(input: MemoryRecallPlanInput): MemoryRecallPlan {
  const gate = shouldRecallLongTerm(input);
  if (!gate.trigger && !input.force) {
    return {
      trigger: false,
      reason: gate.reason,
      channels: [],
      candidateK: {},
      finalN: 0,
      budgetChars: 1200,
      conflictPolicy: "authority_then_recency",
      skipReasons: ["recall_gate_off"],
    };
  }

  if (input.domain && input.domain !== "working") {
    const channel: MemoryRecallChannel = input.domain === "narrative"
      ? "narrative"
      : input.domain === "relationship"
        ? "relationship"
        : "agentic";
    return {
      trigger: true,
      reason: input.force ? "explicit_domain" : gate.reason,
      channels: [channel],
      candidateK: candidateBudgets([channel], 8),
      finalN: 5,
      budgetChars: 1200,
      conflictPolicy: "single_source",
      skipReasons: [],
    };
  }

  if (input.domain === "working") {
    return {
      trigger: false,
      reason: "working_memory",
      channels: [],
      candidateK: {},
      finalN: 0,
      budgetChars: 1200,
      conflictPolicy: "single_source",
      skipReasons: ["working_memory_uses_session_store"],
    };
  }

  const channels = input.force || gate.reason === "memory_cue"
    ? CORE_CHANNELS
    : gate.reason === "personal_fact"
      ? PERSONAL_FACT_CHANNELS
      : ANAPHORA_CHANNELS;
  return {
    trigger: true,
    reason: input.force ? "explicit_recall" : gate.reason,
    channels,
    candidateK: candidateBudgets(channels, gate.reason === "memory_cue" ? 8 : 6),
    finalN: gate.reason === "memory_cue" ? 6 : 5,
    budgetChars: 1200,
    conflictPolicy: "authority_then_recency",
    skipReasons: [],
  };
}
