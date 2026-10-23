import type { StateChangeEvent } from "@nextbot/agent-world";

export type ProactiveRuleHint = {
  priority?: number;
  label?: string;
  templateHint?: string;
};

export type GenericProactiveSignal = {
  signalId: string;
  actorId: string;
  module: string;
  eventType: string;
  title: string;
  summary: string;
  evidence: string[];
  tags: string[];
  urgency: number;
  novelty: number;
  confidence: number;
  interruptiveness: number;
  suggestedTone: "warm" | "playful" | "calm" | "direct";
  templateHint?: string;
  rawEvent: StateChangeEvent;
};

function toTitleCase(input: string): string {
  return input
    .split(/[._:\-/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactScalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t ? t.slice(0, 120) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function classifyTag(text: string): string[] {
  const lower = text.toLowerCase();
  const tags: string[] = [];
  if (/(done|completed|success|finished|完成|成功|结束)/i.test(lower)) tags.push("completion");
  if (/(error|fail|warning|risk|urgent|异常|失败|风险|紧急)/i.test(lower)) tags.push("risk");
  if (/(created|new|received|started|新增|收到|开始)/i.test(lower)) tags.push("newness");
  if (/(remind|schedule|task|calendar|提醒|日程|任务)/i.test(lower)) tags.push("planning");
  if (/(chat|social|friend|message|社交|好友|消息)/i.test(lower)) tags.push("social");
  if (/(money|wallet|trade|payment|stock|fund|钱|交易|支付|股票)/i.test(lower)) tags.push("finance");
  if (/(work|night|sleep|desktop|device|工作|熬夜|睡觉|桌面|设备)/i.test(lower)) tags.push("presence");
  return [...new Set(tags)];
}

function inferTone(tags: string[], urgency: number): GenericProactiveSignal["suggestedTone"] {
  if (tags.includes("risk") || urgency >= 7) return "direct";
  if (tags.includes("completion")) return "playful";
  if (tags.includes("presence")) return "warm";
  return "calm";
}

export function normalizeStateChangeEvent(
  event: StateChangeEvent,
  hint?: ProactiveRuleHint,
  recentResponseCount = 0,
): GenericProactiveSignal {
  const payload = event.payload ?? {};
  const scalarEntries = Object.entries(payload)
    .map(([key, value]) => [key, compactScalar(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));

  const evidence = scalarEntries.slice(0, 6).map(([key, value]) => `${key}: ${value}`);
  const baseText = [
    event.module,
    event.type,
    event.previousState ?? "",
    event.currentState ?? "",
    ...evidence,
  ].join(" ");
  const tags = classifyTag(baseText);

  const numericMagnitude = Object.values(payload)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce((sum, value) => sum + Math.abs(value), 0);

  const urgency =
    (hint?.priority ?? 3) +
    (tags.includes("risk") ? 2 : 0) +
    (tags.includes("completion") ? 1 : 0) +
    Math.min(3, numericMagnitude / 10);

  const novelty = Math.max(1, 6 - Math.min(recentResponseCount, 5));
  const confidence =
    4 +
    Math.min(3, evidence.length / 2) +
    (event.currentState && event.currentState !== event.previousState ? 1 : 0);
  const interruptiveness = Math.max(
    1,
    urgency +
      (tags.includes("presence") ? 1 : 0) +
      (tags.includes("social") ? 1 : 0) -
      Math.min(2, recentResponseCount),
  );

  return {
    signalId: `${event.actorSessionId}:${event.module}:${event.type}:${Date.now()}`,
    actorId: event.actorSessionId,
    module: event.module,
    eventType: event.type,
    title: hint?.label?.trim() || toTitleCase(`${event.module} ${event.type}`),
    summary: `${toTitleCase(event.module)} ${toTitleCase(event.type)}${event.currentState ? ` -> ${event.currentState}` : ""}`,
    evidence,
    tags,
    urgency,
    novelty,
    confidence,
    interruptiveness,
    suggestedTone: inferTone(tags, urgency),
    templateHint: hint?.templateHint,
    rawEvent: event,
  };
}

export function shouldEmitProactiveMessage(signal: GenericProactiveSignal): boolean {
  const weightedScore =
    signal.urgency * 0.35 +
    signal.confidence * 0.25 +
    signal.novelty * 0.2 +
    signal.interruptiveness * 0.2;
  return weightedScore >= 4.2;
}
