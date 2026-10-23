import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import { getStateEventManager, type StateChangeEvent } from "@nextbot/agent-world";
import type {
  PersonalizationPromptSlice,
  UserPersonalizationService,
} from "./user-personalization/user-personalization-service.js";
import { ProactiveOutboundMessageService } from "./proactive-outbound-message-service.js";
import { ProactiveContactPolicyService } from "./proactive-contact-policy.js";
import {
  normalizeStateChangeEvent,
  shouldEmitProactiveMessage,
  type GenericProactiveSignal,
  type ProactiveRuleHint,
} from "./proactive-signal-policy.js";

export type ProactiveRule = {
  module: string;
  eventType: string;
  priority: number;
  label: string;
  templateHint?: string;
};

const BUILTIN_RULES: ProactiveRule[] = [
  { module: "wallet", eventType: "transaction_completed", priority: 7, label: "Transaction Completed" },
  { module: "task", eventType: "task_completed", priority: 6, label: "Task Completed" },
  { module: "market", eventType: "skill_purchased", priority: 5, label: "Skill Purchased" },
  { module: "social", eventType: "post_created", priority: 3, label: "Post Created" },
  { module: "social", eventType: "friend_request_received", priority: 7, label: "Friend Request Received" },
];

type ProactiveConfig = {
  enabled: boolean;
  cooldownMs: number;
  decisionModel?: string;
  maxResponseChars: number;
};

function loadRules(): ProactiveRule[] {
  return BUILTIN_RULES;
}

function loadConfig(): ProactiveConfig {
  const raw = process.env.PROACTIVE_AGENT_ENABLED?.trim().toLowerCase();
  const enabled = raw === undefined || (raw !== "0" && raw !== "false" && raw !== "off");

  const cooldownRaw = process.env.PROACTIVE_AGENT_COOLDOWN_MS?.trim();
  const cooldownMs = cooldownRaw ? Number.parseInt(cooldownRaw, 10) : 5000;

  const modelRaw = process.env.PROACTIVE_AGENT_DECISION_MODEL?.trim();
  const decisionModel = modelRaw || undefined;

  const maxRaw = process.env.PROACTIVE_AGENT_MAX_RESPONSE_CHARS?.trim();
  const maxResponseChars = maxRaw ? Number.parseInt(maxRaw, 10) : 80;

  return {
    enabled,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 5000,
    decisionModel,
    maxResponseChars: Number.isFinite(maxResponseChars) && maxResponseChars > 20 ? maxResponseChars : 80,
  };
}

const SYSTEM_PROMPT = `You are a private life assistant deciding whether to proactively message the user.
Rules:
1. Sound natural, warm, and human.
2. Only speak when the signal is worth interrupting for.
3. Keep it to one short message.
4. If not worth saying, output SILENT exactly.
5. If the signal suggests stress or late-night work, reduce teasing and be gentler.
6. If the signal is celebratory or light, light humor is allowed when appropriate.
Output either one short message or SILENT.`;

export class ProactiveAgentCenter {
  private readonly config: ProactiveConfig;
  private readonly rules: ProactiveRule[];
  private readonly lastResponseAt = new Map<string, number>();
  private readonly recentResponses = new Map<string, string[]>();
  private readonly contactPolicy = new ProactiveContactPolicyService();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly externalChat: ExternalChatProvider | null,
    private readonly promptContextBuilder: PromptContextBuilder | null,
    private readonly outbound: ProactiveOutboundMessageService | null = null,
    private readonly userPersonalizationService: UserPersonalizationService | null = null,
    private readonly isUserOnline: ((actorId: string) => boolean) | null = null,
  ) {
    this.config = loadConfig();
    this.rules = loadRules();
  }

  start(): void {
    if (!this.config.enabled || !this.externalChat) {
      console.log("[ProactiveAgent] Disabled");
      return;
    }

    console.log(
      `[ProactiveAgent] Started | rules=${this.rules.length} | cooldown=${this.config.cooldownMs}ms`,
    );

    this.unsubscribe = getStateEventManager().on("*", "*", (event: StateChangeEvent) => {
      void this.onAnyEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastResponseAt.clear();
    this.recentResponses.clear();
    console.log("[ProactiveAgent] Stopped");
  }

  private async onAnyEvent(event: StateChangeEvent): Promise<void> {
    const rule = this.rules.find((item) => item.module === event.module && item.eventType === event.type);
    const signal = normalizeStateChangeEvent(
      event,
      rule ? this.toRuleHint(rule) : undefined,
      this.recentResponses.get(event.sessionId)?.length ?? 0,
    );

    if (!this.shouldRespond(signal, event)) return;
    await this.decideAndRespond(signal);
  }

  private shouldRespond(signal: GenericProactiveSignal, event: StateChangeEvent): boolean {
    const key = `${event.module}:${event.sessionId}`;
    const lastAt = this.lastResponseAt.get(key) ?? 0;
    if (Date.now() - lastAt < this.config.cooldownMs) return false;

    const globalLast = this.lastResponseAt.get(event.sessionId) ?? 0;
    if (Date.now() - globalLast < this.config.cooldownMs / 2) return false;

    return shouldEmitProactiveMessage(signal);
  }

  private async decideAndRespond(signal: GenericProactiveSignal): Promise<void> {
    try {
      const userPrompt = this.buildDecisionPrompt(signal);
      const personalization = await this.userPersonalizationService?.getPromptSlice(
        signal.actorId,
        `${signal.summary}\n${signal.evidence.join("\n")}`,
      );
      const response = await this.callLlm(signal.actorId, userPrompt, personalization);

      if (!response || response.trim().toUpperCase() === "SILENT") return;

      const relationship = this.userPersonalizationService?.getRelationshipState(signal.actorId) ?? null;
      const timeRhythm = this.userPersonalizationService?.getTimeRhythmState(signal.actorId) ?? null;
      const styleProfile = this.userPersonalizationService?.getStyleProfileState(signal.actorId) ?? null;
      const preference = this.userPersonalizationService?.getContactPreferenceState(signal.actorId) ?? null;
      const decision = this.contactPolicy.decide({
        actorId: signal.actorId,
        category: signal.tags.includes("risk") ? "warning" : signal.tags[0],
        urgency: signal.urgency,
        confidence: signal.confidence,
        tags: signal.tags,
        wsConnected: this.isUserOnline?.(signal.actorId) ?? true,
        recentContactCountHour: this.outbound?.countSince(signal.actorId, 60 * 60_000) ?? 0,
        recentContactCountDay: this.outbound?.countSince(signal.actorId, 24 * 60 * 60_000) ?? 0,
        relationship,
        timeRhythm,
        styleProfile,
        preference,
      });
      if (!decision.allowed) return;

      const clean = response.trim().slice(0, this.config.maxResponseChars);
      this.recordResponse(signal.rawEvent.sessionId, clean);
      this.markResponded(signal.rawEvent);
      await this.outbound?.send({
        actorId: signal.actorId,
        title: signal.title,
        text: clean,
        reason: `${signal.module}:${signal.eventType}`,
        channel: decision.channel,
        meta: {
          module: signal.module,
          eventType: signal.eventType,
          tags: signal.tags,
          urgency: signal.urgency,
          confidence: signal.confidence,
          evidence: signal.evidence,
          contactDecision: decision.reason,
          contactRationale: decision.rationale,
          disturbanceScore: decision.disturbanceScore,
        },
      });

      console.log(`[ProactiveAgent] [${signal.title}] ${clean}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[ProactiveAgent] Error: ${msg}`);
    }
  }

  private buildDecisionPrompt(signal: GenericProactiveSignal): string {
    const recent = this.recentResponses.get(signal.rawEvent.sessionId) ?? [];
    const recentStr = recent.length > 0 ? `Recent proactive lines:\n${recent.slice(-3).join("\n")}` : "";
    const hint = signal.templateHint ? `Hint: ${signal.templateHint}` : "";

    return [
      `Event: ${signal.title}`,
      `Summary: ${signal.summary}`,
      `Tags: ${signal.tags.join(", ") || "general"}`,
      `Metrics: urgency=${signal.urgency.toFixed(1)}, confidence=${signal.confidence.toFixed(1)}, novelty=${signal.novelty.toFixed(1)}, interruptiveness=${signal.interruptiveness.toFixed(1)}`,
      `Suggested tone: ${signal.suggestedTone}`,
      signal.evidence.length > 0 ? `Evidence:\n${signal.evidence.join("\n")}` : "",
      hint,
      recentStr,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async callLlm(
    actorSessionId: string,
    userPrompt: string,
    personalization?: PersonalizationPromptSlice,
  ): Promise<string> {
    if (!this.externalChat?.isEnabled()) return "";

    const baseOpts = this.promptContextBuilder?.build({
      actorId: actorSessionId,
      personalization,
    }) ?? {};

    let fullText = "";
    await this.externalChat.streamCompletion(
      `proactive:${actorSessionId}:${Date.now()}`,
      { text: userPrompt },
      (delta) => {
        fullText += delta;
      },
      undefined,
      {
        ...baseOpts,
        ephemeralTurn: true,
        systemPromptOverride: SYSTEM_PROMPT,
        chatToolsExtra: [],
        maxThreadMessages: 1,
        disableThinking: true,
        modelOverride: this.config.decisionModel,
      },
    );

    return fullText.trim();
  }

  private toRuleHint(rule: ProactiveRule): ProactiveRuleHint {
    return {
      priority: rule.priority,
      label: rule.label,
      templateHint: rule.templateHint,
    };
  }

  private recordResponse(sessionId: string, text: string): void {
    const list = this.recentResponses.get(sessionId) ?? [];
    list.push(text);
    if (list.length > 10) list.splice(0, list.length - 10);
    this.recentResponses.set(sessionId, list);
  }

  private markResponded(event: StateChangeEvent): void {
    const now = Date.now();
    this.lastResponseAt.set(`${event.module}:${event.sessionId}`, now);
    this.lastResponseAt.set(event.sessionId, now);
  }
}
