export type LifeSignalSource =
  | "manual"
  | "schedule"
  | "device"
  | "desktop"
  | "market"
  | "social"
  | "location"
  | "system"
  | "agent_inference";

export type LifeSignalImportance = "low" | "medium" | "high" | "critical";

export type LifeSignal = {
  id: string;
  actorId: string;
  source: LifeSignalSource;
  kind: string;
  title: string;
  summary: string;
  description?: string;
  tags: string[];
  importance: LifeSignalImportance;
  sourceReliability?: number;
  evidence: string[];
  metrics?: Record<string, number>;
  occurredAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type AnticipationCandidate = {
  id: string;
  actorId: string;
  signalId: string;
  category: "care" | "warning" | "opportunity" | "planning" | "follow_up";
  title: string;
  rationale: string;
  suggestedAction: string;
  confidence: number;
  urgency: number;
  shouldNotify: boolean;
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type AnticipationEvaluationContext = {
  behavior?: {
    shoppingInterest: number;
    planningInterest: number;
    companionNeed: number;
    privacyConcern: number;
  } | null;
  relationship?: {
    warmth: number;
    humorTolerance: number;
    proactiveTolerance: number;
    encouragementNeed: number;
    directnessPreference: number;
    rapport: number;
  } | null;
  timeRhythm?: {
    activeHours: Record<string, number>;
    receptiveHours: Record<string, number>;
    weekdayActivity?: Record<string, number>;
    weekdayReceptive?: Record<string, number>;
    lateNightTolerance: number;
    weekendTolerance?: number;
  } | null;
  styleProfile?: {
    banterLevel: number;
    careStyle: "gentle" | "playful" | "direct";
    motivationStyle: "encouraging" | "steady" | "push";
    initiativeStyle: "reserved" | "balanced" | "proactive";
  } | null;
  recentSignals?: LifeSignal[];
  repeatedPatternCount?: number;
  evidenceWindow?: LifeSignalEvidenceWindow;
};

export type LifeSignalEvidenceWindow = {
  actorId: string;
  windowMs: number;
  totalSignals: number;
  recentSignals: LifeSignal[];
  trend: "rising" | "falling" | "stable";
  directionScore: number;
  slopeScore: number;
  turningPoints: number;
  reversalDirection: "upward" | "downward" | "mixed" | null;
  topicCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  signalKinds: Record<string, number>;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
};
